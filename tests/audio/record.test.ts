import { describe, expect, it } from 'vitest';
import {
  RECORD_CHANNELS,
  RECORD_ENCODE_BIT_RATE,
  RECORD_FRAME_SIZE_KB,
  RECORD_MAX_DURATION_MS,
  RECORD_SAMPLE_RATE,
  RecordError,
  isDurationAcceptable,
} from '../../miniprogram/core/audio/record';

describe('录音参数（平台约束）', () => {
  it('44.1k 采样率对应的码率区间为 64000~320000', () => {
    // 码率与采样率强绑定，配错会直接录音失败；这条断言防止配置被改坏
    expect(RECORD_ENCODE_BIT_RATE).toBeGreaterThanOrEqual(64000);
    expect(RECORD_ENCODE_BIT_RATE).toBeLessThanOrEqual(320000);
    expect(RECORD_SAMPLE_RATE).toBe(44100);
  });

  it('人声录音默认单声道，分帧大小与时长上限合法', () => {
    expect(RECORD_CHANNELS).toBe(1);
    expect(RECORD_FRAME_SIZE_KB).toBeGreaterThan(0);
    expect(RECORD_MAX_DURATION_MS).toBe(600000);
  });
});

describe('isDurationAcceptable', () => {
  it('落在 ±50ms 内视为合格', () => {
    expect(isDurationAcceptable(0)).toBe(true);
    expect(isDurationAcceptable(49)).toBe(true);
    expect(isDurationAcceptable(-50)).toBe(true);
  });

  it('超出容差判为不合格（提示重录）', () => {
    expect(isDurationAcceptable(51)).toBe(false);
    expect(isDurationAcceptable(-200)).toBe(false);
  });
});

describe('RecordError', () => {
  it('授权失败类错误携带 openSetting 动作', () => {
    const error = new RecordError('permissionDenied', '没有麦克风权限', 'openSetting');
    expect(error.code).toBe('permissionDenied');
    expect(error.action).toBe('openSetting');
    expect(error).toBeInstanceOf(Error);
  });

  it('PC 平台错误提示改用手机', () => {
    const error = new RecordError('unsupportedPlatform', 'PC 不支持', 'mobile');
    expect(error.action).toBe('mobile');
  });

  it('默认动作为 none', () => {
    expect(new RecordError('tooShort', '太短').action).toBe('none');
  });
});
