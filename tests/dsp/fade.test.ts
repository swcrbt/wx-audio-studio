import { describe, expect, it } from 'vitest';
import {
  applyFadeInInPlace,
  applyFadeOutInPlace,
  fadeGainAt,
  fadeSamplesFromSpec,
} from '../../miniprogram/workers/render/dsp/fade';

describe('fadeGainAt', () => {
  it('linear：淡入为 t，淡出为 1-t', () => {
    expect(fadeGainAt(0, 'linear', 'in')).toBe(0);
    expect(fadeGainAt(0.5, 'linear', 'in')).toBe(0.5);
    expect(fadeGainAt(1, 'linear', 'in')).toBe(1);
    expect(fadeGainAt(0, 'linear', 'out')).toBe(1);
    expect(fadeGainAt(1, 'linear', 'out')).toBe(0);
  });

  it('equalPower：淡入 sin(π/2·t)，淡出 cos(π/2·t)', () => {
    expect(fadeGainAt(0, 'equalPower', 'in')).toBeCloseTo(0, 12);
    expect(fadeGainAt(0.5, 'equalPower', 'in')).toBeCloseTo(Math.SQRT1_2, 12);
    expect(fadeGainAt(1, 'equalPower', 'in')).toBeCloseTo(1, 12);
    expect(fadeGainAt(0, 'equalPower', 'out')).toBeCloseTo(1, 12);
    expect(fadeGainAt(0.5, 'equalPower', 'out')).toBeCloseTo(Math.SQRT1_2, 12);
    expect(fadeGainAt(1, 'equalPower', 'out')).toBeCloseTo(0, 12);
  });

  it('两条等功率曲线功率恒定（交叉淡化无 -6dB 凹陷，docs/03 §6.1）', () => {
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = fadeGainAt(t, 'equalPower', 'in');
      const b = fadeGainAt(t, 'equalPower', 'out');
      expect(a * a + b * b).toBeCloseTo(1, 12);
    }
  });

  it('t 越界被 clamp，非有限值按 0 处理', () => {
    expect(fadeGainAt(-1, 'linear', 'in')).toBe(0);
    expect(fadeGainAt(2, 'linear', 'in')).toBe(1);
    expect(fadeGainAt(Number.NaN, 'linear', 'in')).toBe(0);
  });
});

describe('fadeSamplesFromSpec', () => {
  it('按采样率换算并显式取整（AGENTS §2.3）', () => {
    expect(fadeSamplesFromSpec({ durationSec: 0.5, curve: 'linear' }, 44100)).toBe(22050);
    expect(fadeSamplesFromSpec({ durationSec: 0.01, curve: 'linear' }, 22050)).toBe(221);
  });

  it('零/负/非法时长返回 0', () => {
    expect(fadeSamplesFromSpec({ durationSec: 0, curve: 'linear' }, 44100)).toBe(0);
    expect(fadeSamplesFromSpec({ durationSec: -1, curve: 'linear' }, 44100)).toBe(0);
    expect(fadeSamplesFromSpec({ durationSec: Number.NaN, curve: 'linear' }, 44100)).toBe(0);
  });
});

describe('applyFadeInInPlace', () => {
  it('首采样增益为 0、末采样为 1', () => {
    const buf = new Float32Array(9).fill(1);
    applyFadeInInPlace(buf, 0, 9, 'linear');
    expect(buf[0]).toBe(0);
    expect(buf[8]).toBe(1);
    expect(buf[4]).toBeCloseTo(0.5, 6);
  });

  it('equalPower 曲线端点与中点符合 sin(π/2·t)', () => {
    // 缓冲是 Float32，精度断言取 6 位小数
    const buf = new Float32Array(5).fill(1);
    applyFadeInInPlace(buf, 0, 5, 'equalPower');
    expect(buf[0]).toBeCloseTo(0, 6);
    expect(buf[2]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(buf[4]).toBeCloseTo(1, 6);
  });

  it('支持从中间开始（非 0 起点）', () => {
    const buf = new Float32Array([1, 1, 1, 1]);
    applyFadeInInPlace(buf, 2, 2, 'linear');
    expect(Array.from(buf)).toEqual([1, 1, 0, 1]);
  });

  it('淡入长度超过可用长度时被 clamp，不越界', () => {
    const buf = new Float32Array(3).fill(1);
    applyFadeInInPlace(buf, 0, 100, 'linear');
    expect(buf[0]).toBe(0);
    expect(buf[2]).toBe(1);
    expect(buf.length).toBe(3);
  });

  it('单采样淡入增益为 0（端点定义优先）', () => {
    const buf = new Float32Array([1]);
    applyFadeInInPlace(buf, 0, 1, 'linear');
    expect(buf[0]).toBe(0);
  });

  it('非正长度与全零输入不改动缓冲', () => {
    const buf = new Float32Array([1, 1]);
    applyFadeInInPlace(buf, 0, 0, 'linear');
    applyFadeInInPlace(buf, 0, -3, 'linear');
    expect(Array.from(buf)).toEqual([1, 1]);

    const zeros = new Float32Array(4);
    applyFadeInInPlace(zeros, 0, 4, 'equalPower');
    expect(Array.from(zeros)).toEqual([0, 0, 0, 0]);
  });
});

describe('applyFadeOutInPlace', () => {
  it('区间首采样为 1、末采样为 0', () => {
    const buf = new Float32Array(9).fill(1);
    applyFadeOutInPlace(buf, 9, 9, 'linear');
    expect(buf[0]).toBe(1);
    expect(buf[8]).toBe(0);
    expect(buf[4]).toBeCloseTo(0.5, 6);
  });

  it('只作用于末尾指定长度', () => {
    const buf = new Float32Array([1, 1, 1, 1]);
    applyFadeOutInPlace(buf, 4, 2, 'linear');
    expect(Array.from(buf)).toEqual([1, 1, 1, 0]);
  });

  it('淡出长度超过可用长度时被 clamp，不越界', () => {
    const buf = new Float32Array(3).fill(1);
    applyFadeOutInPlace(buf, 3, 100, 'linear');
    expect(buf[0]).toBe(1);
    expect(buf[2]).toBe(0);
    expect(buf.length).toBe(3);
  });

  it('equalPower 交叉点验证：同一位置淡入×淡出 = 常量', () => {
    const n = 16;
    const a = new Float32Array(n).fill(1);
    const b = new Float32Array(n).fill(1);
    applyFadeInInPlace(a, 0, n, 'equalPower');
    applyFadeOutInPlace(b, n, n, 'equalPower');
    for (let i = 0; i < n; i++) {
      expect(a[i]).toBeCloseTo(b[n - 1 - i] ?? 0, 6);
    }
  });

  it('非正长度不改动缓冲', () => {
    const buf = new Float32Array([1, 1]);
    applyFadeOutInPlace(buf, 2, 0, 'linear');
    expect(Array.from(buf)).toEqual([1, 1]);
  });
});
