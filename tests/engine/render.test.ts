import { describe, expect, it } from 'vitest';
import type { Edl } from '../../miniprogram/core/types';
import {
  assertSameSampleRate,
  chunkBounds,
  initJob,
  panGains,
  planChunk,
  renderChunk,
  type AssetPcmMap,
  type AssetPcmSlice,
  type RenderJobSpec,
} from '../../miniprogram/workers/render/render';
import { makeAsset, makeClip, makeTrack } from '../edl/fixtures';

const SR = 44100;

function sineSlice(
  frames: number,
  opts: { freq?: number; amplitude?: number; channels?: number; startFrame?: number; silent?: boolean } = {},
): AssetPcmSlice {
  const freq = opts.freq ?? 440;
  const amplitude = opts.amplitude ?? 0.5;
  const channels = opts.channels ?? 1;
  const startFrame = opts.startFrame ?? 0;
  const data = new Int16Array(frames * channels);
  if (!opts.silent) {
    for (let i = 0; i < frames; i++) {
      const v = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * (i + startFrame)) / SR));
      for (let c = 0; c < channels; c++) data[i * channels + c] = v;
    }
  }
  return { startFrame, channels, data };
}

function assetMap(slices: Record<string, AssetPcmSlice>): AssetPcmMap {
  return new Map(Object.entries(slices));
}

function makeJob(edl: Edl, overrides: Partial<RenderJobSpec> = {}): RenderJobSpec {
  return {
    projectId: 'p1',
    edl,
    output: { sampleRate: edl.sampleRate, channels: 1 },
    range: { startSec: 0, endSec: 1 },
    chunkSec: 1,
    ...overrides,
  };
}

function peak(pcm: Int16Array): number {
  let max = 0;
  for (const v of pcm) max = Math.max(max, Math.abs(v));
  return max;
}

/** 单轨单片段工程：素材 1s，片段引用 [0, 1)。 */
function singleClipEdl(overrides: Partial<ReturnType<typeof makeClip>> = {}): Edl {
  return {
    sampleRate: SR,
    channels: 1,
    assets: [makeAsset('a1', 1)],
    tracks: [
      makeTrack('t1', [
        makeClip({ id: 'c1', assetId: 'a1', sourceStart: 0, sourceEnd: 1, ...overrides }),
      ]),
    ],
  };
}

describe('initJob / chunkBounds', () => {
  it('按 chunkSec 计算块数与总帧数', () => {
    const state = initJob(makeJob(singleClipEdl(), { range: { startSec: 0, endSec: 2.5 }, chunkSec: 1 }));
    expect(state.chunkFrames).toBe(SR);
    expect(state.totalFrames).toBe(Math.round(2.5 * SR));
    expect(state.totalChunks).toBe(3);
  });

  it('最后一块帧数按剩余长度收敛', () => {
    const state = initJob(makeJob(singleClipEdl(), { range: { startSec: 0, endSec: 1.5 }, chunkSec: 1 }));
    expect(chunkBounds(state, 0).frames).toBe(SR);
    expect(chunkBounds(state, 1).frames).toBe(SR / 2);
    const bounds = chunkBounds(state, 1);
    expect(bounds.startSec).toBeCloseTo(1, 6);
  });

  it('选区渲染的起点被正确偏移', () => {
    const state = initJob(makeJob(singleClipEdl(), { range: { startSec: 0.5, endSec: 1 }, chunkSec: 1 }));
    expect(state.totalFrames).toBe(SR / 2);
    expect(chunkBounds(state, 0).startSec).toBeCloseTo(0.5, 6);
  });

  it('输出采样率与工程不一致时明确报错（跨采样率需先重采样）', () => {
    const job = makeJob(singleClipEdl(), { output: { sampleRate: 22050, channels: 1 } });
    expect(() => assertSameSampleRate(job)).toThrow();
    expect(() => initJob(job)).toThrow();
  });
});

describe('planChunk', () => {
  it('请求与块相交片段覆盖的素材帧区间', () => {
    const state = initJob(makeJob(singleClipEdl()));
    const requests = planChunk(state, 0);
    expect(requests.length).toBe(1);
    expect(requests[0]?.assetId).toBe('a1');
    expect(requests[0]?.startFrame).toBe(0);
    expect(requests[0]?.frameCount).toBeGreaterThanOrEqual(SR);
  });

  it('片段未覆盖的块不请求素材', () => {
    const edl = singleClipEdl({ timelineStart: 5 });
    const state = initJob(makeJob(edl, { range: { startSec: 0, endSec: 1 } }));
    expect(planChunk(state, 0)).toEqual([]);
  });

  it('静音轨道不产生请求', () => {
    const edl = singleClipEdl();
    edl.tracks[0]!.muted = true;
    const state = initJob(makeJob(edl));
    expect(planChunk(state, 0)).toEqual([]);
  });

  it('带变速的片段按 speed 推算素材区间', () => {
    const edl = singleClipEdl({ speed: 2, sourceStart: 0, sourceEnd: 2 });
    edl.assets = [makeAsset('a1', 4)];
    const state = initJob(makeJob(edl, { range: { startSec: 0, endSec: 1 } }));
    const requests = planChunk(state, 0);
    // 时间轴 1s × speed 2 = 素材 2s ≈ 88200 帧
    expect(requests[0]?.frameCount).toBeGreaterThanOrEqual(SR * 2);
  });
});

describe('renderChunk', () => {
  it('渲染出有信号的 PCM，长度等于块帧数', () => {
    const state = initJob(makeJob(singleClipEdl()));
    const result = renderChunk(state, 0, assetMap({ a1: sineSlice(SR) }));
    expect(result.frames).toBe(SR);
    expect(result.pcm.length).toBe(SR);
    expect(result.isLast).toBe(true);
    expect(peak(result.pcm)).toBeGreaterThan(1000);
  });

  it('静音素材渲染为静音', () => {
    const state = initJob(makeJob(singleClipEdl()));
    const result = renderChunk(state, 0, assetMap({ a1: sineSlice(SR, { silent: true }) }));
    expect(peak(result.pcm)).toBe(0);
  });

  it('缺素材时输出静音而不抛错', () => {
    const state = initJob(makeJob(singleClipEdl()));
    const result = renderChunk(state, 0, assetMap({}));
    expect(result.frames).toBe(SR);
    expect(peak(result.pcm)).toBe(0);
  });

  it('片段增益 -6dB 使幅度减半', () => {
    const basePeak = peak(
      interleavedSnapshot(
        renderChunk(initJob(makeJob(singleClipEdl())), 0, assetMap({ a1: sineSlice(SR, { amplitude: 0.5 }) }))
          .pcm,
      ),
    );

    const attenuatedPeak = peak(
      interleavedSnapshot(
        renderChunk(
          initJob(makeJob(singleClipEdl({ gainDb: -6 }))),
          0,
          assetMap({ a1: sineSlice(SR, { amplitude: 0.5 }) }),
        ).pcm,
      ),
    );
    expect(attenuatedPeak / basePeak).toBeCloseTo(0.5, 1);
  });

  it('淡入让块首幅度接近 0，并在淡入结束后恢复', () => {
    const state = initJob(makeJob(singleClipEdl({ fadeIn: { durationSec: 0.1, curve: 'linear' } })));
    const result = renderChunk(state, 0, assetMap({ a1: sineSlice(SR) }));
    const pcm = interleavedSnapshot(result.pcm);
    expect(Math.abs(pcm[0] ?? 1)).toBeLessThan(50);
    expect(peak(pcm.subarray(SR / 2))).toBeGreaterThan(1000);
  });

  it('淡出让片段末尾幅度趋近 0', () => {
    const state = initJob(makeJob(singleClipEdl({ fadeOut: { durationSec: 0.1, curve: 'linear' } })));
    const result = renderChunk(state, 0, assetMap({ a1: sineSlice(SR) }));
    const pcm = interleavedSnapshot(result.pcm);
    const lastPeak = peak(pcm.subarray(SR - 200));
    expect(lastPeak).toBeLessThan(peak(pcm.subarray(SR / 2)) / 10);
  });

  it('静音轨道不参与混音', () => {
    const edl = singleClipEdl();
    edl.tracks[0]!.muted = true;
    const result = renderChunk(initJob(makeJob(edl)), 0, assetMap({ a1: sineSlice(SR) }));
    expect(peak(result.pcm)).toBe(0);
  });

  it('solo 优先：只渲染 solo 轨', () => {
    const edl: Edl = {
      sampleRate: SR,
      channels: 1,
      assets: [makeAsset('a1', 1), makeAsset('a2', 1)],
      tracks: [
        makeTrack('t1', [makeClip({ id: 'c1', assetId: 'a1' })], { solo: true }),
        makeTrack('t2', [makeClip({ id: 'c2', assetId: 'a2' })], { order: 1 }),
      ],
    };
    const result = renderChunk(
      initJob(makeJob(edl)),
      0,
      assetMap({
        a1: sineSlice(SR, { freq: 440 }),
        a2: sineSlice(SR, { freq: 440 }),
      }),
    );
    // solo 轨被渲染两次（轨道内叠加一次），非 solo 轨被跳过：峰值应大于单轨
    const soloOnly = renderChunk(
      initJob(makeJob({ ...edl, tracks: [edl.tracks[0]!] })),
      0,
      assetMap({ a1: sineSlice(SR, { freq: 440 }) }),
    );
    expect(peak(interleavedSnapshot(result.pcm))).toBeCloseTo(
      peak(interleavedSnapshot(soloOnly.pcm)),
      0,
    );
  });

  it('空工程输出静音且不抛错', () => {
    const edl: Edl = { sampleRate: SR, channels: 1, assets: [], tracks: [] };
    const result = renderChunk(initJob(makeJob(edl)), 0, assetMap({}));
    expect(peak(result.pcm)).toBe(0);
    expect(result.frames).toBe(SR);
  });

  it('总线限制器让超限信号不越界，并标记 limited', () => {
    const state = initJob(makeJob(singleClipEdl({ gainDb: 12 })));
    const result = renderChunk(state, 0, assetMap({ a1: sineSlice(SR, { amplitude: 0.9 }) }));
    const ceiling = 32768 * 0.9661; // -0.3dBFS
    expect(peak(result.pcm)).toBeLessThanOrEqual(ceiling + 1);
    expect(result.limited).toBe(true);
  });

  it('关闭限制器时允许超限（后续编码阶段才削波）', () => {
    const state = initJob(makeJob(singleClipEdl({ gainDb: 12 }), { limiter: false }));
    const result = renderChunk(state, 0, assetMap({ a1: sineSlice(SR, { amplitude: 0.9 }) }));
    expect(result.limited).toBe(false);
    // Int16 满量程：正向 32767 / 负向 -32768
    expect(peak(result.pcm)).toBe(32768);
  });

  it('立体声交错正确（右声道为静音时不串音）', () => {
    const edl: Edl = {
      sampleRate: SR,
      channels: 2,
      assets: [makeAsset('a1', 1, { channels: 2 })],
      tracks: [makeTrack('t1', [makeClip({ id: 'c1', assetId: 'a1' })])],
    };
    const slice = sineSlice(SR, { channels: 2 });
    const data = slice.data;
    for (let i = 0; i < SR; i++) data[i * 2 + 1] = 0; // 右声道置零

    const state = initJob(makeJob(edl, { output: { sampleRate: SR, channels: 2 } }));
    const result = renderChunk(state, 0, assetMap({ a1: { ...slice, data } }));
    const pcm = interleavedSnapshot(result.pcm);
    let leftPeak = 0;
    let rightPeak = 0;
    for (let i = 0; i < result.frames; i++) {
      leftPeak = Math.max(leftPeak, Math.abs(pcm[i * 2] ?? 0));
      rightPeak = Math.max(rightPeak, Math.abs(pcm[i * 2 + 1] ?? 0));
    }
    expect(leftPeak).toBeGreaterThan(1000);
    expect(rightPeak).toBe(0);
    expect(chunkBounds(state, 0).frames).toBe(SR);
  });

  it('渲染多个块时每块都覆盖自身时间区间（跨块拼接无空洞）', () => {
    const edl = singleClipEdl({ sourceStart: 0, sourceEnd: 2 });
    edl.assets = [makeAsset('a1', 2)];
    const state = initJob(makeJob(edl, { range: { startSec: 0, endSec: 2 }, chunkSec: 1 }));
    const slice = sineSlice(SR * 2);

    const chunk0 = renderChunk(state, 0, assetMap({ a1: slice }));
    const first = interleavedSnapshot(chunk0.pcm);
    const chunk1 = renderChunk(state, 1, assetMap({ a1: slice }));
    const second = interleavedSnapshot(chunk1.pcm);

    expect(chunk1.isLast).toBe(true);
    expect(peak(first)).toBeGreaterThan(1000);
    expect(peak(second)).toBeGreaterThan(1000);
    // 第二块确实渲染了内容（而不是只输出块首的静音）
    expect(peak(second.subarray(0, 100))).toBeGreaterThan(0);
  });

  it('片段级 highpass 效果被应用（低频衰减）', () => {
    const edl = singleClipEdl({
      effects: [{ id: 'fx1', type: 'highpass', enabled: true, params: { freq: 8000 } }],
    });
    const state = initJob(makeJob(edl));
    const result = renderChunk(state, 0, assetMap({ a1: sineSlice(SR, { freq: 100 }) }));
    const filtered = peak(interleavedSnapshot(result.pcm));
    const unfiltered = peak(
      interleavedSnapshot(
        renderChunk(initJob(makeJob(singleClipEdl())), 0, assetMap({ a1: sineSlice(SR, { freq: 100 }) }))
          .pcm,
      ),
    );
    expect(filtered).toBeLessThan(unfiltered * 0.2);
  });

  it('未实现的效果类型被安全跳过', () => {
    const edl = singleClipEdl({
      effects: [{ id: 'fx1', type: 'reverb', enabled: true, params: { mix: 0.5 } }],
    });
    const result = renderChunk(initJob(makeJob(edl)), 0, assetMap({ a1: sineSlice(SR) }));
    expect(peak(result.pcm)).toBeGreaterThan(1000);
  });
});

describe('panGains', () => {
  it('等功率声像：端点与中点符合 cos/sin(π/4)', () => {
    expect(panGains(0).left).toBeCloseTo(Math.SQRT1_2, 6);
    expect(panGains(0).right).toBeCloseTo(Math.SQRT1_2, 6);
    expect(panGains(-1).left).toBeCloseTo(1, 6);
    expect(panGains(-1).right).toBeCloseTo(0, 6);
    expect(panGains(1).left).toBeCloseTo(0, 6);
    expect(panGains(1).right).toBeCloseTo(1, 6);
  });

  it('功率恒定（L² + R² = 1）', () => {
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const { left, right } = panGains(pan);
      expect(left * left + right * right).toBeCloseTo(1, 10);
    }
  });

  it('越界与非有限值被 clamp', () => {
    expect(panGains(5).right).toBeCloseTo(1, 6);
    expect(panGains(Number.NaN).left).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

/** 拷贝 scratch 视图（`renderChunk` 返回的是复用缓冲，多次调用会互相覆盖）。 */
function interleavedSnapshot(pcm: Int16Array): Int16Array {
  return Int16Array.from(pcm);
}
