/**
 * 波形画布组件。
 *
 * 分工：绘制在 `renderer.ts`，几何与手势语义在 `core/view/viewport.ts`，
 * 本文件只负责"拿 canvas 节点、接触摸事件、按需重绘、把手势结果抛给页面"。
 *
 * 重绘策略（性能红线：手势进行中不得全量重绘）：
 * - 拖动播放头 / 选区 / 手柄：视口不变 → 复用离屏位图（1 次 `drawImage`）+ 叠加层；
 * - 双指平移视口：离屏位图平移 + 只补绘新露出的边缘列；
 * - 双指缩放：像素密度改变，无法复用位图 → 整绘，并按约 30fps 节流。
 *
 * 状态放在模块级 `WeakMap`（以组件实例为键）：`levels` 这类大数组不能进 `data`
 * （`setData` 会做序列化），而自定义实例字段在小程序 TS 类型里不可见。
 */
import type { Px, Seconds, TimeRange } from '../../core/types';
import {
  FINE_STEP_SEC,
  beginDrag,
  clampViewport,
  isFineMode,
  panBy,
  updateDrag,
  xToTime,
  zoomAt,
  type DragSession,
  type Viewport,
} from '../../core/view/viewport';
import type { PeaksLevel } from '../../workers/render/peaks/build';
import {
  DARK_WAVE_STYLE,
  drawBackground,
  drawOverlay,
  drawWaveform,
  type WaveformCtx,
  type WaveformFrame,
  type WaveformStyle,
} from './renderer';

interface CanvasNodeLike {
  width: number;
  height: number;
  getContext(contextType: '2d'): unknown;
}

type GestureMode = 'none' | 'drag' | 'zoom';

interface PinchState {
  startDistancePx: number;
  startMidXPx: Px;
  startViewport: Viewport;
  anchorSec: Seconds;
}

interface WaveformState {
  durationSec: Seconds;
  sampleRate: number;
  levels: readonly PeaksLevel[];
  viewport: Viewport;
  selection: TimeRange | null;
  playheadSec: Seconds;
  style: WaveformStyle;

  node: CanvasNodeLike | null;
  ctx: WaveformCtx | null;
  offscreen: CanvasNodeLike | null;
  offscreenCtx: WaveformCtx | null;
  widthPx: Px;
  heightPx: number;
  canvasLeftPx: Px;
  scratch: Float32Array | null;

  gestureMode: GestureMode;
  session: DragSession | null;
  pinch: PinchState | null;
  lastPaintAtMs: number;
  perfMode: string;
  haptic: boolean;
}

/** 每帧最小间隔：低端机上限制在约 30fps。 */
const PAINT_THROTTLE_MS = 33;

const states = new WeakMap<object, WaveformState>();

function createState(): WaveformState {
  return {
    durationSec: 0,
    sampleRate: 44100,
    levels: [],
    viewport: { startSec: 0, pxPerSecond: 60 },
    selection: null,
    playheadSec: 0,
    style: DARK_WAVE_STYLE,
    node: null,
    ctx: null,
    offscreen: null,
    offscreenCtx: null,
    widthPx: 0,
    heightPx: 0,
    canvasLeftPx: 0,
    scratch: null,
    gestureMode: 'none',
    session: null,
    pinch: null,
    lastPaintAtMs: 0,
    perfMode: 'auto',
    haptic: true,
  };
}

/** 缩放重绘的限帧间隔：低性能模式放宽到 20fps。 */
function paintThrottleMs(state: WaveformState): number {
  return state.perfMode === 'low' ? 50 : PAINT_THROTTLE_MS;
}

function stateOf(instance: object): WaveformState {
  let state = states.get(instance);
  if (!state) {
    state = createState();
    states.set(instance, state);
  }
  return state;
}

function frameOf(state: WaveformState): WaveformFrame {
  return {
    viewport: state.viewport,
    widthPx: state.widthPx,
    heightPx: state.heightPx,
    sampleRate: state.sampleRate,
    selection: state.selection,
    playheadSec: state.playheadSec,
  };
}

/** 整绘：背景 + 波形写入离屏位图，再叠加到主画布。 */
function paintFull(state: WaveformState, columnStepPx = 1): void {
  const ctx = state.ctx;
  const offscreenCtx = state.offscreenCtx;
  if (!ctx || !offscreenCtx || state.widthPx <= 0) return;

  const frame = frameOf(state);
  drawBackground(offscreenCtx, frame, state.style);
  drawWaveform(
    offscreenCtx,
    state.levels,
    frame,
    state.style,
    0,
    state.widthPx,
    state.scratch ?? undefined,
    columnStepPx,
  );
  blit(state, 0);
}

/** 用离屏位图刷新主画布，并重画叠加层。 */
function blit(state: WaveformState, deltaXPx: Px): void {
  const ctx = state.ctx;
  const offscreen = state.offscreen;
  if (!ctx || !offscreen) return;

  ctx.drawImage(offscreen, deltaXPx, 0, state.widthPx, state.heightPx);
  drawOverlay(ctx, frameOf(state), state.style);
}

function touchXPx(state: WaveformState, touch: { x?: number; clientX?: number }): Px {
  if (typeof touch.x === 'number') return touch.x;
  return (touch.clientX ?? 0) - state.canvasLeftPx;
}

function measure(
  instance: WechatMiniprogram.Component.TrivialInstance,
  state: WaveformState,
  done?: () => void,
): void {
  const query = instance.createSelectorQuery();
  query.select('#wave').fields({ node: true, size: true, rect: true });
  query.exec((res: unknown[]) => {
    const item = res[0] as
      | { node?: CanvasNodeLike; width?: number; height?: number; left?: number }
      | undefined;
    const node = item?.node;
    if (!node || !item?.width || !item?.height) return;

    const dpr = wx.getWindowInfo().pixelRatio || 1;
    state.widthPx = Math.round(item.width);
    state.heightPx = Math.round(item.height);
    state.canvasLeftPx = item.left ?? 0;
    state.node = node;

    node.width = Math.round(state.widthPx * dpr);
    node.height = Math.round(state.heightPx * dpr);

    const ctx = node.getContext('2d') as WaveformCtx;
    ctx.scale(dpr, dpr);
    state.ctx = ctx;

    const offscreen = wx.createOffscreenCanvas({
      type: '2d',
      width: node.width,
      height: node.height,
    }) as unknown as CanvasNodeLike;
    const offscreenCtx = offscreen.getContext('2d') as WaveformCtx;
    offscreenCtx.scale(dpr, dpr);
    state.offscreen = offscreen;
    state.offscreenCtx = offscreenCtx;

    state.scratch = new Float32Array(state.widthPx * 2);
    state.viewport = clampViewport(state.viewport, state.durationSec, state.widthPx);
    paintFull(state);
    done?.();
  });
}

/** 双指手势：以捏合中点为锚缩放，再叠加中点位移带来的平移。 */
function updatePinch(state: WaveformState, distancePx: Px, midXPx: Px): void {
  const pinch = state.pinch;
  if (!pinch) return;

  const factor = distancePx / pinch.startDistancePx;
  const zoomed = zoomAt(
    pinch.startViewport,
    factor,
    pinch.anchorSec,
    state.durationSec,
    state.widthPx,
  );
  state.viewport = panBy(zoomed, midXPx - pinch.startMidXPx, state.durationSec, state.widthPx);

  const nowMs = Date.now();
  if (nowMs - state.lastPaintAtMs < paintThrottleMs(state)) return;
  state.lastPaintAtMs = nowMs;
  // 缩放改变了像素密度，位图无法复用，只能重绘；用限帧 + 隔列降级控制开销
  // （取舍与豁免记录见 docs/06 §4）
  paintFull(state, 2);
}

Component({
  properties: {
    /** 工程时长（秒）：视口夹取与手势边界都要用。 */
    durationSec: { type: Number, value: 0 },
    /** 工程采样率：秒与采样帧的换算基准。 */
    sampleRate: { type: Number, value: 44100 },
    /** 性能模式：`low` 把波形重绘限制到约 20fps，其余 30fps。 */
    perfMode: { type: String, value: 'auto' },
    /** 精细调节时是否震动反馈。 */
    haptic: { type: Boolean, value: true },
  },

  lifetimes: {
    attached() {
      const state = stateOf(this);
      state.durationSec = this.data.durationSec;
      state.sampleRate = this.data.sampleRate || state.sampleRate;
      measure(this, state);
    },
    detached() {
      const state = stateOf(this);
      state.node = null;
      state.ctx = null;
      state.offscreen = null;
      state.offscreenCtx = null;
      state.levels = [];
      state.scratch = null;
      state.session = null;
      state.pinch = null;
    },
  },

  methods: {
    /** 设置峰值金字塔（直接传引用，不走 setData）。 */
    setPeaks(levels: readonly PeaksLevel[], sampleRate?: number): void {
      const state = stateOf(this);
      state.levels = levels;
      if (sampleRate && sampleRate > 0) state.sampleRate = sampleRate;
      paintFull(state);
    },

    /** 设置工程时长（打开工程后由页面调用）。 */
    setDuration(durationSec: Seconds): void {
      const state = stateOf(this);
      state.durationSec = Math.max(0, durationSec);
      state.viewport = clampViewport(state.viewport, state.durationSec, state.widthPx);
      paintFull(state);
    },

    /** 应用用户偏好（性能模式与震动）；偏好变更后由页面再次调用。 */
    applyPreferences(options: { perfMode?: string; haptic?: boolean }): void {
      const state = stateOf(this);
      if (options.perfMode) state.perfMode = options.perfMode;
      if (options.haptic !== undefined) state.haptic = options.haptic;
    },

    getViewport(): Viewport {
      return stateOf(this).viewport;
    },

    setViewport(viewport: Viewport): void {
      const state = stateOf(this);
      state.viewport = clampViewport(viewport, state.durationSec, state.widthPx);
      paintFull(state);
    },

    setSelection(selection: TimeRange | null): void {
      const state = stateOf(this);
      state.selection = selection;
      blit(state, 0);
    },

    setPlayhead(sec: Seconds): void {
      const state = stateOf(this);
      state.playheadSec = Math.min(Math.max(0, sec), Math.max(0, state.durationSec));
      blit(state, 0);
    },

    /** 容器尺寸变化后（如旋转、分栏）重新测量并整绘。 */
    remeasure(): void {
      measure(this, stateOf(this));
    },

    handleTouchStart(event: WechatMiniprogram.TouchEvent): void {
      const state = stateOf(this);
      const touches = event.touches;
      if (!touches || touches.length === 0) return;

      if (touches.length >= 2) {
        // 规则：双指落下时取消进行中的单指操作
        state.session = null;
        state.gestureMode = 'zoom';
        state.pinch = beginPinch(state, touches);
        return;
      }

      const touch = touches[0];
      if (!touch) return;
      const xPx = touchXPx(state, touch);
      state.gestureMode = 'drag';
      state.session = beginDrag({
        viewport: state.viewport,
        xPx,
        playheadSec: state.playheadSec,
        selection: state.selection,
      });
    },

    handleTouchMove(event: WechatMiniprogram.TouchEvent): void {
      const state = stateOf(this);
      const touches = event.touches;
      if (!touches || touches.length === 0) return;

      if (touches.length >= 2) {
        if (state.gestureMode !== 'zoom') {
          state.session = null;
          state.gestureMode = 'zoom';
          state.pinch = beginPinch(state, touches);
        }
        const pinch = state.pinch;
        const first = touches[0];
        const second = touches[1];
        if (!pinch || !first || !second) return;
        const x1 = touchXPx(state, first);
        const x2 = touchXPx(state, second);
        updatePinch(state, Math.max(1, Math.abs(x2 - x1)), (x1 + x2) / 2);
        return;
      }

      const session = state.session;
      const touch = touches[0];
      if (state.gestureMode !== 'drag' || !session || !touch) return;

      const fine = isFineMode(state.viewport.pxPerSecond);
      const previousPlayheadSec = state.playheadSec;
      const result = updateDrag(session, state.viewport, touchXPx(state, touch), {
        durationSec: state.durationSec,
        // 放大到 20ms/px 以内时按 5ms 步进，避免手指抖动改不到想要的位置
        ...(fine ? { snapGridSec: FINE_STEP_SEC } : {}),
      });

      state.playheadSec = result.playheadSec;
      if (result.selectionChanged) state.selection = result.selection;

      // 视口未变：复用离屏位图，只重画叠加层
      blit(state, 0);

      if (fine && state.haptic && Math.abs(state.playheadSec - previousPlayheadSec) >= FINE_STEP_SEC) {
        wx.vibrateShort({ type: 'light' });
      }
    },

    handleTouchEnd(event: WechatMiniprogram.TouchEvent): void {
      const state = stateOf(this);
      // 还有手指留在屏幕上：等全部抬起再提交
      if (event.touches && event.touches.length > 0) return;

      const commit = (kind: string): void => {
        this.triggerEvent('gesturecommit', {
          kind,
          playheadSec: state.playheadSec,
          selection: state.selection,
          viewport: state.viewport,
        });
      };

      if (state.gestureMode === 'zoom') {
        state.gestureMode = 'none';
        state.pinch = null;
        paintFull(state);
        this.triggerEvent('viewchange', { viewport: state.viewport });
        commit('zoom');
        return;
      }

      if (state.gestureMode === 'drag' && state.session) {
        const kind = state.session.target;
        state.gestureMode = 'none';
        state.session = null;
        paintFull(state);
        commit(kind);
      }
    },

    handleTouchCancel(): void {
      const state = stateOf(this);
      state.gestureMode = 'none';
      state.session = null;
      state.pinch = null;
      paintFull(state);
    },
  },
});

function beginPinch(
  state: WaveformState,
  touches: WechatMiniprogram.TouchEvent['touches'],
): PinchState | null {
  const first = touches[0];
  const second = touches[1];
  if (!first || !second) return null;

  const x1 = touchXPx(state, first);
  const x2 = touchXPx(state, second);
  const midXPx = (x1 + x2) / 2;
  return {
    startDistancePx: Math.max(1, Math.abs(x2 - x1)),
    startMidXPx: midXPx,
    startViewport: state.viewport,
    anchorSec: xToTime(state.viewport, midXPx),
  };
}
