import { describe, expect, it } from 'vitest';
import { layoutTimeline, markVisibility, timelineEndSec } from '../../miniprogram/core/view/timeline-layout';
import { makeAsset, makeClip, makeTrack } from '../edl/fixtures';
import type { Edl } from '../../miniprogram/core/types';

function buildEdl(tracks = [makeTrack('t1', [makeClip({ id: 'c1', sourceEnd: 4, timelineStart: 2 })])]): Edl {
  return {
    sampleRate: 44100,
    channels: 1,
    assets: [makeAsset('a1', 10), makeAsset('a2', 5)],
    tracks,
  };
}

const viewport = { startSec: 0, pxPerSecond: 10 };

describe('layoutTimeline', () => {
  it('把片段时间与时长换算成像素几何', () => {
    const [track] = layoutTimeline(buildEdl(), viewport);
    const [clip] = track?.clips ?? [];

    expect(clip?.leftPx).toBe(20); // 2s × 10px/s
    expect(clip?.widthPx).toBe(40); // 4s × 10px/s
    expect(clip?.timelineStartSec).toBe(2);
    expect(clip?.durationSec).toBe(4);
  });

  it('标签默认取素材名，缺失素材时标记 assetPresent=false', () => {
    const edl = buildEdl([makeTrack('t1', [makeClip({ id: 'c1', assetId: 'missing' })])]);
    const [track] = layoutTimeline(edl, viewport);
    expect(track?.clips[0]?.assetPresent).toBe(false);
    expect(track?.clips[0]?.label).toBe('片段');

    const withName = buildEdl();
    expect(layoutTimeline(withName, viewport)[0]?.clips[0]?.label).toBe('素材 a1');
  });

  it('增益到底视为静音，淡入淡出时长被带出', () => {
    const edl = buildEdl([
      makeTrack('t1', [
        makeClip({ id: 'c1', gainDb: -60 }),
        makeClip({ id: 'c2', timelineStart: 20, fadeIn: { durationSec: 0.5, curve: 'linear' }, fadeOut: { durationSec: 1, curve: 'equalPower' } }),
      ]),
    ]);
    const [track] = layoutTimeline(edl, viewport);

    expect(track?.clips[0]?.muted).toBe(true);
    expect(track?.clips[1]?.muted).toBe(false);
    expect(track?.clips[1]?.fadeInSec).toBeCloseTo(0.5, 6);
    expect(track?.clips[1]?.fadeOutSec).toBeCloseTo(1, 6);
  });

  it('轨道按 order 排序，audible 反映 mute 与 solo', () => {
    const edl = buildEdl([
      makeTrack('t1', [makeClip()], { order: 1, muted: true }),
      makeTrack('t2', [makeClip({ id: 'c2' })], { order: 0, solo: true }),
    ]);
    const tracks = layoutTimeline(edl, viewport);

    expect(tracks.map((track) => track.trackId)).toEqual(['t2', 't1']);
    expect(tracks[0]?.audible).toBe(true);
    expect(tracks[1]?.audible).toBe(false);
  });

  it('宽度至少 1px，且极端缩放下不会变成负数', () => {
    const edl = buildEdl([makeTrack('t1', [makeClip({ sourceEnd: 0.0001 })])]);
    expect(layoutTimeline(edl, { startSec: 0, pxPerSecond: 4 })[0]?.clips[0]?.widthPx).toBe(1);
  });

  it('timelineEndSec 取所有轨道的最右端', () => {
    const edl = buildEdl([
      makeTrack('t1', [makeClip({ id: 'c1', sourceEnd: 2, timelineStart: 0 })]),
      makeTrack('t2', [makeClip({ id: 'c2', sourceEnd: 3, timelineStart: 10 })], { order: 1 }),
    ]);
    expect(timelineEndSec(layoutTimeline(edl, viewport))).toBeCloseTo(13, 6);
  });
});

describe('markVisibility', () => {
  it('只把与视口相交的片段标为可见', () => {
    const edl = buildEdl([
      makeTrack('t1', [
        makeClip({ id: 'c1', sourceEnd: 2, timelineStart: 0 }),
        makeClip({ id: 'c2', sourceEnd: 2, timelineStart: 100 }),
      ]),
    ]);
    const tracks = markVisibility(layoutTimeline(edl, viewport), viewport, 300);

    expect(tracks[0]?.clips[0]?.visible).toBe(true);
    expect(tracks[0]?.clips[1]?.visible).toBe(false);
  });

  it('边界相接不算相交（片段刚好在视口右侧之外）', () => {
    const edl = buildEdl([makeTrack('t1', [makeClip({ id: 'c1', sourceEnd: 2, timelineStart: 30 })])]);
    // 视口 0~30s（300px / 10px 每秒）
    const tracks = markVisibility(layoutTimeline(edl, viewport), viewport, 300);
    expect(tracks[0]?.clips[0]?.visible).toBe(false);
  });
});
