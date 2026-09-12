/**
 * 采样率转换（windowed-sinc 多相重采样）。纯函数，不修改输入。
 *
 * 实现要点：
 * 1. 截止频率取 `min(1, toRate/fromRate) × 0.5 × 0.94`（0.94 留过渡带，避免镜像折叠）；
 * 2. 每个输出采样在源位置 ±halfTaps 范围内做 sinc × Hann 窗加权求和；
 *    抽头数按比值选择：2:1 用 31 抽头半带 FIR，其他比例用 63 抽头；
 * 3. 权重和归一化 → 直流增益恒为 1，不引入电平漂移。
 */

/** 2:1 比例时使用的抽头数（半带 FIR，31 抽头，docs/03 §6.4）。 */
const HALF_BAND_TAPS = 31;
/** 其他比例时的抽头数（质量更高，代价线性增长）。 */
const GENERAL_TAPS = 63;
/** 过渡带系数：截止频率取 Nyquist 的 94%，给滤波器留过渡带。 */
const CUTOFF_SCALE = 0.94;

function hann(x: number): number {
  // x ∈ [-1, 1] → Hann 窗（半宽归一化）
  return 0.5 + 0.5 * Math.cos(Math.PI * x);
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * 多相相位数量：把小数部分的偏移量化成该数量的相位（512 时幅度误差 < 0.1%，
 * 但把“每个输出采样算一遍 sinc/cos”变成“查表 + 乘加”）。
 */
const POLYPHASE_COUNT = 512;

/** 预计算表缓存：key = `taps:cutoff:phases`，避免每次重采样重建滤波器。 */
const tableCache = new Map<string, Float32Array>();

/**
 * 构建多相滤波器表：`table[phase × taps + k]`。
 * 每个相位的权重已归一化（直流增益为 1），运行时不再需要除权重和。
 */
function polyphaseTable(taps: number, cutoff: number, phases: number): Float32Array {
  const key = `${taps}:${cutoff}:${phases}`;
  const cached = tableCache.get(key);
  if (cached) return cached;

  const half = Math.floor(taps / 2);
  const table = new Float32Array(phases * taps);

  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const distance = k - half - frac;
      const normalized = distance / half;
      const weight =
        Math.abs(normalized) <= 1 ? 2 * cutoff * sinc(2 * cutoff * distance) * hann(normalized) : 0;
      table[p * taps + k] = weight;
      sum += weight;
    }
    if (sum !== 0) {
      for (let k = 0; k < taps; k++) {
        table[p * taps + k] = (table[p * taps + k] ?? 0) / sum;
      }
    }
  }

  tableCache.set(key, table);
  return table;
}

/** 选择合适的多相抽头数（2:1 用半带，其余用通用长度）。 */
export function tapsForRates(fromRate: number, toRate: number): number {
  const ratio = fromRate / toRate;
  if (Math.abs(ratio - 2) < 1e-9 || Math.abs(ratio - 0.5) < 1e-9) return HALF_BAND_TAPS;
  return GENERAL_TAPS;
}

/** 输出帧数（按比值四舍五入，保证与输入时长一致）。 */
export function outputFrameCount(inputFrames: number, fromRate: number, toRate: number): number {
  if (!(fromRate > 0) || !(toRate > 0)) return 0;
  return Math.max(0, Math.round((inputFrames * toRate) / fromRate));
}

/**
 * 单声道重采样。**不修改输入**，返回新缓冲。
 *
 * @param input 输入采样（[-1, 1] 量纲）
 * @param fromRate 输入采样率（Hz）
 * @param toRate 输出采样率（Hz）；与输入相同时直接返回输入副本
 */
export function resampleMono(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  if (!(fromRate > 0) || !(toRate > 0)) return new Float32Array(0);
  if (fromRate === toRate) return Float32Array.from(input);

  const outFrames = outputFrameCount(input.length, fromRate, toRate);
  const out = new Float32Array(outFrames);
  const taps = tapsForRates(fromRate, toRate);
  const halfTaps = Math.floor(taps / 2);
  const ratio = fromRate / toRate;
  const cutoff = (toRate > fromRate ? 0.5 : 0.5 * (toRate / fromRate)) * CUTOFF_SCALE;
  const table = polyphaseTable(taps, cutoff, POLYPHASE_COUNT);

  for (let n = 0; n < outFrames; n++) {
    const srcPos = n * ratio;
    const base = Math.floor(srcPos);

    // 靠近两端时滤波器会越界：退回精确卷积（按有效权重归一化），避免边缘幅度塌陷
    if (base - halfTaps < 0 || base + halfTaps >= input.length) {
      let sum = 0;
      let weightSum = 0;
      for (let k = -halfTaps; k <= halfTaps; k++) {
        const index = base + k;
        if (index < 0 || index >= input.length) continue;
        const distance = srcPos - index;
        const normalized = distance / halfTaps;
        if (normalized < -1 || normalized > 1) continue;
        const weight = 2 * cutoff * sinc(2 * cutoff * distance) * hann(normalized);
        sum += (input[index] ?? 0) * weight;
        weightSum += weight;
      }
      out[n] = weightSum !== 0 ? sum / weightSum : 0;
      continue;
    }

    const frac = srcPos - base;
    const phase = Math.min(POLYPHASE_COUNT - 1, Math.round(frac * POLYPHASE_COUNT));
    const row = phase * taps;
    const start = base - halfTaps;

    let sum = 0;
    for (let k = 0; k < taps; k++) {
      sum += (input[start + k] ?? 0) * (table[row + k] ?? 0);
    }
    out[n] = sum;
  }

  return out;
}

/**
 * 交错多声道重采样。
 *
 * @param input 交错采样（`[L0, R0, L1, R1, …]`）
 * @param channels 声道数
 * @returns 交错结果（长度 = 输出帧数 × 声道数）
 */
export function resampleInterleaved(
  input: Float32Array,
  channels: number,
  fromRate: number,
  toRate: number,
): Float32Array {
  const ch = Math.max(1, Math.floor(channels));
  if (input.length === 0 || ch === 1) {
    if (ch === 1) return resampleMono(input, fromRate, toRate);
    return new Float32Array(0);
  }

  const inFrames = Math.floor(input.length / ch);
  const out = new Float32Array(outputFrameCount(inFrames, fromRate, toRate) * ch);
  const outFrames = Math.floor(out.length / ch);

  const channelBuffer = new Float32Array(inFrames);
  for (let c = 0; c < ch; c++) {
    for (let i = 0; i < inFrames; i++) channelBuffer[i] = input[i * ch + c] ?? 0;
    const resampled = resampleMono(channelBuffer, fromRate, toRate);
    for (let i = 0; i < outFrames; i++) out[i * ch + c] = resampled[i] ?? 0;
  }

  return out;
}

/** Int16 交错 → 重采样 → Int16 交错（导入/导出管线的便捷组合，单位为 16bit）。 */
export function resampleInt16(
  input: Int16Array,
  channels: number,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (fromRate === toRate) return Int16Array.from(input);
  const ch = Math.max(1, Math.floor(channels));
  const floats = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = input[i] ?? 0;
    floats[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  const resampled = resampleInterleaved(floats, ch, fromRate, toRate);
  const out = new Int16Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    const s = resampled[i] ?? 0;
    const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}
