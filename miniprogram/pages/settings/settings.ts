/**
 * 设置页：音频默认值、导出默认值、交互偏好、缓存清理。
 *
 * 偏好读写都在 `core/settings.ts`（存 Storage，不占 200MB 数据目录配额）。
 * 本页只负责取值的展示与写回，不在这里判断合法性（解析时逐项回落默认值）。
 */
import {
  DEFAULT_SETTINGS,
  readSettings,
  resetSettings,
  updateSettings,
  type AppSettings,
  type PerformanceMode,
} from '../../core/settings';
import { cleanStalePreviews, clearTmpDir } from '../../core/fs/quota';
import { formatBytes } from '../../utils/format';
import { logger } from '../../utils/logger';

const SAMPLE_RATE_VALUES: Array<AppSettings['defaultSampleRate']> = [44100, 22050, 16000];
const SAMPLE_RATE_LABELS = ['44100 Hz（推荐）', '22050 Hz（体积一半）', '16000 Hz（语音）'];
const CHANNEL_LABELS = ['单声道', '立体声'];
const PERFORMANCE_VALUES: PerformanceMode[] = ['auto', 'high', 'low'];
const PERFORMANCE_LABELS = ['自动', '高性能', '低性能（省电/防卡顿）'];

/** 把偏好同步到页面 data（一处集中，避免漏字段）。 */
function toViewData(settings: AppSettings): Record<string, unknown> {
  return {
    sampleRateOptions: SAMPLE_RATE_LABELS,
    channelOptions: CHANNEL_LABELS,
    performanceOptions: PERFORMANCE_LABELS,
    sampleRateIndex: Math.max(0, SAMPLE_RATE_VALUES.indexOf(settings.defaultSampleRate)),
    exportSampleRateIndex: Math.max(0, SAMPLE_RATE_VALUES.indexOf(settings.defaultExportSampleRate)),
    exportChannelIndex: settings.defaultExportChannels === 2 ? 1 : 0,
    performanceIndex: Math.max(0, PERFORMANCE_VALUES.indexOf(settings.performanceMode)),
    hapticEnabled: settings.hapticEnabled,
  };
}

Page({
  data: {
    sampleRateOptions: SAMPLE_RATE_LABELS,
    channelOptions: CHANNEL_LABELS,
    performanceOptions: PERFORMANCE_LABELS,
    sampleRateIndex: 0,
    exportSampleRateIndex: 0,
    exportChannelIndex: 0,
    performanceIndex: 0,
    hapticEnabled: true,
  },

  onShow() {
    this.setData(toViewData(readSettings()));
  },

  handleSampleRateChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    const sampleRate = SAMPLE_RATE_VALUES[index] ?? DEFAULT_SETTINGS.defaultSampleRate;
    this.setData(toViewData(updateSettings({ defaultSampleRate: sampleRate })));
  },

  handleExportSampleRateChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    const sampleRate = SAMPLE_RATE_VALUES[index] ?? DEFAULT_SETTINGS.defaultExportSampleRate;
    this.setData(toViewData(updateSettings({ defaultExportSampleRate: sampleRate })));
  },

  handleExportChannelChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    this.setData(toViewData(updateSettings({ defaultExportChannels: index === 1 ? 2 : 1 })));
  },

  handlePerformanceChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    const mode = PERFORMANCE_VALUES[index] ?? DEFAULT_SETTINGS.performanceMode;
    this.setData(toViewData(updateSettings({ performanceMode: mode })));
    wx.showToast({ title: `性能模式：${PERFORMANCE_LABELS[index] ?? ''}`, icon: 'none' });
  },

  handleHapticChange(event: WechatMiniprogram.SwitchChange) {
    this.setData(toViewData(updateSettings({ hapticEnabled: event.detail.value })));
  },

  async handleCleanCache() {
    try {
      const [tmpBytes, previews] = await Promise.all([clearTmpDir(), cleanStalePreviews()]);
      const parts: string[] = [];
      if (tmpBytes > 0) parts.push(formatBytes(tmpBytes));
      if (previews > 0) parts.push(`${previews} 个预览`);
      wx.showToast({ title: parts.length > 0 ? `已清理 ${parts.join(' 与 ')}` : '没有可清理的内容', icon: 'none' });
    } catch (error) {
      logger.warn('settings', 'clean cache failed', error);
      wx.showToast({ title: '清理失败，请重试', icon: 'none' });
    }
  },

  handleReset() {
    wx.showModal({
      title: '恢复默认设置',
      content: '只影响本页的偏好，不会删除工程、素材或成品。',
      confirmText: '恢复',
      success: (res) => {
        if (!res.confirm) return;
        this.setData(toViewData(resetSettings()));
        wx.showToast({ title: '已恢复默认', icon: 'none' });
      },
    });
  },
});
