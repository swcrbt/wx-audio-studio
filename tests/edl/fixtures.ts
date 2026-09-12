/**
 * EDL 测试夹具（非测试文件，vitest 只收集 `*.test.ts`）。
 */
import type { Asset, Clip, Edl, Track } from '../../miniprogram/core/types';

export function makeAsset(id: string, durationSec: number, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    name: `素材 ${id}`,
    origin: 'record',
    path: `assets/${id}.wav`,
    sampleRate: 44100,
    channels: 1,
    durationSec,
    frames: Math.round(durationSec * 44100),
    bytes: Math.round(durationSec * 44100 * 2),
    peakRef: { path: `peaks/${id}.pk`, levels: [{ bucketSize: 1024, count: 8 }] },
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    assetId: 'a1',
    sourceStart: 0,
    sourceEnd: 5,
    timelineStart: 0,
    gainDb: 0,
    fadeIn: null,
    fadeOut: null,
    speed: 1,
    loop: false,
    effects: [],
    ...overrides,
  };
}

export function makeTrack(id: string, clips: Clip[], overrides: Partial<Track> = {}): Track {
  return {
    id,
    name: `轨道 ${id}`,
    order: 0,
    gainDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    effects: [],
    clips,
    ...overrides,
  };
}

/** 单轨 EDL：一个 10s 素材、一个 [0, 5) 的片段。 */
export function makeEdl(): Edl {
  return {
    sampleRate: 44100,
    channels: 1,
    assets: [makeAsset('a1', 10)],
    tracks: [makeTrack('t1', [makeClip()])],
  };
}

/** 顺序递增的 id 生成器（测试可预期）。 */
export function idFactory(prefix = 'new'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
