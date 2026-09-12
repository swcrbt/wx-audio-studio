/**
 * 展示格式化工具：时间、体积、dB。纯函数，无平台依赖。
 * 单位后缀规范见 AGENTS §2.3。
 */

/** 秒 → `mm:ss.mmm`（用于时间输入与标尺提示）。 */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00.000';
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/** 秒 → `mm:ss`（用于列表、进度等粗粒度展示）。 */
export function formatDurationShort(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const totalSec = Math.round(sec);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(totalSec / 60))}:${pad(totalSec % 60)}`;
}

/** 字节 → 人类可读体积（1 位小数）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** 线性增益 → dB 字符串（如 `-3.0 dB`）；0 增益显示为 `-∞ dB`。 */
export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '—';
  if (db <= -60) return '-∞ dB';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}
