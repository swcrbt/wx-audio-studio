/**
 * 时间轴视口与手势几何（纯计算，不碰 Canvas 与 `wx.*`）。
 *
 * 把"时间 ↔ 像素""缩放锚点""拖动语义""命中判定"集中在这里，好处是：
 * 组件只管画和转发触摸事件，所有边界条件（越界、吸附、手柄优先）都能单测。
 *
 * 坐标约定：`xPx` 以波形区左边缘为 0，向右增大；`startSec` 是视口左边缘对应的时间。
 */
import type { Px, Seconds, TimeRange } from '../types';

export const MIN_PX_PER_SECOND = 4;
export const MAX_PX_PER_SECOND = 400;

/** 选区手柄的视觉宽度（命中热区另见 `TOUCH_TARGET_PX`）。 */
export const SELECTION_HANDLE_W_PX = 8;
/** 可点击热区的最小边长（平台无障碍建议值对应的逻辑像素）。 */
export const TOUCH_TARGET_PX = 24;
/** 低于这个"秒/像素"进入精细模式（步进 5ms + 震动反馈）。 */
export const FINE_MODE_SEC_PER_PX = 0.02;
/** 精细模式的步进。 */
export const FINE_STEP_SEC = 0.005;

export interface Viewport {
  /** 视口左边缘对应的时间（秒）。 */
  startSec: Seconds;
  /** 缩放：每秒对应多少像素。 */
  pxPerSecond: number;
}

export function clampPxPerSecond(value: number): number {
  if (!Number.isFinite(value)) return MIN_PX_PER_SECOND;
  return Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, value));
}

export function timeToX(viewport: Viewport, sec: Seconds): Px {
  return (sec - viewport.startSec) * viewport.pxPerSecond;
}

export function xToTime(viewport: Viewport, xPx: Px): Seconds {
  return viewport.startSec + xPx / viewport.pxPerSecond;
}

/** 视口内可见的时间区间。 */
export function visibleRange(viewport: Viewport, widthPx: Px): TimeRange {
  return { startSec: viewport.startSec, endSec: viewport.startSec + widthPx / viewport.pxPerSecond };
}

/**
 * 夹住视口：不出现负起点，也不在末尾留大片空白。
 * 当整段音频比屏幕还短时，起点固定为 0。
 */
export function clampViewport(viewport: Viewport, durationSec: Seconds, widthPx: Px): Viewport {
  const pxPerSecond = clampPxPerSecond(viewport.pxPerSecond);
  const visibleSec = widthPx > 0 ? widthPx / pxPerSecond : 0;
  const maxStartSec = Math.max(0, durationSec - visibleSec);
  const startSec = Math.min(Math.max(0, viewport.startSec), maxStartSec);
  return { startSec, pxPerSecond };
}

/**
 * 以某个时间点为锚缩放。捏合场景锚点是双指中点：缩放前后该点在屏幕上不动。
 */
export function zoomAt(
  viewport: Viewport,
  factor: number,
  anchorSec: Seconds,
  durationSec: Seconds,
  widthPx: Px,
): Viewport {
  const nextPxPerSecond = clampPxPerSecond(viewport.pxPerSecond * factor);
  const anchorXPx = timeToX(viewport, anchorSec);
  const startSec = anchorSec - anchorXPx / nextPxPerSecond;
  return clampViewport({ startSec, pxPerSecond: nextPxPerSecond }, durationSec, widthPx);
}

/** 平移视口：`deltaPx` 为内容跟随手指的位移（手指右滑时 `startSec` 减小）。 */
export function panBy(
  viewport: Viewport,
  deltaPx: Px,
  durationSec: Seconds,
  widthPx: Px,
): Viewport {
  return clampViewport(
    { startSec: viewport.startSec - deltaPx / viewport.pxPerSecond, pxPerSecond: viewport.pxPerSecond },
    durationSec,
    widthPx,
  );
}

/** 当前缩放下的网格步长；返回 `null` 表示不画网格（低端机降级也走这里）。 */
export function gridStepSec(pxPerSecond: number): Seconds | null {
  if (pxPerSecond >= 60) return 0.1;
  if (pxPerSecond >= 20) return 1;
  return null;
}

/** 是否进入精细调节模式（放大到 20ms/px 以内）。 */
export function isFineMode(pxPerSecond: number): boolean {
  return pxPerSecond > 0 && 1 / pxPerSecond <= FINE_MODE_SEC_PER_PX;
}

/** 精细模式下的时间吸附。 */
export function snapToFineStep(sec: Seconds): Seconds {
  return Math.round(sec / FINE_STEP_SEC) * FINE_STEP_SEC;
}

/**
 * 标尺刻度：按“刻度间距不小于 `minSpacingPx`”选择步长，返回可见区间的刻度时间点。
 *
 * 步长从“好看的”时间集合里选（0.01/0.05/0.1/0.5/1/2/5/10/15/30/60s），
 * 避免出现 3.7s 这种刻度。
 */
const TICK_CANDIDATES_SEC: readonly Seconds[] = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300,
];

export function tickTimes(viewport: Viewport, widthPx: Px, minSpacingPx: Px = 64): Seconds[] {
  if (!(viewport.pxPerSecond > 0) || widthPx <= 0) return [];
  const minStepSec = minSpacingPx / viewport.pxPerSecond;
  const stepSec = TICK_CANDIDATES_SEC.find((candidate) => candidate >= minStepSec) ?? TICK_CANDIDATES_SEC[TICK_CANDIDATES_SEC.length - 1] ?? 60;

  const { endSec } = visibleRange(viewport, widthPx);
  const ticks: Seconds[] = [];
  const first = Math.ceil(viewport.startSec / stepSec) * stepSec;
  // 上限保护：极小缩放时也绝不产生上千个刻度（异常参数不会拖垮渲染）
  for (let sec = first, guard = 0; sec <= endSec && guard < 512; sec += stepSec, guard++) {
    ticks.push(Number(sec.toFixed(6)));
  }
  return ticks;
}

export type HitTarget = 'selectionStart' | 'selectionEnd' | 'selection' | 'playhead' | 'waveform';

export interface HitTestInput {
  viewport: Viewport;
  xPx: Px;
  playheadSec: Seconds;
  selection: TimeRange | null;
  /** 命中容差（默认取 `TOUCH_TARGET_PX` 的一半作为半径）。 */
  touchSlopPx?: Px;
}

/**
 * 命中判定。
 *
 * 冲突规则（docs/04 §3.3）：手指落在选区手柄热区内时**优先判为手柄拖动**，
 * 否则再判选区整体、播放头，最后才落到波形空白。
 */
export function hitTest(input: HitTestInput): HitTarget {
  const slop = (input.touchSlopPx ?? TOUCH_TARGET_PX) / 2;
  const x = input.xPx;
  const selection = input.selection;

  if (selection) {
    const startX = timeToX(input.viewport, selection.startSec);
    const endX = timeToX(input.viewport, selection.endSec);
    if (Math.abs(x - startX) <= slop) return 'selectionStart';
    if (Math.abs(x - endX) <= slop) return 'selectionEnd';
    if (x > startX && x < endX) return 'selection';
  }

  const playheadX = timeToX(input.viewport, input.playheadSec);
  if (Math.abs(x - playheadX) <= slop) return 'playhead';

  return 'waveform';
}

export interface DragSession {
  target: HitTarget;
  startXPx: Px;
  /** 手势起点的原始时间（用于计算位移，避免吸附误差累积）。 */
  startSec: Seconds;
  /** 手势开始时的选区（整体平移时保持时长）。 */
  initialSelection: TimeRange | null;
  /** 手势开始时的播放头位置。 */
  initialPlayheadSec: Seconds;
}

export interface DragOptions {
  durationSec: Seconds;
  /** 网格吸附步长（秒）；不传则不吸附。 */
  snapGridSec?: Seconds;
}

export interface DragResult {
  playheadSec: Seconds;
  selection: TimeRange | null;
  /** 本次拖动是否改变了选区（UI 据此决定是否重绘选区）。 */
  selectionChanged: boolean;
}

export function beginDrag(input: HitTestInput): DragSession {
  return {
    target: hitTest(input),
    startXPx: input.xPx,
    startSec: xToTime(input.viewport, input.xPx),
    initialSelection: input.selection,
    initialPlayheadSec: input.playheadSec,
  };
}

/**
 * 拖动中的状态推导。手势期间**只算不提交**：调用方拿到结果先做预览绘制，
 * 手指抬起时再走 `commit`（docs/04 §3.3 规则 3）。
 */
export function updateDrag(
  session: DragSession,
  viewport: Viewport,
  xPx: Px,
  options: DragOptions,
): DragResult {
  const { durationSec, snapGridSec } = options;
  const rawSec = xToTime(viewport, xPx);
  const deltaSec = rawSec - session.startSec;
  const snap = (sec: Seconds): Seconds => {
    const clamped = Math.min(Math.max(0, sec), Math.max(0, durationSec));
    return snapGridSec && snapGridSec > 0 ? Math.round(clamped / snapGridSec) * snapGridSec : clamped;
  };

  switch (session.target) {
    case 'selectionStart':
    case 'selectionEnd': {
      const initial = session.initialSelection ?? { startSec: session.startSec, endSec: session.startSec };
      const next = snap(rawSec);
      const selection =
        session.target === 'selectionStart'
          ? { startSec: Math.min(next, initial.endSec), endSec: initial.endSec }
          : { startSec: initial.startSec, endSec: Math.max(next, initial.startSec) };
      return { playheadSec: session.initialPlayheadSec, selection, selectionChanged: true };
    }

    case 'selection': {
      const initial = session.initialSelection;
      if (!initial) {
        return {
          playheadSec: session.initialPlayheadSec,
          selection: null,
          selectionChanged: false,
        };
      }
      const lengthSec = initial.endSec - initial.startSec;
      const startSec = Math.min(Math.max(0, initial.startSec + deltaSec), Math.max(0, durationSec - lengthSec));
      const dragged = snapGridSec && snapGridSec > 0 ? Math.round(startSec / snapGridSec) * snapGridSec : startSec;
      const bounded = Math.min(Math.max(0, dragged), Math.max(0, durationSec - lengthSec));
      return {
        playheadSec: session.initialPlayheadSec,
        selection: { startSec: bounded, endSec: bounded + lengthSec },
        selectionChanged: true,
      };
    }

    default: {
      // 播放头与波形空白：都是移动播放头（松手后才 seek 播放器）
      return { playheadSec: snap(rawSec), selection: session.initialSelection, selectionChanged: false };
    }
  }
}
