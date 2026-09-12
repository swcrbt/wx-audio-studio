import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectStore,
  ProjectStoreError,
  serializeProject,
  type ProjectSnapshot,
} from '../../miniprogram/core/store/project-store';
import { setClipGainDb } from '../../miniprogram/workers/render/edl/ops';
import type { Project } from '../../miniprogram/core/types';
import type { EditCommand } from '../../miniprogram/core/history/history';
import { makeAsset, makeClip, makeEdl, makeTrack } from '../edl/fixtures';

function makeProject(overrides: Partial<Project> = {}): Project {
  const edl = makeEdl();
  return {
    schemaVersion: 1,
    id: 'p1',
    name: '测试工程',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sampleRate: edl.sampleRate,
    channels: edl.channels,
    assets: edl.assets,
    tracks: edl.tracks,
    summary: { durationSec: 5, assetCount: 1, clipCount: 1 },
    ...overrides,
  };
}

/** 一条可逆的增益命令（把 c1 设成指定 dB）。 */
function gainCommand(gainDb: number, at = 1): EditCommand {
  return {
    id: `gain-${gainDb}`,
    label: '调整音量',
    at,
    coalesceKey: 'gain:c1',
    apply: (edl) => setClipGainDb(edl, 't1', 'c1', gainDb),
    invert: (edl) => setClipGainDb(edl, 't1', 'c1', 0),
  };
}

function collectSaves(): { calls: Project[]; persist: (project: Project) => Promise<void> } {
  const calls: Project[] = [];
  return {
    calls,
    persist: async (project: Project) => {
      calls.push(project);
    },
  };
}

describe('ProjectStore · 编辑与状态', () => {
  it('commit 更新 EDL、重算 summary 并标记 dirty', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 1000 });

    expect(store.snapshot.dirty).toBe(false);
    store.commit(gainCommand(-6));

    expect(store.edl.tracks[0]?.clips[0]?.gainDb).toBe(-6);
    expect(store.snapshot.dirty).toBe(true);
    expect(store.snapshot.canUndo).toBe(true);
    expect(store.snapshot.clipCount).toBe(1);
    expect(store.snapshot.durationSec).toBe(5);
  });

  it('新增片段后 summary 时长与片段数同步更新', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 1000 });

    store.commit({
      id: 'add-clip',
      label: '添加片段',
      at: 1,
      apply: (edl) => ({
        ...edl,
        tracks: [makeTrack('t1', [...(edl.tracks[0]?.clips ?? []), makeClip({ id: 'c2', timelineStart: 5 })])],
      }),
      invert: (edl) => ({
        ...edl,
        tracks: [makeTrack('t1', (edl.tracks[0]?.clips ?? []).filter((clip) => clip.id !== 'c2'))],
      }),
    });

    expect(store.snapshot.clipCount).toBe(2);
    expect(store.snapshot.durationSec).toBe(10);
  });

  it('undo / redo 走历史栈并同样标记 dirty', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 1000 });
    store.commit(gainCommand(-6));

    expect(store.undo()).toBe(true);
    expect(store.edl.tracks[0]?.clips[0]?.gainDb).toBe(0);
    expect(store.snapshot.canRedo).toBe(true);
    expect(store.snapshot.dirty).toBe(true);

    expect(store.redo()).toBe(true);
    expect(store.edl.tracks[0]?.clips[0]?.gainDb).toBe(-6);
  });

  it('无可撤销/重做时返回 false 且不改状态', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 1000 });
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
  });

  it('rename 会改 updatedAt 并标记 dirty；空名或同名忽略', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 1000 });
    store.setProjectName('  播客第03期  ');
    expect(store.project.name).toBe('播客第03期');
    expect(store.snapshot.dirty).toBe(true);

    const updatedAt = store.project.updatedAt;
    store.setProjectName('播客第03期');
    expect(store.project.updatedAt).toBe(updatedAt);
    store.setProjectName('   ');
    expect(store.project.name).toBe('播客第03期');
  });

  it('视图状态独立于文档状态：不进历史、不影响 dirty', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 1000 });
    store.setUiState({ playheadSec: 3.5, selectionStartSec: 1, selectionEndSec: 2 });

    expect(store.ui.playheadSec).toBe(3.5);
    expect(store.snapshot.dirty).toBe(false);
    expect(store.snapshot.canUndo).toBe(false);
  });

  it('订阅者能收到状态快照', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 1000 });
    const seen: ProjectSnapshot[] = [];
    const unsubscribe = store.subscribe((snapshot) => seen.push(snapshot));

    store.commit(gainCommand(-3));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]?.canUndo).toBe(true);

    unsubscribe();
    const count = seen.length;
    store.commit(gainCommand(-9, 2));
    expect(seen.length).toBe(count);
  });
});

describe('ProjectStore · 自动保存', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('防抖窗口内的连续编辑只落盘一次', async () => {
    const { calls, persist } = collectSaves();
    const store = new ProjectStore({ project: makeProject(), persist, debounceMs: 1000, now: () => 1000 });

    store.commit(gainCommand(-3));
    await vi.advanceTimersByTimeAsync(300);
    store.commit(gainCommand(-6, 2));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length).toBe(1);
    expect(store.snapshot.dirty).toBe(false);
    expect(store.snapshot.lastSavedAt).toBe(1000);
  });

  it('flush 立刻落盘，不必等防抖', async () => {
    const { calls, persist } = collectSaves();
    const store = new ProjectStore({ project: makeProject(), persist, debounceMs: 1000 });

    store.commit(gainCommand(-3));
    await store.flush();
    expect(calls.length).toBe(1);
    expect(store.snapshot.dirty).toBe(false);
  });

  it('无改动时 flush 不产生写入', async () => {
    const { calls, persist } = collectSaves();
    const store = new ProjectStore({ project: makeProject(), persist, debounceMs: 1000 });
    await store.flush();
    expect(calls.length).toBe(0);
  });

  it('落盘内容剔除运行时字段 refCount', async () => {
    const { calls, persist } = collectSaves();
    const project = makeProject({ assets: [{ ...makeAsset('a1', 10), refCount: 7 }] });
    const store = new ProjectStore({ project, persist, debounceMs: 0 });

    store.commit(gainCommand(-3));
    await store.flush();

    expect(calls.length).toBe(1);
    expect(calls[0]?.assets[0]).not.toHaveProperty('refCount');
    expect(calls[0]?.tracks[0]?.clips[0]?.gainDb).toBe(-3);
  });

  it('保存中再次编辑不会丢改动（串行化）', async () => {
    const saved: number[] = [];
    // 用容器装 release：赋值发生在回调里，直接给 `let` 赋值会被 TS 收窄成 null
    const gate: { release: (() => void) | null } = { release: null };
    const store = new ProjectStore({
      project: makeProject(),
      debounceMs: 0,
      persist: async (project) => {
        saved.push(project.tracks[0]?.clips[0]?.gainDb ?? 0);
        if (saved.length === 1) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
      },
    });

    store.commit(gainCommand(-3));
    await Promise.resolve();
    store.commit(gainCommand(-6, 2));
    gate.release?.();
    await store.flush();

    expect(saved).toEqual([-3, -6]);
    expect(store.snapshot.dirty).toBe(false);
  });
});

describe('ProjectStore · 保存失败降级', () => {
  it('失败保留 dirty 并把连续失败数累加', async () => {
    const store = new ProjectStore({
      project: makeProject(),
      debounceMs: 0,
      persist: async () => {
        throw new Error('1300202 no space');
      },
    });

    store.commit(gainCommand(-3));
    await store.flush();

    expect(store.snapshot.dirty).toBe(true);
    expect(store.snapshot.saveFailureCount).toBe(1);
    expect(store.snapshot.readOnly).toBe(false);
  });

  it('连续失败达到上限后降级只读，commit 被拒绝；清理后恢复', async () => {
    const store = new ProjectStore({
      project: makeProject(),
      debounceMs: 0,
      maxSaveFailures: 3,
      persist: async () => {
        throw new Error('1300202 no space');
      },
    });

    for (let i = 0; i < 3; i++) {
      store.commit(gainCommand(-3, i + 1));
      await store.flush();
    }

    expect(store.snapshot.readOnly).toBe(true);
    expect(store.isReadOnly).toBe(true);
    expect(() => store.commit(gainCommand(-9))).toThrow(ProjectStoreError);

    store.clearReadOnly();
    expect(() => store.commit(gainCommand(-9))).not.toThrow();
  });

  it('成功一次即重置失败计数', async () => {
    let shouldFail = true;
    const store = new ProjectStore({
      project: makeProject(),
      debounceMs: 0,
      persist: async () => {
        if (shouldFail) throw new Error('write failed');
      },
    });

    store.commit(gainCommand(-3, 1));
    await store.flush();
    expect(store.snapshot.saveFailureCount).toBe(1);

    shouldFail = false;
    store.commit(gainCommand(-6, 2));
    await store.flush();
    expect(store.snapshot.saveFailureCount).toBe(0);
    expect(store.snapshot.dirty).toBe(false);
  });
});

describe('ProjectStore · 素材引用', () => {
  it('被片段引用的素材不允许移除，未被引用的可以', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 0 });

    store.addAsset(makeAsset('a2', 4));
    expect(store.project.assets.map((asset) => asset.id)).toEqual(['a1', 'a2']);
    expect(store.unreferencedAssets().map((asset) => asset.id)).toEqual(['a2']);
    expect(store.referencedAssetIds().has('a1')).toBe(true);

    store.removeAsset('a1');
    expect(store.project.assets.length).toBe(2);

    store.removeAsset('a2');
    expect(store.project.assets.map((asset) => asset.id)).toEqual(['a1']);
  });

  it('删除素材可撤销（素材文件保留到历史被裁剪）', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 0 });
    store.addAsset(makeAsset('a2', 4));
    store.removeAsset('a2');
    expect(store.project.assets.map((asset) => asset.id)).toEqual(['a1']);

    store.undo();
    expect(store.project.assets.map((asset) => asset.id)).toEqual(['a1', 'a2']);
  });

  it('移除不存在的素材是空操作', () => {
    const store = new ProjectStore({ project: makeProject(), persist: async () => undefined, debounceMs: 0 });
    store.removeAsset('nope');
    expect(store.snapshot.canUndo).toBe(false);
    expect(store.snapshot.dirty).toBe(false);
  });
});

describe('serializeProject', () => {
  it('不改动原对象，只返回剔除 refCount 的新对象', () => {
    const project = makeProject({ assets: [{ ...makeAsset('a1', 10), refCount: 2 }] });
    const serialized = serializeProject(project);

    expect(serialized.assets[0]).not.toHaveProperty('refCount');
    expect(project.assets[0]?.refCount).toBe(2);
    expect(serialized).not.toBe(project);
  });
});
