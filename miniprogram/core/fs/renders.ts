/**
 * 成品文件（`renders/out-*.wav`）的扫描与解析。
 *
 * 文件名即元数据：`out-{projectId}-{yyyyMMddHHmmss}.wav`（命名规则见 docs/05 §4.2）。
 * 从文件名解析创建时间而不依赖 `stat` 的时间戳，是因为命名本身就带时间，
 * 且重命名/复制后仍然可解释。
 *
 * 成品**永不自动删除**（docs/05 §5 保护策略），清理只发生在用户明确操作时。
 */
import type { Id } from '../types';
import { paths } from './paths';
import { fileSize, listFiles, removeFile } from './io';
import { readWavMeta } from './wav-file';
import { logger } from '../../utils/logger';

/** 成品文件名规则：`out-{projectId}-{14 位时间戳}.wav`。 */
const OUTPUT_FILE_PATTERN = /^out-(.+)-(\d{14})\.wav$/;

export interface RenderFileInfo {
  fileName: string;
  filePath: string;
  /** 导出该成品的工程 id（工程可能已被删除）。 */
  projectId: Id | null;
  /** 创建时间（毫秒）；无法解析时为 0。 */
  createdAt: number;
  bytes: number;
  durationSec: number;
}

export function parseRenderFileName(name: string): { projectId: Id; stamp: string } | null {
  const matched = OUTPUT_FILE_PATTERN.exec(name);
  const projectId = matched?.[1];
  const stamp = matched?.[2];
  if (!projectId || !stamp) return null;
  return { projectId, stamp };
}

/** `yyyyMMddHHmmss` → 毫秒时间戳（本地时区）；非法输入返回 0。 */
export function parseStamp(stamp: string): number {
  if (!/^\d{14}$/.test(stamp)) return 0;
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(8, 10));
  const minute = Number(stamp.slice(10, 12));
  const second = Number(stamp.slice(12, 14));
  const date = new Date(year, month - 1, day, hour, minute, second);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * 扫描成品目录。
 *
 * 单个文件损坏（头不可读）不影响其它文件：记录时长 0 并继续（列表仍能显示与分享）。
 */
export async function listRenderFiles(): Promise<RenderFileInfo[]> {
  const root = paths.root();
  let names: string[] = [];
  try {
    names = await listFiles(`${root}/renders`);
  } catch (error) {
    logger.warn('renders', 'list renders failed', error);
    return [];
  }

  const files: RenderFileInfo[] = [];
  for (const name of names) {
    const parsed = parseRenderFileName(name);
    if (!parsed) continue;

    const filePath = paths.output(parsed.projectId, parsed.stamp);
    const bytes = await fileSize(filePath).catch(() => 0);
    const durationSec = await readWavMeta(filePath)
      .then((meta) => meta.frames / meta.sampleRate)
      .catch(() => 0);

    files.push({
      fileName: name,
      filePath,
      projectId: parsed.projectId,
      createdAt: parseStamp(parsed.stamp),
      bytes,
      durationSec,
    });
  }

  return files.sort((a, b) => b.createdAt - a.createdAt);
}

/** 删除一个成品（用户明确操作时才调用）。 */
export async function deleteRenderFile(fileName: string): Promise<void> {
  const parsed = parseRenderFileName(fileName);
  if (!parsed) throw new Error(`不是成品文件：${fileName}`);
  await removeFile(paths.output(parsed.projectId, parsed.stamp));
}
