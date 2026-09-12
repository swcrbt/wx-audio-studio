import { describe, expect, it } from 'vitest';
import {
  addClip,
  cloneEdl,
  createEmptyEdl,
  deleteRange,
  frameAlignSec,
  moveClip,
  removeClip,
  setClipFade,
  setClipGainDb,
  snapSec,
  splitClipAt,
  trimToRange,
  updateClip,
  updateTrack,
  upsertAsset,
} from '../../miniprogram/workers/render/edl/ops';
import { clipDurationSec, clipEndSec, edlDurationSec } from '../../miniprogram/workers/render/edl/query';
import { validateEdl } from '../../miniprogram/workers/render/edl/validate';
import { idFactory, makeAsset, makeClip, makeEdl, makeTrack } from './fixtures';

describe('frameAlignSec', () => {
  it('对齐到采样帧边界（docs/05 §9）', () => {
    expect(frameAlignSec(0.1, 44100)).toBeCloseTo(4410 / 44100, 12);
    expect(frameAlignSec(1 / 3, 44100)).toBeCloseTo(Math.round(44100 / 3) / 44100, 12);
    expect(frameAlignSec(1, 44100)).toBe(1);
  });

  it('非有限值返回 0', () => {
    expect(frameAlignSec(Number.NaN, 44100)).toBe(0);
    expect(frameAlignSec(1, 0)).toBe(0);
  });
});

describe('不可变性', () => {
  it('cloneEdl 是深拷贝：改副本不影响原 EDL', () => {
    const edl = makeEdl();
    const copy = cloneEdl(edl);
    copy.tracks[0]!.clips[0]!.sourceEnd = 99;
    copy.tracks[0]!.clips[0]!.effects.push({
      id: 'x',
      type: 'gain',
      enabled: true,
      params: { a: 1 },
    });
    copy.assets[0]!.peakRef.levels.push({ bucketSize: 1, count: 1 });
    expect(edl.tracks[0]!.clips[0]!.sourceEnd).toBe(5);
    expect(edl.tracks[0]!.clips[0]!.effects.length).toBe(0);
    expect(edl.assets[0]!.peakRef.levels.length).toBe(1);
  });

  it('ops 全部返回新对象，原 EDL 保持不变', () => {
    const edl = makeEdl();
    const snapshot = JSON.stringify(edl);
    const next = addClip(edl, 't1', makeClip({ id: 'c2', sourceEnd: 3, timelineStart: 5 }));
    moveClip(next, 't1', 'c2', 6);
    updateClip(next, 't1', 'c2', { gainDb: 3 });
    removeClip(next, 't1', 'c2');
    setClipGainDb(next, 't1', 'c1', -6);
    updateTrack(next, 't1', { muted: true });
    upsertAsset(next, makeAsset('a9', 1));
    expect(JSON.stringify(edl)).toBe(snapshot);
  });
});

describe('addClip', () => {
  it('clamp 素材区间到素材时长、起点帧对齐、按起点排序', () => {
    const edl = makeEdl();
    const next = addClip(
      edl,
      't1',
      makeClip({ id: 'c2', sourceStart: -1, sourceEnd: 99, timelineStart: 1.00001 }),
    );
    const clips = next.tracks[0]!.clips;
    const added = clips.find((clip) => clip.id === 'c2')!;
    expect(added.sourceStart).toBe(0);
    expect(added.sourceEnd).toBe(10); // 素材时长
    expect(added.timelineStart).toBeCloseTo(1, 6);
    expect(clips.map((clip) => clip.timelineStart)).toEqual([...clips.map((c) => c.timelineStart)].sort((a, b) => a - b));
  });

  it('新片段叠加在已有片段之后（允许重叠，用于交叉淡化）', () => {
    const edl = makeEdl();
    const next = addClip(edl, 't1', makeClip({ id: 'c2', sourceEnd: 2, timelineStart: 1 }));
    expect(next.tracks[0]!.clips.map((clip) => clip.id)).toEqual(['c1', 'c2']);
  });

  it('轨道不存在时返回原 EDL', () => {
    const edl = makeEdl();
    expect(addClip(edl, 'missing', makeClip({ id: 'c2' }))).toBe(edl);
  });
});

describe('moveClip / updateClip', () => {
  it('moveClip 把负值归零并对齐到采样帧', () => {
    const next = moveClip(makeEdl(), 't1', 'c1', -3);
    expect(next.tracks[0]!.clips[0]!.timelineStart).toBe(0);
    const moved = moveClip(makeEdl(), 't1', 'c1', 2.00002);
    // 对齐到最近的采样帧，而不是取整到 2.0
    expect(moved.tracks[0]!.clips[0]!.timelineStart).toBe(Math.round(2.00002 * 44100) / 44100);
  });

  it('updateClip 修改区间后重新 clamp 与排序', () => {
    const next = updateClip(makeEdl(), 't1', 'c1', { sourceEnd: 999, timelineStart: 30 });
    expect(next.tracks[0]!.clips[0]!.sourceEnd).toBe(10);
    expect(next.tracks[0]!.clips[0]!.timelineStart).toBe(30);
  });

  it('updateTrack 限制 pan 范围', () => {
    const next = updateTrack(makeEdl(), 't1', { pan: 5, gainDb: -3 });
    expect(next.tracks[0]!.pan).toBe(1);
    expect(next.tracks[0]!.gainDb).toBe(-3);
  });
});

describe('splitClipAt', () => {
  it('在指定位置切成两段，素材区间精确映射', () => {
    const next = splitClipAt(makeEdl(), 't1', 'c1', 2, idFactory()());
    const clips = next.tracks[0]!.clips;
    expect(clips.length).toBe(2);
    expect(clips[0]!.sourceStart).toBe(0);
    expect(clips[0]!.sourceEnd).toBe(2);
    expect(clips[1]!.sourceStart).toBe(2);
    expect(clips[1]!.sourceEnd).toBe(5);
    expect(clips[1]!.timelineStart).toBe(2);
  });

  it('带变速时按 speed 映射素材位置', () => {
    const edl = { ...makeEdl(), tracks: [makeTrack('t1', [makeClip({ speed: 2, sourceEnd: 5 })])] };
    const next = splitClipAt(edl, 't1', 'c1', 1, 'c2');
    expect(next.tracks[0]!.clips[0]!.sourceEnd).toBe(2);
    expect(next.tracks[0]!.clips[1]!.sourceStart).toBe(2);
    expect(clipDurationSec(next.tracks[0]!.clips[1]!)).toBeCloseTo(1.5, 6);
  });

  it('无效切点（区间外/边界）返回原 EDL', () => {
    const edl = makeEdl();
    expect(splitClipAt(edl, 't1', 'c1', 0, 'c2')).toBe(edl);
    expect(splitClipAt(edl, 't1', 'c1', 5, 'c2')).toBe(edl);
    expect(splitClipAt(edl, 't1', 'c1', 99, 'c2')).toBe(edl);
    expect(splitClipAt(edl, 't1', 'missing', 2, 'c2')).toBe(edl);
  });
});

describe('deleteRange', () => {
  it('波纹删除：后续片段前移（ED-6）', () => {
    const next = deleteRange(makeEdl(), { startSec: 1, endSec: 2 }, { ripple: true }, idFactory());
    const clips = next.tracks[0]!.clips;
    expect(clips.length).toBe(2);
    expect(clips[0]!.sourceStart).toBe(0);
    expect(clips[0]!.sourceEnd).toBe(1);
    expect(clips[1]!.sourceStart).toBe(2);
    expect(clips[1]!.timelineStart).toBe(1);
    expect(edlDurationSec(next)).toBeCloseTo(4, 6);
  });

  it('非波纹删除：位置不变，等价于静音（ED-9）', () => {
    const next = deleteRange(makeEdl(), { startSec: 1, endSec: 2 }, { ripple: false }, idFactory());
    const clips = next.tracks[0]!.clips;
    expect(clips.length).toBe(2);
    expect(clips[1]!.timelineStart).toBe(2);
    expect(edlDurationSec(next)).toBeCloseTo(5, 6);
  });

  it('删除覆盖整个片段时片段消失', () => {
    const next = deleteRange(makeEdl(), { startSec: 0, endSec: 10 }, { ripple: true }, idFactory());
    expect(next.tracks[0]!.clips.length).toBe(0);
    expect(edlDurationSec(next)).toBe(0);
  });

  it('循环片段（BGM）不参与区间切分，相交即整体移除', () => {
    const edl = {
      ...makeEdl(),
      tracks: [makeTrack('t1', [makeClip({ loop: true, sourceEnd: 2, timelineStart: 0 })])],
    };
    const next = deleteRange(edl, { startSec: 1, endSec: 1.5 }, { ripple: false }, idFactory());
    expect(next.tracks[0]!.clips.length).toBe(0);
  });

  it('空区间或反序区间返回原 EDL', () => {
    const edl = makeEdl();
    expect(deleteRange(edl, { startSec: 2, endSec: 2 }, { ripple: true }, idFactory())).toBe(edl);
    const reversed = deleteRange(edl, { startSec: 3, endSec: 1 }, { ripple: true }, idFactory());
    expect(reversed.tracks[0]!.clips.length).toBe(2); // 被规范成 [1,3) 后执行
  });

  it('与片段不相交的区间不改变片段', () => {
    const next = deleteRange(makeEdl(), { startSec: 20, endSec: 21 }, { ripple: true }, idFactory());
    expect(next.tracks[0]!.clips.length).toBe(1);
    expect(next.tracks[0]!.clips[0]!.timelineStart).toBe(0);
  });
});

describe('trimToRange', () => {
  it('裁剪到选区并平移起点（ED-5）', () => {
    const next = trimToRange(makeEdl(), { startSec: 2, endSec: 4 }, idFactory());
    const clips = next.tracks[0]!.clips;
    expect(clips.length).toBe(1);
    expect(clips[0]!.sourceStart).toBe(2);
    expect(clips[0]!.sourceEnd).toBe(4);
    expect(clips[0]!.timelineStart).toBe(0);
    expect(clipDurationSec(clips[0]!)).toBeCloseTo(2, 6);
  });

  it('区间跨越两个片段时保留各自的重叠部分', () => {
    const edl = {
      ...makeEdl(),
      tracks: [
        makeTrack('t1', [
          makeClip({ id: 'c1', sourceStart: 0, sourceEnd: 2, timelineStart: 0 }),
          makeClip({ id: 'c2', sourceStart: 0, sourceEnd: 2, timelineStart: 2 }),
        ]),
      ],
    };
    const next = trimToRange(edl, { startSec: 1, endSec: 3 }, idFactory());
    const clips = next.tracks[0]!.clips;
    expect(clips.length).toBe(2);
    expect(clips[0]!.sourceStart).toBe(1);
    expect(clips[0]!.sourceEnd).toBe(2);
    expect(clips[0]!.timelineStart).toBe(0);
    expect(clips[1]!.sourceEnd).toBe(1);
    expect(clips[1]!.timelineStart).toBe(1);
  });

  it('空区间返回原 EDL', () => {
    const edl = makeEdl();
    expect(trimToRange(edl, { startSec: 1, endSec: 1 }, idFactory())).toBe(edl);
  });
});

describe('setClipGainDb / setClipFade', () => {
  it('增益被 clamp 到 -60 ~ +12 dB', () => {
    expect(setClipGainDb(makeEdl(), 't1', 'c1', -100).tracks[0]!.clips[0]!.gainDb).toBe(-60);
    expect(setClipGainDb(makeEdl(), 't1', 'c1', 100).tracks[0]!.clips[0]!.gainDb).toBe(12);
    expect(setClipGainDb(makeEdl(), 't1', 'c1', Number.NaN).tracks[0]!.clips[0]!.gainDb).toBe(0);
  });

  it('淡入淡出被 clamp 到片段时长，且 null 表示取消', () => {
    const next = setClipFade(makeEdl(), 't1', 'c1', 'in', { durationSec: 99, curve: 'linear' });
    expect(next.tracks[0]!.clips[0]!.fadeIn?.durationSec).toBeCloseTo(5, 6);

    const cleared = setClipFade(next, 't1', 'c1', 'in', null);
    expect(cleared.tracks[0]!.clips[0]!.fadeIn).toBeNull();

    const zero = setClipFade(makeEdl(), 't1', 'c1', 'out', { durationSec: 0, curve: 'linear' });
    expect(zero.tracks[0]!.clips[0]!.fadeOut).toBeNull();
  });
});

describe('snapSec', () => {
  it('吸附到候选边界（容差内）', () => {
    expect(snapSec(1.03, [1, 5])).toBe(1);
    expect(snapSec(4.95, [1, 5])).toBe(5);
  });

  it('无候选时吸附到 0.1s 网格', () => {
    expect(snapSec(1.024, [])).toBeCloseTo(1.0, 6);
    expect(snapSec(1.07, [])).toBeCloseTo(1.1, 6);
  });

  it('超出容差时保持原值', () => {
    expect(snapSec(1.5, [1, 5])).toBe(1.5);
  });
});

describe('属性式不变量（docs/06 §2.1）', () => {
  it('随机操作序列后 EDL 始终满足校验不变量', () => {
    let edl = makeEdl();
    const nextId = idFactory();
    let state = 7;
    const rand = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };

    for (let step = 0; step < 200; step++) {
      const op = Math.floor(rand() * 6);
      const t0 = rand() * 12;
      const t1 = t0 + rand() * 3;
      const ids = new Set<string>();
      if (op === 0) edl = addClip(edl, 't1', makeClip({ id: nextId(), sourceStart: t0, sourceEnd: t1, timelineStart: rand() * 6 }));
      else if (op === 1) edl = deleteRange(edl, { startSec: t0, endSec: t1 }, { ripple: rand() > 0.5 }, nextId);
      else if (op === 2) edl = trimToRange(edl, { startSec: t0, endSec: t0 + 4 }, nextId);
      else if (op === 3) edl = moveClip(edl, 't1', 'c1', t0 - 1);
      else if (op === 4) edl = updateClip(edl, 't1', 'c1', { sourceStart: t0, sourceEnd: t1 });
      else edl = setClipFade(edl, 't1', 'c1', 'in', { durationSec: t0, curve: 'equalPower' });

      // 每一步都复核：无 issue、时长非负、素材区间不越界、起点非负
      const { issues } = validateEdl(edl);
      expect(issues).toEqual([]);
      expect(edlDurationSec(edl)).toBeGreaterThanOrEqual(0);
      const assetDuration = edl.assets[0]?.durationSec ?? 0;
      for (const track of edl.tracks) {
        for (const clip of track.clips) {
          expect(clip.sourceStart).toBeGreaterThanOrEqual(0);
          expect(clip.sourceEnd).toBeGreaterThan(clip.sourceStart);
          expect(clip.sourceEnd).toBeLessThanOrEqual(assetDuration + 1 / edl.sampleRate);
          expect(clip.timelineStart).toBeGreaterThanOrEqual(0);
          expect(clipEndSec(clip)).toBeGreaterThanOrEqual(clip.timelineStart);
          for (const id of ids) expect(id).not.toBe(clip.id);
          ids.add(clip.id);
        }
      }
    }
  });

  it('createEmptyEdl 产出空工程骨架', () => {
    const edl = createEmptyEdl(22050, 2);
    expect(edl.sampleRate).toBe(22050);
    expect(edl.channels).toBe(2);
    expect(edl.tracks).toEqual([]);
    expect(edl.assets).toEqual([]);
  });
});
