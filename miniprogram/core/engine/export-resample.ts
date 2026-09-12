/**
 * 渲染后处理：把工程采样率/声道的成品转成用户选择的目标格式。
 *
 * 为什么不在渲染中直接输出目标格式：渲染引擎要求 `output.sampleRate === edl.sampleRate`
 * 且声道与中间格式一致（素材按工程格式存放，不允许混用），因此变采样率与声道变换只能
 * 发生在渲染之后。
 *
 * 实现走"分块读 → 逐声道重采样 → 按声道映射合成 → 交错写"，与导入管线同一套纪律：
 * 任何时刻只有一块 PCM 在内存里；`resampleRange` 的相位由**全局输出索引**决定，
 * 因此分块结果与整段处理一致。声道变换规则与导入时同源（`sourceMixesForTarget`）。
 */
import { requiredInputRange, resampleRange } from '../../workers/render/codec/resample';
import { sourceMixesForTarget } from '../audio/import';
import { openWavWriter, readPcmFrames, readWavMeta, unlinkQuiet } from '../fs/wav-file';
import { logger } from '../../utils/logger';

export interface ProduceOutputOptions {
  srcPath: string;
  dstPath: string;
  targetSampleRate: number;
  /** 目标声道数；缺省沿用源声道数。 */
  targetChannels?: 1 | 2;
  /** 每次处理的输出帧数（默认按 5 秒算）。 */
  chunkFrames?: number;
  onProgress?: (ratio: number) => void;
}

export interface ProduceOutputResult {
  filePath: string;
  bytes: number;
  frames: number;
  sampleRate: number;
  channels: 1 | 2;
  /** 是否真的做了处理（采样率与声道都相同则为 `false`，此时未生成新文件）。 */
  processed: boolean;
}

export async function produceOutputFile(options: ProduceOutputOptions): Promise<ProduceOutputResult> {
  const meta = await readWavMeta(options.srcPath);
  const sourceRate = meta.sampleRate;
  const sourceChannels: 1 | 2 = meta.channels === 2 ? 2 : 1;
  const targetRate = options.targetSampleRate;
  const targetChannels: 1 | 2 = options.targetChannels ?? sourceChannels;

  if (!(targetRate > 0)) throw new Error('目标采样率非法');
  if (targetRate === sourceRate && targetChannels === sourceChannels) {
    return {
      filePath: options.srcPath,
      bytes: meta.fileBytes,
      frames: meta.frames,
      sampleRate: sourceRate,
      channels: sourceChannels,
      processed: false,
    };
  }

  const outFrames = Math.max(1, Math.round(meta.frames * (targetRate / sourceRate)));
  const chunkFrames = Math.max(1, options.chunkFrames ?? Math.round(targetRate * 5));

  const writer = await openWavWriter(options.dstPath, {
    sampleRate: targetRate,
    channels: targetChannels,
    estimatedFrames: outFrames,
  });

  // 源声道重采样后的中间缓冲（复用，不逐块分配）
  const resampledChannels = Array.from({ length: sourceChannels }, () => new Float32Array(chunkFrames));
  const interleaved = new Int16Array(chunkFrames * targetChannels);

  try {
    for (let outStart = 0; outStart < outFrames; outStart += chunkFrames) {
      const outCount = Math.min(chunkFrames, outFrames - outStart);
      const need = requiredInputRange(sourceRate, targetRate, outStart, outCount);
      const srcPcm = await readPcmFrames(meta, need.startFrame, need.frameCount);
      const available = Math.min(need.frameCount, Math.floor(srcPcm.length / sourceChannels));

      for (let channel = 0; channel < sourceChannels; channel++) {
        const target = resampledChannels[channel];
        if (!target) continue;

        const source = new Float32Array(available);
        for (let frame = 0; frame < available; frame++) {
          source[frame] = (srcPcm[frame * sourceChannels + channel] ?? 0) / 32768;
        }

        const resampled = resampleRange(source, sourceRate, targetRate, {
          inputStartFrame: need.startFrame,
          outStart,
          outCount,
        });
        for (let i = 0; i < outCount; i++) target[i] = resampled[i] ?? 0;
      }

      for (let channel = 0; channel < targetChannels; channel++) {
        const mixes = sourceMixesForTarget(sourceChannels, targetChannels, channel);
        for (let i = 0; i < outCount; i++) {
          let value = 0;
          for (const mix of mixes) {
            const source = resampledChannels[mix.index];
            if (source) value += (source[i] ?? 0) * mix.weight;
          }
          const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
          interleaved[i * targetChannels + channel] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        }
      }

      await writer.write(interleaved.subarray(0, outCount * targetChannels));
      options.onProgress?.((outStart + outCount) / outFrames);
    }

    await writer.finalize();
    return {
      filePath: options.dstPath,
      bytes: 44 + writer.dataBytes,
      frames: outFrames,
      sampleRate: targetRate,
      channels: targetChannels,
      processed: true,
    };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    await unlinkQuiet(options.dstPath);
    logger.warn('export', 'produce output failed', error);
    throw error;
  }
}
