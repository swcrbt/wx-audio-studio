import { describe, expect, it } from 'vitest';
import {
  EQ10_BANDS_HZ,
  applyEq10InPlace,
  biquadInPlace,
  createBiquadState,
  createEq10Chain,
  highpassCoeffs,
  highShelfCoeffs,
  isEq10Flat,
  lowpassCoeffs,
  lowShelfCoeffs,
  magnitudeDbAt,
  peakingCoeffs,
} from '../../miniprogram/workers/render/dsp/biquad';
import { linearToDb } from '../../miniprogram/workers/render/dsp/gain';

const SR = 44100;

function sine(freqHz: number, lengthSamples: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SR);
  }
  return out;
}

function rms(buf: Float32Array, fromSample = 0): number {
  let sum = 0;
  let count = 0;
  for (let i = fromSample; i < buf.length; i++) {
    const v = buf[i] ?? 0;
    sum += v * v;
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

describe('系数（RBJ Audio EQ Cookbook）', () => {
  it('峰值滤波在中心频率处的增益等于设定 dB', () => {
    for (const gain of [-12, -6, 6, 12]) {
      const coeffs = peakingCoeffs(SR, 1000, 1.4, gain);
      expect(magnitudeDbAt(coeffs, SR, 1000)).toBeCloseTo(gain, 1);
    }
  });

  it('0dB 时全频段近似直通', () => {
    const coeffs = peakingCoeffs(SR, 1000, 1.4, 0);
    for (const f of [50, 500, 1000, 5000, 16000]) {
      expect(Math.abs(magnitudeDbAt(coeffs, SR, f))).toBeLessThan(1e-6);
    }
  });

  it('高通衰减低频、保持高频（-0.5dB 以内）', () => {
    const coeffs = highpassCoeffs(SR, 200);
    expect(magnitudeDbAt(coeffs, SR, 10)).toBeLessThan(-40);
    expect(magnitudeDbAt(coeffs, SR, 5000)).toBeGreaterThan(-0.5);
    expect(magnitudeDbAt(coeffs, SR, 5000)).toBeLessThan(0.5);
  });

  it('低通保持低频、衰减高频', () => {
    const coeffs = lowpassCoeffs(SR, 1000);
    expect(magnitudeDbAt(coeffs, SR, 100)).toBeGreaterThan(-0.5);
    expect(magnitudeDbAt(coeffs, SR, 10000)).toBeLessThan(-40);
  });

  it('架式滤波：低架抬高低频、高架抬高高频', () => {
    const low = lowShelfCoeffs(SR, 200, 6);
    expect(magnitudeDbAt(low, SR, 50)).toBeCloseTo(6, 0);
    expect(Math.abs(magnitudeDbAt(low, SR, 8000))).toBeLessThan(0.5);

    const high = highShelfCoeffs(SR, 4000, -6);
    expect(magnitudeDbAt(high, SR, 12000)).toBeCloseTo(-6, 0);
    expect(Math.abs(magnitudeDbAt(high, SR, 200))).toBeLessThan(0.5);
  });

  it('非法频率被 clamp 到安全范围（不产生 NaN/Inf）', () => {
    for (const [f0, q] of [
      [0, 0],
      [-100, -5],
      [1e9, 1e9],
      [Number.NaN, Number.NaN],
    ] as const) {
      const coeffs = peakingCoeffs(SR, f0, q, 6);
      for (const key of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
        expect(Number.isFinite(coeffs[key])).toBe(true);
      }
      expect(Number.isFinite(magnitudeDbAt(coeffs, SR, 1000))).toBe(true);
    }
  });
});

describe('biquadInPlace', () => {
  it('正弦波过 +6dB 峰值滤波后幅度比约 2（±0.5dB）', () => {
    const buf = sine(1000, SR); // 1 秒
    biquadInPlace(buf, peakingCoeffs(SR, 1000, 1.4, 6));
    const gainDb = linearToDb(rms(buf, SR / 2) / rms(sine(1000, SR), SR / 2));
    expect(Math.abs(gainDb - 6)).toBeLessThan(0.5);
  });

  it('分块滤波与一次性滤波结果一致（渲染分块依赖）', () => {
    const input = sine(700, 4096, 0.8);
    const whole = Float32Array.from(input);
    biquadInPlace(whole, peakingCoeffs(SR, 700, 1.4, 9));

    const chunked = Float32Array.from(input);
    const coeffs = peakingCoeffs(SR, 700, 1.4, 9);
    let state = createBiquadState();
    for (let offset = 0; offset < chunked.length; offset += 512) {
      const slice = chunked.subarray(offset, Math.min(offset + 512, chunked.length));
      state = biquadInPlace(slice, coeffs, state);
    }

    for (let i = 0; i < whole.length; i++) {
      expect(chunked[i]).toBeCloseTo(whole[i] ?? 0, 6);
    }
  });

  it('空输入与单采样输入安全', () => {
    const empty = new Float32Array(0);
    expect(biquadInPlace(empty, peakingCoeffs(SR, 1000, 1, 6))).toEqual(createBiquadState());

    const one = new Float32Array([1]);
    const nextState = biquadInPlace(one, highpassCoeffs(SR, 100));
    expect(Number.isFinite(one[0] ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(nextState.y1)).toBe(true);
  });

  it('高通让直流分量衰减到接近 0', () => {
    const buf = new Float32Array(SR).fill(0.5);
    biquadInPlace(buf, highpassCoeffs(SR, 200));
    expect(Math.abs(buf[SR - 1] ?? 1)).toBeLessThan(1e-3);
  });

  it('输出不产生 NaN/Inf（含极值输入）', () => {
    const buf = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1]);
    biquadInPlace(buf, peakingCoeffs(SR, 1000, 20, 24));
    for (const v of buf) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('10 段 EQ 链', () => {
  it('中心频率定义与 docs/03 §6.2 一致（10 段）', () => {
    expect(EQ10_BANDS_HZ.length).toBe(10);
    expect(EQ10_BANDS_HZ[0]).toBe(31.5);
    expect(EQ10_BANDS_HZ[9]).toBe(16000);
  });

  it('全 0dB 时输出几乎不变，且 isEq10Flat 判定为平直', () => {
    const gains = new Array<number>(10).fill(0);
    expect(isEq10Flat(gains)).toBe(true);

    const buf = sine(1000, 2048, 0.5);
    const before = Float32Array.from(buf);
    applyEq10InPlace(buf, createEq10Chain(SR, gains));
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).toBeCloseTo(before[i] ?? 0, 5);
    }
  });

  it('提升某一频段只显著影响该频段', () => {
    const gains = new Array<number>(10).fill(0);
    gains[5] = 12; // 1kHz
    const chain = createEq10Chain(SR, gains);

    const low = sine(100, 8192, 0.5);
    const mid = sine(1000, 8192, 0.5);
    const lowBefore = rms(low, 2048);
    const midBefore = rms(mid, 2048);

    applyEq10InPlace(low, createEq10Chain(SR, gains));
    applyEq10InPlace(mid, chain);

    expect(linearToDb(rms(mid, 2048) / midBefore)).toBeGreaterThan(6);
    expect(Math.abs(linearToDb(rms(low, 2048) / lowBefore))).toBeLessThan(1);
  });

  it('非平直时 isEq10Flat 返回 false', () => {
    const gains = new Array<number>(10).fill(0);
    gains[3] = -3;
    expect(isEq10Flat(gains)).toBe(false);
  });
});
