/**
 * 纯 JS 处理链性能基准（3 分钟音频）。
 *
 * 目的：回答"低端机上纯 JS DSP 是否够快"，以及"是否需要引入 WebAssembly"。
 * 运行方式：`npm run bench`。基准脚本不参与 `npm run test`（vitest 默认不收集 .bench.ts）。
 */
import { bench, describe } from 'vitest';
import type { Edl } from '../../miniprogram/core/types';
import { applyEq10InPlace, createEq10Chain, highpassCoeffs, biquadInPlace } from '../../miniprogram/workers/render/dsp/biquad';
import { applyGainInPlace, dbToLinear } from '../../miniprogram/workers/render/dsp/gain';
import { applyLimiterInPlace } from '../../miniprogram/workers/render/dsp/limiter';
import { resampleMono } from '../../miniprogram/workers/render/codec/resample';
import { buildPyramid } from '../../miniprogram/workers/render/peaks/build';
import { initJob, renderChunk } from '../../miniprogram/workers/render/render';

const SAMPLE_RATE = 44100;
/** 3 分钟音频（单声道 ≈ 7.94M 采样 ≈ 15.9MB Int16）。 */
const SECONDS = 180;
const FRAMES = SAMPLE_RATE * SECONDS;

function makePcm(frames: number): Int16Array {
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    pcm[i] = Math.round(20000 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
  }
  return pcm;
}

function makeFloat(frames: number): Float32Array {
  const buf = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    buf[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  }
  return buf;
}

const PCM = makePcm(FRAMES);
const MONO_FLOAT = makeFloat(FRAMES);

function buildEdl(): Edl {
  return {
    sampleRate: SAMPLE_RATE,
    channels: 1,
    assets: [
      {
        id: 'a1',
        name: 'bench',
        origin: 'record',
        path: 'assets/a1.wav',
        sampleRate: SAMPLE_RATE,
        channels: 1,
        durationSec: SECONDS,
        frames: FRAMES,
        bytes: FRAMES * 2,
        peakRef: { path: 'peaks/a1.pk', levels: [] },
        createdAt: 0,
      },
    ],
    tracks: [
      {
        id: 't1',
        name: '人声',
        order: 0,
        gainDb: 0,
        pan: 0,
        muted: false,
        solo: false,
        effects: [
          { id: 'e1', type: 'highpass', enabled: true, params: { freq: 120 } },
          { id: 'e2', type: 'eq10', enabled: true, params: { bands: new Array(10).fill(0) } },
        ],
        clips: [
          {
            id: 'c1',
            assetId: 'a1',
            sourceStart: 0,
            sourceEnd: SECONDS,
            timelineStart: 0,
            gainDb: 0,
            fadeIn: { durationSec: 0.5, curve: 'equalPower' },
            fadeOut: { durationSec: 0.5, curve: 'equalPower' },
            speed: 1,
            loop: false,
            effects: [],
          },
        ],
      },
    ],
  };
}

describe(`3 分钟音频（${FRAMES} 采样 @ ${SAMPLE_RATE}Hz）`, () => {
  bench('峰值金字塔构建（buildPyramid）', () => {
    buildPyramid(PCM);
  });

  bench('重采样 44.1k → 22.05k', () => {
    resampleMono(MONO_FLOAT, SAMPLE_RATE, 22050);
  });

  bench('逐采样增益（applyGainInPlace）', () => {
    const copy = Float32Array.from(MONO_FLOAT);
    applyGainInPlace(copy, dbToLinear(-6));
  });

  bench('高通 120Hz（biquad）', () => {
    const copy = Float32Array.from(MONO_FLOAT);
    biquadInPlace(copy, highpassCoeffs(SAMPLE_RATE, 120));
  });

  bench('10 段 EQ（并联 biquad 链）', () => {
    const copy = Float32Array.from(MONO_FLOAT);
    applyEq10InPlace(copy, createEq10Chain(SAMPLE_RATE, new Array(10).fill(3)));
  });

  bench('总线限制器', () => {
    const copy = Float32Array.from(MONO_FLOAT);
    applyLimiterInPlace(copy, { sampleRate: SAMPLE_RATE });
  });

  bench('完整分块渲染（2s 块，含轨道效果与限制器）', () => {
    const state = initJob({
      projectId: 'bench',
      edl: buildEdl(),
      output: { sampleRate: SAMPLE_RATE, channels: 1 },
      range: { startSec: 0, endSec: SECONDS },
      chunkSec: 2,
    });
    const assets = new Map([
      ['a1', { startFrame: 0, channels: 1, data: PCM }],
    ]);
    for (let chunk = 0; chunk < state.totalChunks; chunk++) {
      renderChunk(state, chunk, assets);
    }
  });
});
