/**
 * WAV（RIFF/WAVE，16-bit PCM，little-endian）头读写与样本格式转换。纯函数、无平台依赖。
 *
 * 规范见 docs/03 §2：所有素材统一为「WAV / PCM / 16-bit / 小端 / 无附加 chunk」，
 * 标准头 44 字节（`RIFF` + `fmt ` + `data`）。
 *
 * 注：本文件所有 TypedArray 读取都写 `?? 0` —— 工程开启了
 * `noUncheckedIndexedAccess`（AGENTS §2.1），索引访问类型为 `number | undefined`；
 * 对音频缓冲而言"越界读按 0 处理"是安全语义。
 */

/** 标准 44 字节头长度。 */
export const WAV_HEADER_BYTES = 44;
/** 中间格式固定位深。 */
export const BITS_PER_SAMPLE = 16;
/** WAVE `fmt ` 块的 PCM 编码标记。 */
export const PCM_AUDIO_FORMAT = 1;

/** Int16 满量程（负向），与 `floatToInt16` 的非对称缩放一致。 */
const INT16_MIN_ABS = 0x8000;
/** Int16 满量程（正向）。 */
const INT16_MAX_ABS = 0x7fff;

export interface WavFormat {
  sampleRate: number;
  channels: number;
}

export interface WavSpec extends WavFormat {
  /** data 区字节数（不含头）。 */
  dataBytes: number;
}

export interface ParsedWav extends WavFormat {
  audioFormat: number;
  bitsPerSample: number;
  /** data 区起始字节偏移。 */
  dataOffset: number;
  dataBytes: number;
  /** 采样帧数（按 blockAlign 计算，向下取整）。 */
  frames: number;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const code = bytes[offset + i] ?? 0;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * 写入 44 字节标准 WAV 头。
 *
 * @param view 目标视图，长度需 ≥ `offset + 44`
 * @param spec `channels` 为 1 或 2；`dataBytes` 为 data 区字节数
 * @param offset 写入起始偏移（回填头时可用）
 */
export function writeWavHeader(view: DataView, spec: WavSpec, offset = 0): void {
  const { channels, sampleRate, dataBytes } = spec;
  const blockAlign = (channels * BITS_PER_SAMPLE) / 8;
  const byteRate = sampleRate * blockAlign;

  writeAscii(view, offset + 0, 'RIFF');
  view.setUint32(offset + 4, 36 + dataBytes, true);
  writeAscii(view, offset + 8, 'WAVE');
  writeAscii(view, offset + 12, 'fmt ');
  view.setUint32(offset + 16, 16, true);
  view.setUint16(offset + 20, PCM_AUDIO_FORMAT, true);
  view.setUint16(offset + 22, channels, true);
  view.setUint32(offset + 24, sampleRate, true);
  view.setUint32(offset + 28, byteRate, true);
  view.setUint16(offset + 32, blockAlign, true);
  view.setUint16(offset + 34, BITS_PER_SAMPLE, true);
  writeAscii(view, offset + 36, 'data');
  view.setUint32(offset + 40, dataBytes, true);
}

/** 生成 44 字节标准头（独立缓冲）。 */
export function createWavHeaderBuffer(spec: WavSpec): ArrayBuffer {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
  writeWavHeader(new DataView(buffer), spec);
  return buffer;
}

/**
 * 只回填随流式写入而变化的两个 uint32：`RIFF.chunkSize`(4) 与 `data.dataSize`(40)。
 * 用于"先写占位头 → 边落数据边写 → 结束时回填"的流式写入（docs/03 §2）。
 */
export function patchWavHeaderSizes(view: DataView, dataBytes: number, offset = 0): void {
  view.setUint32(offset + 4, 36 + dataBytes, true);
  view.setUint32(offset + 40, dataBytes, true);
}

/**
 * 解析 WAV 头：遍历 RIFF 子块定位 `fmt ` 与 `data`。
 *
 * - 兼容常见变体（`fmt ` 块长度 16/18/40；`data` 前存在 `LIST`/`fact` 等附加块）
 * - 不校验也不解码音频数据本身
 *
 * @returns 解析结果；当不是合法 RIFF/WAVE、缺少 `fmt ` 或 `data` 时返回 `null`
 */
export function parseWav(bytes: Uint8Array): ParsedWav | null {
  if (bytes.length < 12) return null;
  if (readAscii(bytes, 0, 4) !== 'RIFF') return null;
  if (readAscii(bytes, 8, 4) !== 'WAVE') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, cursor, 4);
    const chunkSize = view.getUint32(cursor + 4, true);
    const body = cursor + 8;

    if (chunkId === 'fmt ') {
      if (body + 16 > bytes.length) return null;
      audioFormat = view.getUint16(body + 0, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = body;
      // 允许 chunkSize 超出实际长度（截断文件），以实际可用长度为准
      dataBytes = Math.max(0, Math.min(chunkSize, bytes.length - body));
    }

    // 块长为奇数时按规范有 1 字节对齐填充
    cursor = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || channels <= 0 || sampleRate <= 0) return null;

  const blockAlign = (channels * bitsPerSample) / 8;
  const frames = blockAlign > 0 ? Math.floor(dataBytes / blockAlign) : 0;

  return { audioFormat, channels, sampleRate, bitsPerSample, dataOffset, dataBytes, frames };
}

/**
 * Float32（[-1, 1]）→ Int16，就地把结果写入 `dst` 的 `offset` 处。**不修改 `src`**。
 *
 * 采用非对称缩放（`*0x8000` / `*0x7fff`）以避免正峰溢出为负值；超范围值硬削波，
 * 非有限值按 0 处理（AGENTS §3.2）。
 *
 * @param src 源 Float32 采样
 * @param dst 目标 Int16 缓冲，长度需 ≥ `offset + src.length`
 * @param offset 写入起始下标
 */
export function floatToInt16(src: Float32Array, dst: Int16Array, offset = 0): void {
  for (let i = 0; i < src.length; i++) {
    const raw = src[i] ?? 0;
    const s = Number.isFinite(raw) ? (raw > 1 ? 1 : raw < -1 ? -1 : raw) : 0;
    dst[offset + i] = s < 0 ? s * INT16_MIN_ABS : s * INT16_MAX_ABS;
  }
}

/**
 * Int16 → Float32（[-1, 1]），写入 `dst` 的 `offset` 处。**不修改 `src`**。
 *
 * 与 `floatToInt16` 互逆（±1 满量程可精确往返），因此同样用非对称分母。
 */
export function int16ToFloat(src: Int16Array, dst: Float32Array, offset = 0): void {
  for (let i = 0; i < src.length; i++) {
    const v = src[i] ?? 0;
    dst[offset + i] = v < 0 ? v / INT16_MIN_ABS : v / INT16_MAX_ABS;
  }
}

/** 生成一段静音 Int16（供测试与占位使用）。 */
export function createSilenceInt16(samples: number): Int16Array {
  return new Int16Array(samples);
}
