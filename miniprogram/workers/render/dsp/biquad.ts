/**
 * Biquad 滤波器（Direct Form I），系数采用 RBJ Audio EQ Cookbook 公式。
 *
 * 参考：Robert Bristow-Johnson, *Audio EQ Cookbook*（业界标准公式集，
 * 见 https://www.w3.org/TR/audio-eq-cookbook/ 。docs/03 §6.2 引用的即为此文）。
 *
 * 纯函数 + 显式状态：同一段音频可以分块调用并把返回的 `BiquadState` 传给下一次，
 * 结果与一次调用完全一致（渲染分块依赖这一点）。
 */
import { linearToDb } from './gain';

/** 归一化后的系数（已除以 a0）。 */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Direct Form I 的延迟状态。 */
export interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/** Q 下限：过小的 Q 会让系数数值爆炸（Q 越大峰越尖）。 */
const MIN_Q = 0.05;
/** 反馈路径加极小量防 denormal 累积（AGENTS §3.2）。 */
const DENORMAL_EPSILON = 1e-20;
/** 截止/中心频率上限系数：不低于 20Hz，不高于 0.45×采样率（避免逼近奈奎斯特）。 */
const MIN_FREQ_HZ = 20;
const MAX_FREQ_RATIO = 0.45;

export function createBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function clampFreq(sampleRate: number, f0: number): number {
  const max = sampleRate * MAX_FREQ_RATIO;
  if (!Number.isFinite(f0)) return max / 2;
  return f0 < MIN_FREQ_HZ ? MIN_FREQ_HZ : f0 > max ? max : f0;
}

/** Q 的合法化：非有限值回落到 Butterworth Q（0.707），过小值提到 `MIN_Q`。 */
function clampQ(q: number): number {
  if (!Number.isFinite(q)) return Math.SQRT1_2;
  return q < MIN_Q ? MIN_Q : q;
}

/** 增益 dB 的合法化：非有限值视为 0dB（直通）。 */
function clampGainDb(gainDb: number): number {
  return Number.isFinite(gainDb) ? gainDb : 0;
}

function normalize(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): BiquadCoeffs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function omega(sampleRate: number, f0: number): number {
  return (2 * Math.PI * clampFreq(sampleRate, f0)) / sampleRate;
}

/**
 * 峰值滤波（Peaking EQ）。
 *
 * `A = 10^(dB/40)`，`w0 = 2π·f0/fs`，`α = sin(w0)/(2Q)`；
 * `b0 = 1+αA, b1 = -2cos(w0), b2 = 1-αA`；`a0 = 1+α/A, a1 = -2cos(w0), a2 = 1-α/A`。
 */
export function peakingCoeffs(
  sampleRate: number,
  f0: number,
  q: number,
  gainDb: number,
): BiquadCoeffs {
  const A = 10 ** (clampGainDb(gainDb) / 40);
  const w0 = omega(sampleRate, f0);
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * clampQ(q));
  return normalize(1 + alpha * A, -2 * cosw, 1 - alpha * A, 1 + alpha / A, -2 * cosw, 1 - alpha / A);
}

/** 高通（默认 Butterworth Q = 0.707）。 */
export function highpassCoeffs(
  sampleRate: number,
  f0: number,
  q = Math.SQRT1_2,
): BiquadCoeffs {
  const w0 = omega(sampleRate, f0);
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * clampQ(q));
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  // RBJ HPF：b2 = (1 + cos w0)/2 = b0（不是 -b0）
  return normalize(b0, b1, b0, 1 + alpha, -2 * cosw, 1 - alpha);
}

/** 低通（默认 Butterworth Q = 0.707）。 */
export function lowpassCoeffs(sampleRate: number, f0: number, q = Math.SQRT1_2): BiquadCoeffs {
  const w0 = omega(sampleRate, f0);
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * clampQ(q));
  const b0 = (1 - cosw) / 2;
  return normalize(b0, 1 - cosw, b0, 1 + alpha, -2 * cosw, 1 - alpha);
}

/** 低架（S = 1 简化）。 */
export function lowShelfCoeffs(
  sampleRate: number,
  f0: number,
  gainDb: number,
  s = 1,
): BiquadCoeffs {
  const A = 10 ** (clampGainDb(gainDb) / 40);
  const w0 = omega(sampleRate, f0);
  const cosw = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.sqrt((A + 1 / A) * (1 / s - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  return normalize(
    A * (A + 1 - (A - 1) * cosw + twoSqrtAAlpha),
    2 * A * (A - 1 - (A + 1) * cosw),
    A * (A + 1 - (A - 1) * cosw - twoSqrtAAlpha),
    A + 1 + (A - 1) * cosw + twoSqrtAAlpha,
    -2 * (A - 1 + (A + 1) * cosw),
    A + 1 + (A - 1) * cosw - twoSqrtAAlpha,
  );
}

/** 高架（S = 1 简化）。 */
export function highShelfCoeffs(
  sampleRate: number,
  f0: number,
  gainDb: number,
  s = 1,
): BiquadCoeffs {
  const A = 10 ** (clampGainDb(gainDb) / 40);
  const w0 = omega(sampleRate, f0);
  const cosw = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.sqrt((A + 1 / A) * (1 / s - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  return normalize(
    A * (A + 1 + (A - 1) * cosw + twoSqrtAAlpha),
    -2 * A * (A - 1 + (A + 1) * cosw),
    A * (A + 1 + (A - 1) * cosw - twoSqrtAAlpha),
    A + 1 - (A - 1) * cosw + twoSqrtAAlpha,
    2 * (A - 1 - (A + 1) * cosw),
    A + 1 - (A - 1) * cosw - twoSqrtAAlpha,
  );
}

/**
 * 就地对缓冲做一次 biquad 滤波。**in-place**。
 *
 * @param state 上一次调用的状态；不传则从零状态开始。**跨块滤波必须传回上次的返回值**
 * @returns 新的滤波器状态
 */
export function biquadInPlace(
  buf: Float32Array,
  c: BiquadCoeffs,
  state?: BiquadState,
): BiquadState {
  let x1 = state ? state.x1 : 0;
  let x2 = state ? state.x2 : 0;
  let y1 = state ? state.y1 : 0;
  let y2 = state ? state.y2 : 0;

  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] ?? 0;
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2 + DENORMAL_EPSILON;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }

  return { x1, x2, y1, y2 };
}

/**
 * 10 段图形 EQ 的中心频率（Hz），见 docs/03 §6.2 与 docs/01 FX-3。
 * Q 取 1.4（段间近似互补覆盖）。
 */
export const EQ10_BANDS_HZ = [
  31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;

export const EQ10_BAND_Q = 1.4;

/** 10 段 EQ 的一条串联链（每段独立状态）。 */
export interface Eq10Chain {
  coeffs: BiquadCoeffs[];
  states: BiquadState[];
}

/** 依据 10 段增益（dB）构建串联 biquad 链。频点为负增益时也会被正确表达。 */
export function createEq10Chain(sampleRate: number, gainsDb: readonly number[]): Eq10Chain {
  const coeffs = EQ10_BANDS_HZ.map((f0, index) =>
    peakingCoeffs(sampleRate, f0, EQ10_BAND_Q, gainsDb[index] ?? 0),
  );
  return { coeffs, states: coeffs.map(() => createBiquadState()) };
}

/** 就地把整条 10 段 EQ 链应用到缓冲。**in-place**；状态写回 `chain.states`。 */
export function applyEq10InPlace(buf: Float32Array, chain: Eq10Chain): void {
  for (let i = 0; i < chain.coeffs.length; i++) {
    const coeffs = chain.coeffs[i];
    if (!coeffs) continue;
    const next = biquadInPlace(buf, coeffs, chain.states[i]);
    chain.states[i] = next;
  }
}

/** 该组增益是否全是 0dB（用于跳过计算）。 */
export function isEq10Flat(gainsDb: readonly number[]): boolean {
  return gainsDb.every((gain) => !Number.isFinite(gain) || Math.abs(gain) < 1e-6);
}

/** 求系数在给定频率处的幅度响应（dB），用于测试与 UI 频响预览。 */
export function magnitudeDbAt(coeffs: BiquadCoeffs, sampleRate: number, freqHz: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  const numRe = coeffs.b0 + coeffs.b1 * cos1 + coeffs.b2 * cos2;
  const numIm = -(coeffs.b1 * sin1 + coeffs.b2 * sin2);
  const denRe = 1 + coeffs.a1 * cos1 + coeffs.a2 * cos2;
  const denIm = -(coeffs.a1 * sin1 + coeffs.a2 * sin2);

  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm);
  if (!(den > 0) || !(num > 0)) return Number.NEGATIVE_INFINITY;
  return linearToDb(num / den);
}
