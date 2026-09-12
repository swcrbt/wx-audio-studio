/**
 * 波形区绘制（Canvas 2D）。
 *
 * 只画"每像素一条竖线（min..max）"：像素列的数据来自峰值金字塔的抽样
 * （`samplePeaks`），因此绘制成本与屏幕宽度成正比，与音频长度无关。
 *
 * 三件事分开，方便手势期间只补边缘：
 * 1. `drawBackground` —— 背板与网格；
 * 2. `drawWaveform`   —— 波形竖线（可按列区间重绘）；
 * 3. `drawOverlay`    —— 选区、手柄、播放头（每次手势都要重画，成本很低）。
 */
import type { Px, Seconds, TimeRange } from '../../core/types';
import { gridStepSec, timeToX, xToTime, type Viewport } from '../../core/view/viewport';
import type { PeaksLevel } from '../../workers/render/peaks/build';
import { samplePeaks } from '../../workers/render/peaks/sample';

/** 绘制接口：只声明实际用到的成员，避免依赖 DOM 的 `CanvasRenderingContext2D` 类型。 */
export interface WaveformCtx {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  scale(x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  drawImage(image: unknown, dx: number, dy: number, dw?: number, dh?: number): void;
}

export interface WaveformStyle {
  background: string;
  /** 未选中的波形色。 */
  wave: string;
  /** 选区内的波形色。 */
  waveSelected: string;
  playhead: string;
  selectionFill: string;
  selectionBorder: string;
  grid: string;
  /** 接近满量程的警告色。 */
  clipWarn: string;
}

/** 编辑器深色主题（色值见 docs/04 §5）。 */
export const DARK_WAVE_STYLE: WaveformStyle = {
  background: '#12151A',
  wave: '#4C8DFF',
  waveSelected: '#19C37D',
  playhead: '#FF4D4F',
  selectionFill: 'rgba(76,141,255,0.18)',
  selectionBorder: '#4C8DFF',
  grid: 'rgba(255,255,255,0.06)',
  clipWarn: '#FF7A45',
};

/** 视觉常量。 */
export const AMPLITUDE_RATIO = 0.7;
export const SELECTION_HANDLE_WIDTH_PX = 8;
export const PLAYHEAD_WIDTH_PX = 1.5;
/** 单列波形的最小可见高度，避免静音段整片空白看不出"有内容"。 */
const MIN_COLUMN_HEIGHT_PX = 1;
/** 判定削波的阈值（留 0.1% 余量，避免正常满量程被误标）。 */
const CLIP_THRESHOLD = 0.999;

export interface WaveformFrame {
  viewport: Viewport;
  widthPx: Px;
  heightPx: number;
  /** 工程采样率：秒与采样帧的换算基准。 */
  sampleRate: number;
  selection: TimeRange | null;
  playheadSec: Seconds;
}

function midlineY(heightPx: number): number {
  return Math.round(heightPx / 2) + 0.5;
}

function amplitudePx(heightPx: number): number {
  return (heightPx * AMPLITUDE_RATIO) / 2;
}

/** 背板与网格。 */
export function drawBackground(
  ctx: WaveformCtx,
  frame: WaveformFrame,
  style: WaveformStyle,
  fromX: Px = 0,
  toX: Px = frame.widthPx,
): void {
  ctx.fillStyle = style.background;
  ctx.fillRect(fromX, 0, Math.max(0, toX - fromX), frame.heightPx);

  const stepSec = gridStepSec(frame.viewport.pxPerSecond);
  if (stepSec !== null) {
    const fromSec = xToTime(frame.viewport, fromX);
    const toSec = xToTime(frame.viewport, toX);
    ctx.fillStyle = style.grid;

    const firstTick = Math.ceil(fromSec / stepSec) * stepSec;
    for (let sec = firstTick; sec <= toSec; sec += stepSec) {
      const x = Math.round(timeToX(frame.viewport, sec));
      if (x >= fromX && x < toX) ctx.fillRect(x, 0, 1, frame.heightPx);
    }
  }

  // 中线（弱化，帮助判断静音与偏移）
  ctx.fillStyle = style.grid;
  ctx.fillRect(fromX, midlineY(frame.heightPx), Math.max(0, toX - fromX), 1);
}

/**
 * 波形竖线。
 *
 * @param scratch 复用缓冲（长度 ≥ `(toX - fromX) * 2`），避免手势期间反复分配
 * @param columnStepPx 每隔几列画一条（缩放手势中降级到 2，代价减半、观感仍可辨）
 */
export function drawWaveform(
  ctx: WaveformCtx,
  levels: readonly PeaksLevel[],
  frame: WaveformFrame,
  style: WaveformStyle,
  fromX: Px = 0,
  toX: Px = frame.widthPx,
  scratch?: Float32Array,
  columnStepPx = 1,
): void {
  const step = Math.max(1, Math.floor(columnStepPx));
  const columnCount = Math.max(0, Math.floor(toX - fromX));
  if (columnCount === 0 || levels.length === 0) return;

  const samples = scratch && scratch.length >= columnCount * 2 ? scratch : new Float32Array(columnCount * 2);
  const fromSample = xToTime(frame.viewport, fromX) * frame.sampleRate;
  const toSample = xToTime(frame.viewport, toX) * frame.sampleRate;
  samplePeaks(levels, fromSample, toSample, columnCount, samples);

  const midY = midlineY(frame.heightPx);
  const amp = amplitudePx(frame.heightPx);
  const selection = frame.selection;
  const selectionFromX = selection ? timeToX(frame.viewport, selection.startSec) : Number.NEGATIVE_INFINITY;
  const selectionToX = selection ? timeToX(frame.viewport, selection.endSec) : Number.NEGATIVE_INFINITY;

  // 同一颜色连续绘制，减少 fillStyle 切换
  ctx.fillStyle = style.wave;
  for (let p = 0; p < columnCount; p += step) {
    const x = fromX + p;
    if (x >= selectionFromX && x < selectionToX) continue;
    fillColumn(ctx, x, midY, amp, samples[p * 2] ?? 0, samples[p * 2 + 1] ?? 0, step);
  }

  if (selection) {
    ctx.fillStyle = style.waveSelected;
    const start = Math.max(fromX, Math.floor(selectionFromX));
    const end = Math.min(toX, Math.ceil(selectionToX));
    for (let x = start; x < end; x += step) {
      const p = x - fromX;
      fillColumn(ctx, x, midY, amp, samples[p * 2] ?? 0, samples[p * 2 + 1] ?? 0, step);
    }
  }

  // 削波列最后画，覆盖在其它着色之上
  ctx.fillStyle = style.clipWarn;
  for (let p = 0; p < columnCount; p += step) {
    const min = samples[p * 2] ?? 0;
    const max = samples[p * 2 + 1] ?? 0;
    if (Math.max(Math.abs(min), Math.abs(max)) < CLIP_THRESHOLD) continue;
    fillColumn(ctx, fromX + p, midY, amp, min, max, step);
  }
}

function fillColumn(
  ctx: WaveformCtx,
  x: Px,
  midY: number,
  amp: number,
  min: number,
  max: number,
  widthPx = 1,
): void {
  const top = midY - max * amp;
  const bottom = midY - min * amp;
  const height = Math.max(MIN_COLUMN_HEIGHT_PX, bottom - top);
  ctx.fillRect(x, top, widthPx, height);
}

/** 选区高亮、手柄与播放头。 */
export function drawOverlay(
  ctx: WaveformCtx,
  frame: WaveformFrame,
  style: WaveformStyle,
): void {
  const { heightPx, viewport } = frame;

  if (frame.selection) {
    const startX = timeToX(viewport, frame.selection.startSec);
    const endX = timeToX(viewport, frame.selection.endSec);
    const left = Math.max(0, startX);
    const right = Math.min(frame.widthPx, endX);

    if (right > left) {
      ctx.fillStyle = style.selectionFill;
      ctx.fillRect(left, 0, right - left, heightPx);
    }

    ctx.fillStyle = style.selectionBorder;
    if (startX >= 0 && startX <= frame.widthPx) {
      ctx.fillRect(startX - SELECTION_HANDLE_WIDTH_PX / 2, 0, SELECTION_HANDLE_WIDTH_PX, heightPx);
    }
    if (endX >= 0 && endX <= frame.widthPx) {
      ctx.fillRect(endX - SELECTION_HANDLE_WIDTH_PX / 2, 0, SELECTION_HANDLE_WIDTH_PX, heightPx);
    }
  }

  const playheadX = timeToX(viewport, frame.playheadSec);
  if (playheadX < -PLAYHEAD_WIDTH_PX || playheadX > frame.widthPx + PLAYHEAD_WIDTH_PX) return;

  ctx.fillStyle = style.playhead;
  ctx.fillRect(playheadX, 0, PLAYHEAD_WIDTH_PX, heightPx);

  // 顶部小三角，方便看清播放头位置
  ctx.beginPath();
  ctx.moveTo(playheadX - 4, 0);
  ctx.lineTo(playheadX + PLAYHEAD_WIDTH_PX + 4, 0);
  ctx.lineTo(playheadX + PLAYHEAD_WIDTH_PX / 2, 8);
  ctx.closePath();
  ctx.fill();
}
