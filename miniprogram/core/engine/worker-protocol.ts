/**
 * 跨线程消息类型的**唯一定义处**（AGENTS §1）。
 *
 * ⚠️ Worker 侧只能以 `import type` 引用本文件：类型在编译后被消除，不会产生
 * 跨目录 `require`（官方限制：Worker 只能引用 Worker 目录内文件，见 docs/02 §1.5
 * 与 ADR-0001）。
 *
 * 调度模型与字段语义见 docs/03 §5.2。
 */
import type { Edl, Id, Seconds } from '../../core/types';

export interface RenderOutput {
  sampleRate: number;
  channels: 1 | 2;
}

export interface RenderRange {
  startSec: Seconds;
  endSec: Seconds;
}

export interface RenderJob {
  projectId: Id;
  edl: Edl;
  output: RenderOutput;
  /** 支持只渲染选区。 */
  range: RenderRange;
  /** 块大小（默认 2s，可按性能自适应 1~4s）。 */
  chunkSec: number;
  /** 输出 WAV 的绝对路径。 */
  targetPath: string;
}

/** 主线程 → Worker。 */
export type MainToWorkerMessage =
  | { type: 'init'; job: RenderJob }
  | {
      type: 'assetChunk';
      assetId: Id;
      chunkIndex: number;
      /** Int16 PCM（互拷：官方明确 postMessage 是数据复制而非共享）。 */
      pcmBuffer: ArrayBuffer;
    }
  | { type: 'cancel' };

/** Worker → 主线程。 */
export type WorkerToMainMessage =
  | {
      type: 'assetRequest';
      assetId: Id;
      /** data 区内的字节偏移（不含 WAV 头）。 */
      byteOffset: number;
      bytes: number;
    }
  | {
      type: 'chunkDone';
      chunkIndex: number;
      pcmBuffer: ArrayBuffer;
      nextChunk: number | null;
    }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; bytes: number; frames: number }
  | { type: 'error'; code: WorkerErrorCode; message: string };

export type WorkerErrorCode =
  | 'invalidJob'
  | 'assetMissing'
  | 'internal'
  | 'cancelled';

/**
 * 多态消息分发用的判别式辅助类型（Worker 入口与主线程共用）。
 * 不用 TS 的 `Extract` 是为了在 Worker 侧 `import type` 时保持零运行时开销。
 */
export type MessageOfType<T extends { type: string }, K extends string> = T extends {
  type: K;
}
  ? T
  : never;
