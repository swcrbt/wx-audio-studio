import { describe, expect, it } from 'vitest';
import { dbToLinear } from '../../miniprogram/workers/render/dsp/gain';
import { applyLimiterInPlace } from '../../miniprogram/workers/render/dsp/limiter';

const SR = 44100;

function sineBuffer(freqHz: number, lengthSamples: number, amplitude: number): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SR);
  }
  return out;
}

describe('applyLimiterInPlace', () => {
  it('把超限信号压到 ceiling（-0.3dBFS）以内', () => {
    const buf = sineBuffer(220, SR, 2.5);
    const result = applyLimiterInPlace(buf, { sampleRate: SR });
    const ceiling = dbToLinear(-0.3);
    expect(result.outputPeak).toBeLessThanOrEqual(ceiling + 1e-6);
    let observedPeak = 0;
    let allFinite = true;
    for (const v of buf) {
      const abs = Math.abs(v);
      if (abs > observedPeak) observedPeak = abs;
      if (!Number.isFinite(v)) allFinite = false;
    }
    expect(observedPeak).toBeLessThanOrEqual(ceiling + 1e-6);
    expect(allFinite).toBe(true);
    expect(result.limitedSamples).toBeGreaterThan(0);
  });

  it('未超限信号不被改动', () => {
    const buf = sineBuffer(440, SR / 10, 0.5);
    const before = Float32Array.from(buf);
    const result = applyLimiterInPlace(buf, { sampleRate: SR });
    expect(result.limitedSamples).toBe(0);
    expect(result.outputPeak).toBeCloseTo(result.inputPeak, 6);
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).toBeCloseTo(before[i] ?? 0, 6);
    }
  });

  it('统计输入/输出峰值（全零输入返回 0）', () => {
    const zeros = new Float32Array(SR / 10);
    const result = applyLimiterInPlace(zeros, { sampleRate: SR });
    expect(result.inputPeak).toBe(0);
    expect(result.outputPeak).toBe(0);
    expect(result.limitedSamples).toBe(0);
  });

  it('空输入安全', () => {
    const empty = new Float32Array(0);
    expect(applyLimiterInPlace(empty, { sampleRate: SR })).toEqual({
      inputPeak: 0,
      outputPeak: 0,
      limitedSamples: 0,
    });
  });

  it('单位阶跃（DC 2.0）被限制且无 NaN', () => {
    const buf = new Float32Array(SR / 4).fill(2);
    applyLimiterInPlace(buf, { sampleRate: SR });
    for (const v of buf) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(dbToLinear(-0.3) + 1e-6);
    }
  });

  it('单点尖峰也能被压制（前瞻生效）', () => {
    const buf = new Float32Array(1000);
    buf[500] = 3;
    const result = applyLimiterInPlace(buf, { sampleRate: SR, lookaheadMs: 2 });
    expect(result.outputPeak).toBeLessThanOrEqual(dbToLinear(-0.3) + 1e-6);
    expect(buf[500]).toBeLessThan(1);
  });

  it('release 让增益在超限结束后恢复（不再继续压小信号）', () => {
    const buf = new Float32Array(SR);
    for (let i = 0; i < SR / 2; i++) buf[i] = 2 * Math.sin((2 * Math.PI * 200 * i) / SR);
    for (let i = SR / 2; i < SR; i++) buf[i] = 0.2 * Math.sin((2 * Math.PI * 200 * i) / SR);
    applyLimiterInPlace(buf, { sampleRate: SR, releaseMs: 20 });

    let tailPeak = 0;
    for (let i = SR - 1000; i < SR; i++) tailPeak = Math.max(tailPeak, Math.abs(buf[i] ?? 0));
    expect(tailPeak).toBeCloseTo(0.2, 1); // 已恢复到接近原始幅度
  });

  it('自定义 ceiling 生效', () => {
    const buf = sineBuffer(300, SR / 10, 1.5);
    applyLimiterInPlace(buf, { sampleRate: SR, ceilingDb: -6 });
    expect(Math.max(...Array.from(buf).map(Math.abs))).toBeLessThanOrEqual(dbToLinear(-6) + 1e-6);
  });
});
