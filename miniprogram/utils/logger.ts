/**
 * 统一日志出口：禁止裸 `console.log` 入库；日志不得包含音频内容、完整文件路径
 * 或任何可识别信息。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let debugEnabled = false;

/** 打开/关闭 debug 级输出（生产环境应关闭）。 */
export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

function emit(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  if (level === 'debug' && !debugEnabled) return;
  const line = `[${level}][${scope}] ${message}`;
  const sink = console as unknown as Record<string, ((...args: unknown[]) => void) | undefined>;
  const fn = sink[level];
  if (typeof fn === 'function') {
    if (detail === undefined) fn(line);
    else fn(line, detail);
  }
}

export interface Logger {
  debug(scope: string, message: string, detail?: unknown): void;
  info(scope: string, message: string, detail?: unknown): void;
  warn(scope: string, message: string, detail?: unknown): void;
  error(scope: string, message: string, detail?: unknown): void;
}

export const logger: Logger = {
  debug: (scope, message, detail) => emit('debug', scope, message, detail),
  info: (scope, message, detail) => emit('info', scope, message, detail),
  warn: (scope, message, detail) => emit('warn', scope, message, detail),
  error: (scope, message, detail) => emit('error', scope, message, detail),
};
