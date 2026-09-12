/**
 * 淡入 / 淡出包络。纯函数。
 *
 * - `linear`：增益 = t
 * - `equalPower`：淡入 = `sin(π/2·t)`，淡出 = `cos(π/2·t)`
 *
 * 拼接与交叉淡化默认用等功率曲线：两条等功率曲线相加功率恒定，听感上无音量凹陷；
 * 线性曲线在交叉点会凹陷约 -6dB。
 */
import type { FadeSpec } from '../../../core/types';

export type FadeCurve = 'linear' | 'equalPower';

const HALF_PI = Math.PI / 2;

/**
 * 归一化位置 `t ∈ [0, 1]` 处的包络增益。
 * `t` 会被 clamp；非有限值按 0 处理。
 */
export function fadeGainAt(t: number, curve: FadeCurve, direction: 'in' | 'out'): number {
  if (!Number.isFinite(t)) return 0;
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  if (curve === 'linear') {
    return direction === 'in' ? x : 1 - x;
  }
  return direction === 'in' ? Math.sin(HALF_PI * x) : Math.cos(HALF_PI * x);
}

/** 由 `FadeSpec` 求采样数（`durationSec` 只在此处换算成帧，AGENTS §2.3）。 */
export function fadeSamplesFromSpec(spec: FadeSpec, sampleRate: number): number {
  if (!Number.isFinite(spec.durationSec) || spec.durationSec <= 0) return 0;
  return Math.round(spec.durationSec * sampleRate);
}

/**
 * 就地对 `buf[startSample, startSample + fadeSamples)` 施加淡入（首采样增益 0）。
 * **in-place**；区间自动 clamp 到缓冲范围。
 *
 * @param fadeSamples 淡入长度（采样帧）；≤ 0 时不做任何事
 */
export function applyFadeInInPlace(
  buf: Float32Array,
  startSample: number,
  fadeSamples: number,
  curve: FadeCurve = 'equalPower',
): void {
  if (!(fadeSamples > 0)) return;
  const start = Math.max(0, Math.min(buf.length, Math.floor(startSample)));
  const count = Math.min(Math.floor(fadeSamples), buf.length - start);
  if (count <= 0) return;

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    buf[start + i] = (buf[start + i] ?? 0) * fadeGainAt(t, curve, 'in');
  }
}

/**
 * 就地对 `buf[endSampleExclusive - fadeSamples, endSampleExclusive)` 施加淡出
 * （末采样增益 0）。**in-place**；区间自动 clamp 到缓冲范围。
 *
 * @param fadeSamples 淡出长度（采样帧）；≤ 0 时不做任何事
 */
export function applyFadeOutInPlace(
  buf: Float32Array,
  endSampleExclusive: number,
  fadeSamples: number,
  curve: FadeCurve = 'equalPower',
): void {
  if (!(fadeSamples > 0)) return;
  const end = Math.max(0, Math.min(buf.length, Math.floor(endSampleExclusive)));
  const count = Math.min(Math.floor(fadeSamples), end);
  if (count <= 0) return;

  const start = end - count;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 1 : i / (count - 1);
    buf[start + i] = (buf[start + i] ?? 0) * fadeGainAt(t, curve, 'out');
  }
}
