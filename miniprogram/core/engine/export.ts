/**
 * 导出编排：读峰值 → 规划（归一化增益、体积校验）→ 渲染成品 → 返回结果。
 *
 * 导出期间 EDL 被深拷贝快照（`RenderJob.edl`）：用户继续编辑也不会改变正在渲染的结果
 * （编辑锁定由 UI 负责，这里保证数据层不会漂移）。
 */
import type { Id, Project, TimeRange } from '../types';
import { RenderController, type RenderProgress } from './controller';
import { planExport, type ExportOutput, type ExportPlan } from './export-plan';
import { produceOutputFile } from './export-resample';
import { cloneEdl } from '../../workers/render/edl/ops';
import type { PeaksLevel } from '../../workers/render/peaks/build';
import { loadAssetPeaks } from '../store/load-project';
import { paths } from '../fs/paths';
import { unlinkQuiet } from '../fs/wav-file';
import { DEFAULT_RENDER_CHUNK_SEC } from '../../workers/render/constants';
import { logger } from '../../utils/logger';

export type ExportErrorCode = 'blocked' | 'renderFailed' | 'cancelled';

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly action: 'shorten' | 'retry' | 'none';

  constructor(code: ExportErrorCode, message: string, action: ExportError['action'] = 'none') {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.action = action;
  }
}

export interface ExportProgress {
  stage: 'plan' | 'render' | 'postProcess' | 'done';
  /** 已完成块数 / 总块数（`plan` 与 `postProcess` 阶段为 0）。 */
  done: number;
  total: number;
  ratio: number;
  etaSec: number;
}

export interface ExportRequest {
  project: Project;
  output: ExportOutput;
  normalize?: boolean;
  limiter?: boolean;
  range?: TimeRange;
  /** 成品文件的时间戳（命名用）。 */
  stamp: string;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportResult {
  /** 磁盘绝对路径（`renders/out-*.wav`）。 */
  filePath: string;
  /** 分享给朋友时显示的文件名。 */
  fileName: string;
  bytes: number;
  frames: number;
  durationSec: number;
  plan: ExportPlan;
}

export class ExportTask {
  private readonly request: ExportRequest;
  private controller: RenderController | null = null;
  private cancelled = false;

  constructor(request: ExportRequest) {
    this.request = request;
  }

  /** 执行导出；失败时抛 `ExportError`。 */
  async start(): Promise<ExportResult> {
    const { project, output, stamp } = this.request;
    this.request.onProgress?.({ stage: 'plan', done: 0, total: 0, ratio: 0, etaSec: 0 });

    const peaksByAsset = await this.loadPeaks(project);
    const plan = planExport({
      edl: {
        sampleRate: project.sampleRate,
        channels: project.channels,
        assets: project.assets,
        tracks: project.tracks,
      },
      peaksByAsset,
      output,
      ...(this.request.normalize !== undefined ? { normalize: this.request.normalize } : {}),
      ...(this.request.limiter !== undefined ? { limiter: this.request.limiter } : {}),
      ...(this.request.range ? { range: this.request.range } : {}),
    });

    if (plan.blocked) {
      throw new ExportError('blocked', plan.warnings[0] ?? '当前设置无法导出', 'shorten');
    }

    const filePath = paths.output(project.id, stamp);
    const projectRate = project.sampleRate;
    const projectChannels = project.channels;
    const needsPostProcess =
      plan.output.sampleRate !== projectRate || plan.output.channels !== projectChannels;

    // 需要后处理时先渲染到临时文件（渲染引擎只接受与工程一致的采样率与声道）
    const renderPath = needsPostProcess ? paths.tmp(`export-${project.id}-${stamp}.wav`) : filePath;
    const controller = new RenderController({
      job: {
        projectId: project.id,
        // 快照：导出途中编辑不影响结果
        edl: cloneEdl({
          sampleRate: project.sampleRate,
          channels: project.channels,
          assets: project.assets,
          tracks: project.tracks,
        }),
        output: { sampleRate: projectRate, channels: projectChannels },
        range: plan.range,
        chunkSec: DEFAULT_RENDER_CHUNK_SEC,
        targetPath: renderPath,
        limiter: plan.limiter,
        busGainDb: plan.busGainDb,
      },
      onProgress: (progress: RenderProgress) => {
        const total = progress.total > 0 ? progress.total : 1;
        const ratio = progress.done / total;
        this.request.onProgress?.({
          stage: 'render',
          done: progress.done,
          total,
          // 有后处理时渲染只占前 80%
          ratio: needsPostProcess ? ratio * 0.8 : ratio,
          etaSec: progress.etaSec,
        });
      },
    });
    this.controller = controller;

    try {
      const rendered = await controller.start();
      let bytes = rendered.bytes;

      if (needsPostProcess) {
        const produced = await produceOutputFile({
          srcPath: renderPath,
          dstPath: filePath,
          targetSampleRate: plan.output.sampleRate,
          targetChannels: plan.output.channels,
          onProgress: (ratio) => {
            this.request.onProgress?.({
              stage: 'postProcess',
              done: 0,
              total: 0,
              ratio: 0.8 + ratio * 0.2,
              etaSec: 0,
            });
          },
        });
        bytes = produced.bytes;
        await unlinkQuiet(renderPath);
      }

      this.request.onProgress?.({ stage: 'done', done: 1, total: 1, ratio: 1, etaSec: 0 });
      return {
        filePath,
        fileName: `${project.name}.wav`,
        bytes,
        frames: rendered.frames,
        durationSec: plan.durationSec,
        plan,
      };
    } catch (error) {
      if (this.cancelled) {
        throw new ExportError('cancelled', '导出已取消', 'none');
      }
      logger.warn('export', 'render failed', error);
      throw new ExportError('renderFailed', '导出失败，可重试或降低采样率后再试', 'retry');
    } finally {
      this.controller = null;
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.controller?.cancel();
  }

  /** 读全部素材峰值；缺失的素材跳过（`planExport` 会在 `warnings` 里提示）。 */
  private async loadPeaks(project: Project): Promise<Map<Id, PeaksLevel[]>> {
    const map = new Map<Id, PeaksLevel[]>();
    for (const asset of project.assets) {
      const levels = await loadAssetPeaks(asset.id);
      // `loadAssetPeaks` 返回每声道一份，导出估算只需要第一声道
      if (levels?.[0]) map.set(asset.id, levels[0]);
    }
    return map;
  }
}
