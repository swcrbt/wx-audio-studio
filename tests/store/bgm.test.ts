import { describe, expect, it } from 'vitest';
import { MAX_BGM_CLIPS, buildBgmClips, mainDurationSec } from '../../miniprogram/core/store/bgm';
import { makeAsset, makeClip, makeTrack } from '../edl/fixtures';
import type { Edl } from '../../miniprogram/core/types';

function counter(prefix = 'c'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

describe('buildBgmClips', () => {
  it('恰好整除时铺满且首尾相接', () => {
    const clips = buildBgmClips(makeAsset('a1', 30), 90, counter());
    expect(clips).toHaveLength(3);
    expect(clips.map((clip) => clip.timelineStart)).toEqual([0, 30, 60]);
    expect(clips.every((clip) => clip.sourceEnd === 30)).toBe(true);
  });

  it('最后一段按剩余时长截断', () => {
    const clips = buildBgmClips(makeAsset('a1', 30), 75, counter());
    expect(clips).toHaveLength(3);
    expect(clips[2]?.timelineStart).toBe(60);
    expect(clips[2]?.sourceEnd).toBeCloseTo(15, 6);
  });

  it('不使用 loop 标记（用连续片段表达循环）', () => {
    const clips = buildBgmClips(makeAsset('a1', 10), 25, counter());
    expect(clips.every((clip) => clip.loop === false)).toBe(true);
  });

  it('目标比素材还短时只铺一段', () => {
    const clips = buildBgmClips(makeAsset('a1', 60), 12, counter());
    expect(clips).toHaveLength(1);
    expect(clips[0]?.sourceEnd).toBeCloseTo(12, 6);
  });

  it('忽略过短的尾巴，不生成碎片片段', () => {
    const clips = buildBgmClips(makeAsset('a1', 10), 20.02, counter());
    expect(clips).toHaveLength(2);
  });

  it('非法输入返回空数组', () => {
    expect(buildBgmClips(makeAsset('a1', 0), 10, counter())).toEqual([]);
    expect(buildBgmClips(makeAsset('a1', 10), 0, counter())).toEqual([]);
    expect(buildBgmClips(makeAsset('a1', 10), -5, counter())).toEqual([]);
  });

  it('极短素材也不会无限循环（有片段数上限）', () => {
    const clips = buildBgmClips(makeAsset('a1', 0.06), 600, counter());
    expect(clips.length).toBeLessThanOrEqual(MAX_BGM_CLIPS);
  });
});

describe('mainDurationSec', () => {
  const edl: Edl = {
    sampleRate: 44100,
    channels: 1,
    assets: [makeAsset('a1', 100)],
    tracks: [
      makeTrack('t1', [makeClip({ id: 'c1', sourceEnd: 40, timelineStart: 0 })]),
      makeTrack('bgm', [makeClip({ id: 'c2', sourceEnd: 40, timelineStart: 0 })], { order: 1 }),
    ],
  };

  it('默认取所有轨道的最长时长', () => {
    expect(mainDurationSec(edl)).toBeCloseTo(40, 6);
  });

  it('排除 BGM 轨后取人声轨时长（重铺时用）', () => {
    expect(mainDurationSec(edl, ['bgm'])).toBeCloseTo(40, 6);

    const longerBgm: Edl = {
      ...edl,
      tracks: [
        edl.tracks[0] as (typeof edl.tracks)[number],
        makeTrack('bgm', [makeClip({ id: 'c2', sourceEnd: 200, timelineStart: 0 })], { order: 1 }),
      ],
    };
    expect(mainDurationSec(longerBgm, ['bgm'])).toBeCloseTo(40, 6);
  });
});
