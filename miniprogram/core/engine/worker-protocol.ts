/**
 * 跨线程消息与渲染任务的**唯一定义处**（AGENTS §1）。
 *
 * ⚠️ Worker 侧只能以 `import type` 引用本文件：类型在编译后被消除，不会产生
 * 跨目录 `require`（官方限制：Worker 只能引用 Worker 目录内文件，见 docs/02 §1.5
 * 与 ADR-0001）。
 *
 * 调度模型与字段语义见 docs/03 §5.2。传输约定：
 * - 素材请求/回传都用**帧号**（不是字节偏移）：主线程知道素材声道数，由它换算字节；
 * - `pcmBuffer` 是 Int16 交错 PCM 的 `ArrayBuffer`（`postMessage` 为复制语义）。
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
  /** 输出 WAV 的绝对路径。**只有主线程需要**（Worker 不碰文件系统），故可选。 */
  targetPath?: string;
  /** 总线是否挂限制器，默认 true（docs/01 FX-12 导出前防削波）。 */
  limiter?: boolean;
}

/** 主线程 → Worker。 */
export type MainToWorkerMessage =
  | { type: 'init'; job: RenderJob }
  | {
      type: 'assetChunk';
      assetId: Id;
      /** 该切片首帧在素材中的绝对帧号。 */
      startFrame: number;
      /** 切片声道数（决定 `pcmBuffer` 的交错方式）。 */
      channels: number;
      /** Int16 交错 PCM。 */
      pcmBuffer: ArrayBuffer;
    }
  | { type: 'cancel' };

/** Worker → 主线程。 */
export type WorkerToMainMessage =
  | {
      type: 'assetRequest';
      assetId: Id;
      startFrame: number;
      frameCount: number;
    }
  | {
      type: 'chunkDone';
      chunkIndex: number;
      pcmBuffer: ArrayBuffer;
      /** 下一块序号；为 `null` 表示已渲染完最后一块。 */
      nextChunk: number | null;
    }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; bytes: number; frames: number }
  | { type: 'error'; code: WorkerErrorCode; message: string };

export type WorkerErrorCode = 'invalidJob' | 'assetMissing' | 'internal' | 'cancelled';
