/**
 * 基础库与设备能力探测（平台适配层）。
 *
 * 用到的接口与坑：
 * - 基础库版本：`wx.getAppBaseInfo().SDKVersion`（2.20.1 起；低版本降级 `wx.getSystemInfoSync`）
 * - 设备性能等级：`wx.getDeviceInfo().benchmarkLevel`（2.20.1 起，仅 Android；`-1` 表示未知）
 * - 基础库 3.4.5 起 `benchmarkLevel` 停止维护，官方改用 `wx.getDeviceBenchmarkInfo()`
 *   （额外返回 `modelLevel`：1 高档 / 2 中档 / 3 低档 / 0 未知）
 */
export type ProcessingSampleRate = 16000 | 22050 | 44100;

/** 最低基础库：`wx.createWebAudioContext` 从 2.19.0 起提供。 */
export const MIN_SDK_VERSION = '2.19.0';

/**
 * 低端机判定阈值。官方只说 benchmarkLevel 越高越好、移动端不超过 50，未给出档位映射，
 * 因此这里是经验阈值，需按实机表现校准。
 */
export const LOW_END_BENCHMARK_LEVEL = 10;

export interface Caps {
  sdkVersion: string;
  platform: string;
  /** Android 性能等级：-1 未知、>=1 性能值；iOS 无该字段。 */
  benchmarkLevel: number;
  /** 机型档位：1 高档 / 2 中档 / 3 低档 / 0 未知（基础库 3.4.5+ 才有）。 */
  modelLevel: number;
  isLowEnd: boolean;
  /** WebAudio 是否可用（基础库 >= 2.19.0）。 */
  hasWebAudio: boolean;
  /** 按设备能力选择的处理链采样率（docs/02 §6）。 */
  processingSampleRate: ProcessingSampleRate;
}

/**
 * 版本号比较（形如 `2.30.0`）。`a >= b` 返回 true；无法解析的段按 0 处理。
 */
export function isVersionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const y = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x > y;
  }
  return true;
}

interface RawDeviceInfo {
  platform?: string;
  benchmarkLevel?: number;
}

/**
 * 读取基础库版本与设备信息。旧基础库缺少相关接口，任何一步失败都降级为未知而不抛错。
 */
function readSystemInfo(): { sdkVersion: string; platform: string } & RawDeviceInfo {
  const out: { sdkVersion: string; platform: string } & RawDeviceInfo = {
    sdkVersion: '0.0.0',
    platform: 'unknown',
  };

  const baseInfo = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : undefined;
  if (baseInfo?.SDKVersion) {
    out.sdkVersion = baseInfo.SDKVersion;
  } else {
    const legacy = wx.getSystemInfoSync();
    out.sdkVersion = legacy.SDKVersion;
    out.platform = legacy.platform;
    if (typeof legacy.benchmarkLevel === 'number') out.benchmarkLevel = legacy.benchmarkLevel;
  }

  if (isVersionAtLeast(out.sdkVersion, '2.20.1')) {
    const device = wx.getDeviceInfo();
    out.platform = device.platform;
    if (typeof device.benchmarkLevel === 'number') out.benchmarkLevel = device.benchmarkLevel;
  }

  return out;
}

function deriveCaps(
  sdkVersion: string,
  platform: string,
  benchmarkLevel: number,
  modelLevel: number,
): Caps {
  const hasWebAudio = isVersionAtLeast(sdkVersion, MIN_SDK_VERSION);

  // 机型档位优先（3.4.5+）：3 为低档机；否则回退性能值阈值。
  const isLowEnd =
    modelLevel === 3 ||
    (modelLevel === 0 && benchmarkLevel >= 0 && benchmarkLevel < LOW_END_BENCHMARK_LEVEL);

  return {
    sdkVersion,
    platform,
    benchmarkLevel,
    modelLevel,
    isLowEnd,
    hasWebAudio,
    processingSampleRate: !hasWebAudio || isLowEnd ? 22050 : 44100,
  };
}

/** 探测一次设备能力（同步部分）。仅应在启动时调用，结果可缓存。 */
export function detectCaps(): Caps {
  const info = readSystemInfo();
  return deriveCaps(info.sdkVersion, info.platform, info.benchmarkLevel ?? -1, 0);
}

/**
 * 异步读取机型档位。`wx.getDeviceBenchmarkInfo` 官方只有回调式（基础库 3.4.5 起），
 * 不可用时 resolve `null`（不抛错，调用方自行回退到 `getDeviceInfo().benchmarkLevel`）。
 *
 * 为什么要单独异步取：官方声明 `getDeviceInfo().benchmarkLevel` **自基础库 3.4.5 起
 * *停止维护**（docs/02 §6 / S14）。
 */
export function fetchBenchmarkInfo(): Promise<{ benchmarkLevel: number; modelLevel: number } | null> {
  return new Promise((resolve) => {
    if (typeof wx.getDeviceBenchmarkInfo !== 'function') {
      resolve(null);
      return;
    }
    wx.getDeviceBenchmarkInfo({
      success: (res) =>
        resolve({ benchmarkLevel: res.benchmarkLevel, modelLevel: res.modelLevel }),
      fail: () => resolve(null),
    });
  });
}

/** 用异步拿到的机型档位重算能力（处理链采样率可能从 44.1k 降到 22.05k）。 */
export function applyBenchmarkInfo(
  caps: Caps,
  info: { benchmarkLevel: number; modelLevel: number },
): Caps {
  return deriveCaps(caps.sdkVersion, caps.platform, info.benchmarkLevel, info.modelLevel);
}
