import { describe, expect, it } from 'vitest';
import {
  BASE_BUCKET,
  Level0Accumulator,
  buildPeaksLevel0,
  buildPyramid,
  buildUpperLevel,
} from '../../miniprogram/workers/render/peaks/build';

describe('buildPeaksLevel0', () => {
  it('按桶求精确 min/max（交错存储）', () => {
    const pcm = new Int16Array([0, 10, -5, 3, 100, -200, 7, 1]);
    const level0 = buildPeaksLevel0(pcm, 4);
    expect(level0.length).toBe(4); // 2 桶 × (min,max)
    expect(Array.from(level0)).toEqual([-5, 10, -200, 100]);
  });

  it('末桶不满时按实际长度处理', () => {
    const pcm = new Int16Array([5, -5, 20]);
    const level0 = buildPeaksLevel0(pcm, 2);
    expect(Array.from(level0)).toEqual([-5, 5, 20, 20]);
  });

  it('短输入（长度 < 桶大小）产生 1 个桶', () => {
    const pcm = new Int16Array([3, -1]);
    const level0 = buildPeaksLevel0(pcm);
    expect(level0.length).toBe(2);
    expect(Array.from(level0)).toEqual([-1, 3]);
  });

  it('空输入返回空数组', () => {
    expect(buildPeaksLevel0(new Int16Array(0)).length).toBe(0);
  });

  it('极值输入保持满量程', () => {
    const level0 = buildPeaksLevel0(new Int16Array([32767, -32768]), 2);
    expect(Array.from(level0)).toEqual([-32768, 32767]);
  });

  it('非法桶大小被 clamp 到 1', () => {
    const pcm = new Int16Array([1, -1, 2]);
    expect(Array.from(buildPeaksLevel0(pcm, 0))).toEqual([1, 1, -1, -1, 2, 2]);
    expect(Array.from(buildPeaksLevel0(pcm, -1024))).toEqual([1, 1, -1, -1, 2, 2]);
    expect(Array.from(buildPeaksLevel0(pcm, 1.7))).toEqual([1, 1, -1, -1, 2, 2]);
  });

  it('默认桶大小符合 docs/03 §4.1（1024）', () => {
    const pcm = new Int16Array(BASE_BUCKET + 1);
    pcm[0] = -100;
    pcm[BASE_BUCKET] = 100;
    const level0 = buildPeaksLevel0(pcm);
    expect(level0.length).toBe(4);
    expect(Array.from(level0)).toEqual([-100, 0, 100, 100]);
  });
});

describe('Level0Accumulator（分块累加，供导入/录音管线使用）', () => {
  function pseudoRandom(length: number): Int16Array {
    const pcm = new Int16Array(length);
    let state = 4242;
    for (let i = 0; i < length; i++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      pcm[i] = (state % 65536) - 32768;
    }
    return pcm;
  }

  it('分块喂入（含跨桶）与一次性构建结果完全一致', () => {
    const pcm = pseudoRandom(5000);
    const accumulator = new Level0Accumulator(1024);
    const step = 700; // 故意不整除桶大小，覆盖跨桶情况
    for (let offset = 0; offset < pcm.length; offset += step) {
      accumulator.push(pcm.subarray(offset, Math.min(offset + step, pcm.length)));
    }
    expect(Array.from(accumulator.finish())).toEqual(Array.from(buildPeaksLevel0(pcm, 1024)));
  });

  it('极值与未满桶的尾段被正确保留', () => {
    const pcm = new Int16Array([32767, -32768, 5, -5, 9]);
    const accumulator = new Level0Accumulator(2);
    accumulator.push(pcm.subarray(0, 3));
    accumulator.push(pcm.subarray(3));
    expect(Array.from(accumulator.finish())).toEqual(Array.from(buildPeaksLevel0(pcm, 2)));
  });

  it('空输入返回空数组；未喂过数据时 finish 不报错', () => {
    const empty = new Level0Accumulator(1024);
    expect(empty.finish().length).toBe(0);
    const one = new Level0Accumulator(1024);
    one.push(new Int16Array(0));
    expect(one.finish().length).toBe(0);
  });

  it('非法桶大小被 clamp 到 1', () => {
    const accumulator = new Level0Accumulator(0);
    accumulator.push(new Int16Array([3, -3]));
    expect(Array.from(accumulator.finish())).toEqual([3, 3, -3, -3]);
  });
});

describe('buildUpperLevel', () => {
  it('每 2 桶合 1：min 取小、max 取大（无精度损失）', () => {
    const lower = new Int16Array([-5, 10, -200, 100]);
    expect(Array.from(buildUpperLevel(lower))).toEqual([-200, 100]);
  });

  it('桶数为奇数时最后一桶单独成上级桶', () => {
    const lower = new Int16Array([-1, 2, -3, 4, -9, 9]);
    expect(Array.from(buildUpperLevel(lower))).toEqual([-3, 4, -9, 9]);
  });

  it('空输入返回空数组', () => {
    expect(buildUpperLevel(new Int16Array(0)).length).toBe(0);
  });

  it('单桶输入保持不变', () => {
    expect(Array.from(buildUpperLevel(new Int16Array([-7, 7])))).toEqual([-7, 7]);
  });
});

describe('buildPyramid', () => {
  it('层级 bucketSize 逐级 ×2、桶数逐级减半', () => {
    const pcm = new Int16Array(BASE_BUCKET * 5);
    pcm[0] = -1000;
    pcm[BASE_BUCKET * 5 - 1] = 2000;
    const levels = buildPyramid(pcm);

    expect(levels.map((l) => l.bucketSize)).toEqual([1024, 2048, 4096, 8192]);
    expect(levels.map((l) => l.count)).toEqual([5, 3, 2, 1]);
    // 全局极值在每一级都保留
    expect(levels[0]?.data[0]).toBe(-1000);
    expect(levels[3]?.data[0]).toBe(-1000);
    expect(levels[3]?.data[1]).toBe(2000);
    // 每级 data 长度恒为 count × 2
    for (const level of levels) {
      expect(level.data.length).toBe(level.count * 2);
    }
  });

  it('空输入返回空层级', () => {
    expect(buildPyramid(new Int16Array(0))).toEqual([]);
  });

  it('maxLevels 限制层级数量', () => {
    const pcm = new Int16Array(BASE_BUCKET * 8);
    expect(buildPyramid(pcm, { maxLevels: 1 }).length).toBe(1);
    expect(buildPyramid(pcm, { maxLevels: 3 }).length).toBe(3);
  });

  it('长音频默认层级收敛到 1 个桶', () => {
    const levels = buildPyramid(new Int16Array(BASE_BUCKET * 100));
    expect(levels[levels.length - 1]?.count).toBe(1);
    expect(levels.length).toBeLessThanOrEqual(16);
  });
});
