import { describe, expect, it } from 'vitest';
import { buildPyramid } from '../../miniprogram/workers/render/peaks/build';
import {
  PEAKS_VERSION,
  deserializePeaks,
  peaksByteLength,
  peaksHeaderBytes,
  serializePeaks,
} from '../../miniprogram/workers/render/peaks/codec';

function samplePyramid(buckets = 5) {
  const pcm = new Int16Array(1024 * buckets);
  pcm[0] = -30000;
  pcm[10] = 30000;
  pcm[pcm.length - 1] = -1;
  return buildPyramid(pcm);
}

function baseFile() {
  const levels = samplePyramid();
  return { version: PEAKS_VERSION, channels: 1, baseBucket: 1024, levels };
}

describe('serializePeaks / deserializePeaks', () => {
  it('序列化长度与 peaksByteLength 一致，body 起始与 peaksHeaderBytes 一致', () => {
    const file = baseFile();
    const buffer = serializePeaks(file);
    expect(buffer.byteLength).toBe(peaksByteLength(file.levels));
    expect(peaksHeaderBytes(file.levels.length)).toBe(16 + file.levels.length * 4);
  });

  it('往返后每级 bucketSize/count/数据完全一致', () => {
    const file = baseFile();
    const restored = deserializePeaks(serializePeaks(file));
    expect(restored).not.toBeNull();
    expect(restored?.version).toBe(PEAKS_VERSION);
    expect(restored?.channels).toBe(1);
    expect(restored?.baseBucket).toBe(1024);
    expect(restored?.levels.length).toBe(file.levels.length);
    for (let i = 0; i < file.levels.length; i++) {
      const a = file.levels[i];
      const b = restored?.levels[i];
      expect(b?.bucketSize).toBe(a?.bucketSize);
      expect(b?.count).toBe(a?.count);
      expect(Array.from(b?.data ?? [])).toEqual(Array.from(a?.data ?? []));
    }
  });

  it('保留极值（序列化不引入精度损失）', () => {
    const restored = deserializePeaks(serializePeaks(baseFile()));
    const top = restored?.levels[restored.levels.length - 1];
    expect(top?.data[0]).toBe(-30000);
    expect(top?.data[1]).toBe(30000);
  });

  it('magic 或版本不符时返回 null', () => {
    const buffer = serializePeaks(baseFile());
    const bytes = new Uint8Array(buffer);
    const backup = bytes[0] ?? 0;
    bytes[0] = 0x00;
    expect(deserializePeaks(buffer)).toBeNull();
    bytes[0] = backup;
    expect(deserializePeaks(buffer)).not.toBeNull();

    const wrongVersion = serializePeaks(baseFile());
    new DataView(wrongVersion).setUint16(4, 99, true);
    expect(deserializePeaks(wrongVersion)).toBeNull();
  });

  it('长度不足或 levelCount 非法时返回 null', () => {
    expect(deserializePeaks(new ArrayBuffer(8))).toBeNull();
    const buffer = serializePeaks(baseFile());
    new DataView(buffer).setUint16(12, 0, true); // levelCount = 0
    expect(deserializePeaks(buffer)).toBeNull();
    const truncated = serializePeaks(baseFile());
    new DataView(truncated).setUint16(12, 1000, true); // 超出实际数据
    expect(deserializePeaks(truncated)).toBeNull();
  });

  it('零长度缓冲返回 null 而不是抛错', () => {
    expect(deserializePeaks(new ArrayBuffer(0))).toBeNull();
  });
});
