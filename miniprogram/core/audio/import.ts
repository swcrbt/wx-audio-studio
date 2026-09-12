/**
 * 素材导入管线：读文件 → 解码 → 重采样 → 声道统一 → 峰值 → WAV 落盘。
 *
 * 内存纪律（长音频不允许整段驻留 PCM）：
 * 1. 同一时刻只允许一个解码任务（`importAudio` 内部串行化），解码产物是唯一的大块内存；
 * 2. 解码后按 `PROCESS_CHUNK_SEC` 分块处理：取源声道切片 → 重采样 → 转 Int16 → 立即写盘，
 *    峰值在同一个循环里顺带累计（`Level0Accumulator`），不额外遍历；
 * 3. 结束或失败后释放音频缓冲引用与半成品文件。
 */
import type { Asset, Id, PeakRef } from '../types';
import {
  MAX_ASSET_DURATION_SEC,
  MAX_DECODED_BYTES,
  PROCESS_CHUNK_SEC,
} from '../../workers/render/constants';
import {
  BASE_BUCKET,
  Level0Accumulator,
  buildUpperLevel,
  type PeaksLevel,
} from '../../workers/render/peaks/build';
import { PEAKS_VERSION, serializePeaks } from '../../workers/render/peaks/codec';
import { requiredInputRange, resampleRange } from '../../workers/render/codec/resample';
import { paths } from '../fs/paths';
import { fileSize, readArrayBuffer, removeFile, writeArrayBuffer } from '../fs/io';
import { openWavWriter } from '../fs/wav-file';
import { logger } from '../../utils/logger';

export type ProjectSampleRate = 16000 | 22050 | 44100;

export type ImportStage = 'read' | 'decode' | 'process' | 'peaks' | 'done';

export interface ImportOptions {
  srcPath: string;
  projectSampleRate: ProjectSampleRate;
  projectChannels: 1 | 2;
  assetId: Id;
  name?: string;
  origin?: Asset['origin'];
  onProgress?: (stage: ImportStage, ratio: number) => void;
}

export interface ImportResult {
  asset: Asset;
  /** 声道处理方式，UI 可据此提示（如"已转为单声道"）。 */
  channelConversion: 'none' | 'upmix' | 'downmix';
  /** 是否发生了采样率转换。 */
  resampled: boolean;
  elapsedMs: number;
}

export type ImportErrorCode =
  | 'readFailed'
  | 'decodeFailed'
  | 'tooLong'
  | 'tooLarge'
  | 'writeFailed'
  | 'cancelled';

/** 带用户可读文案的导入错误（AGENTS §6.1：失败路径要有文案与可执行动作）。 */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly action: 'chooseFile' | 'retry' | 'shorten' | 'none';

  constructor(code: ImportErrorCode, message: string, action: ImportError['action'] = 'none') {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.action = action;
  }
}

interface DecodedSource {
  sampleRate: number;
  channels: number;
  durationSec: number;
  frames: number;
  channelData: Float32Array[];
}

interface AudioBufferLike {
  sampleRate: number;
  numberOfChannels: number;
  duration: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

/** 用结构断言调用 decodeAudioData：平台类型定义未覆盖其回调签名。 */
function decodeAudioData(context: unknown, data: ArrayBuffer): Promise<AudioBufferLike> {
  const target = context as {
    decodeAudioData: (
      audioData: ArrayBuffer,
      success: (buffer: AudioBufferLike) => void,
      fail: (error: unknown) => void,
    ) => void;
  };
  return new Promise((resolve, reject) => {
    target.decodeAudioData(data, (buffer) => resolve(buffer), (error) => reject(error));
  });
}

/** 串行队列：确保同一时刻只有一个解码任务（内存红线）。 */
let importChain: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = importChain.then(task, task);
  importChain = result.catch(() => undefined);
  return result;
}

/** 目标声道需要的源声道与权重：单声道上混为复制，立体声下混为等权平均。 */
export function sourceMixesForTarget(
  sourceChannels: number,
  targetChannels: 1 | 2,
  targetChannel: number,
): Array<{ index: number; weight: number }> {
  if (sourceChannels <= 1) return [{ index: 0, weight: 1 }];
  if (targetChannels === 2) return [{ index: Math.min(targetChannel, sourceChannels - 1), weight: 1 }];

  // 立体声（或更多声道）下混为单声道：取前两个声道等权平均，避免削波
  return [
    { index: 0, weight: 0.5 },
    { index: 1, weight: 0.5 },
  ];
}

/** 把某个目标声道在 `[outStart, outStart + outCount)` 的输出帧写入 `target`。 */
function renderChannelInto(
  source: DecodedSource,
  targetChannel: number,
  targetChannels: 1 | 2,
  targetRate: number,
  outStart: number,
  outCount: number,
  target: Float32Array,
): void {
  target.fill(0, 0, outCount);
  const mixes = sourceMixesForTarget(source.channels, targetChannels, targetChannel);

  for (const mix of mixes) {
    const data = source.channelData[mix.index];
    if (!data || mix.weight === 0) continue;

    if (targetRate === source.sampleRate) {
      for (let i = 0; i < outCount; i++) {
        const index = outStart + i;
        const value = index >= 0 && index < data.length ? (data[index] ?? 0) : 0;
        target[i] = (target[i] ?? 0) + value * mix.weight;
      }
      continue;
    }

    const need = requiredInputRange(source.sampleRate, targetRate, outStart, outCount);
    const end = Math.min(need.startFrame + need.frameCount, data.length);
    const slice = data.subarray(need.startFrame, Math.max(need.startFrame, end));
    const resampled = resampleRange(slice, source.sampleRate, targetRate, {
      inputStartFrame: need.startFrame,
      outStart,
      outCount,
    });
    for (let i = 0; i < outCount; i++) {
      target[i] = (target[i] ?? 0) + (resampled[i] ?? 0) * mix.weight;
    }
  }
}

async function decodeSource(srcPath: string, onReadBytes: (bytes: number) => void): Promise<DecodedSource> {
  const bytes = await fileSize(srcPath);
  onReadBytes(bytes);

  const context = wx.createWebAudioContext();
  try {
    const data = await readArrayBuffer(srcPath);
    const audio = await decodeAudioData(context, data);
    const channelData: Float32Array[] = [];
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      channelData.push(audio.getChannelData(channel));
    }
    return {
      sampleRate: audio.sampleRate,
      channels: audio.numberOfChannels,
      durationSec: audio.duration,
      frames: audio.length,
      channelData,
    };
  } finally {
    // 上下文只用于解码：数据已通过 getChannelData 取出，这里可以安全关闭
    void Promise.resolve((context as { close?: () => Promise<void> }).close?.()).catch(() => undefined);
  }
}

/** 由 level0 数据构建完整金字塔（逐级合并）。 */
function buildLevelsFromLevel0(level0: Int16Array): PeaksLevel[] {
  const levels: PeaksLevel[] = [];
  if (level0.length === 0) return levels;

  levels.push({ bucketSize: BASE_BUCKET, count: level0.length >> 1, data: level0 });
  while ((levels[levels.length - 1]?.count ?? 0) > 1) {
    const lower = levels[levels.length - 1];
    if (!lower) break;
    const data = buildUpperLevel(lower.data);
    const count = data.length >> 1;
    if (count === 0 || count >= lower.count) break;
    levels.push({ bucketSize: lower.bucketSize * 2, count, data });
  }
  return levels;
}

async function doImport(options: ImportOptions): Promise<ImportResult> {
  const startedAt = Date.now();
  const { srcPath, projectSampleRate, projectChannels, assetId } = options;
  const report = (stage: ImportStage, ratio: number): void => options.onProgress?.(stage, ratio);

  report('read', 0);
  let source: DecodedSource;
  try {
    source = await decodeSource(srcPath, (bytes) => report('read', bytes > 0 ? 1 : 0));
  } catch {
    throw new ImportError(
      'decodeFailed',
      '该格式暂不支持，可先转为 WAV 或 MP3 再导入',
      'chooseFile',
    );
  }

  if (source.durationSec > MAX_ASSET_DURATION_SEC) {
    throw new ImportError(
      'tooLong',
      `音频时长 ${source.durationSec.toFixed(0)} 秒，超过 ${MAX_ASSET_DURATION_SEC / 60} 分钟上限，请先裁剪`,
      'shorten',
    );
  }

  const decodedBytes = source.frames * source.channels * 4;
  if (decodedBytes > MAX_DECODED_BYTES) {
    throw new ImportError(
      'tooLarge',
      '音频过长导致解码内存超限，请改用更低的采样率或先裁剪',
      'shorten',
    );
  }

  const channelConversion: ImportResult['channelConversion'] =
    source.channels === projectChannels ? 'none' : source.channels > projectChannels ? 'downmix' : 'upmix';
  const resampled = source.sampleRate !== projectSampleRate;

  const outFrames = Math.max(1, Math.round(source.durationSec * projectSampleRate));
  const assetPath = paths.asset(assetId);
  const peaksPath = paths.peaks(assetId);

  report('process', 0);
  const writer = await openWavWriter(assetPath, {
    sampleRate: projectSampleRate,
    channels: projectChannels,
    estimatedFrames: outFrames,
  });

  const accumulators = Array.from({ length: projectChannels }, () => new Level0Accumulator(BASE_BUCKET));
  const chunkFrames = Math.max(1, Math.round(PROCESS_CHUNK_SEC * projectSampleRate));
  const floatChannels = Array.from({ length: projectChannels }, () => new Float32Array(chunkFrames));
  const int16Channels = Array.from({ length: projectChannels }, () => new Int16Array(chunkFrames));
  const interleaved = new Int16Array(chunkFrames * projectChannels);

  try {
    for (let outStart = 0; outStart < outFrames; outStart += chunkFrames) {
      const outCount = Math.min(chunkFrames, outFrames - outStart);

      for (let channel = 0; channel < projectChannels; channel++) {
        const floatBuffer = floatChannels[channel];
        if (!floatBuffer) continue;
        renderChannelInto(source, channel, projectChannels, projectSampleRate, outStart, outCount, floatBuffer);

        // 同一趟里完成：削波保护 → Int16 → 峰值累计 → 交错写盘的数据准备
        const int16Buffer = int16Channels[channel];
        for (let i = 0; i < outCount; i++) {
          const value = floatBuffer[i] ?? 0;
          const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
          const sample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
          if (int16Buffer) int16Buffer[i] = sample;
          interleaved[i * projectChannels + channel] = sample;
        }
        if (int16Buffer) accumulators[channel]?.push(int16Buffer.subarray(0, outCount));
      }

      await writer.write(interleaved.subarray(0, outCount * projectChannels));
      report('process', (outStart + outCount) / outFrames);
    }

    await writer.finalize();
  } catch {
    await writer.abort().catch(() => undefined);
    throw new ImportError('writeFailed', '写入素材文件失败，请检查存储空间后重试', 'retry');
  }

  // 峰值金字塔：逐声道构建并落盘
  report('peaks', 0);
  let levelsPerChannel: PeaksLevel[][] = [];
  try {
    levelsPerChannel = accumulators.map((accumulator) => buildLevelsFromLevel0(accumulator.finish()));
    await writeArrayBuffer(
      peaksPath,
      serializePeaks({
        version: PEAKS_VERSION,
        channels: projectChannels,
        baseBucket: BASE_BUCKET,
        levels: levelsPerChannel,
      }),
    );
  } catch (error) {
    logger.warn('import', 'peaks build failed', error);
    await removeFile(peaksPath).catch(() => undefined);
    levelsPerChannel = [];
  }

  // 释放音频缓冲引用，便于 GC 回收（大块内存的主要来源）
  source.channelData = [];

  const levelsMeta: PeakRef['levels'] = (levelsPerChannel[0] ?? []).map((level) => ({
    bucketSize: level.bucketSize,
    count: level.count,
  }));

  const asset: Asset = {
    id: assetId,
    name: options.name ?? '导入音频',
    origin: options.origin ?? 'local',
    path: paths.relative.asset(assetId),
    sampleRate: projectSampleRate,
    channels: projectChannels,
    durationSec: outFrames / projectSampleRate,
    frames: outFrames,
    bytes: 44 + outFrames * projectChannels * 2,
    peakRef: { path: paths.relative.peaks(assetId), levels: levelsMeta },
    createdAt: Date.now(),
  };

  report('done', 1);

  return {
    asset,
    channelConversion,
    resampled,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 导入一个音频文件为工程素材（标准 WAV + 峰值金字塔）。
 *
 * 同一时刻只执行一个导入；失败时清理半成品文件并抛出 `ImportError`。
 */
export function importAudio(options: ImportOptions): Promise<ImportResult> {
  return runExclusive(() => doImport(options));
}
