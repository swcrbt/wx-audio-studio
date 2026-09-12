/**
 * 峰值金字塔的二进制序列化。
 *
 * 布局（全部小端）：
 * ```
 * offset 0  : magic 'PK01'      (4B)
 * offset 4  : version           (uint16)
 * offset 6  : channels          (uint16)
 * offset 8  : baseBucket        (uint32)
 * offset 12 : levelCount        (uint16)
 * offset 14 : reserved          (uint16，置 0，保持 4 字节对齐)
 * offset 16 : levelCounts[]     (uint32 × levelCount)
 * 之后       : body —— 先排列声道 0 的全部 level，再排列声道 1 的全部 level，依此类推；
 *              每个 level 内每桶为 int16 min + int16 max（小端交错）
 * ```
 *
 * 所有声道的 `levelCount` 与各级桶数必须一致，因此只存一份 `levelCounts`。
 * `bucketSize` 由 `baseBucket << level` 推出，同样不落盘。
 */
import type { PeaksLevel } from './build';

export const PEAKS_MAGIC = 'PK01';
export const PEAKS_VERSION = 1;

const FIXED_HEADER_BYTES = 16;
const LEVEL_COUNT_BYTES = 4;

export interface PeaksFile {
  version: number;
  /** 声道数，等于 `levels.length`。 */
  channels: number;
  baseBucket: number;
  /** `levels[声道][级别]`。 */
  levels: PeaksLevel[][];
}

/** 头部总字节数（含 `levelCounts` 数组），可据此定位 body 起始。 */
export function peaksHeaderBytes(levelCount: number): number {
  return FIXED_HEADER_BYTES + levelCount * LEVEL_COUNT_BYTES;
}

/** 序列化后的总字节数（按声道累加各级数据）。 */
export function peaksByteLength(levels: PeaksLevel[][]): number {
  const levelCount = levels[0]?.length ?? 0;
  if (levelCount === 0) return peaksHeaderBytes(0);

  let perChannel = 0;
  for (const level of levels[0] ?? []) perChannel += level.data.length * 2;

  return peaksHeaderBytes(levelCount) + perChannel * levels.length;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/**
 * 序列化为可落盘的 `ArrayBuffer`。
 *
 * 调用方需保证：所有声道的级别数一致、各级 `bucketSize` 满足 `baseBucket << level`、
 * 各级 `count` 一致（否则抛错，避免写出结构不一致的文件）。
 */
export function serializePeaks(file: PeaksFile): ArrayBuffer {
  const reference = file.levels[0] ?? [];
  const levelCount = reference.length;
  if (levelCount === 0) throw new Error('serializePeaks: levels 为空');

  for (const channelLevels of file.levels) {
    if (channelLevels.length !== levelCount) {
      throw new Error('serializePeaks: 各声道的级别数不一致');
    }
    for (let i = 0; i < levelCount; i++) {
      const expected = reference[i]?.count;
      if (channelLevels[i]?.count !== expected) {
        throw new Error('serializePeaks: 各声道同级桶数不一致');
      }
    }
  }

  const buffer = new ArrayBuffer(peaksByteLength(file.levels));
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  writeAscii(view, 0, PEAKS_MAGIC);
  view.setUint16(4, file.version, true);
  view.setUint16(6, file.levels.length, true);
  view.setUint32(8, file.baseBucket, true);
  view.setUint16(12, levelCount, true);
  view.setUint16(14, 0, true);

  let cursor = FIXED_HEADER_BYTES;
  for (const level of reference) {
    view.setUint32(cursor, level.count, true);
    cursor += LEVEL_COUNT_BYTES;
  }

  for (const channelLevels of file.levels) {
    for (const level of channelLevels) {
      bytes.set(
        new Uint8Array(level.data.buffer, level.data.byteOffset, level.data.byteLength),
        cursor,
      );
      cursor += level.data.byteLength;
    }
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
  if (channels === 0 || baseBucket === 0 || levelCount === 0) return null;

  const headerBytes = peaksHeaderBytes(levelCount);
  if (buffer.byteLength < headerBytes) return null;

  const counts: number[] = [];
  for (let i = 0; i < levelCount; i++) {
    counts.push(view.getUint32(FIXED_HEADER_BYTES + i * LEVEL_COUNT_BYTES, true));
  }

  let cursor = headerBytes;
  const levels: PeaksLevel[][] = [];

  for (let channel = 0; channel < channels; channel++) {
    const channelLevels: PeaksLevel[] = [];
    for (let i = 0; i < levelCount; i++) {
      const count = counts[i] ?? 0;
      const byteLength = count * 4; // count × (int16 min + int16 max)
      if (byteLength === 0 || cursor + byteLength > buffer.byteLength) return null;
      channelLevels.push({
        bucketSize: baseBucket * 2 ** i,
        count,
        data: new Int16Array(buffer, cursor, count * 2),
      });
      cursor += byteLength;
    }
    levels.push(channelLevels);
  }

  return { version, channels, baseBucket, levels };
}
