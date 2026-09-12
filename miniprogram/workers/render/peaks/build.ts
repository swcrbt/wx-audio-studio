/**
 * 峰值金字塔构建。
 *
 * 每个桶存该区间内 PCM 的 min/max（Int16 交错）；每上一级把下一级的 2 个桶合并为 1 个，
 * 因此 bucketSize 逐级 ×2（level k = `BASE_BUCKET << k`）。
 * 合并只取 min 的较小者与 max 的较大者，相对本级无精度损失。
 */

/** 基础桶大小（采样帧/桶）。 */
export const BASE_BUCKET = 1024;

/** 单级峰值数据。 */
export interface PeaksLevel {
  /** 每个桶覆盖的采样帧数（level k = baseBucket << k）。 */
  bucketSize: number;
  /** 桶数量。 */
  count: number;
  /** `min`/`max` 交错数据，长度恒为 `count * 2`。 */
  data: Int16Array;
}

const INT16_MIN = -32768;
const INT16_MAX = 32767;

/**
 * 构建 level 0：把 `pcm` 按 `baseBucket` 分桶求 min/max。
 * 最后一桶不满时按实际长度处理（不影响正确性）。
 *
 * @returns `min`/`max` 交错数组，长度 `ceil(pcm.length / baseBucket) * 2`；空输入返回空数组
 */
export function buildPeaksLevel0(pcm: Int16Array, baseBucket: number = BASE_BUCKET): Int16Array {
  if (pcm.length === 0) return new Int16Array(0);
  const bucket = Math.max(1, Math.floor(baseBucket));
  const bucketCount = Math.ceil(pcm.length / bucket);
  const out = new Int16Array(bucketCount * 2);

  for (let b = 0; b < bucketCount; b++) {
    const start = b * bucket;
    const end = Math.min(start + bucket, pcm.length);
    let min = INT16_MAX;
    let max = INT16_MIN;
    for (let i = start; i < end; i++) {
      const v = pcm[i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

/**
 * 由下一级合并出上一级：每 2 个桶合 1 个，min 取较小、max 取较大。
 * 桶数为奇数时最后一个桶单独成为一个上级桶（取原值）。
 *
 * @param lower 下一级的 min/max 交错数据
 */
export function buildUpperLevel(lower: Int16Array): Int16Array {
  const lowerCount = lower.length >> 1;
  if (lowerCount === 0) return new Int16Array(0);

  const upperCount = Math.ceil(lowerCount / 2);
  const out = new Int16Array(upperCount * 2);

  for (let b = 0; b < upperCount; b++) {
    const i = b * 4;
    const min0 = lower[i] ?? 0;
    const max0 = lower[i + 1] ?? 0;
    const min1 = i + 3 < lower.length ? (lower[i + 2] ?? 0) : min0;
    const max1 = i + 3 < lower.length ? (lower[i + 3] ?? 0) : max0;
    out[b * 2] = min0 < min1 ? min0 : min1;
    out[b * 2 + 1] = max0 > max1 ? max0 : max1;
  }
  return out;
}

/**
 * level 0 的增量累加器：分块喂入 PCM，边处理边累计桶的 min/max。
 *
 * 用途：导入/录音管线按块处理时不把整段 PCM 留在内存里；结果与 `buildPeaksLevel0` 一致。
 * 每填满一个桶才写一次数组，不存在逐采样分配。
 */
export class Level0Accumulator {
  private readonly bucketSize: number;
  private readonly buckets: number[] = [];
  private currentMin = INT16_MAX;
  private currentMax = INT16_MIN;
  private filled = 0;

  constructor(bucketSize: number = BASE_BUCKET) {
    this.bucketSize = Math.max(1, Math.floor(bucketSize));
  }

  /** 喂入一段 PCM（可以跨桶边界）。 */
  push(pcm: Int16Array): void {
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] ?? 0;
      if (v < this.currentMin) this.currentMin = v;
      if (v > this.currentMax) this.currentMax = v;
      this.filled++;
      if (this.filled >= this.bucketSize) this.flushBucket();
    }
  }

  /** 结束并返回 `min/max` 交错数据（与 `buildPeaksLevel0` 同构）。 */
  finish(): Int16Array {
    if (this.filled > 0) this.flushBucket();
    return Int16Array.from(this.buckets);
  }

  private flushBucket(): void {
    this.buckets.push(this.currentMin, this.currentMax);
    this.currentMin = INT16_MAX;
    this.currentMax = INT16_MIN;
    this.filled = 0;
  }
}

export interface BuildPyramidOptions {  /** level 0 的桶大小，默认 `BASE_BUCKET`。 */
  baseBucket?: number;
  /** 最多构建多少级（防止极长音频构建出无意义的层级），默认 16。 */
  maxLevels?: number;
}

/**
 * 构建完整金字塔：level 0 起逐级合并，直到只剩 1 个桶或达到 `maxLevels`。
 *
 * @returns 层级数组（下标即 level）；空输入返回空数组
 */
export function buildPyramid(pcm: Int16Array, opts: BuildPyramidOptions = {}): PeaksLevel[] {
  const baseBucket = Math.max(1, Math.floor(opts.baseBucket ?? BASE_BUCKET));
  const maxLevels = Math.max(1, Math.floor(opts.maxLevels ?? 16));

  const levels: PeaksLevel[] = [];
  const level0 = buildPeaksLevel0(pcm, baseBucket);
  if (level0.length === 0) return levels;

  levels.push({ bucketSize: baseBucket, count: level0.length >> 1, data: level0 });

  while (levels.length < maxLevels) {
    const last = levels[levels.length - 1];
    if (!last || last.count <= 1) break;
    const data = buildUpperLevel(last.data);
    const count = data.length >> 1;
    if (count === 0 || count >= last.count) break;
    levels.push({ bucketSize: last.bucketSize * 2, count, data });
  }

  return levels;
}
