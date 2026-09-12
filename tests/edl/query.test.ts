import { describe, expect, it } from 'vitest';
import {
  assetById,
  clipAt,
  clipDurationSec,
  clipEndSec,
  clipsInRange,
  clipSourceSpanSec,
  edlDurationSec,
  hasSolo,
  isTrackAudible,
  referencedAssetIds,
  sourceTimeAt,
  trackDurationSec,
} from '../../miniprogram/workers/render/edl/query';
import { makeAsset, makeClip, makeEdl, makeTrack } from './fixtures';

describe('时长推导', () => {
  it('片段时长 = 素材跨度 / speed', () => {
    expect(clipSourceSpanSec(makeClip({ sourceStart: 1, sourceEnd: 4 }))).toBe(3);
    expect(clipDurationSec(makeClip({ sourceStart: 1, sourceEnd: 4 }))).toBe(3);
    expect(clipDurationSec(makeClip({ sourceStart: 1, sourceEnd: 4, speed: 2 }))).toBe(1.5);
    expect(clipDurationSec(makeClip({ sourceStart: 1, sourceEnd: 4, speed: 0.5 }))).toBe(6);
  });

  it('素材区间反向时不产生负时长', () => {
    expect(clipSourceSpanSec(makeClip({ sourceStart: 5, sourceEnd: 2 }))).toBe(0);
  });

  it('clipEndSec / trackDurationSec / edlDurationSec 逐级推导', () => {
    const clip = makeClip({ sourceStart: 0, sourceEnd: 4, timelineStart: 2 });
    expect(clipEndSec(clip)).toBe(6);

    const track = makeTrack('t1', [clip, makeClip({ id: 'c2', sourceEnd: 2, timelineStart: 10 })]);
    expect(trackDurationSec(track)).toBe(12);

    const edl = { ...makeEdl(), tracks: [track, makeTrack('t2', [makeClip({ id: 'c3', sourceEnd: 20 })])] };
    expect(edlDurationSec(edl)).toBe(20);
    expect(edlDurationSec({ ...edl, tracks: [] })).toBe(0);
  });
});

describe('可听性（solo 优先级）', () => {
  it('muted 轨道不可听', () => {
    const edl = makeEdl();
    const track = makeTrack('t1', [], { muted: true });
    expect(isTrackAudible(edl, track)).toBe(false);
  });

  it('存在 solo 时只有 solo 轨道可听', () => {
    const solo = makeTrack('t1', [], { solo: true });
    const normal = makeTrack('t2', []);
    const edl = { ...makeEdl(), tracks: [solo, normal] };
    expect(hasSolo(edl)).toBe(true);
    expect(isTrackAudible(edl, solo)).toBe(true);
    expect(isTrackAudible(edl, normal)).toBe(false);
  });

  it('无 solo 时未静音轨道都可听', () => {
    const edl = makeEdl();
    expect(isTrackAudible(edl, makeTrack('t2', []))).toBe(true);
  });
});

describe('区间查询', () => {
  it('clipsInRange 返回相交片段并按起点升序', () => {
    const track = makeTrack('t1', [
      makeClip({ id: 'late', sourceEnd: 2, timelineStart: 8 }),
      makeClip({ id: 'early', sourceEnd: 2, timelineStart: 0 }),
      makeClip({ id: 'mid', sourceEnd: 2, timelineStart: 4 }),
    ]);
    const hit = clipsInRange(track, 1, 5).map((clip) => clip.id);
    expect(hit).toEqual(['early', 'mid']);
    expect(clipsInRange(track, 3, 4)).toEqual([]);
    expect(clipsInRange(track, 5, 5)).toEqual([]);
    expect(clipsInRange(track, 0, 100).map((c) => c.id)).toEqual(['early', 'mid', 'late']);
  });

  it('片段边界按左闭右开处理', () => {
    const track = makeTrack('t1', [makeClip({ sourceStart: 0, sourceEnd: 2 })]);
    expect(clipsInRange(track, 0, 2).length).toBe(1);
    expect(clipsInRange(track, 2, 3).length).toBe(0);
  });

  it('clipAt 命中重叠处最靠后的片段', () => {
    const track = makeTrack('t1', [
      makeClip({ id: 'a', sourceEnd: 10, timelineStart: 0 }),
      makeClip({ id: 'b', sourceStart: 0, sourceEnd: 3, timelineStart: 2 }),
    ]);
    expect(clipAt(track, 1)?.id).toBe('a');
    expect(clipAt(track, 3)?.id).toBe('b');
    expect(clipAt(track, 11)).toBeUndefined();
  });
});

describe('sourceTimeAt', () => {
  it('非循环片段按 speed 线性映射', () => {
    const clip = makeClip({ sourceStart: 1, sourceEnd: 5, timelineStart: 10, speed: 2 });
    expect(sourceTimeAt(clip, 10)).toBe(1);
    expect(sourceTimeAt(clip, 11)).toBe(3);
  });

  it('循环片段对素材跨度取模', () => {
    const clip = makeClip({ sourceStart: 1, sourceEnd: 3, timelineStart: 0, loop: true });
    expect(sourceTimeAt(clip, 0)).toBe(1);
    expect(sourceTimeAt(clip, 2)).toBe(1); // 恰好一个循环后回到起点
    expect(sourceTimeAt(clip, 3)).toBe(2);
    expect(sourceTimeAt(clip, 5)).toBe(2); // 5 → 取模 1 → 1 + 1
  });

  it('零跨度与反向区间不产生 NaN', () => {
    expect(Number.isFinite(sourceTimeAt(makeClip({ sourceStart: 2, sourceEnd: 2 }), 5))).toBe(true);
    expect(Number.isFinite(sourceTimeAt(makeClip({ sourceStart: 5, sourceEnd: 2 }), 5))).toBe(true);
  });
});

describe('素材索引', () => {
  it('assetById / referencedAssetIds', () => {
    const edl = {
      ...makeEdl(),
      assets: [makeAsset('a1', 10), makeAsset('a2', 5)],
      tracks: [makeTrack('t1', [makeClip({ assetId: 'a2' })])],
    };
    expect(assetById(edl, 'a2')?.durationSec).toBe(5);
    expect(assetById(edl, 'missing')).toBeUndefined();
    expect(Array.from(referencedAssetIds(edl))).toEqual(['a2']);
  });
});
