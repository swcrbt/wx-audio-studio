import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings } from '../../miniprogram/core/settings';

describe('parseSettings', () => {
  it('缺失或非对象时返回默认值', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('abc')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('保留合法值', () => {
    const parsed = parseSettings({
      defaultSampleRate: 22050,
      defaultExportSampleRate: 16000,
      defaultExportChannels: 2,
      performanceMode: 'low',
      hapticEnabled: false,
    });
    expect(parsed).toEqual({
      defaultSampleRate: 22050,
      defaultExportSampleRate: 16000,
      defaultExportChannels: 2,
      performanceMode: 'low',
      hapticEnabled: false,
    });
  });

  it('非法值逐项回落默认，不影响其它字段', () => {
    const parsed = parseSettings({
      defaultSampleRate: 12345,
      defaultExportSampleRate: 'high',
      defaultExportChannels: 7,
      performanceMode: 'turbo',
      hapticEnabled: 'yes',
    });
    expect(parsed).toEqual(DEFAULT_SETTINGS);
  });

  it('忽略未知字段（前向/后向兼容）', () => {
    const parsed = parseSettings({ unknownFutureField: true, defaultExportChannels: 2 });
    expect(parsed.defaultExportChannels).toBe(2);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('hapticEnabled 只在显式 false 时关闭', () => {
    expect(parseSettings({}).hapticEnabled).toBe(true);
    expect(parseSettings({ hapticEnabled: false }).hapticEnabled).toBe(false);
    expect(parseSettings({ hapticEnabled: 0 }).hapticEnabled).toBe(true);
  });
});
