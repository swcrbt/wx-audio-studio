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
import { PreviewSession } from '../../core/player/preview-session';
import { ProjectStore, ProjectStoreError } from '../../core/store/project-store';
import { loadAssetPeaks, openProject, ProjectLoadError } from '../../core/store/load-project';
import { createId, paths } from '../../core/fs/paths';
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
import { clipById } from '../../workers/render/edl/query';
import { MAX_GAIN_DB, MIN_GAIN_DB } from '../../workers/render/constants';
import { edlDurationSec } from '../../workers/render/edl/query';
import type { PeaksLevel } from '../../workers/render/peaks/build';
import { readSettings } from '../../core/settings';
import { formatDuration, formatDurationShort } from '../../utils/format';
import type { ParamField } from '../../components/param-sheet/index';
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
  session: PreviewSession | null;
  /// 焦点片段/素材（M1 单素材视图）
  focusTrackId: Id | null;
  focusClipId: Id | null;
  focusAssetPath: string | null;
  unsubscribe: (() => void) | null;
  rate: number;
  /** 参数面板当前编辑的对象与取值（拖动中只改这里，不碰 EDL）。 */
  sheetKind: 'fade' | 'gain' | null;
  sheet: {
    durationSec: Seconds;
    curve: 'linear' | 'equalPower';
    target: 'in' | 'out' | 'both';
    gainDb: number;
  };
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
      session: null,
      focusTrackId: null,
      focusClipId: null,
      focusAssetPath: null,
      unsubscribe: null,
      rate: 1,
      sheetKind: null,
      sheet: { durationSec: 0.5, curve: 'equalPower', target: 'both', gainDb: 0 },
    };
    states.set(instance, state);
  }
  return state;
}

const TOOL_DEFS: ReadonlyArray<{ action: string; label: string; needsSelection: boolean }> = [
  { action: 'trim', label: '裁剪', needsSelection: true },
  { action: 'cut', label: '删除选区', needsSelection: true },
  { action: 'mute', label: '静音', needsSelection: true },
  { action: 'fade', label: '淡入淡出…', needsSelection: false },
  { action: 'gain', label: '音量…', needsSelection: false },
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
    sheetVisible: false,
    sheetTitle: '',
    sheetFields: [] as ParamField[],
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
    state.session?.pause();
    void state.store?.flush();
  },

  onUnload() {
    const state = stateOf(this);
    state.session?.destroy();
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
    const session = state.session;
    if (!session) return;

    if (this.data.playing) {
      session.pause();
      this.setData({ playing: false });
      return;
    }
    await session.play(state.playheadSec);
    session.setRate(state.rate);
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
    state.session?.setRate(next);
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
    if (action === 'fade') {
      openFadeSheet(this);
      return;
    }
    if (action === 'gain') {
      openGainSheet(this);
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
        if (!state.focusTrackId || !state.focusClipId) return;
        commitEdl(this, '静音', (edl) =>
          setClipGainDb(edl, state.focusTrackId ?? '', state.focusClipId ?? '', MIN_GAIN_DB),
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

  /** 停止：停止播放并把播放头留在当前位置。 */
  handleStop() {
    const state = stateOf(this);
    state.session?.stop();
    this.setData({ playing: false });
  },

  /** 参数面板的实时/提交两级上报：拖动中只回显，松手才写进 EDL。 */
  handleSheetChange(event: WechatMiniprogram.CustomEvent) {
    const detail = event.detail as { key: string; value: number | boolean | string; committed: boolean };
    const state = stateOf(this);
    applySheetValue(state, detail.key, detail.value);
    this.setData({ sheetFields: sheetFieldsFor(state) });
    if (!detail.committed) return;
    commitSheet(this);
  },

  handleSheetClose() {
    this.setData({ sheetVisible: false });
  },

  /** 面板内的动作按钮（如“恢复 0dB”）。 */
  handleSheetAction(event: WechatMiniprogram.CustomEvent) {
    const key = (event.detail as { key?: string }).key;
    const state = stateOf(this);
    if (key === 'reset') {
      state.sheet.gainDb = 0;
      this.setData({ sheetFields: sheetFieldsFor(state) });
      commitSheet(this);
    }
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

    state.session = createSession(page, projectId, store);
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

function createSession(
  page: WechatMiniprogram.Page.TrivialInstance,
  projectId: Id,
  store: ProjectStore,
): PreviewSession {
  const state = stateOf(page);
  return new PreviewSession({
    projectId,
    previewPath: paths.preview(projectId),
    getEdl: () => store.edl,
    output: { sampleRate: store.project.sampleRate, channels: store.project.channels },
    onPreparingChange: (preparing) => page.setData({ preparing }),
    onPosition: (absoluteSec) => {
      state.playheadSec = absoluteSec;
      page.setData({ positionLabel: formatDuration(absoluteSec) });
      waveCanvas(page)?.setPlayhead(absoluteSec);
    },
    onStateChange: (transportState) => page.setData({ playing: transportState === "playing" }),
    onEnded: () => page.setData({ playing: false }),
    onError: (error) => wx.showToast({ title: error.message, icon: "none" }),
  });
}

/** seek：先更新播放头，再尝试在当前预览窗口内定位（窗口外等下次播放重渲染）。 */
function seekTo(page: WechatMiniprogram.Page.TrivialInstance, sec: Seconds): void {
  const state = stateOf(page);
  state.playheadSec = Math.min(Math.max(0, sec), page.data.durationSec);
  page.setData({ positionLabel: formatDuration(state.playheadSec) });
  waveCanvas(page)?.setPlayhead(state.playheadSec);
  state.session?.seek(state.playheadSec);
}

/** 参数面板：淡入淡出（时长/曲线/应用位置）与音量（dB 滑杆）。 */
function openFadeSheet(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  state.sheetKind = 'fade';
  state.sheet.curve = 'equalPower';
  state.sheet.target = 'both';

  // 默认时长取当前选区长度（用户刚框完一段就调淡化，这个默认值才符合直觉）
  const selection = state.selection;
  const selectionSec = selection ? Math.abs(selection.endSec - selection.startSec) : 0;
  state.sheet.durationSec = clampFadeSec(selectionSec > 0.05 ? selectionSec : 0.5);

  page.setData({ sheetVisible: true, sheetTitle: '淡入淡出', sheetFields: sheetFieldsFor(state) });
}

function openGainSheet(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  const store = state.store;
  if (!store || !state.focusTrackId || !state.focusClipId) {
    wx.showToast({ title: '先选中一个片段', icon: 'none' });
    return;
  }

  const clip = clipById(store.edl, state.focusTrackId, state.focusClipId);
  state.sheetKind = 'gain';
  state.sheet.gainDb = Math.max(MIN_GAIN_DB, clip?.gainDb ?? 0);
  page.setData({ sheetVisible: true, sheetTitle: '片段音量', sheetFields: sheetFieldsFor(state) });
}

function clampFadeSec(sec: Seconds): Seconds {
  return Math.min(5, Math.max(0.05, Math.round(sec * 20) / 20));
}

function applySheetValue(
  state: EditorState,
  key: string,
  value: number | boolean | string,
): void {
  if (key === 'durationSec' && typeof value === 'number') state.sheet.durationSec = clampFadeSec(value);
  if (key === 'curve') state.sheet.curve = value === 'linear' ? 'linear' : 'equalPower';
  if (key === 'target') {
    state.sheet.target = value === 'in' || value === 'out' ? value : 'both';
  }
  if (key === 'gainDb' && typeof value === 'number') {
    state.sheet.gainDb = Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, value));
  }
}

/** 回显字段（含单位文案）：页面负责格式化，组件只渲染。 */
function sheetFieldsFor(state: EditorState): ParamField[] {
  if (state.sheetKind === 'gain') {
    const gainDb = state.sheet.gainDb;
    return [
      {
        key: 'gainDb',
        label: '增益',
        type: 'slider',
        value: gainDb,
        min: MIN_GAIN_DB,
        max: MAX_GAIN_DB,
        step: 0.5,
        displayValue: gainDb <= MIN_GAIN_DB ? '静音' : `${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`,
      },
      { key: 'reset', label: '恢复 0dB', type: 'action', value: 0 },
    ];
  }

  const { durationSec, curve, target } = state.sheet;
  return [
    {
      key: 'durationSec',
      label: '时长',
      type: 'slider',
      value: durationSec,
      min: 0.05,
      max: 5,
      step: 0.05,
      displayValue: `${durationSec.toFixed(2)}s`,
    },
    {
      key: 'curve',
      label: '曲线',
      type: 'segmented',
      value: curve,
      displayValue: curve === 'linear' ? '线性' : '等功率',
      options: [
        { label: '等功率', value: 'equalPower' },
        { label: '线性', value: 'linear' },
      ],
    },
    {
      key: 'target',
      label: '应用',
      type: 'segmented',
      value: target,
      displayValue: target === 'in' ? '仅淡入' : target === 'out' ? '仅淡出' : '两端',
      options: [
        { label: '淡入', value: 'in' },
        { label: '淡出', value: 'out' },
        { label: '两端', value: 'both' },
      ],
    },
  ];
}

/** 把面板取值写进 EDL（一次命令，可撤销）。 */
function commitSheet(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  const store = state.store;
  const trackId = state.focusTrackId;
  const clipId = state.focusClipId;
  if (!store || !trackId || !clipId) return;

  const { durationSec, curve, target, gainDb } = state.sheet;

  if (state.sheetKind === 'gain') {
    // 滑杆连续拖动用同一合并键，避免每次松手都产生一条历史
    const before = store.edl;
    store.commit({
      id: `gain-${clipId}`,
      label: '调整音量',
      at: Date.now(),
      coalesceKey: `gain:${clipId}`,
      apply: (edl) => setClipGainDb(edl, trackId, clipId, gainDb),
      invert: () => before,
    });
    state.session?.markDirty();
    return;
  }

  const fade = { durationSec, curve };
  const before = store.edl;
  store.commit({
    id: `fade-${clipId}-${target}`,
    label: '淡入淡出',
    at: Date.now(),
    coalesceKey: `fade:${clipId}:${target}`,
    apply: (edl) => {
      let next = edl;
      if (target === 'in' || target === 'both') next = setClipFade(next, trackId, clipId, 'in', fade);
      if (target === 'out' || target === 'both') next = setClipFade(next, trackId, clipId, 'out', fade);
      return next;
    },
    invert: () => before,
  });
  state.session?.markDirty();
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
  state.session?.markDirty();

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
