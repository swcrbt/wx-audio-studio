/**
 * 用户偏好（轻量键值，存在 `wx.setStorageSync` 而非数据目录）。
 *
 * 为什么不用文件：这些是几十字节的偏好，放进 `USER_DATA_PATH` 会占用 200MB 配额
 * 并需要额外的原子写与清理逻辑；Storage 的容量与生命周期由平台管理，更适合偏好。
 *
 * 读取一律不抛错：偏好损坏时回落到默认值，不能因为一个偏好读失败就打不开页面。
 */
import { logger } from '../utils/logger';

export type PerformanceMode = 'auto' | 'high' | 'low';

export interface AppSettings {
  /** 默认导出采样率。 */
  defaultExportSampleRate: 16000 | 22050 | 44100;
  /** 默认录音采样率（PC 不支持设置，仅记录用户期望）。 */
  defaultRecordSampleRate: 16000 | 22050 | 44100;
  /** 默认导出声道数。 */
  defaultExportChannels: 1 | 2;
  /** 性能模式：影响限帧与波形降级策略。 */
  performanceMode: PerformanceMode;
  /** 精细调节时是否震动反馈。 */
  hapticEnabled: boolean;
}

const STORAGE_KEY = 'wx-audio-studio:settings';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultExportSampleRate: 44100,
  defaultRecordSampleRate: 44100,
  defaultExportChannels: 1,
  performanceMode: 'auto',
  hapticEnabled: true,
};

const SAMPLE_RATES: ReadonlyArray<AppSettings['defaultExportSampleRate']> = [16000, 22050, 44100];
const PERFORMANCE_MODES: readonly PerformanceMode[] = ['auto', 'high', 'low'];

function pickSampleRate(value: unknown, fallback: 16000 | 22050 | 44100): 16000 | 22050 | 44100 {
  return typeof value === 'number' && (SAMPLE_RATES as readonly number[]).includes(value)
    ? (value as 16000 | 22050 | 44100)
    : fallback;
}

/** 读取偏好；未知字段忽略、非法值回落默认（前向兼容）。 */
export function readSettings(): AppSettings {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY) as unknown;
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
    const record = raw as Record<string, unknown>;

    return {
      defaultExportSampleRate: pickSampleRate(
        record.defaultExportSampleRate,
        DEFAULT_SETTINGS.defaultExportSampleRate,
      ),
      defaultRecordSampleRate: pickSampleRate(
        record.defaultRecordSampleRate,
        DEFAULT_SETTINGS.defaultRecordSampleRate,
      ),
      defaultExportChannels: record.defaultExportChannels === 2 ? 2 : 1,
      performanceMode: PERFORMANCE_MODES.includes(record.performanceMode as PerformanceMode)
        ? (record.performanceMode as PerformanceMode)
        : DEFAULT_SETTINGS.performanceMode,
      hapticEnabled: record.hapticEnabled !== false,
    };
  } catch (error) {
    // 读偏好失败不能让页面打不开
    logger.warn('settings', 'read failed, fallback to defaults', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/** 合并写入（只覆盖传入的字段）；写入失败只记日志，不打断交互。 */
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...readSettings(), ...patch };
  try {
    wx.setStorageSync(STORAGE_KEY, next);
  } catch (error) {
    logger.warn('settings', 'write failed', error);
  }
  return next;
}

/** 恢复默认（设置页的"恢复默认"用）。 */
export function resetSettings(): AppSettings {
  return updateSettings({ ...DEFAULT_SETTINGS });
}
