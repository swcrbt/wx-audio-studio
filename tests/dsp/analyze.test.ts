import { describe, expect, it } from 'vitest';
import {
  computePeak,
  computeRms,
  computeRmsDb,
  detectSilence,
  estimateMp3FileSize,
  estimateWavFileSize,
  normalizePeakInPlace,
} from '../../miniprogram/workers/render/dsp/analyze';

const SR = 44100;

function sine(freqHz: number, lengthSamples: number, amplitude: number, offsetSamples = 0): Float32Array {
  const out = new Float32Array(offsetSamples + lengthSamples);
  for (let i = 0; i < lengthSamples; i++) {
    out[offsetSamples + i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SR);
  }
  return out;
}

describe('computePeak', () => {
  it('满量程 0dBFS、半量程 -6.02dBFS', () => {
    expect(computePeak(new Float32Array([1, -1])).peakDb).toBeCloseTo(0, 6);
    expect(computePeak(new Float32Array([0.5, -0.5])).peakDb).toBeCloseTo(-6.0206, 3);
  });

  it('全零与空输入返回 -Infinity', () => {
    expect(computePeak(new Float32Array(4)).peakDb).toBe(Number.NEGATIVE_INFINITY);
    expect(computePeak(new Float32Array(0)).peakDb).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('computeRms', () => {
  it('常量信号的 RMS 等于其绝对值', () => {
    expect(computeRms(new Float32Array([0.5, 0.5, 0.5, 0.5]))).toBeCloseTo(0.5, 6);
  });

  it('正弦波 RMS ≈ 幅度 / √2', () => {
    expect(computeRms(sine(1000, SR, 0.8))).toBeCloseTo(0.8 * Math.SQRT1_2, 3);
  });

  it('空输入返回 0 且 dB 为 -Infinity', () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
    expect(computeRmsDb(new Float32Array(0))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('detectSilence', () => {
  it('找出中段与尾段静音（含两端 pad 收缩）', () => {
    const buf = new Float32Array(SR * 3);
    // 0.0~0.5s 静音 | 0.5~1.5s 有声 | 1.5~3.0s 静音
    const tone = sine(440, SR, 0.6, SR / 2);
    for (let i = 0; i < SR; i++) buf[SR / 2 + i] = tone[SR / 2 + i] ?? 0;

    const ranges = detectSilence(buf, { sampleRate: SR });
    expect(ranges.length).toBe(2);
    // 前 0.5s 静音：两端各收缩 60ms
    expect(ranges[0]?.startSec).toBeCloseTo(0.06, 2);
    expect(ranges[0]?.endSec).toBeCloseTo(0.44, 2);
    // 尾段静音到 3s
    expect(ranges[1]?.startSec).toBeCloseTo(1.56, 2);
    expect(ranges[1]?.endSec).toBeCloseTo(2.94, 2);
  });

  it('minSilenceMs 过滤过短的静音', () => {
    const buf = new Float32Array(SR); // 1s：中段 100ms 静音
    const tone = sine(440, SR, 0.6);
    for (let i = 0; i < SR; i++) buf[i] = tone[i] ?? 0;
    for (let i = SR / 2; i < SR / 2 + SR / 10; i++) buf[i] = 0;

    expect(detectSilence(buf, { sampleRate: SR, minSilenceMs: 300 }).length).toBe(0);
    const found = detectSilence(buf, { sampleRate: SR, minSilenceMs: 50, padMs: 0 });
    expect(found.length).toBe(1);
    expect(found[0]?.startSec).toBeCloseTo(0.5, 1);
  });

  it('阈值可调：把较安静的信号视为静音', () => {
    const buf = sine(440, SR, 0.01); // ≈ -40dBFS
    expect(detectSilence(buf, { sampleRate: SR, thresholdDb: -50 }).length).toBe(0);
    const all = detectSilence(buf, { sampleRate: SR, thresholdDb: -20, padMs: 0 });
    expect(all.length).toBe(1);
    expect(all[0]?.startSec).toBeCloseTo(0, 2);
  });

  it('空输入与全静音输入不抛错', () => {
    expect(detectSilence(new Float32Array(0), { sampleRate: SR })).toEqual([]);
    const silence = detectSilence(new Float32Array(SR), { sampleRate: SR, padMs: 0 });
    expect(silence.length).toBe(1);
    expect(silence[0]?.endSec).toBeCloseTo(1, 2);
  });
});

describe('normalizePeakInPlace', () => {
  it('把峰值拉到目标 dBFS 并返回施加的增益', () => {
    const buf = new Float32Array([0.5, -0.5, 0.25, 0]);
    const result = normalizePeakInPlace(buf, -1);
    expect(computePeak(buf).peakDb).toBeCloseTo(-1, 3);
    expect(result.appliedGainDb).toBeCloseTo(5.0206, 2);
    expect(result.peakBefore).toBeCloseTo(0.5, 6);
  });

  it('全零输入不改变数据', () => {
    const buf = new Float32Array(4);
    const result = normalizePeakInPlace(buf, -1);
    expect(result.appliedGainDb).toBe(0);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
  });

  it('默认目标为 -1dBFS', () => {
    const buf = new Float32Array([0.1]);
    normalizePeakInPlace(buf);
    expect(computePeak(buf).peakDb).toBeCloseTo(-1, 3);
  });
});

describe('体积预估', () => {
  it('WAV 体积 = 44 字节头 + 帧数 × 声道 × 2', () => {
    expect(estimateWavFileSize(1, 44100, 1)).toBe(44 + 88200);
    expect(estimateWavFileSize(1, 44100, 2)).toBe(44 + 176400);
  });

  it('10 分钟 44.1k 立体声约 105.8MB（与 docs/02 §3 的容量表一致，十进制 MB）', () => {
    const bytes = estimateWavFileSize(600, 44100, 2);
    expect(bytes / 1e6).toBeCloseTo(105.8, 1);
  });

  it('MP3 体积按恒定码率估算', () => {
    expect(estimateMp3FileSize(60, 128)).toBeCloseTo((60 * 128 * 1000) / 8, 6);
  });
});
