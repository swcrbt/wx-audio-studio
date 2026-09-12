/**
 * 文件系统通用操作封装（平台适配层）。所有路径都必须由 `fs/paths.ts` 构造。
 *
 * `rename` 官方支持本地路径且可移动文件，因此 `writeJsonAtomic` 用
 * “先写 `.tmp` 再 rename”实现原子保存。
 */
import { FsError, describeFsError } from './errors';

function getFs(): WechatMiniprogram.FileSystemManager {
  return wx.getFileSystemManager();
}

/** 递归创建目录（已存在时不报错）。 */
export async function ensureDir(dirPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    getFs().mkdir({
      dirPath,
      recursive: true,
      success: () => resolve(),
      fail: () => resolve(), // 已存在等情况下也视为成功
    });
  });
}

/** 批量确保目录存在。 */
export async function ensureDirs(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    await ensureDir(dir);
  }
}

/** 文件/目录是否存在。 */
export function exists(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    getFs().access({
      path: filePath,
      success: () => resolve(true),
      fail: () => resolve(false),
    });
  });
}

/** 列出目录下的文件名（目录不存在时返回空数组）。 */
export function listFiles(dirPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    getFs().readdir({
      dirPath,
      success: (res) => resolve(res.files ?? []),
      fail: (err) => {
        const info = describeFsError(err);
        if (info.code === 'notFound') resolve([]);
        else reject(new FsError(info));
      },
    });
  });
}

/** 删除文件（不存在时视为成功）。 */
export function removeFile(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    getFs().unlink({
      filePath,
      success: () => resolve(),
      fail: (err) => {
        const info = describeFsError(err);
        if (info.code === 'notFound') resolve();
        else reject(new FsError(info));
      },
    });
  });
}

/** 读取整个文件为 ArrayBuffer（素材导入的第一步）。 */
export function readArrayBuffer(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    getFs().readFile({
      filePath,
      success: (res) => resolve(res.data as ArrayBuffer),
      fail: (err) => reject(new FsError(describeFsError(err))),
    });
  });
}

/** 写入二进制数据（峰值文件、分割后的素材等）。 */
export function writeArrayBuffer(filePath: string, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    getFs().writeFile({
      filePath,
      data,
      success: () => resolve(),
      fail: (err) => reject(new FsError(describeFsError(err, data.byteLength))),
    });
  });
}

/** 读取 UTF-8 文本。 */
export function readText(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    getFs().readFile({
      filePath,
      encoding: 'utf8',
      success: (res) => resolve(String(res.data)),
      fail: (err) => reject(new FsError(describeFsError(err))),
    });
  });
}

/** 读取 JSON；文件不存在或内容损坏时返回 `null`（由调用方决定重建）。 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const text = await readText(filePath);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 写 UTF-8 文本（直接覆盖）。 */
export function writeText(filePath: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    getFs().writeFile({
      filePath,
      data,
      encoding: 'utf8',
      success: () => resolve(),
      fail: (err) => reject(new FsError(describeFsError(err, data.length))),
    });
  });
}

/**
 * 原子写 JSON：先写 `{filePath}.tmp`，成功后 `rename` 覆盖正式文件（docs/05 §7）。
 * rename 失败时回退为"直接写正式文件"，保证数据仍能落盘。
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data);
  const tmpPath = `${filePath}.tmp`;
  await writeText(tmpPath, text);

  try {
    await new Promise<void>((resolve, reject) => {
      getFs().rename({
        oldPath: tmpPath,
        newPath: filePath,
        success: () => resolve(),
        fail: (err) => reject(new FsError(describeFsError(err))),
      });
    });
  } catch {
    await writeText(filePath, text);
    await removeFile(tmpPath).catch(() => undefined);
  }
}

/** 文件字节数（不存在返回 0）。 */
export function fileSize(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    getFs().stat({
      path: filePath,
      success: (res) => {
        const stats = Array.isArray(res.stats) ? res.stats[0] : res.stats;
        const size = (stats as { size?: unknown } | undefined)?.size;
        resolve(typeof size === 'number' ? size : 0);
      },
      fail: () => resolve(0),
    });
  });
}
