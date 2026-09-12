/**
 * Spike 结果的环境信息与文本导出（仅 M0 使用）。
 *
 * 导出的文本是回填 docs/02 §5 的输入：每项一行结论，含设备与版本，便于直接粘贴。
 */
import type { SpikeResult } from './types';

/** 设备环境行：型号 / 系统 / 微信版本 / 基础库版本 / 机型档位。 */
export function deviceEnvLine(): string {
  try {
    const app = wx.getAppBaseInfo();
    const device = wx.getDeviceInfo();
    const benchmark =
      typeof device.benchmarkLevel === 'number' ? `benchmark=${device.benchmarkLevel}` : 'benchmark=未知';
    return [
      `${device.brand ?? '?'} ${device.model ?? '?'}`,
      device.system ?? '?',
      `微信 ${app.version ?? '?'}`,
      `基础库 ${app.SDKVersion ?? '?'}`,
      device.platform ?? '?',
      benchmark,
    ].join(' / ');
  } catch (error) {
    return `环境信息读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 单条结果 → 可复制文本。 */
export function formatResult(result: SpikeResult): string {
  const lines = [`${result.id} | ${result.env}`];
  for (const line of result.lines) {
    const mark = line.ok === undefined ? ' ' : line.ok ? '✓' : '✗';
    lines.push(`  ${mark} ${line.label}: ${line.value}`);
  }
  lines.push(`  结论: ${result.conclusion}`);
  return lines.join('\n');
}

/** 全部结果 → 可复制文本。 */
export function formatAll(results: readonly SpikeResult[]): string {
  if (results.length === 0) return '（还没有结果）';
  const header = `M0 Spike 结果 · ${deviceEnvLine()}`;
  return [header, '', ...results.map((result) => formatResult(result))].join('\n');
}
