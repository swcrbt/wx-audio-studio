/**
 * 录音管线：以 PCM 分帧方式流式落盘为标准 WAV。
 *
 * 为什么不直接用平台的 mp3/wav 输出：录音产物需要与中间格式完全一致（44 字节标准头、
 * 16bit PCM），且必须边录边写以免把整段音频留在内存里。因此走 `format: 'PCM'` +
 * `frameSize` 分帧回调，自己拼装 WAV 头并在结束时回填长度。
 *
 * 平台注意点：
 * - `frameSize` 只对 `mp3` / `pcm` 生效；
 * - `encodeBitRate` 与采样率强绑定（44100 对应 64000~320000），配错会直接录音失败；
 * - **PC 微信不支持设置 `sampleRate`**，因此 PC 上无法保证中间格式的采样率，明确拒绝并提示；
 * - `pause/resume` 期间不产生帧，因此时间轴不会出现空隙。
 */
import type { Asset, Id, PeakRef } from '../types';
import { BASE_BUCKET, Level0Accumulator, buildUpperLevel, type PeaksLevel } from '../../workers/render/peaks/build';
import { PEAKS_VERSION, serializePeaks } from '../../workers/render/peaks/codec';
import { paths } from '../fs/paths';
import { removeFile, writeArrayBuffer } from '../fs/io';
import { openWavWriter, type WavWriter } from '../fs/wav-file';
import { logger } from '../../utils/logger';
import { detectCaps } from '../caps';

/** 人声录音默认参数（单声道省内存，44.1k 与主流素材一致）。 */
export const RECORD_SAMPLE_RATE = 44100;
export const RECORD_CHANNELS = 1;
/** 录音码率必须落在采样率对应的合法区间内（44.1k → 64000~320000）。 */
export const RECORD_ENCODE_BIT_RATE = 96000;
/** 分帧大小（KB）。 */
export const RECORD_FRAME_SIZE_KB = 64;
/** 平台录音时长上限（毫秒）。 */
export const RECORD_MAX_DURATION_MS = 600_000;
/** 落盘时长与墙钟时间的允许误差（毫秒）。 */
const MAX_DURATION_DELTA_MS = 50;

export type RecordErrorCode =
  | 'permissionDenied'
  | 'unsupportedPlatform'
  | 'startFailed'
  | 'writeFailed'
  | 'interrupted'
  | 'tooShort';

export class RecordError extends Error {
  readonly code: RecordErrorCode;
  readonly action: 'openSetting' | 'retry' | 'none' | 'mobile';

  constructor(code: RecordErrorCode, message: string, action: RecordError['action'] = 'none') {
    super(message);
    this.name = 'RecordError';
    this.code = code;
    this.action = action;
  }
}

export interface RecordOptions {
  assetId: Id;
  /** 最长录音时长（毫秒），默认平台上限 10 分钟。 */
  maxDurationMs?: number;
  /** 录音支持的输入源（仅 Android 可用的取值会被平台忽略）。 */
  audioSource?: string;
  onProgress?: (progress: RecordProgress) => void;
}

export interface RecordProgress {
  /** 已录帧数（采样帧）。 */
  frames: number;
  /** 收到并落盘的分帧数。 */
  frameCount: number;
  /** 已录时长（秒，按帧数推算，不受暂停影响）。 */
  durationSec: number;
}

export interface RecordingResult {
  asset: Asset;
  frames: number;
  durationSec: number;
  /** 落盘时长与墙钟时间之差（毫秒）：明显偏离说明丢帧或时间基准不同。 */
  durationDeltaMs: number;
  frameCount: number;
  /** 所有分帧的字节数是否一致（除最后一帧）。 */
  frameSizesUniform: boolean;
  interrupted: boolean;
}

function isPcPlatform(): boolean {
  const platform = detectCaps().platform;
  return platform === 'windows' || platform === 'mac' || platform === 'ohos_pc';
}

/** 把平台错误文案映射成可执行动作：授权失败要引导去设置页。 */
function toRecordError(error: unknown): RecordError {
  const message =
    typeof error === 'object' && error !== null
      ? String((error as { errMsg?: string }).errMsg ?? '录音失败')
      : String(error);

  if (/auth|deny|permission/i.test(message)) {
    return new RecordError('permissionDenied', '没有麦克风权限，请在设置中开启后重试', 'openSetting');
  }
  return new RecordError('startFailed', `录音启动失败：${message}`, 'retry');
}

/**
 * 当前活跃录音的回调汇。
 *
 * `RecorderManager` 是全局单例，且**没有 offXxx 解绑接口**，因此全局事件只注册一次，
 * 转发给当前录音；同时它也充当“同一时刻只能有一个录音”的互斥标志。
 */
interface RecorderSink {
  handleFrame(buffer: ArrayBuffer): void;
  handleStop(): void;
  handleError(error: unknown): void;
  handleInterruption(): void;
}

let activeSink: RecorderSink | null = null;
let recorderHandlersAttached = false;

function ensureRecorderHandlers(manager: WechatMiniprogram.RecorderManager): void {
  if (recorderHandlersAttached) return;
  recorderHandlersAttached = true;

  manager.onFrameRecorded((res) => activeSink?.handleFrame(res.frameBuffer));
  manager.onStop(() => activeSink?.handleStop());
  manager.onError((error) => activeSink?.handleError(error));
  manager.onInterruptionBegin(() => activeSink?.handleInterruption());
}

/** 由 level0 数据构建完整金字塔。 */
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

export class Recorder {
  private readonly options: RecordOptions;
  private writer: WavWriter | null = null;
  private accumulator: Level0Accumulator | null = null;
  private readonly pendingFrames: ArrayBuffer[] = [];
  private draining = false;
  private frameCount = 0;
  private frames = 0;
  private frameSizes = new Set<number>();
  private interrupted = false;
  private startedAtMs = 0;
  private pausedTotalMs = 0;
  private pausedAtMs = 0;
  private stopped = false;
  private resolveStop: ((result: RecordingResult) => void) | null = null;
  private rejectStop: ((error: unknown) => void) | null = null;

  constructor(options: RecordOptions) {
    this.options = options;
  }

  /** 开始录音；返回 Promise，在停止（或中断）后以录音结果 resolve。 */
  async start(): Promise<RecordingResult> {
    if (isPcPlatform()) {
      throw new RecordError(
        'unsupportedPlatform',
        'PC 微信不支持指定录音采样率，请在手机上完成录音',
        'mobile',
      );
    }

    const maxDurationMs = Math.min(this.options.maxDurationMs ?? RECORD_MAX_DURATION_MS, RECORD_MAX_DURATION_MS);
    const assetPath = paths.asset(this.options.assetId);

    this.writer = await openWavWriter(assetPath, {
      sampleRate: RECORD_SAMPLE_RATE,
      channels: RECORD_CHANNELS,
      estimatedFrames: Math.round((maxDurationMs / 1000) * RECORD_SAMPLE_RATE),
    });
    this.accumulator = new Level0Accumulator(BASE_BUCKET);

    if (activeSink) {
      throw new RecordError('startFailed', '已有录音在进行中，请先停止当前录音', 'retry');
    }

    const manager = wx.getRecorderManager();
    activeSink = {
      handleFrame: (buffer) => this.handleFrame(buffer),
      handleStop: () => {
        void this.handleStop();
      },
      handleError: (error) => this.handleError(error),
      handleInterruption: () => this.handleInterruption(),
    };
    ensureRecorderHandlers(manager);

    return new Promise<RecordingResult>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
      this.startedAtMs = Date.now();

      const startOptions: WechatMiniprogram.RecorderManagerStartOption = {
        duration: maxDurationMs,
        sampleRate: RECORD_SAMPLE_RATE,
        numberOfChannels: RECORD_CHANNELS,
        encodeBitRate: RECORD_ENCODE_BIT_RATE,
        format: 'PCM',
        frameSize: RECORD_FRAME_SIZE_KB,
      };
      if (this.options.audioSource) {
        startOptions.audioSource = this.options.audioSource as WechatMiniprogram.RecorderManagerStartOption['audioSource'];
      }

      try {
        manager.start(startOptions);
      } catch (error) {
        activeSink = null;
        this.rejectStop?.(toRecordError(error));
      }
    });
  }

  pause(): void {
    if (this.stopped) return;
    this.pausedAtMs = Date.now();
    wx.getRecorderManager().pause();
  }

  resume(): void {
    if (this.stopped || this.pausedAtMs === 0) return;
    this.pausedTotalMs += Date.now() - this.pausedAtMs;
    this.pausedAtMs = 0;
    wx.getRecorderManager().resume();
  }

  /** 主动停止录音（正常结束）。 */
  stop(): void {
    if (this.stopped) return;
    wx.getRecorderManager().stop();
  }

  /** 分帧到达（由全局事件桥转发）。 */
  handleFrame(frameBuffer: ArrayBuffer): void {
    if (this.stopped) return;
    this.frameCount++;
    this.frameSizes.add(frameBuffer.byteLength);
    this.pendingFrames.push(frameBuffer);
    this.frames += frameBuffer.byteLength / 2 / RECORD_CHANNELS;
    this.options.onProgress?.({
      frames: this.frames,
      frameCount: this.frameCount,
      durationSec: this.frames / RECORD_SAMPLE_RATE,
    });
    void this.drain();
  }

  handleError(error: unknown): void {
    if (this.stopped) return;
    this.finishWithError(toRecordError(error));
  }

  /** 被系统抢占（来电、微信通话等）：停止录音并保留已录部分。 */
  handleInterruption(): void {
    if (this.stopped) return;
    this.interrupted = true;
    this.stop();
  }

  /** 串行消费分帧队列：保持写入顺序，且不阻塞录音回调。 */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pendingFrames.length > 0) {
        const frame = this.pendingFrames.shift();
        if (!frame || !this.writer) break;
        const pcm = new Int16Array(frame);
        this.accumulator?.push(pcm);
        await this.writer.write(pcm);
      }
    } catch (error) {
      logger.warn('record', 'frame write failed', error);
      this.finishWithError(new RecordError('writeFailed', '写入录音文件失败，请检查存储空间', 'retry'));
    } finally {
      this.draining = false;
    }
  }

  private async waitForDrain(): Promise<void> {
    while (this.pendingFrames.length > 0 || this.draining) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 录音结束（由全局事件桥转发）：等待分帧写完、回填头、构建峰值。 */
  async handleStop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (activeSink) activeSink = null;

    try {
      await this.waitForDrain();
      await this.writer?.finalize();
    } catch {
      this.finishWithError(new RecordError('writeFailed', '录音文件保存失败', 'retry'));
      return;
    }

    const wallClockMs = Date.now() - this.startedAtMs - this.pausedTotalMs;
    const durationSec = this.frames / RECORD_SAMPLE_RATE;

    if (durationSec <= 0.05) {
      this.finishWithError(new RecordError('tooShort', '录音太短，请至少录制 1 秒', 'retry'));
      return;
    }

    // 峰值金字塔
    let levels: PeaksLevel[] = [];
    const peaksPath = paths.peaks(this.options.assetId);
    try {
      levels = buildLevelsFromLevel0(this.accumulator?.finish() ?? new Int16Array(0));
      await writeArrayBuffer(
        peaksPath,
        serializePeaks({
          version: PEAKS_VERSION,
          channels: RECORD_CHANNELS,
          baseBucket: BASE_BUCKET,
          levels: [levels],
        }),
      );
    } catch (error) {
      logger.warn('record', 'peaks build failed', error);
      await removeFile(peaksPath).catch(() => undefined);
      levels = [];
    }

    const levelsMeta: PeakRef['levels'] = levels.map((level) => ({
      bucketSize: level.bucketSize,
      count: level.count,
    }));

    const frames = Math.round(this.frames);
    const asset: Asset = {
      id: this.options.assetId,
      name: `录音 ${new Date(this.startedAtMs).toLocaleString()}`,
      origin: 'record',
      path: paths.relative.asset(this.options.assetId),
      sampleRate: RECORD_SAMPLE_RATE,
      channels: RECORD_CHANNELS,
      durationSec,
      frames,
      bytes: 44 + frames * RECORD_CHANNELS * 2,
      peakRef: { path: paths.relative.peaks(this.options.assetId), levels: levelsMeta },
      createdAt: Date.now(),
    };

    this.resolveStop?.({
      asset,
      frames,
      durationSec,
      durationDeltaMs: durationSec * 1000 - wallClockMs,
      frameCount: this.frameCount,
      frameSizesUniform: this.frameSizes.size <= 1 || (this.frameSizes.size === 2 && this.frameCount > 1),
      interrupted: this.interrupted,
    });
  }

  private finishWithError(error: RecordError): void {
    if (this.stopped) return;
    this.stopped = true;
    if (activeSink) activeSink = null;
    void this.writer?.abort().catch(() => undefined);
    this.rejectStop?.(error);
  }
}

/**
 * 校验落盘后的录音时长与误差，供 UI 决定是否提示"重录"。
 * 误差来源：分帧丢失、平台时间基准不同、暂停期间的计时差异。
 */
export function isDurationAcceptable(durationDeltaMs: number): boolean {
  return Math.abs(durationDeltaMs) <= MAX_DURATION_DELTA_MS;
}
