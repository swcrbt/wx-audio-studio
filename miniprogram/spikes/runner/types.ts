/**
 * M0 Spike 的类型定义（仅 M0 使用，随 `spikes/` 一起删除）。
 */
export interface SpikeLine {
  label: string;
  value: string;
  /** 该项是否符合通过标准；无法判定时留空。 */
  ok?: boolean;
}

export interface SpikeResult {
  id: string;
  title: string;
  /** 设备环境行（由 report.ts 自动填充）。 */
  env: string;
  lines: SpikeLine[];
  conclusion: string;
  failed?: boolean;
}

export interface SpikeCase {
  id: string;
  title: string;
  /** 通过标准。 */
  criteria: string;
  /** 该实验阻塞的功能。 */
  blocks: string;
  /** 是否必须真机（开发者工具上跑不出有效结论）。 */
  needsDevice: boolean;
  run: (log: (message: string) => void) => Promise<SpikeResult>;
}

/** 从微信 API 错误对象里取一句可读描述。 */
export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const typed = error as { errMsg?: string; errno?: number; message?: string; name?: string };
    const parts = [
      typed.errMsg ?? typed.message ?? typed.name ?? 'unknown',
      typeof typed.errno === 'number' ? `errno=${typed.errno}` : '',
    ].filter((part) => part.length > 0);
    return parts.join(' ');
  }
  return String(error);
}

/** 从路径里取扩展名（不记录完整文件名，避免回传时带上无关信息）。 */
export function extensionOf(filePath: string): string {
  const name = filePath.split('/').pop() ?? '';
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '(无扩展名)';
}

/** 字节数 → 人类可读。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}
