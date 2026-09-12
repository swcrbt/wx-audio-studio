/**
 * 编辑器页面：单素材波形切割视图。
 *
 * M1 实现范围（docs/04 §3）：一条焦点素材的波形 + 选区 + 播放头 + 切割类工具。
 * 波形数据是焦点素材的峰值金字塔（第一声道），横轴为素材时间；单片段工程的
 * 工程时间轴与素材时间一致，因此选区可直接用于 `edl/ops` 的时间轴操作。
 * 多片段拼接在混音页完成（docs/04 §2 的页面流程）。
 *
 * 大对象（工程状态、峰值、播放器）放在模块级 `WeakMap`：`setData` 会走序列化，
 * 峰值与 EDL 不能进 `data`。
 */
import type { Id, Px, Seconds, TimeRange } from '../../core/types';
import { PreviewCache, PreviewEmptyError } from '../../core/player/preview-cache';
import { Transport } from '../../core/player/transport';
import { ProjectStore, ProjectStoreError } from '../../core/store/project-store';
import { loadAssetPeaks, openProject, ProjectLoadError } from '../../core/store/load-project';
import { RenderController } from '../../core/engine/controller';
import { paths } from '../../core/fs/paths';
import {
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  clampPxPerSecond,
  clampViewport,
  tickTimes,
  timeToX,
  visibleRange,
  type Viewport,
} from '../../core/view/viewport';
import { deleteRange, setClipFade, setClipGainDb, splitClipAt, trimToRange } from '../../workers/render/edl/ops';
import { MIN_GAIN_DB } from '../../workers/render/constants';
import { DEFAULT_RENDER_CHUNK_SEC } from '../../workers/render/constants';
import { edlDurationSec } from '../../workers/render/edl/query';
import type { PeaksLevel } from '../../workers/render/peaks/build';
import { createId } from '../../core/fs/paths';
import { readSettings } from '../../core/settings';
import { formatDuration, formatDurationShort } from '../../utils/format';
import { logger } from '../../utils/logger';

/** 波形画布组件的对外方法（组件侧用 Component 定义，页面侧只关心这份契约）。 */
interface WaveCanvasApi {
  setPeaks(levels: readonly PeaksLevel[], sampleRate?: number): void;
  setDuration(sec: Seconds): void;
  setViewport(viewport: Viewport): void;
  setSelection(selection: TimeRange | null): void;
  setPlayhead(sec: Seconds): void;
  applyPreferences(options: { perfMode?: string; haptic?: boolean }): void;
}

function waveCanvas(page: WechatMiniprogram.Page.TrivialInstance): WaveCanvasApi | null {
  const component = page.selectComponent('#wave');
  if (!component) return null;
  return component as unknown as WaveCanvasApi;
}

interface Tick {
  sec: Seconds;
  xPx: Px;
  label: string;
}

interface ToolView {
  action: string;
  label: string;
  enabled: boolean;
}

interface EditorState {
  store: ProjectStore | null;
  peaks: PeaksLevel[];
  viewport: Viewport;
  selection: TimeRange | null;
  playheadSec: Seconds;
  widthPx: Px;
  transport: Transport | null;
  preview: PreviewCache | null;
  /** 当前预览文件覆盖的窗口起点（把播放位置换算成工程时间）。 */
  windowStartSec: Seconds;
  /// 焦点片段/素材（M1 单素材视图）
  focusTrackId: Id | null;
  focusClipId: Id | null;
  focusAssetPath: string | null;
  unsubscribe: (() => void) | null;
  rate: number;
}

const states = new WeakMap<object, EditorState>();

function stateOf(instance: object): EditorState {
  let state = states.get(instance);
  if (!state) {
    state = {
      store: null,
      peaks: [],
      viewport: { startSec: 0, pxPerSecond: 60 },
      selection: null,
      playheadSec: 0,
      widthPx: 360,
      transport: null,
      preview: null,
      windowStartSec: 0,
      focusTrackId: null,
      focusClipId: null,
      focusAssetPath: null,
      unsubscribe: null,
      rate: 1,
    };
    states.set(instance, state);
  }
  return state;
}

const TOOL_DEFS: ReadonlyArray<{ action: string; label: string; needsSelection: boolean }> = [
  { action: 'trim', label: '裁剪', needsSelection: true },
  { action: 'cut', label: '删除选区', needsSelection: true },
  { action: 'mute', label: '静音', needsSelection: true },
  { action: 'fadeIn', label: '淡入', needsSelection: true },
  { action: 'fadeOut', label: '淡出', needsSelection: true },
  { action: 'split', label: '在播放头分割', needsSelection: false },
  { action: 'clearSelection', label: '取消选区', needsSelection: true },
  { action: 'selectAll', label: '全选', needsSelection: false },
];

Page({
  data: {
    loading: true,
    error: '',
    projectName: '',
    durationSec: 0,
    sampleRate: 44100,
    durationLabel: '00:00.000',
    positionLabel: '00:00.000',
    selectionLabel: '',
    ticks: [] as Tick[],
    playing: false,
    preparing: false,
    rateLabel: '1.0×',
    zoomLabel: '',
    canUndo: false,
    canRedo: false,
    undoLabel: '',
    readOnly: false,
    tools: TOOL_DEFS.map((tool) => ({
      action: tool.action,
      label: tool.label,
      enabled: !tool.needsSelection,
    })) as ToolView[],
  },

  async onLoad(query: Record<string, string | undefined>) {
    const projectId = query.projectId ?? query.id;
    if (!projectId) {
      this.setData({ loading: false, error: '缺少工程 id' });
      return;
    }
    await loadEditor(this, projectId);
  },

  onShow() {
    // 偏好可能在设置页改过，回前台时重新套用
    const settings = readSettings();
    waveCanvas(this)?.applyPreferences({
      perfMode: settings.performanceMode,
      haptic: settings.hapticEnabled,
    });
  },

  onReady() {
    // 画布尺寸决定刻度与视口夹取范围，必须等布局完成后再测
    wx.createSelectorQuery()
      .select('.wave-area')
      .boundingClientRect((rect) => {
        const state = stateOf(this);
        if (rect && !Array.isArray(rect) && rect.width > 0) {
          state.widthPx = Math.round(rect.width);
          refreshTicks(this);
        }
      })
      .exec();

    const state = stateOf(this);
    if (state.peaks.length > 0) pushPeaks(this);
  },

  onHide() {
    const state = stateOf(this);
    state.transport?.pause();
    void state.store?.flush();
  },

  onUnload() {
    const state = stateOf(this);
    state.transport?.destroy();
    state.unsubscribe?.();
    state.store?.dispose();
  },

  /** 波形区手势提交：处理 seek / 选区 / 缩放。 */
  handleGestureCommit(event: WechatMiniprogram.CustomEvent) {
    const detail = event.detail as {
      kind: string;
      playheadSec: Seconds;
      selection: TimeRange | null;
      viewport: Viewport;
    };
    const state = stateOf(this);

    state.playheadSec = detail.playheadSec;
    state.selection = detail.selection;
    state.viewport = detail.viewport;
    refreshTicks(this);
    refreshSelectionLabel(this);

    if (detail.kind === 'selectionStart' || detail.kind === 'selectionEnd' || detail.kind === 'selection') {
      // 松手才提交：手势期间不碰 EDL（性能红线）
      return;
    }
    if (detail.kind === 'zoom') return;

    seekTo(this, detail.playheadSec);
  },

  handleViewChange(event: WechatMiniprogram.CustomEvent) {
    const detail = event.detail as { viewport: Viewport };
    const state = stateOf(this);
    state.viewport = detail.viewport;
    refreshTicks(this);
  },

  handleUndo() {
    const state = stateOf(this);
    if (!state.store || !state.store.undo()) return;
    afterEdit(this, '撤销');
  },

  handleRedo() {
    const state = stateOf(this);
    if (!state.store || !state.store.redo()) return;
    afterEdit(this, '重做');
  },

  async handleTogglePlay() {
    const state = stateOf(this);
    if (!state.transport || !state.preview) return;

    if (this.data.playing) {
      state.transport.pause();
      this.setData({ playing: false });
      return;
    }

    await preparePreview(this);
    const transport = state.transport;
    if (!transport) return;
    transport.play({
      fromSec: Math.max(0, state.playheadSec - state.windowStartSec),
      rate: state.rate,
    });
  },

  handleSeekStart() {
    const state = stateOf(this);
    seekTo(this, Math.max(0, state.playheadSec - 5));
  },

  handleSeekEnd() {
    const state = stateOf(this);
    seekTo(this, Math.min(this.data.durationSec, state.playheadSec + 5));
  },

  handleCycleRate() {
    const state = stateOf(this);
    const candidates = [1, 1.5, 0.5, 0.75, 1.25, 2];
    const index = candidates.indexOf(state.rate);
    const next = candidates[(index + 1) % candidates.length] ?? 1;
    state.rate = next;
    state.transport?.setRate(next);
    this.setData({ rateLabel: `${next.toFixed(2)}×` });
  },

  handleZoomIn() {
    zoomBy(this, 1.5);
  },

  handleZoomOut() {
    zoomBy(this, 1 / 1.5);
  },

  handleZoomFit() {
    const state = stateOf(this);
    const duration = Math.max(0.1, this.data.durationSec);
    state.viewport = { startSec: 0, pxPerSecond: clampPxPerSecond(state.widthPx / duration) };
    applyViewport(this);
  },

  handleTool(event: WechatMiniprogram.TouchEvent) {
    const action = (event.currentTarget.dataset as { action?: string }).action;
    if (!action) return;
    const state = stateOf(this);
    const store = state.store;
    if (!store) return;

    if (action === 'clearSelection') {
      state.selection = null;
      applySelection(this);
      return;
    }
    if (action === 'selectAll') {
      state.selection = { startSec: 0, endSec: this.data.durationSec };
      applySelection(this);
      return;
    }

    const selection = state.selection;
    try {
      if (action === 'trim') {
        if (!selection) return;
        commitEdl(this, '裁剪到选区', (edl) => trimToRange(edl, selection, createId));
      } else if (action === 'cut') {
        if (!selection) return;
        commitEdl(this, '删除选区', (edl) => deleteRange(edl, selection, { ripple: true }, createId));
      } else if (action === 'mute') {
        if (!selection || !state.focusTrackId || !state.focusClipId) return;
        commitEdl(this, '静音', (edl) =>
          setClipGainDb(edl, state.focusTrackId ?? '', state.focusClipId ?? '', MIN_GAIN_DB),
        );
      } else if (action === 'fadeIn' || action === 'fadeOut') {
        if (!selection || !state.focusTrackId || !state.focusClipId) return;
        const durationSec = Math.max(0.05, selection.endSec - selection.startSec);
        commitEdl(this, action === 'fadeIn' ? '淡入' : '淡出', (edl) =>
          setClipFade(
            edl,
            state.focusTrackId ?? '',
            state.focusClipId ?? '',
            action === 'fadeIn' ? 'in' : 'out',
            { durationSec, curve: 'equalPower' },
          ),
        );
      } else if (action === 'split') {
        if (!state.focusTrackId || !state.focusClipId) return;
        const atSec = state.playheadSec;
        commitEdl(this, '分割', (edl) =>
          splitClipAt(edl, state.focusTrackId ?? '', state.focusClipId ?? '', atSec, createId()),
        );
      }
    } catch (error) {
      if (error instanceof ProjectStoreError) {
        wx.showToast({ title: error.message, icon: 'none' });
        return;
      }
      throw error;
    }
  },

  handleExport() {
    const projectId = stateOf(this).store?.project.id;
    if (!projectId) return;
    wx.navigateTo({ url: `/pages/export/export?projectId=${projectId}` });
  },

  handleOpenMixer() {
    const projectId = stateOf(this).store?.project.id;
    if (!projectId) return;
    wx.navigateTo({ url: `/pages/mixer/mixer?projectId=${projectId}` });
  },

  handleLeave() {
    wx.navigateBack({ delta: 1 });
  },
});

/** 载入工程、峰值与播放器。 */
async function loadEditor(page: WechatMiniprogram.Page.TrivialInstance, projectId: Id): Promise<void> {
  const state = stateOf(page);
  try {
    const { store, issues } = await openProject(projectId);
    state.store = store;

    const project = store.project;
    const track = project.tracks[0];
    const clip = track?.clips[0];
    state.focusTrackId = track?.id ?? null;
    state.focusClipId = clip?.id ?? null;

    const durationSec = edlDurationSec(store.edl);
    page.setData({
      loading: false,
      projectName: project.name,
      durationSec,
      sampleRate: project.sampleRate,
      durationLabel: formatDuration(durationSec),
      canUndo: false,
      canRedo: false,
      readOnly: store.isReadOnly,
    });
    wx.setNavigationBarTitle({ title: project.name });

    state.unsubscribe = store.subscribe((snapshot) => {
      page.setData({
        canUndo: snapshot.canUndo,
        canRedo: snapshot.canRedo,
        undoLabel: snapshot.undoLabel ?? '',
        readOnly: snapshot.readOnly,
        durationSec: snapshot.durationSec,
        durationLabel: formatDuration(snapshot.durationSec),
      });
    });

    // 焦点素材的峰值：波形横轴为素材时间（M1 单素材视图）
    if (clip) {
      const asset = project.assets.find((item) => item.id === clip.assetId);
      if (asset) {
        state.focusAssetPath = asset.path;
        const levels = await loadAssetPeaks(asset.id);
        const first = levels?.[0] ?? [];
        state.peaks = first;
        // 单片段工程的素材时间与工程时间一致，直接用工程时长做视口边界
        pushPeaks(page);
      }
    }

    state.transport = createTransport(page);
    state.preview = createPreview(projectId, store);
    refreshTicks(page);
    refreshSelectionLabel(page);

    if (issues.length > 0) {
      wx.showToast({ title: `工程已修复 ${issues.length} 处问题`, icon: 'none' });
      logger.warn('editor', `project repaired with ${issues.length} issues`);
    }
  } catch (error) {
    const message =
      error instanceof ProjectLoadError ? error.message : '工程打开失败，请返回重试';
    logger.warn('editor', 'open project failed', error);
    page.setData({ loading: false, error: message });
  }
}

function pushPeaks(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  const canvas = waveCanvas(page);
  if (!canvas) return;
  canvas.setPeaks(state.peaks, page.data.sampleRate);
  canvas.setDuration(page.data.durationSec);
}

function createTransport(page: WechatMiniprogram.Page.TrivialInstance): Transport {
  const state = stateOf(page);
  return new Transport({
    onStateChange: (transportState) => {
      page.setData({ playing: transportState === 'playing' });
    },
    onPosition: (positionSec) => {
      const absoluteSec = state.windowStartSec + positionSec;
      state.playheadSec = absoluteSec;
      page.setData({ positionLabel: formatDuration(absoluteSec) });
      waveCanvas(page)?.setPlayhead(absoluteSec);
    },
    onEnded: () => {
      page.setData({ playing: false });
    },
    onError: (error) => {
      wx.showToast({ title: error.message, icon: 'none' });
    },
  });
}

/** 预览缓存：渲染函数包一层 `RenderController`（Worker 分块渲染到预览文件）。 */
function createPreview(projectId: Id, store: ProjectStore): PreviewCache {
  return new PreviewCache({
    projectId,
    previewPath: paths.preview(projectId),
    durationSec: () => edlDurationSec(store.edl),
    render: async (window) => {
      const controller = new RenderController({
        job: {
          projectId,
          edl: store.edl,
          output: { sampleRate: store.project.sampleRate, channels: store.project.channels },
          range: { startSec: window.startSec, endSec: window.endSec },
          chunkSec: DEFAULT_RENDER_CHUNK_SEC,
          targetPath: paths.preview(projectId),
        },
      });
      const result = await controller.start();
      return { filePath: result.filePath, bytes: result.bytes, frames: result.frames };
    },
  });
}

/** 确保预览窗口就绪（命中缓存则秒回，命中脏区间则先渲染）。 */
async function preparePreview(page: WechatMiniprogram.Page.TrivialInstance): Promise<void> {
  const state = stateOf(page);
  const preview = state.preview;
  const transport = state.transport;
  if (!preview || !transport) return;

  page.setData({ preparing: true });
  try {
    const info = await preview.ensure(state.playheadSec);
    state.windowStartSec = info.window.startSec;
    transport.load(info.filePath);
  } catch (error) {
    if (error instanceof PreviewEmptyError) {
      wx.showToast({ title: error.message, icon: 'none' });
    } else {
      logger.warn('editor', 'preview render failed', error);
      wx.showToast({ title: '预览生成失败，请重试', icon: 'none' });
    }
    throw error;
  } finally {
    page.setData({ preparing: false });
  }
}

/** seek：先让预览窗口覆盖目标位置，再定位播放器。 */
function seekTo(page: WechatMiniprogram.Page.TrivialInstance, sec: Seconds): void {
  const state = stateOf(page);
  state.playheadSec = Math.min(Math.max(0, sec), page.data.durationSec);
  page.setData({ positionLabel: formatDuration(state.playheadSec) });

  const canvas = waveCanvas(page);
  canvas?.setPlayhead(state.playheadSec);

  const transport = state.transport;
  if (!transport?.filePath) return;
  // 预览文件只覆盖一个窗口：目标在窗口内才直接 seek，否则等下次播放时重渲染
  const relativeSec = state.playheadSec - state.windowStartSec;
  if (relativeSec >= 0 && relativeSec <= transport.durationSec) transport.seek(relativeSec);
}

/** 提交一次 EDL 变更（正/逆操作都用快照引用：EDL 是不可变替换，旧对象仍完整）。 */
function commitEdl(
  page: WechatMiniprogram.Page.TrivialInstance,
  label: string,
  apply: (edl: import('../../core/types').Edl) => import('../../core/types').Edl,
): void {
  const state = stateOf(page);
  const store = state.store;
  if (!store) return;

  const before = store.edl;
  store.commit({
    id: `editor-${Date.now()}`,
    label,
    at: Date.now(),
    apply,
    invert: () => before,
  });
  afterEdit(page, label);
}

/** 编辑后的统一收尾：刷新时长/选区标签，标记预览失效并重新加载波形。 */
function afterEdit(page: WechatMiniprogram.Page.TrivialInstance, label: string): void {
  const state = stateOf(page);
  const durationSec = state.store ? edlDurationSec(state.store.edl) : page.data.durationSec;

  state.selection = null;
  state.playheadSec = Math.min(state.playheadSec, durationSec);
  state.preview?.markAllDirty();
  state.windowStartSec = 0;
  state.transport?.stop();

  page.setData({ durationSec, durationLabel: formatDuration(durationSec), playing: false });
  applySelection(page);
  applyViewport(page);
  pushPeaks(page);
  wx.showToast({ title: label, icon: 'none', duration: 1200 });
}

/** 把视口推给画布并刷新刻度。 */
function applyViewport(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  state.viewport = clampViewport(state.viewport, page.data.durationSec, state.widthPx);
  waveCanvas(page)?.setViewport(state.viewport);
  refreshTicks(page);
}

function applySelection(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  waveCanvas(page)?.setSelection(state.selection);
  refreshSelectionLabel(page);
}

function refreshSelectionLabel(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  const selection = state.selection;
  if (!selection) {
    page.setData({ selectionLabel: '', tools: toolViews(false) });
    return;
  }
  const spanSec = Math.abs(selection.endSec - selection.startSec);
  page.setData({
    selectionLabel: `选区 ${formatDurationShort(spanSec)}`,
    tools: toolViews(true),
  });
}

function toolViews(hasSelection: boolean): ToolView[] {
  return TOOL_DEFS.map((tool) => ({
    action: tool.action,
    label: tool.label,
    enabled: tool.needsSelection ? hasSelection : true,
  }));
}

function refreshTicks(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  const widthPx = state.widthPx > 0 ? state.widthPx : 360;
  const ticks: Tick[] = tickTimes(state.viewport, widthPx).map((sec) => ({
    sec,
    xPx: Math.round(timeToX(state.viewport, sec)),
    label: formatDurationShort(sec),
  }));

  const visible = visibleRange(state.viewport, widthPx);
  page.setData({
    ticks,
    zoomLabel: `${Math.round(state.viewport.pxPerSecond)}px/s · ${formatDurationShort(
      visible.endSec - visible.startSec,
    )}/屏`,
  });
}

function zoomBy(page: WechatMiniprogram.Page.TrivialInstance, factor: number): void {
  const state = stateOf(page);
  const anchorSec = state.playheadSec;
  const anchorXPx = timeToX(state.viewport, anchorSec);
  const pxPerSecond = clampPxPerSecond(state.viewport.pxPerSecond * factor);
  state.viewport = clampViewport(
    { startSec: anchorSec - anchorXPx / pxPerSecond, pxPerSecond },
    page.data.durationSec,
    state.widthPx,
  );
  applyViewport(page);
}

/** 供 pages/index 复用的缩放边界（避免两处定义不同的上下限）。 */
export const ZOOM_LIMITS = { min: MIN_PX_PER_SECOND, max: MAX_PX_PER_SECOND };
