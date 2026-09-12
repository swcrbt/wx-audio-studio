/**
 * 总线限制器：前瞻 + 平滑增益 + 硬限幅（docs/03 §6.3）。
 *
 * 算法（离线渲染专用，允许"看到未来"）：
 * 1. 对每个采样求其**前瞻窗口内**的最大绝对值 `windowPeak[i]`（O(n) 滑动窗口最大值）；
 * 2. 目标增益 `gainTarget[i] = min(1, ceiling / windowPeak[i])`；
 * 3. 增益包络：下降（attack）立即、上升（release）指数恢复；
 * 4. `y[i] = x[i] × gain[i]`。
 *
 * 为什么这样能保证不超 ceiling：`gain[i] ≤ ceiling / windowPeak[i]`，
 * 而 `|x[i]| ≤ windowPeak[i]`，故 `|y[i]| ≤ ceiling`。
 */
import { dbToLinear } from './gain';

export interface LimiterOptions {
  sampleRate: number;
  /** 限幅上限，默认 -0.3dBFS（docs/03 §2：为 16bit 编码留余量）。 */
  ceilingDb?: number;
  /** 前瞻时间，默认 10ms（docs/03 §6.3）。 */
  lookaheadMs?: number;
  /** 恢复时间，默认 80ms。 */
  releaseMs?: number;
}

export interface LimiterResult {
  /** 过程中观测到的输入峰值（线性）。 */
  inputPeak: number;
  /** 过程中观测到的输出峰值（线性）。 */
  outputPeak: number;
  /** 被压缩的采样数（增益 < 1 的采样数）。 */
  limitedSamples: number;
}

const DEFAULT_CEILING_DB = -0.3;
const DEFAULT_LOOKAHEAD_MS = 10;
const DEFAULT_RELEASE_MS = 80;

/**
 * 就地对缓冲做限制。**in-place**。
 *
 * @returns 峰值统计；当 `buf` 为空或全零时返回零值统计
 */
export function applyLimiterInPlace(buf: Float32Array, opts: LimiterOptions): LimiterResult {
  const sampleRate = opts.sampleRate > 0 ? opts.sampleRate : 44100;
  const ceiling = Math.max(1e-6, dbToLinear(opts.ceilingDb ?? DEFAULT_CEILING_DB));
  const lookaheadSamples = Math.max(
    1,
    Math.round(((opts.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS) / 1000) * sampleRate),
  );
  const releaseSamples = Math.max(
    1,
    Math.round(((opts.releaseMs ?? DEFAULT_RELEASE_MS) / 1000) * sampleRate),
  );
  const releaseCoef = Math.exp(-1 / releaseSamples);

  const length = buf.length;
  if (length === 0) return { inputPeak: 0, outputPeak: 0, limitedSamples: 0 };

  // 输入峰值与绝对值
  const absValues = new Float32Array(length);
  let inputPeak = 0;
  for (let i = 0; i < length; i++) {
    const v = Math.abs(buf[i] ?? 0);
    absValues[i] = v;
    if (v > inputPeak) inputPeak = v;
  }

  // 滑动窗口最大值（前缀/后缀分块法，O(n)）
  const windowPeak = new Float32Array(length);
  const blockSize = lookaheadSamples;
  const suffix = new Float32Array(length);
  const prefix = new Float32Array(length);

  for (let blockStart = 0; blockStart < length; blockStart += blockSize) {
    const blockEnd = Math.min(blockStart + blockSize, length);
    let max = 0;
    for (let i = blockStart; i < blockEnd; i++) {
      const v = absValues[i] ?? 0;
      if (v > max) max = v;
      prefix[i] = max;
    }
    max = 0;
    for (let i = blockEnd - 1; i >= blockStart; i--) {
      const v = absValues[i] ?? 0;
      if (v > max) max = v;
      suffix[i] = max;
    }
  }

  for (let i = 0; i < length; i++) {
    const windowEnd = Math.min(length - 1, i + blockSize - 1);
    const a = suffix[i] ?? 0;
    const b = prefix[windowEnd] ?? 0;
    windowPeak[i] = a > b ? a : b;
  }

  // 增益包络与限幅
  let gain = 1;
  let outputPeak = 0;
  let limitedSamples = 0;
  for (let i = 0; i < length; i++) {
    const peak = windowPeak[i] ?? 0;
    const target = peak > ceiling ? ceiling / peak : 1;
    if (target < gain) {
      gain = target; // attack 立即
    } else {
      gain = target + (gain - target) * releaseCoef; // release 指数恢复
    }
    if (gain < 1 - 1e-6) limitedSamples++;

    const y = (buf[i] ?? 0) * gain;
    // 硬限幅兜底：浮点误差不应让输出越过 ceiling
    const clamped = y > ceiling ? ceiling : y < -ceiling ? -ceiling : y;
    buf[i] = clamped;
    const abs = Math.abs(clamped);
    if (abs > outputPeak) outputPeak = abs;
  }

  return { inputPeak, outputPeak, limitedSamples };
}
