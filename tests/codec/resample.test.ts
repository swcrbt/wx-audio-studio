import { describe, expect, it } from 'vitest';
import {
  outputFrameCount,
  resampleInt16,
  resampleInterleaved,
  resampleMono,
  tapsForRates,
} from '../../miniprogram/workers/render/codec/resample';

function sine(freqHz: number, sampleRate: number, frames: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    const v = buf[i] ?? 0;
    sum += v * v;
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

describe('outputFrameCount / tapsForRates', () => {
  it('按比值四舍五入输出帧数', () => {
    expect(outputFrameCount(44100, 44100, 22050)).toBe(22050);
    expect(outputFrameCount(22050, 22050, 44100)).toBe(44100);
    expect(outputFrameCount(44100, 44100, 16000)).toBe(16000);
    expect(outputFrameCount(0, 44100, 22050)).toBe(0);
  });

  it('非法采样率返回 0 帧', () => {
    expect(outputFrameCount(1000, 0, 22050)).toBe(0);
    expect(outputFrameCount(1000, 44100, 0)).toBe(0);
  });

  it('2:1 与 1:2 用半带抽头，其他比例用通用抽头', () => {
    expect(tapsForRates(44100, 22050)).toBe(31);
    expect(tapsForRates(22050, 44100)).toBe(31);
    expect(tapsForRates(44100, 16000)).toBe(63);
  });
});

describe('resampleMono', () => {
  it('采样率相同时直接返回副本（值完全一致，且不是同一个对象）', () => {
    const input = sine(440, 44100, 1000);
    const out = resampleMono(input, 44100, 44100);
    expect(out.length).toBe(input.length);
    expect(out).not.toBe(input);
    for (let i = 0; i < input.length; i++) expect(out[i]).toBe(input[i]);
  });

  it('44.1k → 22.05k：长度减半且幅度保持（±5%）', () => {
    const input = sine(440, 44100, 44100);
    const out = resampleMono(input, 44100, 22050);
    expect(out.length).toBe(22050);

    const ratio = rms(out, 2000, out.length - 2000) / rms(input, 4000, input.length - 4000);
    expect(Math.abs(ratio - 1)).toBeLessThan(0.05);
  });

  it('22.05k → 44.1k：长度翻倍且幅度保持（±5%）', () => {
    const input = sine(440, 22050, 22050);
    const out = resampleMono(input, 22050, 44100);
    expect(out.length).toBe(44100);

    const ratio = rms(out, 4000, out.length - 4000) / rms(input, 2000, input.length - 2000);
    expect(Math.abs(ratio - 1)).toBeLessThan(0.05);
  });

  it('44.1k → 16k（非整数比）不产生 NaN 且幅度保持', () => {
    const input = sine(300, 44100, 44100);
    const out = resampleMono(input, 44100, 16000);
    expect(out.length).toBe(16000);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);

    const ratio = rms(out, 2000, out.length - 2000) / rms(input, 4000, input.length - 4000);
    expect(Math.abs(ratio - 1)).toBeLessThan(0.1);
  });

  it('直流分量保持为 1（权重归一化生效）', () => {
    const input = new Float32Array(4096).fill(0.8);
    const out = resampleMono(input, 44100, 22050);
    for (let i = 64; i < out.length - 64; i++) {
      expect(out[i]).toBeCloseTo(0.8, 4);
    }
  });

  it('降采样时高于目标 Nyquist 的分量被显著衰减（抗混叠）', () => {
    const input = sine(15000, 44100, 44100, 0.5);
    const out = resampleMono(input, 44100, 22050);
    const ratio = rms(out, 2000, out.length - 2000) / rms(input, 4000, input.length - 4000);
    expect(ratio).toBeLessThan(0.2);
  });

  it('空输入与非法采样率返回空缓冲', () => {
    expect(resampleMono(new Float32Array(0), 44100, 22050).length).toBe(0);
    expect(resampleMono(new Float32Array(100), 0, 22050).length).toBe(0);
    expect(resampleMono(new Float32Array(100), 44100, -1).length).toBe(0);
  });

  it('极短输入（少于抽头数）不越界且输出有限', () => {
    const input = new Float32Array([0.5, -0.5, 0.25]);
    const out = resampleMono(input, 44100, 22050);
    expect(out.length).toBeGreaterThan(0);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('resampleInterleaved / resampleInt16', () => {
  it('多声道交错重采样保持声道分离', () => {
    const frames = 4410;
    const input = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      input[i * 2] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100);
      input[i * 2 + 1] = 0;
    }
    const out = resampleInterleaved(input, 2, 44100, 22050);
    expect(out.length).toBe(((frames * 22050) / 44100 | 0) * 2);

    let leftRms = 0;
    let rightRms = 0;
    const outFrames = out.length / 2;
    for (let i = 0; i < outFrames; i++) {
      leftRms += (out[i * 2] ?? 0) ** 2;
      rightRms += (out[i * 2 + 1] ?? 0) ** 2;
    }
    expect(Math.sqrt(leftRms / outFrames)).toBeGreaterThan(0.2);
    expect(rightRms).toBe(0);
  });

  it('Int16 版本在同采样率下原样返回副本', () => {
    const input = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const out = resampleInt16(input, 1, 44100, 44100);
    expect(Array.from(out)).toEqual(Array.from(input));
    expect(out).not.toBe(input);
  });

  it('Int16 版本降采样保持满量程不溢出', () => {
    const frames = 44100;
    const input = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      input[i] = Math.round(32767 * Math.sin((2 * Math.PI * 440 * i) / 44100));
    }
    const out = resampleInt16(input, 1, 44100, 22050);
    expect(out.length).toBe(22050);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(32768);
    expect(peak).toBeGreaterThan(20000);
  });
});
