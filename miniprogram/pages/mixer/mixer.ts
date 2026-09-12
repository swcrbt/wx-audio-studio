/**
 * 混音页：多轨拼接（M1 的"拼接混音"落地页）。
 *
 * 数据流与编辑器一致：所有变更都经 `ProjectStore.commit`（命令内调用 `edl/ops` 的纯函数），
 * 因此撤销链、自动保存、预览失效三件事自动成立；页面只负责把结果摆到屏幕上。
 *
 * 屏幕上的几何（片段的 left/width）由 `core/view/timeline-layout.ts` 统一计算，
 * 组件不做时间换算 —— 否则拖动手势与渲染显示会出现两套口径。
 */
import type { Edl, Id, Px, Seconds } from '../../core/types';
import type { TrackLayout } from '../../core/view/timeline-layout';
import { layoutTimeline, markVisibility, timelineEndSec } from '../../core/view/timeline-layout';
import { clampPxPerSecond, timeToX, type Viewport } from '../../core/view/viewport';
import { PreviewSession } from '../../core/player/preview-session';
import { ProjectStore, ProjectStoreError } from '../../core/store/project-store';
import { openProject, ProjectLoadError } from '../../core/store/load-project';
import { commitAddAsset } from '../../core/store/add-asset';
import { createId, paths } from '../../core/fs/paths';
import {
  addClip,
  addTrack,
  removeClip,
  removeTrack,
  setClipFade,
  setClipGainDb,
  splitClipAt,
  updateTrack,
} from '../../workers/render/edl/ops';
import { clipById, clipEndSec, clipSourceSpanSec, edlDurationSec, trackById } from '../../workers/render/edl/query';
import { MIN_GAIN_DB } from '../../workers/render/constants';
import { formatDuration, formatDurationShort } from '../../utils/format';
import { logger } from '../../utils/logger';

/** 轨道泳道最小宽度（像素），保证短工程也能看到可点区域。 */
const MIN_LANE_WIDTH_PX = 320;
const ZOOM_STEPS = [4, 8, 16, 32, 64, 128, 256, 400];

/** 增益预设（dB）：避免在手机上拖滑杆，直接用档位选择。 */
const GAIN_PRESETS = [0, -3, -6, -12, -18, MIN_GAIN_DB];

interface MixerState {
  store: ProjectStore | null;
  tracks: TrackLayout[];
  viewport: Viewport;
  laneWidthPx: Px;
  selectedClipId: Id;
  session: PreviewSession | null;
  playheadSec: Seconds;
  unsubscribe: (() => void) | null;
}

const states = new WeakMap<object, MixerState>();

function stateOf(instance: object): MixerState {
  let state = states.get(instance);
  if (!state) {
    state = {
      store: null,
      tracks: [],
      viewport: { startSec: 0, pxPerSecond: 16 },
      laneWidthPx: MIN_LANE_WIDTH_PX,
      selectedClipId: '',
      session: null,
      playheadSec: 0,
      unsubscribe: null,
    };
    states.set(instance, state);
  }
  return state;
}

Page({
  data: {
    loading: true,
    error: '',
    projectName: '',
    tracks: [] as TrackLayout[],
    laneWidthPx: MIN_LANE_WIDTH_PX,
    playheadPx: 0,
    showPlayhead: false,
    selectedClipId: '',
    durationLabel: '00:00',
    pxPerSecondLabel: '',
    playing: false,
    preparing: false,
    scrollLeft: 0,
  },

  async onLoad(query: Record<string, string | undefined>) {
    const projectId = query.projectId ?? query.id;
    if (!projectId) {
      this.setData({ loading: false, error: '缺少工程 id' });
      return;
    }

    const state = stateOf(this);
    try {
      const { store } = await openProject(projectId);
      state.store = store;

      state.session = new PreviewSession({
        projectId: store.project.id,
        previewPath: paths.preview(store.project.id),
        getEdl: () => store.edl,
        output: { sampleRate: store.project.sampleRate, channels: store.project.channels },
        onPreparingChange: (preparing) => this.setData({ preparing }),
        onPosition: (sec) => {
          state.playheadSec = sec;
          this.setData({
            playheadPx: Math.round(timeToX(state.viewport, sec)),
            showPlayhead: true,
          });
        },
        onStateChange: (transportState) => this.setData({ playing: transportState === 'playing' }),
        onError: (error) => wx.showToast({ title: error.message, icon: 'none' }),
      });

      state.unsubscribe = store.subscribe(() => render(this));
      this.setData({ loading: false, projectName: store.project.name });
      wx.setNavigationBarTitle({ title: `混音 · ${store.project.name}` });
      render(this);
    } catch (error) {
      const message = error instanceof ProjectLoadError ? error.message : '打开工程失败';
      logger.warn('mixer', 'open project failed', error);
      this.setData({ loading: false, error: message });
    }
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

  async handleTogglePreview() {
    const state = stateOf(this);
    const session = state.session;
    if (!session) return;

    if (this.data.playing) {
      session.pause();
      return;
    }
    try {
      await session.play(state.playheadSec);
    } catch (error) {
      if (error instanceof ProjectStoreError) wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  handleAddTrack() {
    const state = stateOf(this);
    const store = state.store;
    if (!store) return;

    const order = store.project.tracks.length;
    const label = `轨道 ${order + 1}`;
    const track = { ...trackTemplate(createId(), label, order) };

    try {
      store.commit({
        id: `add-track-${track.id}`,
        label: '添加轨道',
        at: Date.now(),
        apply: (edl) => addTrack(edl, track),
        invert: (edl) => removeTrack(edl, track.id),
      });
    } catch (error) {
      handleStoreError(error);
    }
  },

  /**
   * 添加片段：选素材 → 追加到指定轨道末尾。
   *
   * 素材已经在工程里（录音或导入产生），这里只把它摆到时间轴上。
   */
  handleAddClip() {
    const state = stateOf(this);
    const store = state.store;
    if (!store) return;

    const assets = store.project.assets;
    if (assets.length === 0) {
      wx.showModal({
        title: '还没有素材',
        content: '先回到编辑器录音或导入音频，再回来拼接',
        showCancel: false,
      });
      return;
    }

    wx.showActionSheet({
      itemList: assets.map((asset) => `${asset.name}（${formatDurationShort(asset.durationSec)}）`),
      success: (res) => {
        const asset = assets[res.tapIndex];
        if (!asset) return;

        const tracks = store.project.tracks;
        if (tracks.length === 0) {
          commitAddAsset(store, asset, { label: '添加素材' });
          return;
        }
        if (tracks.length === 1) {
          const trackId = tracks[0]?.id ?? '';
          commitAppendClip(state, store, asset.id, trackId);
          return;
        }

        wx.showActionSheet({
          itemList: tracks.map((track) => track.name),
          success: (picked) => {
            const track = tracks[picked.tapIndex];
            if (track) commitAppendClip(state, store, asset.id, track.id);
          },
          fail: () => undefined,
        });
      },
      fail: () => undefined,
    });
  },

  handleTrackAction(event: WechatMiniprogram.CustomEvent) {
    const detail = event.detail as { trackId: Id; action: string };
    const state = stateOf(this);
    const store = state.store;
    if (!store) return;

    const track = trackById(store.edl, detail.trackId);
    if (!track) return;

    if (detail.action === 'mute') {
      commitTrack(this, detail.trackId, `静音 ${track.name}`, { muted: !track.muted });
      return;
    }
    if (detail.action === 'solo') {
      commitTrack(this, detail.trackId, `Solo ${track.name}`, { solo: !track.solo });
      return;
    }
    if (detail.action === 'remove') {
      wx.showModal({
        title: '删除轨道',
        content: `确定删除「${track.name}」？可用撤销恢复。`,
        confirmText: '删除',
        confirmColor: '#cf1322',
        success: (res) => {
          if (!res.confirm) return;
          const before = store.edl;
          store.commit({
            id: `remove-track-${detail.trackId}`,
            label: '删除轨道',
            at: Date.now(),
            apply: (edl) => removeTrack(edl, detail.trackId),
            invert: () => before,
          });
          state.session?.markDirty();
        },
      });
      return;
    }
    if (detail.action === 'gain') {
      wx.showActionSheet({
        itemList: GAIN_PRESETS.map((db) => (db <= MIN_GAIN_DB ? '静音（最低）' : `${db} dB`)),
        success: (res) => {
          const gainDb = GAIN_PRESETS[res.tapIndex];
          if (gainDb === undefined) return;
          commitTrack(this, detail.trackId, '轨道音量', { gainDb });
        },
        fail: () => undefined,
      });
    }
  },

  handleClipAction(event: WechatMiniprogram.CustomEvent) {
    const detail = event.detail as { trackId: Id; clipId: Id; action: string };
    const state = stateOf(this);
    const store = state.store;
    if (!store) return;

    state.selectedClipId = detail.clipId;
    this.setData({ selectedClipId: detail.clipId });

    if (detail.action === 'select') return;

    const clip = clipById(store.edl, detail.trackId, detail.clipId);
    if (!clip) return;

    wx.showActionSheet({
      itemList: ['复制到本轨末尾', '在播放头分割', '淡入 0.5s', '淡出 0.5s', '清除淡入淡出', '设置音量', '删除片段'],
      success: (res) => {
        const before = store.edl;
        const label = CLIP_MENU_LABELS[res.tapIndex] ?? '编辑片段';
        try {
          store.commit({
            id: `clip-${res.tapIndex}-${Date.now()}`,
            label,
            at: Date.now(),
            apply: (edl) => applyClipMenu(edl, detail.trackId, detail.clipId, res.tapIndex, state.playheadSec),
            invert: () => before,
          });
          state.session?.markDirty();
          if (res.tapIndex === 6) {
            state.selectedClipId = '';
            this.setData({ selectedClipId: '' });
          }
        } catch (error) {
          handleStoreError(error);
        }
      },
      fail: () => undefined,
    });
  },

  handleZoomIn() {
    stepZoom(this, 1);
  },

  handleZoomOut() {
    stepZoom(this, -1);
  },

  handleZoomFit() {
    const state = stateOf(this);
    const duration = Math.max(1, edlDurationSec(state.store?.edl ?? emptyEdl()));
    const availablePx = Math.max(MIN_LANE_WIDTH_PX, this.data.laneWidthPx || MIN_LANE_WIDTH_PX);
    state.viewport = { startSec: 0, pxPerSecond: clampPxPerSecond(availablePx / duration) };
    render(this);
  },

  handleOpenEditor() {
    const projectId = stateOf(this).store?.project.id;
    if (!projectId) return;
    wx.redirectTo({ url: `/pages/editor/editor?projectId=${projectId}` });
  },

  handleExport() {
    const projectId = stateOf(this).store?.project.id;
    if (!projectId) return;
    wx.navigateTo({ url: `/pages/export/export?projectId=${projectId}` });
  },
});

const CLIP_MENU_LABELS = [
  '复制片段',
  '分割片段',
  '淡入',
  '淡出',
  '清除淡入淡出',
  '片段音量',
  '删除片段',
];

const CLIP_GAIN_PRESETS = [0, -6, -12, -18, MIN_GAIN_DB];

/** 片段菜单的七种操作（下标与 `CLIP_MENU_LABELS` 一一对应）。 */
function applyClipMenu(
  edl: Edl,
  trackId: Id,
  clipId: Id,
  menuIndex: number,
  playheadSec: Seconds,
): Edl {
  const clip = clipById(edl, trackId, clipId);
  if (!clip) return edl;

  switch (menuIndex) {
    case 0: {
      const copy = {
        ...clip,
        id: createId(),
        timelineStart: clipEndSec(clip),
        fadeIn: null,
        fadeOut: null,
      };
      return addClip(edl, trackId, copy);
    }
    case 1:
      return splitClipAt(edl, trackId, clipId, playheadSec, createId());
    case 2:
      return setClipFade(edl, trackId, clipId, 'in', {
        durationSec: Math.min(0.5, clipSourceSpanSec(clip)),
        curve: 'equalPower',
      });
    case 3:
      return setClipFade(edl, trackId, clipId, 'out', {
        durationSec: Math.min(0.5, clipSourceSpanSec(clip)),
        curve: 'equalPower',
      });
    case 4:
      return setClipFade(edl, trackId, clipId, 'in', null);
    case 5: {
      // 手机上没有滑杆输入框，用固定档位循环：菜单重开一次就是下一档
      const currentIndex = CLIP_GAIN_PRESETS.findIndex((db) => Math.abs(db - clip.gainDb) < 0.01);
      const nextGain = CLIP_GAIN_PRESETS[(currentIndex + 1) % CLIP_GAIN_PRESETS.length];
      return setClipGainDb(edl, trackId, clipId, nextGain ?? 0);
    }
    case 6:
      return removeClip(edl, trackId, clipId);
    default:
      return edl;
  }
}

/** 轨道属性变更（音量/静音/Solo）——一个入口，避免三个分支各写一遍命令。 */
function commitTrack(
  page: WechatMiniprogram.Page.TrivialInstance,
  trackId: Id,
  label: string,
  patch: { muted?: boolean; solo?: boolean; gainDb?: number },
): void {
  const state = stateOf(page);
  const store = state.store;
  if (!store || !trackById(store.edl, trackId)) return;

  const before = store.edl;
  store.commit({
    id: `track-${label}-${Date.now()}`,
    label,
    at: Date.now(),
    apply: (edl) => updateTrack(edl, trackId, patch),
    invert: () => before,
  });
  state.session?.markDirty();
}

/** 把素材追加到轨道末尾。 */
function commitAppendClip(
  state: MixerState,
  store: ProjectStore,
  assetId: Id,
  trackId: Id,
): void {
  const edl = store.edl;
  const track = trackById(edl, trackId);
  const asset = edl.assets.find((item) => item.id === assetId);
  if (!track || !asset) return;

  const timelineStart = track.clips.reduce((max, clip) => Math.max(max, clipEndSec(clip)), 0);
  const clip = {
    id: createId(),
    assetId,
    sourceStart: 0,
    sourceEnd: asset.durationSec,
    timelineStart,
    gainDb: 0,
    fadeIn: null,
    fadeOut: null,
    speed: 1,
    loop: false,
    effects: [],
  };

  const before = edl;
  store.commit({
    id: `append-clip-${clip.id}`,
    label: '添加片段',
    at: Date.now(),
    apply: (current) => addClip(current, trackId, clip),
    invert: () => before,
  });
  state.session?.markDirty();
}

/** 轨道模板（避免在页面里重复构造字段）。 */
function trackTemplate(id: Id, name: string, order: number): import('../../core/types').Track {  return {
    id,
    name,
    order,
    gainDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    effects: [],
    clips: [],
  };
}

function emptyEdl(): Edl {
  return { sampleRate: 44100, channels: 1, assets: [], tracks: [] };
}

function stepZoom(page: WechatMiniprogram.Page.TrivialInstance, direction: number): void {
  const state = stateOf(page);
  const current = state.viewport.pxPerSecond;
  const next =
    direction > 0
      ? (ZOOM_STEPS.find((step) => step > current + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
      : ([...ZOOM_STEPS].reverse().find((step) => step < current - 0.01) ?? ZOOM_STEPS[0]);
  state.viewport = { startSec: 0, pxPerSecond: clampPxPerSecond(next ?? current) };
  render(page);
}

function handleStoreError(error: unknown): void {
  if (error instanceof ProjectStoreError) {
    wx.showToast({ title: error.message, icon: 'none' });
    return;
  }
  throw error;
}

/** 重新布局并推给视图。 */
function render(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  const store = state.store;
  if (!store) return;

  const durationSec = edlDurationSec(store.edl);
  const laneWidthPx = Math.max(MIN_LANE_WIDTH_PX, Math.round(durationSec * state.viewport.pxPerSecond + 40));
  state.laneWidthPx = laneWidthPx;

  const tracks = markVisibility(layoutTimeline(store.edl, state.viewport), state.viewport, laneWidthPx);
  state.tracks = tracks;

  page.setData({
    tracks,
    laneWidthPx,
    durationLabel: formatDuration(timelineEndSec(tracks)),
    pxPerSecondLabel: `${Math.round(state.viewport.pxPerSecond)}px/s`,
    playheadPx: Math.round(timeToX(state.viewport, state.playheadSec)),
    showPlayhead: state.playheadSec > 0,
    selectedClipId: state.selectedClipId,
  });
}
