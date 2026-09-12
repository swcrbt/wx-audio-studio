import { describe, expect, it } from 'vitest';
import {
  applyGainDbInPlace,
  applyGainInPlace,
  applyGainRangeInPlace,
  clampGainDb,
  dbToLinear,
  linearToDb,
} from '../../miniprogram/workers/render/dsp/gain';

describe('dbToLinear', () => {
  it('常用换算点正确', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 12);
    expect(dbToLinear(-6)).toBeCloseTo(0.501187, 6);
    expect(dbToLinear(6)).toBeCloseTo(1.995262, 6);
    expect(dbToLinear(-60)).toBeCloseTo(0.001, 9);
    expect(dbToLinear(12)).toBeCloseTo(3.981072, 6);
  });

  it('-∞ dB 表示静音；NaN/ +∞ 直通', () => {
    expect(dbToLinear(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(dbToLinear(Number.POSITIVE_INFINITY)).toBe(1);
    expect(dbToLinear(Number.NaN)).toBe(1);
  });
});

describe('linearToDb', () => {
  it('是 dbToLinear 的逆运算', () => {
    for (const db of [-60, -12, -6, 0, 6, 12]) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 9);
    }
  });

  it('0 与非正数返回 -∞', () => {
    expect(linearToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(linearToDb(-1)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('clampGainDb', () => {
  it('限制在 -60 ~ +12 dB（docs/05 §2）', () => {
    expect(clampGainDb(-100)).toBe(-60);
    expect(clampGainDb(50)).toBe(12);
    expect(clampGainDb(3)).toBe(3);
    expect(clampGainDb(Number.NaN)).toBe(0);
  });
});

describe('applyGainInPlace', () => {
  it('逐采样相乘，就地修改', () => {
    const buf = new Float32Array([1, -0.5, 0.25]);
    applyGainInPlace(buf, 0.5);
    expect(Array.from(buf)).toEqual([0.5, -0.25, 0.125]);
  });

  it('增益为 1 时不改动缓冲（短路返回）', () => {
    const buf = new Float32Array([0.3, -0.7]);
    applyGainInPlace(buf, 1);
    expect(buf[0]).toBeCloseTo(0.3, 6);
    expect(buf[1]).toBeCloseTo(-0.7, 6);
  });

  it('非有限增益不修改缓冲', () => {
    const buf = new Float32Array([0.3, -0.7]);
    applyGainInPlace(buf, Number.NaN);
    applyGainInPlace(buf, Number.POSITIVE_INFINITY);
    expect(buf[0]).toBeCloseTo(0.3, 6);
    expect(buf[1]).toBeCloseTo(-0.7, 6);
  });

  it('零长度与全零输入安全', () => {
    const empty = new Float32Array(0);
    applyGainInPlace(empty, 0.5);
    expect(empty.length).toBe(0);

    const zeros = new Float32Array(4);
    applyGainInPlace(zeros, 2);
    expect(Array.from(zeros)).toEqual([0, 0, 0, 0]);
  });

  it('不在此处钳制，超范围交给总线限制器（docs/03 §6.6）', () => {
    const buf = new Float32Array([0.9]);
    applyGainInPlace(buf, 2);
    expect(buf[0]).toBeCloseTo(1.8, 6);
  });
});

describe('applyGainDbInPlace', () => {
  it('按 dB 施加并在越界时 clamp 到 UI 范围', () => {
    const buf = new Float32Array([1]);
    applyGainDbInPlace(buf, -80); // 会被 clamp 到 -60dB
    expect(buf[0]).toBeCloseTo(0.001, 6);
  });
});

describe('applyGainRangeInPlace', () => {
  it('只作用于指定区间', () => {
    const buf = new Float32Array([1, 1, 1, 1]);
    applyGainRangeInPlace(buf, 1, 3, 0.5);
    expect(Array.from(buf)).toEqual([1, 0.5, 0.5, 1]);
  });

  it('区间被 clamp 到缓冲范围内，非法区间直接返回', () => {
    const buf = new Float32Array([1, 1, 1]);
    applyGainRangeInPlace(buf, -5, 99, 0.5);
    expect(Array.from(buf)).toEqual([0.5, 0.5, 0.5]);

    const untouched = new Float32Array([1, 1]);
    applyGainRangeInPlace(untouched, 1, 1, 0.5);
    applyGainRangeInPlace(untouched, 2, 1, 0.5);
    applyGainRangeInPlace(untouched, 0, 2, Number.NaN);
    expect(Array.from(untouched)).toEqual([1, 1]);
  });
});
