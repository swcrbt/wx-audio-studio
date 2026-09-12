/**
 * WAV 文件分块读写（平台适配层，允许 `wx.*`；AGENTS §1）。
 *
 * 依赖的官方能力与限制（依据 docs/02 §1.4，来源编号 `S8` 见 §1.7）：
 * - `FileSystemManager.open()` → `fd`；
 * - `FileSystemManager.read({ fd, arrayBuffer, offset, length, position })`：**基础库 2.16.1+**，
 *   `position` 为正整数时文件指针不变 → 可随机访问（分块渲染的基石）；
 * - `FileSystemManager.write({ fd, data, position })`；
 * - 单文件上限 **100MB**（错误码 `1300202`）。
 *
 * 头部解析与回填复用 `workers/render/codec/wav.ts`（主线程反向依赖 Worker 目录是被允许的，
 * 见 ADR-0001）。
 */
import {
  WAV_HEADER_BYTES,
  parseWav,
  patchWavHeaderSizes,
  writeWavHeader,
  type ParsedWav,
} from '../../workers/render/codec/wav';
import { FsError, describeFsError } from './errors';

export interface WavFileMeta extends ParsedWav {
  filePath: string;
  /** 文件总字节数。 */
  fileBytes: number;
}

/** 读取 WAV 头所需的最大字节数（兼容 data 前有附加块的情况）。 */
const HEADER_PROBE_BYTES = 4096;

function getFs(): WechatMiniprogram.FileSystemManager {
  return wx.getFileSystemManager();
}

function openFd(filePath: string, flag: 'r' | 'w+'): Promise<string> {
  return new Promise((resolve, reject) => {
    getFs().open({
      filePath,
      flag,
      success: (res) => resolve(res.fd),
      fail: (err) => reject(new FsError(describeFsError(err))),
    });
  });
}

function closeFd(fd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    getFs().close({
      fd,
      success: () => resolve(),
      fail: (err) => reject(new FsError(describeFsError(err))),
    });
  });
}

function readAt(fd: string, position: number, length: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const buffer = new ArrayBuffer(length);
    getFs().read({
      fd,
      arrayBuffer: buffer,
      offset: 0,
      length,
      position,
      success: (res) => resolve(res.arrayBuffer),
      fail: (err) => reject(new FsError(describeFsError(err, length))),
    });
  });
}

function writeAt(fd: string, position: number, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    getFs().write({
      fd,
      data,
      position,
      success: () => resolve(),
      fail: (err) => reject(new FsError(describeFsError(err, data.byteLength))),
    });
  });
}

function statSize(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    getFs().stat({
      path: filePath,
      // `stats` 在 recursive 下是数组，这里用结构守卫兼容两种形状
      success: (res) => resolve(extractStatsSize(res.stats)),
      fail: (err) => reject(new FsError(describeFsError(err))),
    });
  });
}

function extractStatsSize(stats: unknown): number {
  if (Array.isArray(stats)) return stats.length > 0 ? extractStatsSize(stats[0]) : 0;
  if (typeof stats === 'object' && stats !== null) {
    const size = (stats as { size?: unknown }).size;
    if (typeof size === 'number') return size;
  }
  return 0;
}

/** 删除文件（失败静默：用于"先删再建"的清理路径，不阻断主流程）。 */
export function unlinkQuiet(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    getFs().unlink({
      filePath,
      success: () => resolve(),
      fail: () => resolve(),
    });
  });
}

/**
 * 读取 WAV 元信息（含 data 区偏移与帧数）。
 *
 * @throws {FsError} 文件不存在 / 权限错误 / 不是合法 WAV
 */
export async function readWavMeta(filePath: string): Promise<WavFileMeta> {
  const fileBytes = await statSize(filePath);
  const probeBytes = Math.min(HEADER_PROBE_BYTES, fileBytes);
  if (probeBytes < WAV_HEADER_BYTES) {
    throw new FsError({ code: 'unknown', message: '文件不是有效的 WAV（长度不足）', action: 'chooseFile' });
  }

  const fd = await openFd(filePath, 'r');
  try {
    const head = await readAt(fd, 0, probeBytes);
    const parsed = parseWav(new Uint8Array(head));
    if (!parsed) {
      throw new FsError({
        code: 'unknown',
        message: '文件不是有效的 WAV（RIFF/WAVE 结构不完整）',
        action: 'chooseFile',
      });
    }
    return { ...parsed, filePath, fileBytes };
  } finally {
    await closeFd(fd);
  }
}

/**
 * 按帧号读取一段交错 PCM。
 *
 * 越界部分会被截断为返回更短的数组（不抛错），便于渲染末尾块。
 *
 * @param startFrame 起始采样帧（0 基）
 * @param frameCount 需要的帧数
 */
export async function readPcmFrames(
  meta: WavFileMeta,
  startFrame: number,
  frameCount: number,
): Promise<Int16Array> {
  const bytesPerFrame = meta.channels * 2;
  const availableFrames = meta.frames;
  const from = Math.max(0, Math.floor(startFrame));
  const count = Math.max(0, Math.min(Math.floor(frameCount), availableFrames - from));
  if (count === 0) return new Int16Array(0);

  const fd = await openFd(meta.filePath, 'r');
  try {
    const buffer = await readAt(fd, meta.dataOffset + from * bytesPerFrame, count * bytesPerFrame);
    return new Int16Array(buffer);
  } finally {
    await closeFd(fd);
  }
}

export interface WavWriterSpec {
  sampleRate: number;
  channels: number;
  /** 预估总帧数（仅用于计算占位头；实际以写入量为准，结束时回填）。 */
  estimatedFrames: number;
}

export interface WavWriter {
  /** 追加交错 PCM（内部按顺序写入，调用方保证顺序）。 */
  write(pcm: Int16Array): Promise<void>;
  /** 回填 `RIFF.chunkSize` 与 `data.dataSize` 并关闭文件。 */
  finalize(): Promise<void>;
  /** 中止写盘：关闭并删除半成品（docs/03 §9：渲染失败不留残file）。 */
  abort(): Promise<void>;
  /** 已写入的 data 区字节数。 */
  readonly dataBytes: number;
}

/**
 * 打开一个流式 WAV 写入器：先写占位头，数据边算边写，结束时回填长度。
 * 这是录音与分块渲染共用的落盘路径（docs/03 §2 / §3）。
 */
export async function openWavWriter(filePath: string, spec: WavWriterSpec): Promise<WavWriter> {
  await unlinkQuiet(filePath); // 新文件：避免 'w+' 之外的残留内容
  const fd = await openFd(filePath, 'w+');

  const header = new ArrayBuffer(WAV_HEADER_BYTES);
  const headerView = new DataView(header);
  // 先用预估长度写一个占位头（结束时用真实长度回填，见 docs/03 §2）
  const placeholderBytes = Math.max(0, Math.round(spec.estimatedFrames)) * spec.channels * 2;
  writeWavHeader(headerView, {
    sampleRate: spec.sampleRate,
    channels: spec.channels,
    dataBytes: placeholderBytes,
  });

  await writeAt(fd, 0, header);

  let closed = false;
  let dataBytes = 0;

  async function closeOnce(): Promise<void> {
    if (closed) return;
    closed = true;
    await closeFd(fd);
  }

  return {
    get dataBytes(): number {
      return dataBytes;
    },

    async write(pcm: Int16Array): Promise<void> {
      if (closed) throw new FsError({ code: 'ioError', message: '写入器已关闭', action: 'retry' });
      if (pcm.length === 0) return;
      const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      await writeAt(fd, WAV_HEADER_BYTES + dataBytes, payload);
      dataBytes += payload.byteLength;
    },

    async finalize(): Promise<void> {
      if (closed) return;
      const head = await readAt(fd, 0, WAV_HEADER_BYTES);
      const view = new DataView(head);
      patchWavHeaderSizes(view, dataBytes);
      await writeAt(fd, 0, head);
      await closeOnce();
    },

    async abort(): Promise<void> {
      await closeOnce();
      await unlinkQuiet(filePath);
    },
  };
}
