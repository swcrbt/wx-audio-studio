import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  migrateProject,
  validateEdl,
} from '../../miniprogram/workers/render/edl/validate';
import { makeAsset, makeClip, makeEdl, makeTrack } from './fixtures';

describe('migrateProject', () => {
  const validRaw = {
    schemaVersion: 1,
    id: 'p1',
    name: '播客第03期',
    createdAt: 1,
    updatedAt: 2,
    sampleRate: 44100,
    channels: 1,
    assets: [makeAsset('a1', 10)],
    tracks: [makeTrack('t1', [makeClip()])],
    summary: { durationSec: 5, assetCount: 1, clipCount: 1 },
  };

  it('合法 JSON 完整还原', () => {
    const project = migrateProject(validRaw);
    expect(project).not.toBeNull();
    expect(project?.id).toBe('p1');
    expect(project?.sampleRate).toBe(44100);
    expect(project?.assets.length).toBe(1);
    expect(project?.tracks[0]?.clips.length).toBe(1);
    expect(project?.summary.durationSec).toBe(5);
  });

  it('缺失字段补默认值，并把 schemaVersion 提升到当前版本', () => {
    const project = migrateProject({ id: 'p2' });
    expect(project?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project?.name).toBe('未命名工程');
    expect(project?.sampleRate).toBe(44100);
    expect(project?.channels).toBe(1);
    expect(project?.assets).toEqual([]);
    expect(project?.tracks).toEqual([]);
    expect(project?.summary.clipCount).toBe(0);
  });

  it('v0（无 schemaVersion）走迁移函数', () => {
    const project = migrateProject({ id: 'p0', sampleRate: 22050 });
    expect(project?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project?.sampleRate).toBe(22050);
  });

  it('版本高于当前或结构不可用时返回 null（不猜测、不覆盖）', () => {
    expect(migrateProject({ ...validRaw, schemaVersion: 99 })).toBeNull();
    expect(migrateProject(null)).toBeNull();
    expect(migrateProject('x')).toBeNull();
    expect(migrateProject([])).toBeNull();
    expect(migrateProject({ schemaVersion: 1 })).toBeNull(); // 缺 id
  });

  it('忽略未知字段（向前兼容），非法枚举回落到安全默认', () => {
    const project = migrateProject({
      ...validRaw,
      somethingNew: { nested: true },
      sampleRate: 12345,
      channels: 7,
      exportDefaults: { format: 'flac', sampleRate: 22050, channels: 2 },
    });
    expect(project?.sampleRate).toBe(44100);
    expect(project?.channels).toBe(1);
    expect(project?.exportDefaults?.format).toBeUndefined();
    expect(project?.exportDefaults?.sampleRate).toBe(22050);
    expect(project?.exportDefaults?.channels).toBe(2);
    expect(project).not.toHaveProperty('somethingNew');
  });

  it('过滤结构非法的素材与轨道，不整体失败', () => {
    const project = migrateProject({
      ...validRaw,
      assets: [makeAsset('a1', 10), { name: '坏素材' }, null],
      tracks: [makeTrack('t1', [makeClip()]), 'bad'],
    });
    expect(project?.assets.length).toBe(1);
    expect(project?.tracks.length).toBe(1);
  });

  it('summary.clipCount 由轨道推导（不信任落盘值）', () => {
    const project = migrateProject({
      ...validRaw,
      tracks: [makeTrack('t1', [makeClip({ id: 'c1' }), makeClip({ id: 'c2' })])],
      summary: { durationSec: 5, assetCount: 1, clipCount: 999 },
    });
    expect(project?.summary.clipCount).toBe(2);
  });
});

describe('validateEdl', () => {
  it('干净的 EDL 不产生 issue', () => {
    expect(validateEdl(makeEdl()).issues).toEqual([]);
  });

  it('移除引用不存在素材的片段并记录', () => {
    const edl = {
      ...makeEdl(),
      tracks: [makeTrack('t1', [makeClip({ id: 'c1' }), makeClip({ id: 'c2', assetId: 'ghost' })])],
    };
    const result = validateEdl(edl);
    expect(result.edl.tracks[0]?.clips.map((clip) => clip.id)).toEqual(['c1']);
    expect(result.issues.map((issue) => issue.code)).toEqual(['assetMissing']);
  });

  it('clamp 越界的素材区间与负起点', () => {
    const edl = {
      ...makeEdl(),
      tracks: [
        makeTrack('t1', [
          makeClip({ id: 'c1', sourceStart: -2, sourceEnd: 99, timelineStart: -5 }),
        ]),
      ],
    };
    const result = validateEdl(edl);
    const clip = result.edl.tracks[0]!.clips[0]!;
    expect(clip.sourceStart).toBe(0);
    expect(clip.sourceEnd).toBe(10); // 素材时长
    expect(clip.timelineStart).toBe(0);
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      'negativeStart',
      'rangeClamped',
      'rangeClamped',
    ]);
  });

  it('修正空区间与非法 speed', () => {
    const edl = {
      ...makeEdl(),
      tracks: [
        makeTrack('t1', [makeClip({ id: 'c1', sourceStart: 4, sourceEnd: 4, speed: 0 })]),
      ],
    };
    const result = validateEdl(edl);
    const clip = result.edl.tracks[0]!.clips[0]!;
    expect(clip.sourceEnd).toBeGreaterThan(clip.sourceStart);
    expect(clip.speed).toBe(1);
    expect(result.issues.map((issue) => issue.code).sort()).toEqual(['invalidSpeed', 'rangeClamped']);
  });

  it('重命名重复的片段与轨道 id', () => {
    const edl = {
      ...makeEdl(),
      tracks: [
        makeTrack('t1', [makeClip({ id: 'dup' }), makeClip({ id: 'dup', timelineStart: 6 })]),
        makeTrack('t1', []),
      ],
    };
    const result = validateEdl(edl);
    const ids = result.edl.tracks.flatMap((track) => track.clips.map((clip) => clip.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(result.edl.tracks.map((track) => track.id)).size).toBe(2);
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      'duplicateClipId',
      'duplicateTrackId',
    ]);
  });

  it('轨道内片段按 timelineStart 排序', () => {
    const edl = {
      ...makeEdl(),
      tracks: [
        makeTrack('t1', [
          makeClip({ id: 'late', sourceEnd: 1, timelineStart: 5 }),
          makeClip({ id: 'early', sourceEnd: 1, timelineStart: 1 }),
        ]),
      ],
    };
    const result = validateEdl(edl);
    expect(result.edl.tracks[0]!.clips.map((clip) => clip.id)).toEqual(['early', 'late']);
  });

  it('validateEdl 不修改传入的 EDL', () => {
    const edl = makeEdl();
    const snapshot = JSON.stringify(edl);
    validateEdl(edl);
    expect(JSON.stringify(edl)).toBe(snapshot);
  });
});
