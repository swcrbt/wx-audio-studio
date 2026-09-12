import { describe, expect, it } from 'vitest';
import { buildPyramid, type PeaksLevel } from '../../miniprogram/workers/render/peaks/build';
import { pickLevelIndex, samplePeaks } from '../../miniprogram/workers/render/peaks/sample';

/** 用固定种子的伪随机 PCM（避免测试随机波动）。 */
function pseudoRandomPcm(length: number): Int16Array {
  const pcm = new Int16Array(length);
  let state = 12345;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    pcm[i] = (state % 65536) - 32768;
  }
  return pcm;
}

/** 单级金字塔（bucketSize = 1），使桶边界与采样边界一致，便于与暴力算法对比。 */
function levelOnePyramid(pcm: Int16Array): PeaksLevel[] {
  return buildPyramid(pcm, { baseBucket: 1, maxLevels: 1 });
}

function bruteForce(pcm: Int16Array, from: number, to: number, px: number): Float32Array {
  const out = new Float32Array(px * 2);
  const spp = (to - from) / px;
  for (let p = 0; p < px; p++) {
    const start = Math.max(0, Math.floor(from + p * spp));
    const end = Math.min(pcm.length, Math.max(start + 1, Math.ceil(from + (p + 1) * spp)));
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = start; i < end; i++) {
      const v = pcm[i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[p * 2] = Number.isFinite(min) ? min / 32768 : 0;
    out[p * 2 + 1] = Number.isFinite(max) ? max / 32768 : 0;
  }
  return out;
}

describe('pickLevelIndex', () => {
  it('放大很深（每像素不足 1 桶）时用 level 0', () => {
    const levels = buildPyramid(new Int16Array(1024 * 8));
    expect(pickLevelIndex(levels, 4)).toBe(0);
    expect(pickLevelIndex(levels, 1024)).toBe(0);
  });

  it('按 samplesPerPixel 选级并 clamp 到最大级', () => {
    const levels = buildPyramid(new Int16Array(1024 * 8));
    expect(pickLevelIndex(levels, 1025)).toBe(0);
    expect(pickLevelIndex(levels, 2048)).toBe(1);
    expect(pickLevelIndex(levels, 4096)).toBe(2);
    expect(pickLevelIndex(levels, 10 ** 9)).toBe(levels.length - 1);
  });

  it('空层级返回 -1', () => {
    expect(pickLevelIndex([], 100)).toBe(-1);
  });
});

describe('samplePeaks', () => {
  it('聚合结果与暴力计算一致（1 采样/像素）', () => {
    const pcm = pseudoRandomPcm(500);
    const levels = levelOnePyramid(pcm);
    const out = new Float32Array(500 * 2);
    samplePeaks(levels, 0, 500, 500, out);

    const expected = bruteForce(pcm, 0, 500, 500);
    for (let i = 0; i < expected.length; i++) {
      expect(out[i]).toBeCloseTo(expected[i] ?? 0, 6);
    }
  });

  it('随机子区间与暴力计算一致', () => {
    const pcm = pseudoRandomPcm(4096);
    const levels = levelOnePyramid(pcm);
    for (const [from, to, px] of [
      [100, 300, 200],
      [1000, 1500, 500],
      [2000, 2048, 48],
    ] as const) {
      const out = new Float32Array(px * 2);
      samplePeaks(levels, from, to, px, out);
      const expected = bruteForce(pcm, from, to, px);
      for (let i = 0; i < px * 2; i++) {
        expect(out[i]).toBeCloseTo(expected[i] ?? 0, 6);
      }
    }
  });

  it('输出归一化到 [-1, 1]', () => {
    const pcm = new Int16Array(64);
    pcm[0] = -32768;
    pcm[1] = 32767;
    const out = new Float32Array(64 * 2);
    samplePeaks(levelOnePyramid(pcm), 0, 64, 64, out);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(out[0]).toBeCloseTo(-1, 6);
    expect(out[1]).toBeCloseTo(-1, 6);
    expect(out[2]).toBeCloseTo(1 - 1 / 32768, 6);
    expect(out[3]).toBeCloseTo(1 - 1 / 32768, 6);
  });

  it('非法参数把输出置 0 且不抛错', () => {
    const levels = levelOnePyramid(pseudoRandomPcm(64));
    const out = new Float32Array(8).fill(9);
    samplePeaks(levels, 10, 10, 4, out); // 空区间
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const out2 = new Float32Array(4).fill(9);
    samplePeaks(levels, 0, 64, 0, out2); // 0 像素
    expect(Array.from(out2)).toEqual([0, 0, 0, 0]);

    const out3 = new Float32Array(4).fill(9);
    samplePeaks([], 0, 64, 2, out3); // 空层级
    expect(Array.from(out3)).toEqual([0, 0, 0, 0]);
  });

  it('视口超出素材范围时钳制到最近桶', () => {
    const pcm = new Int16Array([-100, 100]);
    const out = new Float32Array(2);
    samplePeaks(levelOnePyramid(pcm), 1000, 1002, 2, out); // 全部越界 → 钳到最后一桶
    expect(out[0]).toBeCloseTo(100 / 32768, 6);
    expect(out[1]).toBeCloseTo(100 / 32768, 6);
  });

  it('长音频跨级抽样不抛错且长度正确', () => {
    const pcm = pseudoRandomPcm(1024 * 40);
    const levels = buildPyramid(pcm);
    const out = new Float32Array(375 * 2);
    samplePeaks(levels, 0, pcm.length, 375, out);
    expect(out.length).toBe(750);
    expect(out.some((v) => v !== 0)).toBe(true);
  });
});
