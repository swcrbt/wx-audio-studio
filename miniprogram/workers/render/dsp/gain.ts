/**
 * 增益换算与逐采样增益。纯函数（AGENTS §3.1）。
 *
 * 单位约定（AGENTS §2.3）：dB 与线性增益**永不混用**，函数名与参数名必须表明单位。
 */

/**
 * dB → 线性增益：`10^(db/20)`。0dB → 1，-6dB ≈ 0.5012，-60dB ≈ 0.001。
 *
 * 边界约定：`-Infinity` dB = 静音（返回 0）；`NaN` 与 `+Infinity` 视为无意义输入，
 * 按直通（返回 1）处理，避免把 NaN 扩散到整段音频。
 */
export function dbToLinear(db: number): number {
  if (Number.isNaN(db)) return 1;
  if (db === Number.NEGATIVE_INFINITY) return 0;
  if (db === Number.POSITIVE_INFINITY) return 1;
  return 10 ** (db / 20);
}

/**
 * 线性增益 → dB：`20·log10(x)`。`x <= 0` 返回 `-Infinity`（表示静音）。
 * 非有限输入同样返回 `-Infinity`。
 */
export function linearToDb(gainLinear: number): number {
  if (!(gainLinear > 0)) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(gainLinear);
}

const MIN_GAIN_DB = -60;
const MAX_GAIN_DB = 12;

/**
 * 把增益限制到 UI 允许范围（-60dB ～ +12dB，见 docs/05 §2 `Track.gainDb`）。
 * 非有限值按 0dB 处理。
 */
export function clampGainDb(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 0;
  return gainDb < MIN_GAIN_DB ? MIN_GAIN_DB : gainDb > MAX_GAIN_DB ? MAX_GAIN_DB : gainDb;
}

/**
 * 就地把缓冲乘以线性增益。**in-place**（AGENTS §2.4：就地修改必须在函数名标明）。
 *
 * 乘积超出 [-1, 1] 时**不在此处钳制** —— 中间动态留给总线限制器处理（docs/03 §6.6 管线），
 * 提前削波会破坏后续动态处理。
 */
export function applyGainInPlace(buf: Float32Array, gainLinear: number): void {
  if (gainLinear === 1) return;
  if (!Number.isFinite(gainLinear)) return;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = (buf[i] ?? 0) * gainLinear;
  }
}

/** 就地把缓冲乘以 dB 增益（内部换算为线性）。**in-place**。 */
export function applyGainDbInPlace(buf: Float32Array, gainDb: number): void {
  applyGainInPlace(buf, dbToLinear(clampGainDb(gainDb)));
}

/**
 * 就地把缓冲的 `[startSample, endSampleExclusive)` 区间乘以线性增益。**in-place**。
 * 区间会被 clamp 到缓冲范围内；非法区间直接返回。
 */
export function applyGainRangeInPlace(
  buf: Float32Array,
  startSample: number,
  endSampleExclusive: number,
  gainLinear: number,
): void {
  const start = Math.max(0, Math.min(buf.length, Math.floor(startSample)));
  const end = Math.max(start, Math.min(buf.length, Math.floor(endSampleExclusive)));
  if (start === end || !Number.isFinite(gainLinear) || gainLinear === 1) return;
  for (let i = start; i < end; i++) {
    buf[i] = (buf[i] ?? 0) * gainLinear;
  }
}
