import { describe, expect, it } from 'vitest';
import type { Edl } from '../../miniprogram/core/types';
import { HistoryStack, MAX_HISTORY, defineCommand } from '../../miniprogram/core/history/history';
import { addClip, moveClip, removeClip, setClipGainDb } from '../../miniprogram/workers/render/edl/ops';
import { makeClip, makeEdl } from '../edl/fixtures';

/** 造一条"加入片段"命令（正向：加；逆向：删）。 */
function addClipCommand(id: string, timelineStart: number, at: number, coalesceKey?: string) {
  return defineCommand({
    id,
    label: `加入片段 ${id}`,
    at,
    ...(coalesceKey === undefined ? {} : { coalesceKey }),
    apply: (edl) =>
      addClip(
        edl,
        't1',
        makeClip({ id, assetId: 'a1', sourceStart: 0, sourceEnd: 1, timelineStart }),
      ),
    invert: (edl) => removeClip(edl, 't1', id),
  });
}

describe('HistoryStack 基本流程', () => {
  it('push 应用命令，undo 回滚，redo 重放', () => {
    const history = new HistoryStack();
    const initial = makeEdl();

    const after = history.push(addClipCommand('c2', 6, 1), initial);
    expect(after.tracks[0]?.clips.map((clip) => clip.id)).toEqual(['c1', 'c2']);
    expect(history.canUndo).toBe(true);
    expect(history.undoLabel).toBe('加入片段 c2');

    const undone = history.undo(after);
    expect(undone.tracks[0]?.clips.map((clip) => clip.id)).toEqual(['c1']);
    expect(history.canRedo).toBe(true);

    const redone = history.redo(undone);
    expect(redone.tracks[0]?.clips.map((clip) => clip.id)).toEqual(['c1', 'c2']);
    expect(history.canRedo).toBe(false);
  });

  it('无可撤销/重做时返回原 EDL 而不是抛错', () => {
    const history = new HistoryStack();
    const edl = makeEdl();
    expect(history.undo(edl)).toBe(edl);
    expect(history.redo(edl)).toBe(edl);
    expect(history.canUndo).toBe(false);
    expect(history.undoLabel).toBeNull();
  });

  it('push 新命令会清空重做栈', () => {
    const history = new HistoryStack();
    let edl = makeEdl();
    edl = history.push(addClipCommand('c2', 6, 1), edl);
    edl = history.undo(edl);
    expect(history.canRedo).toBe(true);

    history.push(addClipCommand('c3', 7, 2), edl);
    expect(history.canRedo).toBe(false);
  });

  it('多步操作后全部 undo，EDL 与初始状态深相等', () => {
    const history = new HistoryStack();
    const initial = makeEdl();
    let edl = initial;

    edl = history.push(addClipCommand('c2', 6, 1), edl);
    edl = history.push(
      defineCommand({
        id: 'mv1',
        label: '移动 c2',
        at: 2,
        apply: (current) => moveClip(current, 't1', 'c2', 7),
        invert: (current) => moveClip(current, 't1', 'c2', 6),
      }),
      edl,
    );
    edl = history.push(
      defineCommand({
        id: 'gain1',
        label: '调整音量',
        at: 3,
        apply: (current) => setClipGainDb(current, 't1', 'c2', -6),
        invert: (current) => setClipGainDb(current, 't1', 'c2', 0),
      }),
      edl,
    );

    expect(edl.tracks[0]?.clips.length).toBe(2);

    edl = history.undo(edl);
    edl = history.undo(edl);
    edl = history.undo(edl);

    expect(JSON.stringify(edl)).toBe(JSON.stringify(initial));
    expect(history.canUndo).toBe(false);
  });

  it('不可逆命令（invert 省略）的 undo 不改变 EDL', () => {
    const history = new HistoryStack();
    const edl = makeEdl();
    const command = defineCommand({
      id: 'asset1',
      label: '导入素材',
      at: 1,
      apply: (current: Edl) => current,
    });
    const after = history.push(command, edl);
    expect(history.undo(after)).toEqual(after);
  });
});

describe('命令合并（coalesce）', () => {
  it('同一 coalesceKey 且在窗口内合并为一条', () => {
    let clock = 1000;
    const history = new HistoryStack({ now: () => clock });
    let edl = makeEdl();

    edl = history.push(addClipCommand('c2', 6, clock, 'gain:c2'), edl);
    clock += 300;
    edl = history.push(addClipCommand('c2', 6, clock, 'gain:c2'), edl);
    clock += 300;
    edl = history.push(addClipCommand('c2', 6, clock, 'gain:c2'), edl);

    expect(history.labels()).toEqual(['加入片段 c2']);
    expect(history.depth).toBe(1);

    // 合并后一次 undo 应回到初始状态
    const undone = history.undo(edl);
    expect(undone.tracks[0]?.clips.map((clip) => clip.id)).toEqual(['c1']);
  });

  it('超出合并窗口则不合并', () => {
    let clock = 1000;
    const history = new HistoryStack({ now: () => clock });
    let edl = makeEdl();

    edl = history.push(addClipCommand('c2', 6, clock, 'gain:c2'), edl);
    clock += 5000;
    edl = history.push(addClipCommand('c3', 7, clock, 'gain:c2'), edl);

    expect(history.depth).toBe(2);
    expect(edl.tracks[0]?.clips.length).toBe(3);
  });

  it('不同 coalesceKey 不合并；无 coalesceKey 不合并', () => {
    const history = new HistoryStack({ now: () => 1000 });
    let edl = makeEdl();
    edl = history.push(addClipCommand('c2', 6, 1000, 'gain:c2'), edl);
    edl = history.push(addClipCommand('c3', 7, 1000, 'gain:c3'), edl);
    edl = history.push(addClipCommand('c4', 8, 1000), edl);
    expect(history.depth).toBe(3);
    expect(edl.tracks[0]?.clips.length).toBe(4);
  });
});

describe('栈容量', () => {
  it('超过 MAX_HISTORY 时丢弃最旧的命令', () => {
    const history = new HistoryStack({ maxEntries: 3 });
    let edl = makeEdl();
    for (let i = 0; i < 5; i++) {
      edl = history.push(addClipCommand(`x${i}`, 6 + i, i), edl);
    }
    expect(history.depth).toBe(3);
    expect(history.labels()).toEqual(['加入片段 x2', '加入片段 x3', '加入片段 x4']);
    expect(edl.tracks[0]?.clips.length).toBe(6); // 1 + 5，容量只影响历史不影响 EDL
  });

  it('默认上限与文档常量一致（100）', () => {
    const history = new HistoryStack();
    let edl = makeEdl();
    for (let i = 0; i < MAX_HISTORY + 20; i++) {
      edl = history.push(addClipCommand(`y${i}`, 6 + i, i), edl);
    }
    expect(history.depth).toBe(MAX_HISTORY);
    expect(edl.tracks[0]?.clips.length).toBe(MAX_HISTORY + 21);
  });

  it('clear 清空双向栈', () => {
    const history = new HistoryStack();
    const edl = history.push(addClipCommand('c2', 6, 1), makeEdl());
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo(edl)).toBe(edl);
  });
});
