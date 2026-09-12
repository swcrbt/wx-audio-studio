/**
 * 打开工程：读盘 → 版本迁移 → EDL 校验修复 → 组装可编辑状态。
 *
 * 打开失败与"数据被修复过"都必须是可见事件：前者给用户可执行文案，
 * 后者记 `issues` 供 UI 提示（例如"2 个片段引用的素材缺失，已移除"）。
 */
import type { Asset, Id, Project } from '../types';
import { migrateProject, validateEdl, type EdlIssue } from '../../workers/render/edl/validate';
import { countClips, edlDurationSec } from '../../workers/render/edl/query';
import { deserializePeaks } from '../../workers/render/peaks/codec';
import type { PeaksLevel } from '../../workers/render/peaks/build';
import { readArrayBuffer } from '../fs/io';
import { paths } from '../fs/paths';
import { readProjectFile, readStoreIndex, setLastOpenedProjectId } from '../fs/store';
import { ProjectStore, createFsProjectPersist } from './project-store';
import { logger } from '../../utils/logger';

export type ProjectLoadErrorCode = 'notFound' | 'corrupted';

export class ProjectLoadError extends Error {
  readonly code: ProjectLoadErrorCode;
  readonly action: 'back' | 'retry';

  constructor(code: ProjectLoadErrorCode, message: string, action: ProjectLoadError['action'] = 'back') {
    super(message);
    this.name = 'ProjectLoadError';
    this.code = code;
    this.action = action;
  }
}

export interface OpenProjectOptions {
  persist?: (project: Project) => Promise<void>;
  now?: () => number;
}

export interface OpenProjectResult {
  store: ProjectStore;
  /** 校验过程中做过的修复（UI 可据此提示用户）。 */
  issues: EdlIssue[];
}

export async function openProject(
  projectId: Id,
  options: OpenProjectOptions = {},
): Promise<OpenProjectResult> {
  const raw = await readProjectFile(projectId);
  if (!raw) throw new ProjectLoadError('notFound', '工程不存在或已被删除', 'back');

  const migrated = migrateProject(raw);
  if (!migrated) {
    throw new ProjectLoadError('corrupted', '工程数据损坏或版本过新，请更新小程序后重试', 'retry');
  }

  const { edl, issues } = validateEdl(migrated);
  const project: Project = {
    ...migrated,
    sampleRate: edl.sampleRate,
    channels: edl.channels,
    assets: edl.assets,
    tracks: edl.tracks,
    summary: {
      durationSec: edlDurationSec(edl),
      assetCount: edl.assets.length,
      clipCount: countClips(edl),
      ...(migrated.summary.thumbnailPeaksPath
        ? { thumbnailPeaksPath: migrated.summary.thumbnailPeaksPath }
        : {}),
    },
  };

  const store = new ProjectStore({
    project,
    persist: options.persist ?? createFsProjectPersist(),
    ...(options.now ? { now: options.now } : {}),
  });

  // 会话恢复：让首页能提示"继续编辑"
  try {
    const index = await readStoreIndex();
    await setLastOpenedProjectId(index, projectId);
  } catch (error) {
    // 记录失败不影响打开工程
    logger.warn('store', 'set lastOpenedProjectId failed', error);
  }

  return { store, issues };
}

/** 读取素材的峰值金字塔（每声道一份）。缺失或损坏时返回 `null`，由调用方降级显示。 */
export async function loadAssetPeaks(assetId: Id): Promise<PeaksLevel[][] | null> {
  try {
    const buffer = await readArrayBuffer(paths.peaks(assetId));
    const file = deserializePeaks(buffer);
    if (!file) {
      logger.warn('peaks', `peaks file invalid: ${assetId}`);
      return null;
    }
    return file.levels;
  } catch (error) {
    logger.warn('peaks', `peaks load failed: ${assetId}`, error);
    return null;
  }
}

/** 编辑器的"焦点素材"：工程里第一个被片段引用的素材（M1 编辑器按单素材切割设计）。 */
export function focusAssetId(project: Project): Id | null {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      return clip.assetId;
    }
  }
  return null;
}

export function findAsset(project: Project, assetId: Id | null): Asset | undefined {
  if (!assetId) return undefined;
  return project.assets.find((asset) => asset.id === assetId);
}
