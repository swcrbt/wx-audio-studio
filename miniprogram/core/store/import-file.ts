/**
 * 把外部文件导入成工程素材（首页"导入文件"与录音页结束时共用）。
 *
 * 顺序：先建工程（写盘）→ 再导入素材（解码 + 转格式 + 峰值）→ 最后把素材挂到时间轴。
 * 素材导入失败时工程仍在（用户可重试导入），比"全有或全无"更符合直觉。
 */
import type { Asset, Id, Project } from '../types';
import { importAudio, type ImportResult } from '../audio/import';
import { createId } from '../fs/paths';
import { readProjectFile, readStoreIndex, upsertProjectEntry, writeProjectFile } from '../fs/store';
import { migrateProject } from '../../workers/render/edl/validate';
import { ProjectStore, createFsProjectPersist } from './project-store';
import { commitAddAsset } from './add-asset';
import { logger } from '../../utils/logger';

export type ImportStageName = 'read' | 'decode' | 'process' | 'peaks' | 'done';

export interface ImportIntoProjectOptions {
  project: Project;
  srcPath: string;
  name?: string;
  onProgress?: (stage: ImportStageName, ratio: number) => void;
}

export interface ImportIntoProjectResult {
  asset: Asset;
  /** 导入统计（是否重采样、声道如何转换）。 */
  result: ImportResult;
}

export async function importFileIntoProject(
  options: ImportIntoProjectOptions,
): Promise<ImportIntoProjectResult> {
  const { project, srcPath } = options;
  const store = new ProjectStore({ project, persist: createFsProjectPersist() });

  const assetId = createId();
  const result = await importAudio({
    srcPath,
    projectSampleRate: project.sampleRate,
    projectChannels: project.channels,
    assetId,
    name: options.name ?? project.name,
    origin: 'local',
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  commitAddAsset(store, result.asset, { label: '导入素材' });
  await store.flush();
  store.dispose();

  return { asset: result.asset, result };
}

/** 重命名工程（列表页操作）：读盘 → 改名 → 写盘 → 更新索引。 */
export async function renameProjectById(projectId: Id, name: string): Promise<void> {
  const raw = await readProjectFile(projectId);
  const project = raw ? migrateProject(raw) : null;
  if (!project) throw new Error(`工程不存在或已损坏：${projectId}`);

  const next: Project = { ...project, name: name.trim() || project.name, updatedAt: Date.now() };
  await writeProjectFile(next);

  try {
    const index = await readStoreIndex();
    await upsertProjectEntry(index, next);
  } catch (error) {
    // 索引可重建，失败不阻断重命名
    logger.warn('store', 'index update failed after rename', error);
  }
}
