import { describe, expect, it } from 'vitest';
import { parseRenderFileName, parseStamp } from '../../miniprogram/core/fs/renders';

describe('parseRenderFileName', () => {
  it('解析标准成品名', () => {
    expect(parseRenderFileName('out-1751360001000-b7d2e4-20250912102345.wav')).toEqual({
      projectId: '1751360001000-b7d2e4',
      stamp: '20250912102345',
    });
  });

  it('拒绝非成品文件与临时文件', () => {
    expect(parseRenderFileName('preview-1751360001000-b7d2e4.wav')).toBeNull();
    expect(parseRenderFileName('out-abc.tmp')).toBeNull();
    expect(parseRenderFileName('out-abc-123.wav')).toBeNull();
    expect(parseRenderFileName('README.md')).toBeNull();
  });

  it('时间戳位数不对时拒绝（避免把任意文件当成品）', () => {
    expect(parseRenderFileName('out-abc-2025091210234.wav')).toBeNull();
    expect(parseRenderFileName('out-abc-202509121023456.wav')).toBeNull();
  });
});

describe('parseStamp', () => {
  it('按本地时区解析成毫秒时间戳', () => {
    const date = new Date(2025, 8, 12, 10, 23, 45);
    expect(parseStamp('20250912102345')).toBe(date.getTime());
  });

  it('非法输入返回 0', () => {
    expect(parseStamp('2025')).toBe(0);
    expect(parseStamp('abcdefghijklmn')).toBe(0);
    expect(parseStamp('')).toBe(0);
  });
});
