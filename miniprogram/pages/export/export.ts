/**
 * 导出页：配置 → 预估 → 渲染成品 → 分享。
 *
 * 只读工程（不建状态层）：导出不修改 EDL，而 `RenderJob.edl` 在开始时已做快照，
 * 因此导出途中即使用户在编辑器里继续改动也不影响结果。
 *
 * 平台限制（见 docs/02 §1.4）：小程序**无法把音频写入手机文件管理器/音乐库**，
 * 所以成功态只承诺两件事 —— 保存在「我的 → 成品」与发送给朋友；
 * "保存到电脑"仅在 PC 微信可用。
 */
import type { Id, Project } from '../../core/types';
import type { PeaksLevel } from '../../workers/render/peaks/build';
import { ExportTask, ExportError, type ExportProgress, type ExportResult } from '../../core/engine/export';
import { NORMALIZE_TARGET_DB, planExport, type ExportPlan } from '../../core/engine/export-plan';
import { loadAssetPeaks, readProject } from '../../core/store/load-project';
import { formatBytes, formatDuration, formatStamp } from '../../utils/format';
import { logger } from '../../utils/logger';

const SAMPLE_RATE_OPTIONS = ['44100 Hz（推荐）', '22050 Hz（体积一半）', '16000 Hz（语音）'];
const SAMPLE_RATE_VALUES: Array<16000 | 22050 | 44100> = [44100, 22050, 16000];
const CHANNEL_OPTIONS = ['单声道', '立体声'];

interface ExportPageState {
  project: Project | null;
  peaks: Map<Id, PeaksLevel[]>;
  plan: ExportPlan | null;
  task: ExportTask | null;
  result: ExportResult | null;
}

const states = new WeakMap<object, ExportPageState>();

function stateOf(instance: object): ExportPageState {
  let state = states.get(instance);
  if (!state) {
    state = { project: null, peaks: new Map(), plan: null, task: null, result: null };
    states.set(instance, state);
  }
  return state;
}

Page({
  data: {
    loading: true,
    error: '',
    sampleRateOptions: SAMPLE_RATE_OPTIONS,
    sampleRateIndex: 0,
    channelOptions: CHANNEL_OPTIONS,
    channelIndex: 0,
    normalize: true,
    limiter: true,
    durationLabel: '00:00',
    sizeLabel: '—',
    peakLabel: '—',
    warnings: [] as string[],
    blocked: false,
    exporting: false,
    percent: 0,
    stageText: '准备中',
    etaLabel: '',
    result: null as { fileName: string; sizeLabel: string; durationLabel: string } | null,
    isPc: false,
  },

  async onLoad(query: Record<string, string | undefined>) {
    const projectId = query.projectId ?? query.id;
    if (!projectId) {
      this.setData({ loading: false, error: '缺少工程 id' });
      return;
    }

    const state = stateOf(this);
    try {
      const project = await readProject(projectId);
      if (!project) {
        this.setData({ loading: false, error: '工程不存在或已损坏' });
        return;
      }
      state.project = project;

      // 峰值只读一次：所有配置变更都在内存里重算
      for (const asset of project.assets) {
        const levels = await loadAssetPeaks(asset.id);
        if (levels?.[0]) state.peaks.set(asset.id, levels[0]);
      }

      const platform = wx.getDeviceInfo().platform;
      this.setData({
        loading: false,
        channelIndex: project.channels === 2 ? 1 : 0,
        sampleRateIndex: Math.max(0, SAMPLE_RATE_VALUES.indexOf(project.sampleRate)),
        isPc: platform === 'windows' || platform === 'mac',
      });
      wx.setNavigationBarTitle({ title: `导出 · ${project.name}` });
      replan(this);
    } catch (error) {
      logger.warn('export', 'load project failed', error);
      this.setData({ loading: false, error: '读取工程失败' });
    }
  },

  onUnload() {
    stateOf(this).task?.cancel();
  },

  handleSampleRateChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ sampleRateIndex: Number(event.detail.value) }, () => replan(this));
  },

  handleChannelChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ channelIndex: Number(event.detail.value) }, () => replan(this));
  },

  handleNormalizeChange(event: WechatMiniprogram.SwitchChange) {
    this.setData({ normalize: event.detail.value }, () => replan(this));
  },

  handleLimiterChange(event: WechatMiniprogram.SwitchChange) {
    this.setData({ limiter: event.detail.value }, () => replan(this));
  },

  async handleExport() {
    const state = stateOf(this);
    const project = state.project;
    if (!project || this.data.blocked || state.task) return;

    const task = new ExportTask({
      project,
      output: {
        sampleRate: SAMPLE_RATE_VALUES[this.data.sampleRateIndex] ?? 44100,
        channels: this.data.channelIndex === 1 ? 2 : 1,
      },
      normalize: this.data.normalize,
      limiter: this.data.limiter,
      stamp: formatStamp(Date.now()),
      onProgress: (progress) => applyProgress(this, progress),
    });
    state.task = task;

    this.setData({ exporting: true, percent: 0, stageText: '准备中', etaLabel: '' });
    try {
      const result = await task.start();
      state.result = result;
      this.setData({
        exporting: false,
        result: {
          fileName: result.fileName,
          sizeLabel: formatBytes(result.bytes),
          durationLabel: formatDuration(result.durationSec),
        },
      });
      wx.showToast({ title: '导出完成', icon: 'success' });
    } catch (error) {
      this.setData({ exporting: false });
      showExportError(error);
    } finally {
      state.task = null;
    }
  },

  handleCancel() {
    const state = stateOf(this);
    state.task?.cancel();
    this.setData({ exporting: false, stageText: '已取消' });
  },

  handleShare() {
    const result = stateOf(this).result;
    if (!result) return;
    wx.shareFileMessage({
      filePath: result.filePath,
      fileName: result.fileName,
      success: () => undefined,
      fail: (error) => {
        const message = String((error as { errMsg?: string }).errMsg ?? '');
        if (message.includes('cancel')) return;
        logger.warn('export', 'shareFileMessage failed', error);
        wx.showToast({ title: '分享失败，可稍后在成品列表里再试', icon: 'none' });
      },
    });
  },

  handleSaveToDisk() {
    const result = stateOf(this).result;
    if (!result) return;
    wx.saveFileToDisk({
      filePath: result.filePath,
      success: () => wx.showToast({ title: '已保存', icon: 'success' }),
      fail: (error) => {
        logger.warn('export', 'saveFileToDisk failed', error);
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      },
    });
  },

  handleBackToEditor() {
    wx.navigateBack({ delta: 1 });
  },
});

/** 按当前配置重算预估。 */
function replan(page: WechatMiniprogram.Page.TrivialInstance): void {
  const state = stateOf(page);
  const project = state.project;
  if (!project) return;

  const plan = planExport({
    edl: {
      sampleRate: project.sampleRate,
      channels: project.channels,
      assets: project.assets,
      tracks: project.tracks,
    },
    peaksByAsset: state.peaks,
    output: {
      sampleRate: SAMPLE_RATE_VALUES[page.data.sampleRateIndex] ?? 44100,
      channels: page.data.channelIndex === 1 ? 2 : 1,
    },
    normalize: page.data.normalize,
    limiter: page.data.limiter,
  });
  state.plan = plan;

  page.setData({
    durationLabel: formatDuration(plan.durationSec),
    sizeLabel: formatBytes(plan.estimatedBytes),
    peakLabel:
      plan.estimatedPeakDb === null
        ? '无数据'
        : `${plan.estimatedPeakDb.toFixed(1)} dBFS${
            plan.normalizeApplied ? ` → ${NORMALIZE_TARGET_DB} dBFS` : '（无需调整）'
          }`,
    warnings: plan.warnings,
    blocked: plan.blocked,
  });
}

function applyProgress(page: WechatMiniprogram.Page.TrivialInstance, progress: ExportProgress): void {
  const percent = Math.min(100, Math.round(progress.ratio * 100));
  const stageText = progress.stage === 'done' ? '完成' : progress.stage === 'plan' ? '准备中' : '渲染中';
  const etaLabel = progress.etaSec > 0 ? ` · 约剩 ${Math.ceil(progress.etaSec)}s` : '';
  page.setData({ percent, stageText, etaLabel });
}

function showExportError(error: unknown): void {
  if (error instanceof ExportError) {
    if (error.code === 'cancelled') {
      wx.showToast({ title: error.message, icon: 'none' });
      return;
    }
    wx.showModal({
      title: '导出失败',
      content: error.message,
      confirmText: error.action === 'retry' ? '重试' : '知道了',
      showCancel: false,
    });
    return;
  }
  logger.warn('export', 'unexpected export error', error);
  wx.showModal({ title: '导出失败', content: '可重试，或降低采样率后再试', showCancel: false });
}
