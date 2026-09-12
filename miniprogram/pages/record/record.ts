/**
 * 录音页：麦克风录音入口（Tab）。
 *
 * 平台事实（决定了实现方式）：小程序的 WebAudio 没有麦克风输入节点，
 * 因此实时波形与电平表都从 `RecorderManager` 的 PCM 分帧计算（不是 `AnalyserNode`），
 * 见 docs/03 §7。录音文件边录边写（`core/audio/record.ts`），页面只负责展示与权限。
 *
 * 合规：首次进入先展示麦克风用途说明（音频只在本机处理，不上传）；被拒绝过则引导
 * `wx.openSetting`，不做反复弹窗。
 */
import type { Id } from '../../core/types';
import { RECORD_MAX_DURATION_MS, RECORD_SAMPLE_RATE, Recorder, RecordError, type RecordingResult, type RecordSampleRate } from '../../core/audio/record';
import { readSettings } from '../../core/settings';
import { createProjectWithAsset } from '../../core/store/import-file';
import { createId } from '../../core/fs/paths';
import { RollingWaveform } from '../../core/view/rolling-waveform';
import { ensureDataDirs } from '../../core/fs/store';
import { formatDuration, formatDurationShort } from '../../utils/format';
import { logger } from '../../utils/logger';

/** 波形每列对应的采样帧数：每列约 16.7ms，即每秒 60 列。 */
const COLUMNS_PER_SECOND = 60;
/** 距上限多少秒开始提醒。 */
const REMAIN_WARN_SEC = 30;
/** 电平表刷新间隔（毫秒）。 */
const UI_TICK_MS = 200;

type RecordPhase = 'idle' | 'recording' | 'paused' | 'saving';

interface RecordPageState {
  recorder: Recorder | null;
  rolling: RollingWaveform;
  assetId: Id | null;
  ctx: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D | null;
  widthPx: number;
  heightPx: number;
  scratch: Float32Array | null;
  timer: ReturnType<typeof setInterval> | null;
  /** 累计已录时长（秒），由分帧数推算，与界面刷新无关。 */
  durationSec: number;
  /** 本次录音的采样率（同时也作为新建工程的采样率）。 */
  sampleRate: RecordSampleRate;
  warned: boolean;
}

const states = new WeakMap<object, RecordPageState>();

function stateOf(instance: object): RecordPageState {
  let state = states.get(instance);
  if (!state) {
    state = {
      recorder: null,
      rolling: new RollingWaveform({
        capacityColumns: 360,
        samplesPerColumn: Math.round(RECORD_SAMPLE_RATE / COLUMNS_PER_SECOND),
        channels: 1,
      }),
      assetId: null,
      ctx: null,
      widthPx: 0,
      heightPx: 0,
      scratch: null,
      timer: null,
      durationSec: 0,
      sampleRate: RECORD_SAMPLE_RATE,
      warned: false,
    };
    states.set(instance, state);
  }
  return state;
}

Page({
  data: {
    phase: 'idle' as RecordPhase,
    showPermissionCard: true,
    permissionDenied: false,
    elapsedLabel: '00:00.000',
    remainingLabel: formatDurationShort(RECORD_MAX_DURATION_MS / 1000),
    level: 0,
    clipped: false,
    hint: '',
    stateText: '准备就绪',
  },

  async onShow() {
    const permission = await readRecordPermission();
    this.setData({
      showPermissionCard: permission !== 'granted',
      permissionDenied: permission === 'denied',
    });
    if (permission === 'granted') measureCanvas(this);
  },

  onHide() {
    // 切后台/来电：停止并保留已录内容（record.ts 里同样处理了系统中断）
    const state = stateOf(this);
    if (state.recorder && this.data.phase !== 'idle') {
      this.setData({ hint: '已停止录音（应用进入后台）' });
      state.recorder.stop();
    }
  },

  onUnload() {
    const state = stateOf(this);
    stopTimer(state);
    state.recorder?.stop();
    state.recorder = null;
  },

  async handleRequestPermission() {
    try {
      await new Promise<void>((resolve, reject) => {
        wx.authorize({ scope: 'scope.record', success: () => resolve(), fail: reject });
      });
      this.setData({ showPermissionCard: false, permissionDenied: false, hint: '' });
      measureCanvas(this);
    } catch (error) {
      logger.warn('record', 'authorize scope.record denied', error);
      this.setData({ permissionDenied: true, hint: '未获得麦克风权限，可去设置里开启' });
    }
  },

  handleOpenSetting() {
    wx.openSetting({
      success: (res) => {
        const granted = res.authSetting['scope.record'] === true;
        this.setData({
          showPermissionCard: !granted,
          permissionDenied: !granted,
          hint: granted ? '' : '仍未开启麦克风权限',
        });
        if (granted) measureCanvas(this);
      },
      fail: () => this.setData({ hint: '打开设置失败，请手动前往设置页' }),
    });
  },

  async handleStart() {
    const state = stateOf(this);
    if (state.recorder) return;

    await ensureDataDirs();
    const settings = readSettings();
    const sampleRate = settings.defaultSampleRate;

    state.assetId = createId();
    state.durationSec = 0;
    state.warned = false;
    state.rolling.reset();
    paintWave(this);

    const recorder = new Recorder({
      assetId: state.assetId,
      sampleRate,
      onProgress: (progress) => {
        state.durationSec = progress.durationSec;
      },
      onFrame: (frame) => {
        const info = state.rolling.push(frame.pcm);
        paintWave(this);
        this.setData({ level: Math.round(info.peakLinear * 100), clipped: info.clipped });
      },
    });
    state.recorder = recorder;
    state.sampleRate = sampleRate;

    this.setData({ phase: 'recording', stateText: '录音中', level: 0, hint: '' });
    startTimer(this);

    try {
      const result = await recorder.start();
      await finishRecording(this, result);
    } catch (error) {
      state.recorder = null;
      stopTimer(state);
      this.setData({ phase: 'idle', stateText: '准备就绪', level: 0 });

      if (error instanceof RecordError) {
        if (error.action === 'openSetting') {
          this.setData({ showPermissionCard: true, permissionDenied: true, hint: error.message });
          return;
        }
        wx.showModal({
          title: '录音失败',
          content: error.message,
          confirmText: error.action === 'retry' ? '重试' : '知道了',
          showCancel: false,
        });
        return;
      }
      logger.warn('record', 'start failed', error);
      wx.showToast({ title: '录音启动失败', icon: 'none' });
    }
  },

  async handleTogglePause() {
    const state = stateOf(this);
    const recorder = state.recorder;
    if (!recorder) return;

    if (this.data.phase === 'recording') {
      recorder.pause();
      this.setData({ phase: 'paused', stateText: '已暂停' });
      return;
    }
    recorder.resume();
    this.setData({ phase: 'recording', stateText: '录音中' });
  },

  handleStop() {
    const state = stateOf(this);
    if (!state.recorder) return;
    this.setData({ phase: 'saving', stateText: '保存中' });
    stopTimer(state);
    state.recorder.stop();
  },
});

/** 录音结束：建工程 + 挂素材 + 进编辑器。 */
async function finishRecording(
  page: WechatMiniprogram.Page.TrivialInstance,
  result: RecordingResult,
): Promise<void> {
  const state = stateOf(page);
  state.recorder = null;
  stopTimer(state);
  state.rolling.flush();
  paintWave(page);
  page.setData({ phase: 'saving', stateText: '保存中', level: 0 });

  try {
    const stamp = new Date().toLocaleString();
    const project = await createProjectWithAsset(result.asset, {
      name: `录音 ${stamp}`,
      sampleRate: state.sampleRate,
    });

    if (result.interrupted) {
      wx.showToast({ title: `已保存前 ${formatDurationShort(result.durationSec)}`, icon: 'none', duration: 2500 });
    }
    page.setData({ phase: 'idle', stateText: '准备就绪' });
    wx.navigateTo({ url: `/pages/editor/editor?projectId=${project.id}` });
  } catch (error) {
    logger.warn('record', 'finish failed', error);
    page.setData({
      phase: 'idle',
      stateText: '准备就绪',
      hint: '录音已保存，但工程创建失败，可在项目列表里重试',
    });
  }
}

function startTimer(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  stopTimer(state);
  const tick = (): void => {
    if (page.data.phase === 'saving') return;
    const elapsedSec = state.durationSec;
    const remainingSec = Math.max(0, RECORD_MAX_DURATION_MS / 1000 - elapsedSec);
    page.setData({
      elapsedLabel: formatDuration(elapsedSec),
      remainingLabel: formatDurationShort(remainingSec),
    });

    if (remainingSec <= REMAIN_WARN_SEC && !state.warned) {
      state.warned = true;
      if (readSettings().hapticEnabled) wx.vibrateShort({ type: 'medium' });
      wx.showToast({ title: `还剩 ${REMAIN_WARN_SEC} 秒将自动结束`, icon: 'none' });
    }
  };
  tick();
  state.timer = setInterval(tick, UI_TICK_MS);
}

function stopTimer(state: RecordPageState): void {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/** 读取麦克风授权状态：未询问过返回 `unknown`。 */
async function readRecordPermission(): Promise<'granted' | 'denied' | 'unknown'> {
  try {
    const setting = await new Promise<WechatMiniprogram.GetSettingSuccessCallbackResult>((resolve, reject) => {
      wx.getSetting({ success: resolve, fail: reject });
    });
    const value = setting.authSetting['scope.record'];
    if (value === true) return 'granted';
    if (value === false) return 'denied';
    return 'unknown';
  } catch (error) {
    logger.warn('record', 'getSetting failed', error);
    return 'unknown';
  }
}

function measureCanvas(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  wx.createSelectorQuery()
    .select('#wave')
    .fields({ node: true, size: true })
    .exec((res: unknown[]) => {
      const item = res[0] as { node?: { width: number; height: number; getContext(type: '2d'): unknown }; width?: number; height?: number } | undefined;
      const node = item?.node;
      if (!node || !item?.width || !item?.height) return;

      const dpr = wx.getWindowInfo().pixelRatio || 1;
      state.widthPx = Math.round(item.width);
      state.heightPx = Math.round(item.height);
      node.width = Math.round(state.widthPx * dpr);
      node.height = Math.round(state.heightPx * dpr);

      const ctx = node.getContext('2d') as WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D;
      ctx.scale(dpr, dpr);
      state.ctx = ctx;
      state.scratch = new Float32Array(Math.min(state.widthPx, 400) * 2);
      paintWave(page);
    });
}

/** 画最近的滚动波形：最新一列贴右边。 */
function paintWave(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  const ctx = state.ctx;
  if (!ctx || state.widthPx <= 0) return;

  ctx.fillStyle = '#12151A';
  ctx.fillRect(0, 0, state.widthPx, state.heightPx);

  const columns = state.rolling.columnCount;
  if (columns === 0) return;

  const samples = state.rolling.snapshot(state.scratch ?? undefined);
  const visible = Math.min(columns, state.widthPx);
  const midY = state.heightPx / 2;
  const amp = state.heightPx * 0.42;
  const offset = (columns - visible) * 2;

  ctx.fillStyle = '#4C8DFF';
  for (let i = 0; i < visible; i++) {
    const min = samples[offset + i * 2] ?? 0;
    const max = samples[offset + i * 2 + 1] ?? 0;
    const x = state.widthPx - visible + i;
    const top = midY - max * amp;
    const bottom = midY - min * amp;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}
