/**
 * 按视口从峰值金字塔取点。
 *
 * 输出为归一化到 [-1, 1] 的 `Float32Array`，每像素两个值：`[min0, max0, min1, max1, …]`，
 * 画布层直接用它在每像素画一条竖线。
 */
import type { PeaksLevel } from './build';

/** Int16 → [-1, 1]。用 32768 做分母，负向满量程精确映射到 -1。 */
const INT16_SCALE = 1 / 32768;

/**
 * 选择绘制用的 level 下标：
 * `samplesPerPixel < 基础桶` 时用 level 0（放大很深，交给前端逐点绘制），
 * 否则取 `floor(log2(samplesPerPixel / baseBucket))` 并 clamp 到最大级。
 */
export function pickLevelIndex(levels: readonly PeaksLevel[], samplesPerPixel: number): number {
  const base = levels[0];
  if (!base) return -1;
  if (!(samplesPerPixel > base.bucketSize)) return 0;
  const idx = Math.floor(Math.log2(samplesPerPixel / base.bucketSize));
  return Math.min(Math.max(idx, 0), levels.length - 1);
}

/**
 * 把 `[fromSample, toSample)` 区间聚合到 `px` 个像素。
 *
 * @param levels 金字塔层级（下标即 level）
 * @param fromSample 视口起始采样帧
 * @param toSample 视口结束采样帧（不含）
 * @param px 视口像素数
 * @param out 输出缓冲，长度需 ≥ `px * 2`（交错 min/max，归一化）
 *
 * 行为约定：非法参数（`px <= 0`、`toSample <= fromSample`、`levels` 为空）时把 `out`
 * 的相关位置置 0，不抛错；超出素材范围的采样按"无数据"处理（该像素输出 0）。
 */
export function samplePeaks(
  levels: readonly PeaksLevel[],
  fromSample: number,
  toSample: number,
  px: number,
  out: Float32Array,
): void {
  const pixelCount = Math.max(0, Math.floor(px));
  const level = levels[pickLevelIndex(levels, (toSample - fromSample) / Math.max(1, pixelCount))];

  if (!level || pixelCount <= 0 || !(toSample > fromSample)) {
    out.fill(0);
    return;
  }

  const samplesPerPixel = (toSample - fromSample) / pixelCount;
  const bucketSize = level.bucketSize;
  const { data, count } = level;

  for (let p = 0; p < pixelCount; p++) {
    const bucketStart = Math.floor((fromSample + p * samplesPerPixel) / bucketSize);
    const bucketEnd = Math.ceil((fromSample + (p + 1) * samplesPerPixel) / bucketSize) - 1;

    const b0 = Math.max(0, Math.min(count - 1, bucketStart));
    const b1 = Math.max(0, Math.min(count - 1, Math.max(bucketStart, bucketEnd)));

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let b = b0; b <= b1; b++) {
      const lo = data[b * 2] ?? 0;
      const hi = data[b * 2 + 1] ?? 0;
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      out[p * 2] = 0;
      out[p * 2 + 1] = 0;
    } else {
      out[p * 2] = min * INT16_SCALE;
      out[p * 2 + 1] = max * INT16_SCALE;
    }
  }
}
