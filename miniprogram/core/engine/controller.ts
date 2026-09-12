/**
 * 渲染控制器（主线程侧）：Worker 生命周期 + 素材读盘 + 结果写盘。
 *
 * 平台限制（决定了这里的分工）：
 * - Worker 内没有 `wx.*`：素材必须由本控制器读出后传过去；
 * - 同时只能存在一个 Worker，创建下一个前必须 `terminate()`；
 * - 重度计算建议开启 `useExperimentalWorker`（iOS 提速明显），但它可能被系统回收，
 *   因此需处理 `onProcessKilled`。
 */
import type { MainToWorkerMessage, RenderJob, WorkerToMainMessage } from './worker-protocol';
import { FsError, describeFsError } from '../fs/errors';
import { paths } from '../fs/paths';
import { openWavWriter, readPcmFrames, readWavMeta, unlinkQuiet, type WavWriter } from '../fs/wav-file';
import { logger } from '../../utils/logger';

/** Worker 入口脚本路径（相对 `miniprogramRoot`，**不以 `/` 开头**，官方要求）。 */
export const RENDER_WORKER_PATH = 'workers/render/index.js';

export interface RenderProgress {
  done: number;
  total: number;
  /** 预计剩余秒数（按已耗时线性外推）。 */
  etaSec: number;
}

export interface RenderResult {
  filePath: string;
  bytes: number;
  frames: number;
}

export interface RenderControllerOptions {
  job: RenderJob;
  onProgress?: (progress: RenderProgress) => void;
  /** 是否在渲染失败/取消时删除半成品文件（默认删）。 */
  cleanupOnFailure?: boolean;
}

/** 同一时刻只允许一个渲染任务（官方限制 + 内存预算）。 */
let renderBusy = false;

export class RenderController {
  private readonly options: RenderControllerOptions;
  private worker: WechatMiniprogram.Worker | null = null;
  private writer: WavWriter | null = null;
  private finished = false;
  private startedAt = 0;
  private resolveFn: ((result: RenderResult) => void) | null = null;
  private rejectFn: ((error: unknown) => void) | null = null;

  constructor(options: RenderControllerOptions) {
    this.options = options;
  }

  /** 启动渲染；返回产物信息。失败时抛 `FsError` 或普通 `Error`。 */
  async start(): Promise<RenderResult> {
    if (renderBusy) {
      throw new FsError({ code: 'ioError', message: '已有导出任务在进行中，请等待完成', action: 'retry' });
    }
    renderBusy = true;
    this.finished = false;
    this.startedAt = Date.now();

    const job = this.options.job;
    const targetPath = job.targetPath;
    if (!targetPath) throw new Error('渲染任务缺少 targetPath');

    try {
      // 只渲染选区时，帧数按选区长度估算（不能按整段 EDL 长度）
      const rangeSec = Math.max(0, job.range.endSec - job.range.startSec);
      const estimatedFrames = Math.round(rangeSec * job.output.sampleRate);
      this.writer = await openWavWriter(targetPath, {
        sampleRate: job.output.sampleRate,
        channels: job.output.channels,
        estimatedFrames,
      });
    } catch (error) {
      renderBusy = false;
      throw error;
    }

    return new Promise<RenderResult>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;

      try {
        this.worker = wx.createWorker(RENDER_WORKER_PATH, { useExperimentalWorker: true });
      } catch (error) {
        // Worker 创建失败：由上层决定是否降级到主线程分片渲染
        this.fail(
          new FsError({ code: 'ioError', message: '渲染线程创建失败，可重试或改用主线程渲染', action: 'retry' }),
        );
        logger.warn('render', 'createWorker failed', error);
        return;
      }

      this.worker.onMessage((res: unknown) => {
        void this.handleMessage(unwrap(res));
      });
      // 实验 Worker 可能被系统回收
      this.worker.onProcessKilled?.(() => {
        this.fail(new Error('渲染线程被系统回收，请重试'));
      });

      this.post({ type: 'init', job });
    });
  }

  /** 取消渲染：通知 Worker 并终止线程，随后清理半成品。 */
  cancel(): void {
    if (this.finished) return;
    this.post({ type: 'cancel' });
    this.fail(new Error('渲染已取消'), true);
  }

  private post(message: MainToWorkerMessage): void {
    try {
      this.worker?.postMessage(message);
    } catch (error) {
      logger.warn('render', 'postMessage failed', error);
    }
  }

  private async handleMessage(message: WorkerToMainMessage | null): Promise<void> {
    if (!message || this.finished) return;

    switch (message.type) {
      case 'assetRequest': {
        await this.serveAssetRequest(message.assetId, message.startFrame, message.frameCount);
        return;
      }

      case 'chunkDone': {
        try {
          const pcm = new Int16Array(message.pcmBuffer);
          await this.writer?.write(pcm);
        } catch (error) {
          this.fail(error);
        }
        return;
      }

      case 'progress': {
        this.reportProgress(message.done, message.total);
        return;
      }

      case 'done': {
        try {
          await this.writer?.finalize();
          this.succeed({ filePath: this.options.job.targetPath ?? '', bytes: message.bytes, frames: message.frames });
        } catch (error) {
          this.fail(error);
        }
        return;
      }

      case 'error': {
        this.fail(new Error(message.message), message.code === 'cancelled');
        return;
      }

      default:
        return;
    }
  }

  /** 读取素材帧区间并回传给 Worker（Worker 内无法读文件）。 */
  private async serveAssetRequest(
    assetId: string,
    startFrame: number,
    frameCount: number,
  ): Promise<void> {
    const asset = this.options.job.edl.assets.find((item) => item.id === assetId);
    if (!asset) {
      this.fail(new Error(`素材缺失：${assetId}`));
      return;
    }

    try {
      const filePath = absoluteAssetPath(asset.path);
      const meta = await readWavMeta(filePath);
      const pcm = await readPcmFrames(meta, startFrame, frameCount);
      const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      this.post({
        type: 'assetChunk',
        assetId,
        startFrame,
        channels: meta.channels,
        pcmBuffer: payload,
      });
    } catch (error) {
      const info = error instanceof FsError ? error.info : describeFsError(error);
      this.fail(new FsError(info));
    }
  }

  private reportProgress(done: number, total: number): void {
    if (!this.options.onProgress) return;
    const elapsedSec = (Date.now() - this.startedAt) / 1000;
    const etaSec = done > 0 ? Math.max(0, (elapsedSec / done) * (total - done)) : 0;
    this.options.onProgress({ done, total, etaSec });
  }

  private succeed(result: RenderResult): void {
    this.settle();
    this.resolveFn?.(result);
  }

  private fail(error: unknown, keepFile = false): void {
    if (this.finished) return;
    const cleanup = this.options.cleanupOnFailure !== false && !keepFile;
    this.settle();
    if (cleanup) {
      void this.removePartialFile();
    }
    this.rejectFn?.(error);
  }

  private async removePartialFile(): Promise<void> {
    try {
      await this.writer?.abort();
    } catch (error) {
      logger.warn('render', 'abort writer failed', error);
    }
  }

  /** 统一收尾：终止 Worker、释放写盘器、解除忙标志。 */
  private settle(): void {
    if (this.finished) return;
    this.finished = true;
    renderBusy = false;

    try {
      this.worker?.terminate();
    } catch (error) {
      logger.warn('render', 'terminate failed', error);
    }
    this.worker = null;
    this.writer = null;
  }
}

/** 把素材的相对路径转成平台绝对路径（路径字符串只允许在 `fs/paths.ts` 构造）。 */
function absoluteAssetPath(relativePath: string): string {
  if (relativePath.startsWith('/') || relativePath.includes(':')) return relativePath;
  return `${paths.root()}/${relativePath}`;
}

/** 请求失败时删除临时产物（保留用户成品目录不动）。 */
export async function removeIfExists(filePath: string): Promise<void> {
  await unlinkQuiet(filePath);
}

function unwrap(res: unknown): WorkerToMainMessage | null {
  if (typeof res !== 'object' || res === null) return null;
  const wrapped = res as { data?: WorkerToMainMessage };
  const candidate = wrapped.data ?? (res as WorkerToMainMessage);
  return typeof candidate.type === 'string' ? candidate : null;
}
