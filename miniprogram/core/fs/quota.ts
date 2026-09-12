/**
 * 容量统计与清理（策略见 docs/05 §5）。
 *
 * 官方的硬约束（来源见 docs/02 §1.4 的 `S7`）：**本地用户文件 + 本地缓存文件合计上限 200MB**。
 * 阈值以"占用百分比"驱动，不假设具体可用字节数（⚠️ 实际阈值待 DB-14 真机确认）。
 */
import type { Edl } from '../types';
import { DATA_DIRS, paths } from './paths';
import { exists, fileSize, listFiles, removeFile } from './io';
import { logger } from '../../utils/logger';

/** 官方配额（docs/05 §5：本表所有百分比均以此为分母）。 */
export const STORAGE_QUOTA_BYTES = 200 * 1024 * 1024;

/** 容量警戒线（docs/05 §5：> 80% 首页提示，> 95% 导出前强制提示）。 */
export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_CRITICAL_RATIO = 0.95;

/** 预览缓存保留数量上限（docs/05 §5 清理策略）。 */
export const MAX_PREVIEW_FILES = 3;

export type QuotaLevel = 'ok' | 'warn' | 'critical';

export interface StorageUsage {
  assetsBytes: number;
  peaksBytes: number;
  rendersBytes: number;
  projectsBytes: number;
  tmpBytes: number;
  /** 本地用户文件占用合计。 */
  totalBytes: number;
  quotaBytes: number;
  ratio: number;
  level: QuotaLevel;
}

function levelFor(ratio: number): QuotaLevel {
  if (ratio >= QUOTA_CRITICAL_RATIO) return 'critical';
  if (ratio >= QUOTA_WARN_RATIO) return 'warn';
  return 'ok';
}

async function sumDirBytes(dirPath: string, filter?: (name: string) => boolean): Promise<number> {
  const files = await listFiles(dirPath);
  let total = 0;
  for (const name of files) {
    if (filter && !filter(name)) continue;
    total += await fileSize(`${dirPath}/${name}`);
  }
  return total;
}

/** 统计当前存储占用（异步；列表页可在空闲时刷新）。 */
export async function computeStorageUsage(): Promise<StorageUsage> {
  const root = paths.root();
  const [assetsBytes, peaksBytes, rendersBytes, projectsBytes, tmpBytes] = await Promise.all([
    sumDirBytes(`${root}/${DATA_DIRS.assets}`),
    sumDirBytes(`${root}/${DATA_DIRS.peaks}`),
    sumDirBytes(`${root}/${DATA_DIRS.renders}`),
    sumDirBytes(`${root}/${DATA_DIRS.projects}`),
    sumDirBytes(`${root}/${DATA_DIRS.tmp}`),
  ]);

  const totalBytes = assetsBytes + peaksBytes + rendersBytes + projectsBytes + tmpBytes;
  const ratio = totalBytes / STORAGE_QUOTA_BYTES;
  return {
    assetsBytes,
    peaksBytes,
    rendersBytes,
    projectsBytes,
    tmpBytes,
    totalBytes,
    quotaBytes: STORAGE_QUOTA_BYTES,
    ratio,
    level: levelFor(ratio),
  };
}

/** 启动时清空 `tmp/`（docs/05 §5 清理策略①）。 */
export async function clearTmpDir(): Promise<number> {
  const dir = `${paths.root()}/${DATA_DIRS.tmp}`;
  const files = await listFiles(dir);
  let removed = 0;
  for (const name of files) {
    try {
      await removeFile(`${dir}/${name}`);
      removed++;
    } catch (error) {
      logger.warn('quota', 'clear tmp failed', error);
    }
  }
  return removed;
}

interface StampedFile {
  name: string;
  modifiedAt: number;
}

/** 读取文件最后修改时间（拿不到时返回 0）。 */
function lastModifiedAt(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().stat({
      path: filePath,
      success: (res) => {
        const stats = Array.isArray(res.stats) ? res.stats[0] : res.stats;
        const value = (stats as { lastModifiedTime?: unknown } | undefined)?.lastModifiedTime;
        resolve(typeof value === 'number' ? value : 0);
      },
      fail: () => resolve(0),
    });
  });
}

/**
 * 清理旧预览文件：`renders/preview-*.wav` 只保留最新的 `MAX_PREVIEW_FILES` 个。
 * **用户成品 `out-*.wav` 永不自动删除**（docs/05 §5 保护策略）。
 */
export async function cleanStalePreviews(maxFiles = MAX_PREVIEW_FILES): Promise<number> {
  const dir = `${paths.root()}/${DATA_DIRS.renders}`;
  const files = (await listFiles(dir)).filter((name) => name.startsWith('preview-') && name.endsWith('.wav'));
  if (files.length <= maxFiles) return 0;

  const stamped: StampedFile[] = [];
  for (const name of files) {
    stamped.push({ name, modifiedAt: await lastModifiedAt(`${dir}/${name}`) });
  }
  stamped.sort((a, b) => b.modifiedAt - a.modifiedAt);

  let removed = 0;
  for (const item of stamped.slice(maxFiles)) {
    try {
      await removeFile(`${dir}/${item.name}`);
      removed++;
    } catch (error) {
      logger.warn('quota', 'clean preview failed', error);
    }
  }
  return removed;
}

/**
 * 找出未被任何片段引用的素材文件（相对路径形式，docs/05 §5 清理策略③）。
 * 只返回确实存在的文件对应的素材 id。
 */
export async function findUnreferencedAssets(
  referencedAssetIds: ReadonlySet<string>,
  assets: readonly { id: string; path: string }[],
): Promise<Array<{ id: string; path: string }>> {
  const out: Array<{ id: string; path: string }> = [];
  for (const asset of assets) {
    if (referencedAssetIds.has(asset.id)) continue;
    if (await exists(`${paths.root()}/${asset.path}`)) out.push(asset);
  }
  return out;
}

/** 导入前的体积/时长预估（docs/02 §3 的内存与配额约束）。 */
export function estimateAssetBytes(seconds: number, sampleRate: number, channels: number): number {
  return Math.max(0, Math.round(seconds * sampleRate)) * channels * 2 + 44;
}

/** 该素材是否会导致存储配额吃紧（超过配额的一半时提示转单声道/降采样）。 */
export function wouldStrainQuota(estimatedBytes: number): boolean {
  return estimatedBytes > STORAGE_QUOTA_BYTES / 2;
}

/** 供 UI 显示的容量文案（不暴露内部路径）。 */
export function formatUsageRatio(usage: StorageUsage): string {
  return `${Math.round(usage.ratio * 100)}%`;
}

/** 简洁的一致性检查：EDL 引用的素材是否都还在磁盘上。 */
export async function missingAssetFiles(edl: Edl): Promise<string[]> {
  const missing: string[] = [];
  for (const asset of edl.assets) {
    if (!(await exists(`${paths.root()}/${asset.path}`))) missing.push(asset.id);
  }
  return missing;
}
