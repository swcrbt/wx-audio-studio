import { describe, expect, it } from 'vitest';
import {
  FINE_STEP_SEC,
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  beginDrag,
  clampPxPerSecond,
  clampViewport,
  gridStepSec,
  hitTest,
  isFineMode,
  panBy,
  snapToFineStep,
  tickTimes,
  timeToX,
  updateDrag,
  visibleRange,
  xToTime,
  zoomAt,
  type Viewport,
} from '../../miniprogram/core/view/viewport';

const WIDTH = 360;

function makeSession(viewport: Viewport, xPx: number, options: {
  playheadSec?: number;
  selection?: { startSec: number; endSec: number } | null;
} = {}) {
  return beginDrag({
    viewport,
    xPx,
    playheadSec: options.playheadSec ?? 0,
    selection: options.selection ?? null,
  });
}

describe('时间与像素换算', () => {
  it('往返换算保持一致', () => {
    const viewport: Viewport = { startSec: 12.5, pxPerSecond: 60 };
    expect(xToTime(viewport, timeToX(viewport, 20))).toBeCloseTo(20, 9);
    expect(timeToX(viewport, 12.5)).toBe(0);
  });

  it('可见区间宽度等于画布宽度除以缩放', () => {
    const range = visibleRange({ startSec: 5, pxPerSecond: 90 }, WIDTH);
    expect(range.startSec).toBe(5);
    expect(range.endSec).toBeCloseTo(5 + WIDTH / 90, 9);
  });
});

describe('缩放', () => {
  it('pxPerSecond 被夹在合法区间', () => {
    expect(clampPxPerSecond(0)).toBe(MIN_PX_PER_SECOND);
    expect(clampPxPerSecond(1e6)).toBe(MAX_PX_PER_SECOND);
    expect(clampPxPerSecond(Number.NaN)).toBe(MIN_PX_PER_SECOND);
  });

  it('以锚点缩放时锚点在屏幕上的位置不变', () => {
    const viewport: Viewport = { startSec: 10, pxPerSecond: 60 };
    const anchorSec = 15;
    const xBefore = timeToX(viewport, anchorSec);

    const zoomed = zoomAt(viewport, 2, anchorSec, 300, WIDTH);
    expect(timeToX(zoomed, anchorSec)).toBeCloseTo(xBefore, 6);
    expect(zoomed.pxPerSecond).toBe(120);
  });

  it('缩小到极限后不产生负起点', () => {
    const zoomed = zoomAt({ startSec: 0, pxPerSecond: 8 }, 0.01, 0, 300, WIDTH);
    expect(zoomed.pxPerSecond).toBe(MIN_PX_PER_SECOND);
    expect(zoomed.startSec).toBeGreaterThanOrEqual(0);
  });
});

describe('视口夹取与平移', () => {
  it('起点不为负，末尾不留空白', () => {
    expect(clampViewport({ startSec: -5, pxPerSecond: 60 }, 300, WIDTH).startSec).toBe(0);

    const atEnd = clampViewport({ startSec: 1000, pxPerSecond: 60 }, 300, WIDTH);
    expect(atEnd.startSec).toBeCloseTo(300 - WIDTH / 60, 6);
  });

  it('音频短于屏幕时起点固定为 0', () => {
    expect(clampViewport({ startSec: 50, pxPerSecond: 60 }, 2, WIDTH).startSec).toBe(0);
  });

  it('向右拖动内容使视口左移，且不会越过 0', () => {
    const viewport: Viewport = { startSec: 5, pxPerSecond: 60 };
    expect(panBy(viewport, 60, 300, WIDTH).startSec).toBeCloseTo(4, 9);
    expect(panBy({ startSec: 0.5, pxPerSecond: 60 }, 600, 300, WIDTH).startSec).toBe(0);
  });
});

describe('网格与精细模式', () => {
  it('按缩放切换网格步长，过小时不画网格', () => {
    expect(gridStepSec(100)).toBe(0.1);
    expect(gridStepSec(60)).toBe(0.1);
    expect(gridStepSec(30)).toBe(1);
    expect(gridStepSec(20)).toBe(1);
    expect(gridStepSec(10)).toBeNull();
  });

  it('放大到 50px/s 以上进入精细模式并按 5ms 步进', () => {
    expect(isFineMode(50)).toBe(true);
    expect(isFineMode(40)).toBe(false);
    expect(snapToFineStep(1.234)).toBeCloseTo(1.235, 9);
    expect(snapToFineStep(1.234) % FINE_STEP_SEC).toBeCloseTo(0, 9);
  });
});

describe('tickTimes', () => {
  it('刻度步长取“好看的”时间集合，且间距不小于下限', () => {
    const ticks = tickTimes({ startSec: 0, pxPerSecond: 60 }, WIDTH, 64);
    expect(ticks.slice(0, 4)).toEqual([0, 2, 4, 6]);

    const dense = tickTimes({ startSec: 0, pxPerSecond: 300 }, WIDTH, 64);
    expect(dense.slice(0, 3)).toEqual([0, 0.5, 1]);
  });

  it('视口起点不在 0 时仍从对齐的刻度开始', () => {
    const ticks = tickTimes({ startSec: 12.3, pxPerSecond: 60 }, WIDTH, 64);
    expect(ticks[0]).toBe(14);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(12.3 + WIDTH / 60);
  });

  it('极小缩放时刻度数量受保护，不会爆量', () => {
    const ticks = tickTimes({ startSec: 0, pxPerSecond: 0.0001 }, WIDTH, 64);
    expect(ticks.length).toBeLessThanOrEqual(512);
  });

  it('非法参数返回空数组', () => {
    expect(tickTimes({ startSec: 0, pxPerSecond: 60 }, 0)).toEqual([]);
    expect(tickTimes({ startSec: 0, pxPerSecond: 0 }, WIDTH)).toEqual([]);
  });
});

describe('命中判定', () => {
  const viewport: Viewport = { startSec: 0, pxPerSecond: 60 };

  it('手柄热区优先于选区内部与播放头', () => {
    const selection = { startSec: 1, endSec: 3 };
    // 起点在 60px；播放头也放在 60px 处，仍应判为手柄
    expect(hitTest({ viewport, xPx: 62, playheadSec: 1, selection })).toBe('selectionStart');
    expect(hitTest({ viewport, xPx: 178, playheadSec: 10, selection })).toBe('selectionEnd');
  });

  it('选区内部判为整体拖动', () => {
    const selection = { startSec: 1, endSec: 3 };
    expect(hitTest({ viewport, xPx: 120, playheadSec: 10, selection })).toBe('selection');
  });

  it('点中播放头判为播放头，其余为波形空白', () => {
    expect(hitTest({ viewport, xPx: 300, playheadSec: 5, selection: null })).toBe('playhead');
    expect(hitTest({ viewport, xPx: 150, playheadSec: 5, selection: null })).toBe('waveform');
  });
});

describe('拖动语义', () => {
  const viewport: Viewport = { startSec: 0, pxPerSecond: 60 };
  const options = { durationSec: 100 };

  it('拖波形区移动播放头，并夹在 [0, duration]', () => {
    const session = makeSession(viewport, 0);
    expect(updateDrag(session, viewport, 120, options).playheadSec).toBeCloseTo(2, 9);
    expect(updateDrag(session, viewport, -6000, options).playheadSec).toBe(0);
    expect(updateDrag(session, viewport, 6000 * 60, options).playheadSec).toBe(100);
  });

  it('拖起手柄只改对应的边界，不会交叉', () => {
    const selection = { startSec: 1, endSec: 3 };
    const startSession = makeSession(viewport, 60, { selection });
    const moved = updateDrag(startSession, viewport, 240, options);
    expect(moved.selection).toEqual({ startSec: 3, endSec: 3 });

    const endSession = makeSession(viewport, 180, { selection });
    const shrunk = updateDrag(endSession, viewport, 0, options);
    expect(shrunk.selection).toEqual({ startSec: 1, endSec: 1 });
  });

  it('整体平移到选区长度不变，且被夹在工程范围内', () => {
    const selection = { startSec: 1, endSec: 3 };
    const session = makeSession(viewport, 120, { selection });

    const moved = updateDrag(session, viewport, 180, { durationSec: 100 });
    expect(moved.selection?.startSec).toBeCloseTo(2, 6);
    expect((moved.selection?.endSec ?? 0) - (moved.selection?.startSec ?? 0)).toBeCloseTo(2, 6);

    const clamped = updateDrag(session, viewport, 6000 * 60, { durationSec: 100 });
    expect(clamped.selection?.endSec).toBeCloseTo(100, 6);
  });

  it('提供网格步长时吸附到网格', () => {
    const session = makeSession(viewport, 0);
    const snapped = updateDrag(session, viewport, 64, { durationSec: 100, snapGridSec: 0.1 });
    expect(snapped.playheadSec).toBeCloseTo(1.1, 6);
  });

  it('无选区时整体拖动是空操作', () => {
    const session = makeSession(viewport, 120, { selection: null });
    const result = updateDrag(session, viewport, 200, options);
    expect(result.selectionChanged).toBe(false);
    expect(result.selection).toBeNull();
  });

  it('拖动播放头不会改选区', () => {
    const selection = { startSec: 1, endSec: 3 };
    const session = makeSession(viewport, 300, { playheadSec: 5, selection });
    const result = updateDrag(session, viewport, 0, options);
    expect(result.selection).toEqual(selection);
    expect(result.playheadSec).toBe(0);
  });
});
