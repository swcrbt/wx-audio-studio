import { describe, expect, it } from 'vitest';
import { RollingWaveform } from '../../miniprogram/core/view/rolling-waveform';

/** 生成 `frames` 个采样帧的单声道 Int16 数据，值由 `at` 决定。 */
function makePcm(frames: number, at: (frame: number) => number): Int16Array {
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) pcm[i] = at(i);
  return pcm;
}

describe('RollingWaveform · 列聚合', () => {
  it('每 samplesPerColumn 个采样聚成一列，取 min/max', () => {
    const rolling = new RollingWaveform({ capacityColumns: 10, samplesPerColumn: 4 });
    const info = rolling.push(makePcm(8, (i) => (i === 2 ? 32767 : i === 5 ? -32768 : 0)));

    expect(rolling.columnCount).toBe(2);
    expect(info.peakLinear).toBeCloseTo(1, 6);
    expect(info.clipped).toBe(true);

    const snapshot = rolling.snapshot();
    expect(snapshot[0]).toBeCloseTo(0, 6); // 第一列 min
    expect(snapshot[1]).toBeCloseTo(32767 / 32768, 6); // 第一列 max
    expect(snapshot[2]).toBeCloseTo(-1, 6); // 第二列 min
    expect(snapshot[3]).toBeCloseTo(0, 6); // 第二列 max
  });

  it('列边界跨帧：不足一列的部分留到下一帧继续累积', () => {
    const rolling = new RollingWaveform({ capacityColumns: 10, samplesPerColumn: 4 });
    rolling.push(makePcm(3, () => 1000));
    expect(rolling.columnCount).toBe(0);

    rolling.push(makePcm(1, () => 2000));
    expect(rolling.columnCount).toBe(1);
    expect(rolling.snapshot()[1]).toBeCloseTo(2000 / 32768, 6);
  });

  it('flush 提交未满一列的残余', () => {
    const rolling = new RollingWaveform({ capacityColumns: 10, samplesPerColumn: 4 });
    rolling.push(makePcm(2, () => 5000));
    expect(rolling.columnCount).toBe(0);
    rolling.flush();
    expect(rolling.columnCount).toBe(1);
  });

  it('未削波时 clipped 为 false', () => {
    const rolling = new RollingWaveform({ samplesPerColumn: 2 });
    expect(rolling.push(makePcm(2, () => 16000)).clipped).toBe(false);
  });
});

describe('RollingWaveform · 环形缓冲', () => {
  it('超出容量后只保留最近的列，且按时间从左到右排列', () => {
    const rolling = new RollingWaveform({ capacityColumns: 3, samplesPerColumn: 1 });
    for (let i = 1; i <= 5; i++) rolling.push(makePcm(1, () => i * 1000));

    expect(rolling.columnCount).toBe(3);
    const snapshot = rolling.snapshot();
    expect(snapshot[1]).toBeCloseTo(3000 / 32768, 6);
    expect(snapshot[3]).toBeCloseTo(4000 / 32768, 6);
    expect(snapshot[5]).toBeCloseTo(5000 / 32768, 6);
  });

  it('复用传入的缓冲，避免每帧分配', () => {
    const rolling = new RollingWaveform({ capacityColumns: 4, samplesPerColumn: 1 });
    rolling.push(makePcm(2, () => 100));
    const buffer = new Float32Array(16);
    expect(rolling.snapshot(buffer)).toBe(buffer);
  });

  it('reset 清空状态', () => {
    const rolling = new RollingWaveform({ capacityColumns: 4, samplesPerColumn: 1 });
    rolling.push(makePcm(4, () => 100));
    rolling.reset();
    expect(rolling.columnCount).toBe(0);
    expect(rolling.snapshot().every((value) => value === 0)).toBe(true);
  });
});

describe('RollingWaveform · 多声道', () => {
  it('立体声交错数据按帧聚合，峰值取两声道最大值', () => {
    const rolling = new RollingWaveform({ capacityColumns: 4, samplesPerColumn: 2, channels: 2 });
    // 两帧立体声：帧 0 左 0 右 32767；帧 1 左 -32768 右 0
    const pcm = new Int16Array([0, 32767, -32768, 0]);
    const info = rolling.push(pcm);

    expect(info.peakLinear).toBeCloseTo(1, 6);
    expect(rolling.columnCount).toBe(1);
    const snapshot = rolling.snapshot();
    expect(snapshot[0]).toBeCloseTo(-1, 6);
    expect(snapshot[1]).toBeCloseTo(32767 / 32768, 6);
  });

  it('声道数不能小于 1，非法输入按单声道处理', () => {
    const rolling = new RollingWaveform({ channels: 0, samplesPerColumn: 1 });
    rolling.push(makePcm(1, () => 100));
    expect(rolling.columnCount).toBe(1);
  });
});
