/**
 * 工程索引 `index.json` 的读写与重建。
 *
 * 为什么需要它：列表页只读这一份轻量索引，避免为渲染列表解析全部工程文件。
 * 索引在每次保存工程时同步更新；若缺失或损坏，扫描 `projects/*.json` 重建。
 */
import type { Id, Project } from '../types';
import { DATA_DIRS, paths } from './paths';
import { ensureDirs, exists, listFiles, readJson, writeJsonAtomic } from './io';
import { logger } from '../../utils/logger';

/** 索引文件自身的结构版本（与工程的 `schemaVersion` 相互独立）。 */
export const STORE_INDEX_VERSION = 1;

export interface StoreProjectEntry {
  id: Id;
  name: string;
  updatedAt: number;
  durationSec: number;
  thumbnailPeaksPath?: string;
  /** 该项目相关文件总占用（估算，异步刷新）。 */
  sizeBytes: number;
}

export interface StoreIndex {
  schemaVersion: number;
  projects: StoreProjectEntry[];
  stats: {
    assetsBytes: number;
    peaksBytes: number;
    rendersBytes: number;
    /** 是否已提示过容量告警。 */
    quotaWarned: boolean;
  };
}

export function createEmptyIndex(): StoreIndex {
  return {
    schemaVersion: STORE_INDEX_VERSION,
    projects: [],
    stats: { assetsBytes: 0, peaksBytes: 0, rendersBytes: 0, quotaWarned: false },
  };
}

/** 确保数据目录存在（启动时调用一次）。 */
export async function ensureDataDirs(): Promise<void> {
  const root = paths.root();
  await ensureDirs([root, ...Object.values(DATA_DIRS).map((dir) => `${root}/${dir}`)]);
}

/**
 * 读取索引；不存在或损坏时自动重建（扫描工程目录）。
 */
export async function readStoreIndex(): Promise<StoreIndex> {
  const raw = await readJson<StoreIndex>(paths.index());
  if (raw && raw.schemaVersion === STORE_INDEX_VERSION && Array.isArray(raw.projects)) {
    return raw;
  }
  logger.warn('store', 'index.json missing or invalid, rebuilding');
  return rebuildStoreIndex();
}

export async function writeStoreIndex(index: StoreIndex): Promise<void> {
  await writeJsonAtomic(paths.index(), { ...index, schemaVersion: STORE_INDEX_VERSION });
}

/**
 * 全目录扫描重建索引（降级路径）。
 * 只读取每个工程 JSON 的轻量字段，不加载素材。
 */
export async function rebuildStoreIndex(): Promise<StoreIndex> {
  const index = createEmptyIndex();
  const root = paths.root();
  const files = await listFiles(`${root}/${DATA_DIRS.projects}`);

  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
    const filePath = `${root}/${DATA_DIRS.projects}/${file}`;
    const project = await readJson<Project>(filePath);
    if (!project || typeof project.id !== 'string') continue;

    index.projects.push({
      id: project.id,
      name: typeof project.name === 'string' ? project.name : '未命名工程',
      updatedAt: typeof project.updatedAt === 'number' ? project.updatedAt : 0,
      durationSec: project.summary?.durationSec ?? 0,
      ...(project.summary?.thumbnailPeaksPath
        ? { thumbnailPeaksPath: project.summary.thumbnailPeaksPath }
        : {}),
      sizeBytes: 0,
    });
  }

  index.projects.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeStoreIndex(index).catch((error) => {
    logger.warn('store', 'rebuild index write failed', error);
  });
  return index;
}

/** 保存工程后更新索引中的一行（不存在则插入）。 */
export async function upsertProjectEntry(
  index: StoreIndex,
  project: Project,
): Promise<StoreIndex> {
  const entry: StoreProjectEntry = {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    durationSec: project.summary.durationSec,
    ...(project.summary.thumbnailPeaksPath
      ? { thumbnailPeaksPath: project.summary.thumbnailPeaksPath }
      : {}),
    sizeBytes: index.projects.find((item) => item.id === project.id)?.sizeBytes ?? 0,
  };

  const projects = index.projects.filter((item) => item.id !== project.id);
  projects.unshift(entry);
  projects.sort((a, b) => b.updatedAt - a.updatedAt);

  const next: StoreIndex = { ...index, projects };
  await writeStoreIndex(next);
  return next;
}

/** 删除工程条目。 */
export async function removeProjectEntry(index: StoreIndex, projectId: Id): Promise<StoreIndex> {
  const next: StoreIndex = { ...index, projects: index.projects.filter((item) => item.id !== projectId) };
  await writeStoreIndex(next);
  return next;
}

/** 读取工程 JSON（不存在返回 `null`）。调用方负责 `migrateProject` 与 `validateEdl`。 */
export async function readProjectFile(projectId: Id): Promise<unknown | null> {
  const filePath = paths.project(projectId);
  if (!(await exists(filePath))) return null;
  return readJson<unknown>(filePath);
}

/** 原子写工程 JSON（先写 `.tmp` 再 rename）。 */
export async function writeProjectFile(project: Project): Promise<void> {
  await writeJsonAtomic(paths.project(project.id), project);
}
