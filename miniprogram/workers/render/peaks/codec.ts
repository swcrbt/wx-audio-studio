/**
 * 峰值金字塔的二进制序列化（格式见 docs/03 §4.1）。
 *
 * 布局（全部小端）：
 * ```
 * offset 0  : magic 'PK01'      (4B)
 * offset 4  : version           (uint16)
 * offset 6  : channels          (uint16)
 * offset 8  : baseBucket        (uint32)
 * offset 12 : levelCount        (uint16)
 * offset 14 : reserved          (uint16，置 0，保持 4 字节对齐)
 * offset 16 : levelCounts[]      (uint32 × levelCount)
 * 之后       : 各 level 依次排列，每桶 int16 min + int16 max（交错）
 * ```
 *
 * 只存每级桶数与 `baseBucket`：`bucketSize` 由 `baseBucket << level` 推出，
 * 避免同一信息存两份（AGENTS §0.7）。
 */
import type { PeaksLevel } from './build';

export const PEAKS_MAGIC = 'PK01';
export const PEAKS_VERSION = 1;

const FIXED_HEADER_BYTES = 16;
const LEVEL_COUNT_BYTES = 4;

export interface PeaksFile {
  version: number;
  channels: number;
  baseBucket: number;
  /** 下标即 level，`bucketSize` 必须等于 `baseBucket << level`。 */
  levels: PeaksLevel[];
}

/** 头部总字节数（含 levelCounts 数组），可据此定位 body 起始。 */
export function peaksHeaderBytes(levelCount: number): number {
  return FIXED_HEADER_BYTES + levelCount * LEVEL_COUNT_BYTES;
}

/** 序列化后的总字节数。 */
export function peaksByteLength(levels: PeaksLevel[]): number {
  let body = 0;
  for (const level of levels) body += level.data.length * 2;
  return peaksHeaderBytes(levels.length) + body;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/** 序列化为可落盘的 `ArrayBuffer`。调用方需保证 `levels` 满足 `bucketSize = base << i`。 */
export function serializePeaks(file: PeaksFile): ArrayBuffer {
  const buffer = new ArrayBuffer(peaksByteLength(file.levels));
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  writeAscii(view, 0, PEAKS_MAGIC);
  view.setUint16(4, file.version, true);
  view.setUint16(6, file.channels, true);
  view.setUint32(8, file.baseBucket, true);
  view.setUint16(12, file.levels.length, true);
  view.setUint16(14, 0, true);

  let cursor = FIXED_HEADER_BYTES;
  for (const level of file.levels) {
    view.setUint32(cursor, level.count, true);
    cursor += LEVEL_COUNT_BYTES;
  }

  for (const level of file.levels) {
    bytes.set(new Uint8Array(level.data.buffer, level.data.byteOffset, level.data.byteLength), cursor);
    cursor += level.data.byteLength;
  }

  return buffer;
}

/**
 * 反序列化。返回的 `Int16Array` 是 `buffer` 上的视图（零拷贝），调用方需保证
 * `buffer` 在使用期间不被复用或释放。
 *
 * @returns 解析结果；magic/版本不符或长度不足时返回 `null`（不抛错）
 */
export function deserializePeaks(buffer: ArrayBuffer): PeaksFile | null {
  if (buffer.byteLength < FIXED_HEADER_BYTES) return null;
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (readAscii(bytes, 0, 4) !== PEAKS_MAGIC) return null;

  const version = view.getUint16(4, true);
  if (version !== PEAKS_VERSION) return null;

  const channels = view.getUint16(6, true);
  const baseBucket = view.getUint32(8, true);
  const levelCount = view.getUint16(12, true);
  if (levelCount === 0 || channels === 0 || baseBucket === 0) return null;

  const headerBytes = peaksHeaderBytes(levelCount);
  if (buffer.byteLength < headerBytes) return null;

  const counts: number[] = [];
  for (let i = 0; i < levelCount; i++) {
    counts.push(view.getUint32(FIXED_HEADER_BYTES + i * LEVEL_COUNT_BYTES, true));
  }

  let cursor = headerBytes;
  const levels: PeaksLevel[] = [];
  for (let i = 0; i < levelCount; i++) {
    const count = counts[i] ?? 0;
    const byteLength = count * 4; // count × (int16 min + int16 max)
    if (byteLength === 0 || cursor + byteLength > buffer.byteLength) return null;
    levels.push({
      bucketSize: baseBucket * 2 ** i,
      count,
      data: new Int16Array(buffer, cursor, count * 2),
    });
    cursor += byteLength;
  }

  return { version, channels, baseBucket, levels };
}
