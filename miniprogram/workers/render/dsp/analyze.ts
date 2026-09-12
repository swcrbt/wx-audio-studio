/**
 * 分析与工具函数：峰值、RMS、静音检测、峰值归一化、体积预估。
 * 全部为纯函数；就地修改的函数名带 `InPlace`。
 */
import type { TimeRange } from '../../../core/types';
import { dbToLinear, linearToDb } from './gain';

export interface PeakInfo {
  /** 线性峰值（0～1+）。 */
  peak: number;
  /** 峰值 dBFS；全零时返回 `-Infinity`。 */
  peakDb: number;
}

/** 绝对峰值与 dBFS。 */
export function computePeak(buf: Float32Array): PeakInfo {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const abs = Math.abs(buf[i] ?? 0);
    if (abs > peak) peak = abs;
  }
  return { peak, peakDb: linearToDb(peak) };
}

/** 整体 RMS（线性）。空输入返回 0。 */
export function computeRms(buf: Float32Array): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

/** 整体 RMS（dBFS）。 */
export function computeRmsDb(buf: Float32Array): number {
  return linearToDb(computeRms(buf));
}

export interface SilenceOptions {
  sampleRate: number;
  /** 低于该阈值视为静音，默认 -45dBFS。 */
  thresholdDb?: number;
  /** 最短静音时长，默认 300ms（口播场景的常用值）。 */
  minSilenceMs?: number;
  /** 两端各保留的余量，避免切掉字头，默认 60ms。 */
  padMs?: number;
  /** RMS 分析窗，默认 20ms。 */
  windowMs?: number;
}

const DEFAULT_SILENCE_DB = -45;
const DEFAULT_MIN_SILENCE_MS = 300;
const DEFAULT_PAD_MS = 60;
const DEFAULT_WINDOW_MS = 20;

/**
 * 检测静音区间（自动去停顿）。
 *
 * 实现：按 `windowMs` 分窗求 RMS，低于阈值记为静音窗，合并相邻静音窗；
 * 只保留长度 ≥ `minSilenceMs` 的段，并按 `padMs` 向两侧收缩（保留呼吸声余量）。
 */
export function detectSilence(buf: Float32Array, opts: SilenceOptions): TimeRange[] {
  const sampleRate = opts.sampleRate > 0 ? opts.sampleRate : 44100;
  const threshold = dbToLinear(
    opts.thresholdDb === undefined || !Number.isFinite(opts.thresholdDb)
      ? DEFAULT_SILENCE_DB
      : opts.thresholdDb,
  );
  const windowSamples = Math.max(
    1,
    Math.round(((opts.windowMs ?? DEFAULT_WINDOW_MS) / 1000) * sampleRate),
  );
  const minSilenceSec = (opts.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS) / 1000;
  const padSec = (opts.padMs ?? DEFAULT_PAD_MS) / 1000;

  if (buf.length === 0) return [];

  const ranges: TimeRange[] = [];
  let runStart = -1;

  const windowCount = Math.ceil(buf.length / windowSamples);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSamples;
    const end = Math.min(start + windowSamples, buf.length);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = buf[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    const isSilent = rms < threshold;

    if (isSilent && runStart < 0) runStart = start;
    if (!isSilent && runStart >= 0) {
      pushRange(ranges, runStart, start, sampleRate, minSilenceSec, padSec);
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    pushRange(ranges, runStart, buf.length, sampleRate, minSilenceSec, padSec);
  }

  return ranges;
}

function pushRange(
  out: TimeRange[],
  startSample: number,
  endSample: number,
  sampleRate: number,
  minSilenceSec: number,
  padSec: number,
): void {
  const startSec = startSample / sampleRate + padSec;
  const endSec = endSample / sampleRate - padSec;
  if (endSec - startSec >= minSilenceSec - 2 * padSec && endSec > startSec) {
    out.push({ startSec, endSec });
  }
}

export interface NormalizeResult {
  /** 实际施加的增益（dB）。 */
  appliedGainDb: number;
  /** 归一化前的峰值（线性）。 */
  peakBefore: number;
}

/**
 * 峰值归一化：把峰值拉到 `targetDb`（默认 -1dBFS）。**in-place**。
 *
 * 只做衰减或提升的**统一缩放**，因此不会改变动态；全零输入不做任何处理。
 */
export function normalizePeakInPlace(buf: Float32Array, targetDb = -1): NormalizeResult {
  const { peak } = computePeak(buf);
  if (!(peak > 0)) return { appliedGainDb: 0, peakBefore: 0 };

  const target = dbToLinear(targetDb);
  const gain = target / peak;
  if (!Number.isFinite(gain) || gain === 1) return { appliedGainDb: 0, peakBefore: peak };

  for (let i = 0; i < buf.length; i++) {
    buf[i] = (buf[i] ?? 0) * gain;
  }
  return { appliedGainDb: linearToDb(gain), peakBefore: peak };
}

/**
 * 预估 WAV 文件体积（含 44 字节标准头）。
 * 用于导出前拦截超过平台 100MB 单文件上限的情况。
 */
export function estimateWavFileSize(
  seconds: number,
  sampleRate: number,
  channels: number,
  headerBytes = 44,
): number {
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  return headerBytes + frames * channels * 2;
}

/** 预估 MP3 体积（按 `bitrateKbps` 恒定码率，用于导出前的体积提示）。 */
export function estimateMp3FileSize(seconds: number, bitrateKbps: number): number {
  return Math.max(0, (seconds * bitrateKbps * 1000) / 8);
}
