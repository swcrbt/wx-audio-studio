/**
 * 预览会话：把「预览缓存 + 播放通道」组装成页面可直接用的播放能力。
 *
 * 编辑器与混音页共用它，避免两个页面各自维护"窗口偏移换算""渲染中转场""脏区间标记"
 * 这些容易写错的细节（预览文件只覆盖一个窗口，播放位置必须减去窗口起点才是文件内位置）。
 */
import type { Edl, Id, Seconds, TimeRange } from '../types';
import { RenderController } from '../engine/controller';
import { PreviewCache, PreviewEmptyError } from './preview-cache';
import { Transport, type TransportState } from './transport';
import { edlDurationSec } from '../../workers/render/edl/query';
import { DEFAULT_RENDER_CHUNK_SEC } from '../../workers/render/constants';
import { logger } from '../../utils/logger';

export interface PreviewSessionOptions {
  projectId: Id;
  previewPath: string;
  /** 每次取最新 EDL：编辑后立即反映，无需重建会话。 */
  getEdl: () => Edl;
  output: { sampleRate: number; channels: 1 | 2 };
  /** 渲染中转场状态变化（UI 显示"正在准备…"）。 */
  onPreparingChange?: (preparing: boolean) => void;
  /** 播放位置（工程时间，已加回窗口起点）。 */
  onPosition?: (sec: Seconds) => void;
  onStateChange?: (state: TransportState) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
}

export class PreviewSession {
  private readonly options: PreviewSessionOptions;
  private readonly cache: PreviewCache;
  private readonly transport: Transport;
  /** 当前预览文件覆盖的窗口起点（把播放位置换算成工程时间）。 */
  private windowStartSec: Seconds = 0;
  private preparing = false;

  constructor(options: PreviewSessionOptions) {
    this.options = options;
    this.cache = new PreviewCache({
      projectId: options.projectId,
      previewPath: options.previewPath,
      durationSec: () => edlDurationSec(options.getEdl()),
      render: async (window) => {
        const controller = new RenderController({
          job: {
            projectId: options.projectId,
            edl: options.getEdl(),
            output: options.output,
            range: { startSec: window.startSec, endSec: window.endSec },
            chunkSec: DEFAULT_RENDER_CHUNK_SEC,
            targetPath: options.previewPath,
          },
        });
        const result = await controller.start();
        return { filePath: result.filePath, bytes: result.bytes, frames: result.frames };
      },
    });

    this.transport = new Transport({
      onStateChange: (state) => options.onStateChange?.(state),
      onPosition: (positionSec) => options.onPosition?.(this.windowStartSec + positionSec),
      onEnded: () => options.onEnded?.(),
      onError: (error) => options.onError?.(error),
    });
  }

  /** 当前预览文件覆盖的窗口起点（把位置换算回文件内偏移时用）。 */
  get windowStart(): Seconds {
    return this.windowStartSec;
  }

  get isPreparing(): boolean {
    return this.preparing;
  }

  get loadedPath(): string | null {
    return this.transport.filePath;
  }

  /**
   * 播放：必要时先渲染窗口，再送进播放通道。
   *
   * @param fromSec 工程时间上的起始位置
   */
  async play(fromSec: Seconds): Promise<void> {
    this.setPreparing(true);
    try {
      const info = await this.cache.ensure(fromSec);
      this.windowStartSec = info.window.startSec;
      this.transport.load(info.filePath);
      this.transport.play({ fromSec: Math.max(0, fromSec - info.window.startSec) });
    } catch (error) {
      if (error instanceof PreviewEmptyError) {
        this.options.onError?.(error);
        return;
      }
      logger.warn('player', 'preview play failed', error);
      this.options.onError?.(error instanceof Error ? error : new Error('预览生成失败'));
    } finally {
      this.setPreparing(false);
    }
  }

  pause(): void {
    this.transport.pause();
  }

  stop(): void {
    this.transport.stop();
  }

  /** 定位到工程时间 `sec`；目标不在当前窗口内时不做处理（下次播放会重渲染）。 */
  seek(sec: Seconds): void {
    const relativeSec = sec - this.windowStartSec;
    if (!this.transport.filePath) return;
    if (relativeSec < 0 || relativeSec > this.transport.durationSec) return;
    this.transport.seek(relativeSec);
  }

  setRate(rate: number): number {
    return this.transport.setRate(rate);
  }

  /**
   * 标记预览失效。
   *
   * @param range 只失效一段区间；不传表示整体失效（批量操作、结构变化）
   */
  markDirty(range?: TimeRange): void {
    if (range) this.cache.markDirty(range.startSec, range.endSec);
    else this.cache.markAllDirty();
    // 波形已变，正在播的旧内容必须停掉，避免"听到已删除的片段"
    this.transport.stop();
  }

  destroy(): void {
    this.transport.destroy();
  }

  private setPreparing(preparing: boolean): void {
    if (this.preparing === preparing) return;
    this.preparing = preparing;
    this.options.onPreparingChange?.(preparing);
  }
}
