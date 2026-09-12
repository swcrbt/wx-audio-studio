/**
 * 导出规划：把工程与导出选项算成可直接交给渲染引擎的参数。
 *
 * 归一化需要"先知道有多响，再决定增益"，而渲染是流式写盘（不能回头改已写的数据），
 * 因此这里用**峰值金字塔**估算工程峰值：金字塔已经存在，读它比先渲染一遍便宜两个数量级。
 * 估算只考虑片段增益与轨道增益（忽略淡入淡出——它只会降低峰值，忽略是安全的近似），
 * 限制器负责托住残余的峰值误差。
 *
 * 本模块是纯计算（峰值由调用方读好后注入），因此可单测。
 */
import type { Edl, Id, Seconds, TimeRange } from '../types';
import { assetById, edlDurationSec, isTrackAudible, tracksByOrder } from '../../workers/render/edl/query';
import { dbToLinear, linearToDb } from '../../workers/render/dsp/gain';
import { estimateWavFileSize } from '../../workers/render/dsp/analyze';
import type { PeaksLevel } from '../../workers/render/peaks/build';
import { MAX_FILE_BYTES, STORAGE_QUOTA_BYTES } from '../../workers/render/constants';

/** 归一化目标峰值。 */
export const NORMALIZE_TARGET_DB = -1;
/** 归一化增益上限：素材极轻时与其硬拉到目标，不如保留动态并提示用户。 */
export const MAX_NORMALIZE_GAIN_DB = 24;

export interface ExportOutput {
  sampleRate: 16000 | 22050 | 44100;
  channels: 1 | 2;
}

export interface ExportPlanInput {
  edl: Edl;
  /** 各素材的峰值金字塔（缺失的素材会被跳过并在 `warnings` 里提示）。 */
  peaksByAsset: ReadonlyMap<Id, PeaksLevel[]>;
  output: ExportOutput;
  /** 是否归一化到 `NORMALIZE_TARGET_DB`，默认 true。 */
  normalize?: boolean;
  /** 是否挂总线限制器，默认 true。 */
  limiter?: boolean;
  /** 导出区间，默认整段。 */
  range?: TimeRange;
}

export interface ExportPlan {
  range: TimeRange;
  output: ExportOutput;
  limiter: boolean;
  /** 总线增益（dB），交给 `RenderJob.busGainDb`。 */
  busGainDb: number;
  /** 估算出的工程峰值（dBFS）；`null` 表示没有峰值数据、无法估算。 */
  estimatedPeakDb: number | null;
  /** 是否真的应用了归一化增益。 */
  normalizeApplied: boolean;
  durationSec: Seconds;
  estimatedBytes: number;
  /** 用户可读的提示（体积、缺失峰值等）。 */
  warnings: string[];
  /** `true` 表示超过平台单文件上限，UI 应禁用导出。 */
  blocked: boolean;
}

/**
 * 由峰值金字塔估算工程峰值（dBFS）。
 *
 * 多轨取各轨最大值而非求和：不同轨的峰值通常不在同一时刻出现，求和会过度低估响度；
 * 个别同时到顶的情况交给限制器处理。
 *
 * @returns `null` 表示工程里没有任何可用峰值数据
 */
export function estimatePeakFromPeaks(
  edl: Edl,
  peaksByAsset: ReadonlyMap<Id, PeaksLevel[]>,
): number | null {
  let maxAbs = 0;

  for (const track of tracksByOrder(edl)) {
    if (!isTrackAudible(edl, track)) continue;
    const trackGain = dbToLinear(track.gainDb);

    for (const clip of track.clips) {
      const level0 = peaksByAsset.get(clip.assetId)?.[0];
      const asset = assetById(edl, clip.assetId);
      if (!level0 || !asset || level0.count <= 0) continue;

      const clipGain = dbToLinear(clip.gainDb);
      const bucketSize = level0.bucketSize;
      const firstBucket = Math.max(0, Math.floor((clip.sourceStart * asset.sampleRate) / bucketSize));
      const lastBucket = Math.min(
        level0.count - 1,
        Math.ceil((clip.sourceEnd * asset.sampleRate) / bucketSize),
      );

      for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
        const min = (level0.data[bucket * 2] ?? 0) / 32768;
        const max = (level0.data[bucket * 2 + 1] ?? 0) / 32768;
        const effective = Math.max(Math.abs(min), Math.abs(max)) * clipGain * trackGain;
        if (effective > maxAbs) maxAbs = effective;
      }
    }
  }

  return maxAbs > 0 ? linearToDb(maxAbs) : null;
}

export function planExport(input: ExportPlanInput): ExportPlan {
  const { edl, peaksByAsset, output } = input;
  const durationSec = edlDurationSec(edl);
  const range = clampRange(input.range ?? { startSec: 0, endSec: durationSec }, durationSec);
  const rangeSec = Math.max(0, range.endSec - range.startSec);

  const normalize = input.normalize !== false;
  const estimatedPeakDb = normalize ? estimatePeakFromPeaks(edl, peaksByAsset) : null;

  let busGainDb = 0;
  if (normalize && estimatedPeakDb !== null && Number.isFinite(estimatedPeakDb)) {
    const needed = NORMALIZE_TARGET_DB - estimatedPeakDb;
    // 已经达到或超过目标：不衰减（衰减是用户用音量工具该做的事）
    if (needed > 0.05) busGainDb = Math.min(MAX_NORMALIZE_GAIN_DB, needed);
  }

  const estimatedBytes = estimateWavFileSize(rangeSec, output.sampleRate, output.channels);
  const warnings: string[] = [];
  let blocked = false;

  if (rangeSec <= 0) {
    warnings.push('工程还没有内容，先录音或导入素材');
    blocked = true;
  }
  if (estimatedBytes > MAX_FILE_BYTES) {
    warnings.push(
      `预估体积 ${(estimatedBytes / 1024 / 1024).toFixed(0)}MB 超过单文件 100MB 上限，请缩短时长或降低采样率`,
    );
    blocked = true;
  } else if (estimatedBytes > STORAGE_QUOTA_BYTES / 4) {
    warnings.push(`预估体积 ${(estimatedBytes / 1024 / 1024).toFixed(0)}MB，注意本机存储余量`);
  }
  if (normalize && estimatedPeakDb === null) {
    warnings.push('缺少波形数据，本次导出未应用归一化');
  }
  if (normalize && busGainDb >= MAX_NORMALIZE_GAIN_DB) {
    warnings.push(`音频整体偏轻，归一化已到上限 +${MAX_NORMALIZE_GAIN_DB}dB`);
  }

  return {
    range,
    output,
    limiter: input.limiter !== false,
    busGainDb,
    estimatedPeakDb,
    normalizeApplied: busGainDb !== 0,
    durationSec: rangeSec,
    estimatedBytes,
    warnings,
    blocked,
  };
}

function clampRange(range: TimeRange, durationSec: Seconds): TimeRange {
  const startSec = Math.max(0, Math.min(range.startSec, range.endSec, durationSec));
  const endSec = Math.max(startSec, Math.min(Math.max(range.startSec, range.endSec), durationSec));
  return { startSec, endSec };
}
