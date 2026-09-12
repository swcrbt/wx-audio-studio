/**
 * 预览缓存：`renders/preview-{projectId}.wav` 的脏区间与渲染调度。
 *
 * 模型：预览文件对应**一个窗口**（`[startSec, endSec)`），路径固定 —— 为新窗口渲染会覆盖旧文件。
 * 因此"局部编辑只失效局部"通过脏区间列表实现：播放窗口只要与任一脏区间相交，
 * 就需要重新渲染整个窗口（窗口本身很小，重渲染比拼装多窗口文件简单可靠）。
 *
 * 渲染由调用方注入（生产实现包 `RenderController`），所以调度与命中判定可在 Node 中单测。
 */
import type { Id, Seconds, TimeRange } from '../types';
import { logger } from '../../utils/logger';

/** 播放头前方的预留时长：用户往回拖一点不必等重渲染。 */
export const PREVIEW_LEAD_SEC = 5;
/** 播放头后方的预渲染时长：决定"最多能连听多久不用等"。 */
export const PREVIEW_TAIL_SEC = 60;
/** 窗口变化容差：播放头微动不触发重渲染。 */
export const WINDOW_TOLERANCE_SEC = 0.5;

export interface PreviewWindow {
  startSec: Seconds;
  endSec: Seconds;
}

export interface PreviewRenderResult {
  filePath: string;
  bytes: number;
  frames: number;
}

export interface PreviewInfo {
  filePath: string;
  window: PreviewWindow;
  /** 是否直接命中了缓存（未重新渲染）。 */
  cached: boolean;
  renderedAt: number | null;
}

export interface PreviewCacheOptions {
  projectId: Id;
  previewPath: string;
  /** 当前工程时长（秒）：窗口必须夹在有效范围内。 */
  durationSec: () => Seconds;
  render: (range: PreviewWindow) => Promise<PreviewRenderResult>;
  leadSec?: Seconds;
  tailSec?: Seconds;
  now?: () => number;
}

/** 工程为空（时长为 0）时没有可预览的内容。 */
export class PreviewEmptyError extends Error {
  constructor() {
    super('工程还没有内容，先导入素材或录音');
    this.name = 'PreviewEmptyError';
  }
}

export class PreviewCache {
  private readonly options: PreviewCacheOptions;
  private readonly leadSec: Seconds;
  private readonly tailSec: Seconds;
  private readonly now: () => number;

  private dirty: TimeRange[] = [];
  private allDirty = true;
  private currentWindow: PreviewWindow | null = null;
  private renderedAt: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: PreviewCacheOptions) {
    this.options = options;
    this.leadSec = Math.max(0, options.leadSec ?? PREVIEW_LEAD_SEC);
    this.tailSec = Math.max(0, options.tailSec ?? PREVIEW_TAIL_SEC);
    this.now = options.now ?? (() => Date.now());
  }

  get window(): PreviewWindow | null {
    return this.currentWindow;
  }

  get dirtyRanges(): readonly TimeRange[] {
    return this.dirty;
  }

  get isFullyDirty(): boolean {
    return this.allDirty;
  }

  /** 标记一段区间失效（编辑、删除、效果参数变化后调用）。 */
  markDirty(fromSec: Seconds, toSec: Seconds): void {
    const from = Math.max(0, Math.min(fromSec, toSec));
    const to = Math.max(fromSec, toSec);
    if (to <= from) return;
    this.allDirty = false;
    this.dirty = mergeRanges([...this.dirty, { startSec: from, endSec: to }]);
  }

  /** 整体失效（批量操作、采样率变化、工程刚打开）。 */
  markAllDirty(): void {
    this.allDirty = true;
    this.dirty = [];
  }

  /** 以播放头为中心计算应渲染的窗口。 */
  windowFor(playheadSec: Seconds): PreviewWindow {
    const duration = Math.max(0, this.options.durationSec());
    const startSec = Math.max(0, Math.min(playheadSec - this.leadSec, duration));
    const endSec = Math.min(duration, startSec + this.leadSec + this.tailSec);
    return { startSec, endSec };
  }

  /** 该窗口是否需要重新渲染。 */
  needsRender(window: PreviewWindow): boolean {
    if (this.allDirty) return true;
    const current = this.currentWindow;
    if (!current) return true;
    if (
      Math.abs(current.startSec - window.startSec) > WINDOW_TOLERANCE_SEC ||
      Math.abs(current.endSec - window.endSec) > WINDOW_TOLERANCE_SEC
    ) {
      return true;
    }
    return this.dirty.some((range) => rangesIntersect(range, window));
  }

  /**
   * 确保预览可用：必要时渲染窗口，否则直接复用缓存。
   *
   * 并发调用会串行执行（渲染引擎本身也不允许并行），后到的调用在第一个完成后再判断。
   */
  ensure(playheadSec: Seconds): Promise<PreviewInfo> {
    const run = (): Promise<PreviewInfo> => this.doEnsure(playheadSec);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** 预览文件路径（窗口无关，固定路径）。 */
  get filePath(): string {
    return this.options.previewPath;
  }

  private async doEnsure(playheadSec: Seconds): Promise<PreviewInfo> {
    const window = this.windowFor(playheadSec);
    if (window.endSec <= window.startSec) throw new PreviewEmptyError();

    if (!this.needsRender(window)) {
      return { filePath: this.options.previewPath, window, cached: true, renderedAt: this.renderedAt };
    }

    const result = await this.options.render(window);
    this.currentWindow = window;
    this.renderedAt = this.now();
    this.allDirty = false;
    // 窗口已覆盖的脏区间可以清除，窗口外的脏区间保留（下次换窗口时还会命中）
    this.dirty = this.dirty.filter((range) => !rangeCoveredBy(range, window));

    logger.debug('player', `preview rendered ${window.startSec.toFixed(2)}-${window.endSec.toFixed(2)}s`);
    return { filePath: result.filePath, window, cached: false, renderedAt: this.renderedAt };
  }
}

/** 合并相交或相邻的区间，输出按起点排序且互不相交的列表。 */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);
  const merged: TimeRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startSec <= last.endSec) {
      merged[merged.length - 1] = { startSec: last.startSec, endSec: Math.max(last.endSec, range.endSec) };
      continue;
    }
    merged.push({ startSec: range.startSec, endSec: range.endSec });
  }
  return merged;
}

function rangesIntersect(a: TimeRange, b: TimeRange): boolean {
  return a.startSec < b.endSec && b.startSec < a.endSec;
}

function rangeCoveredBy(range: TimeRange, window: PreviewWindow): boolean {
  return range.startSec >= window.startSec && range.endSec <= window.endSec;
}
