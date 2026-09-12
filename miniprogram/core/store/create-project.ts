/**
 * 新建工程：创建 EDL、写盘、登记索引。
 *
 * 工程参数（采样率 / 声道）一旦确定就不再变——它决定了处理链与素材中间格式，
 * 打开后再改会让已导入素材全部失配（docs/05 §9），因此只能在创建时选择。
 */
import type { Id, Project, Track } from '../types';
import { createEmptyEdl, createTrack } from '../../workers/render/edl/ops';
import { CURRENT_SCHEMA_VERSION } from '../../workers/render/edl/validate';
import { createId, paths } from '../fs/paths';
import { ensureDataDirs, readStoreIndex, upsertProjectEntry, writeProjectFile } from '../fs/store';
import { logger } from '../../utils/logger';

export interface CreateProjectOptions {
  name?: string;
  sampleRate?: Project['sampleRate'];
  channels?: Project['channels'];
  /** 是否附带一条默认轨道（录音/导入后立刻可用）。 */
  withDefaultTrack?: boolean;
  now?: () => number;
  projectId?: Id;
}

export const DEFAULT_PROJECT_NAME = '未命名工程';

/** 新建一条默认轨道（名称按产品语言而非"轨道 1"）。 */
export function defaultTrack(): Track {
  return createTrack({ id: createId(), name: '主音轨', order: 0 });
}

export async function createProject(options: CreateProjectOptions = {}): Promise<Project> {
  const now = options.now ?? (() => Date.now());
  const at = now();
  const projectId = options.projectId ?? createId(at);
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 1;

  const edl = createEmptyEdl(sampleRate, channels);
  const project: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: projectId,
    name: options.name?.trim() || DEFAULT_PROJECT_NAME,
    createdAt: at,
    updatedAt: at,
    sampleRate,
    channels,
    assets: edl.assets,
    tracks: options.withDefaultTrack === false ? [] : [defaultTrack()],
    summary: { durationSec: 0, assetCount: 0, clipCount: 0 },
  };

  await ensureDataDirs();
  await writeProjectFile(project);

  try {
    const index = await readStoreIndex();
    await upsertProjectEntry(index, project);
  } catch (error) {
    // 索引失败不影响工程本身（下次启动会扫描重建）
    logger.warn('store', 'index update failed after create', error);
  }

  return project;
}

/** 删除工程文件与索引条目（素材是否删除由容量清理决定，不在这里做）。 */
export async function deleteProjectFile(projectId: Id): Promise<void> {
  const fs = wx.getFileSystemManager();
  await new Promise<void>((resolve) => {
    fs.unlink({
      filePath: paths.project(projectId),
      success: () => resolve(),
      fail: () => resolve(),
    });
  });
}
