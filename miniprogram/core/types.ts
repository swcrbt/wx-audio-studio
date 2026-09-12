/**
 * 全部数据模型类型。字段语义的唯一权威处：docs/05 §2（本文件是它的代码落地）。
 *
 * ⚠️ 本文件**只允许类型声明**，不得出现运行时代码：Worker 侧以 `import type`
 * 引用它（编译后消除，不产生跨目录 require，见 ADR-0001）。
 */

export type Id = string;
/** 时间一律用秒（float）；采样帧只出现在 DSP 与渲染内部（AGENTS §2.3）。 */
/** 时间量一律用秒（float）；采样帧只出现在 DSP 与渲染内部（AGENTS §2.3）。 */
export type Seconds = number;

/** 时间轴区间（秒），闭开区间 `[startSec, endSec)`。 */
export interface TimeRange {
  startSec: Seconds;
  endSec: Seconds;
}

export interface Project {
  schemaVersion: number;
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;

  /** 工程级音频参数：决定处理链，创建后不可改（除非重新导入全部素材）。 */
  sampleRate: 16000 | 22050 | 44100;
  channels: 1 | 2;

  assets: Asset[];
  tracks: Track[];

  summary: {
    durationSec: Seconds;
    assetCount: number;
    clipCount: number;
    thumbnailPeaksPath?: string;
  };

  exportDefaults?: Partial<ExportSettings>;
}

/** 渲染与编辑所需的 EDL 视图（Project 的子集，见 docs/03 §5.3）。 */
export type Edl = Pick<Project, 'sampleRate' | 'channels' | 'assets' | 'tracks'>;

export interface Asset {
  id: Id;
  name: string;
  origin: 'record' | 'messageFile' | 'local' | 'duplicate';
  /** 相对 USER_DATA_PATH 的中间格式路径：`assets/{id}.wav`。 */
  path: string;
  sampleRate: number;
  channels: 1 | 2;
  durationSec: Seconds;
  frames: number;
  bytes: number;
  peakRef: PeakRef;
  createdAt: number;
  /** 运行时计算，不落盘。 */
  refCount?: number;
}

export interface PeakRef {
  path: string;
  levels: Array<{ bucketSize: number; count: number }>;
}

export interface Track {
  id: Id;
  name: string;
  order: number;
  /** -60 .. +12，默认 0（dB）。 */
  gainDb: number;
  /** -1 .. 1，默认 0。 */
  pan: number;
  muted: boolean;
  solo: boolean;
  effects: EffectInstance[];
  clips: Clip[];
}

export interface Clip {
  id: Id;
  assetId: Id;

  /** 素材侧区间（秒）。 */
  sourceStart: Seconds;
  sourceEnd: Seconds;

  /** 时间轴侧起点（秒）；时长由推导：`(sourceEnd - sourceStart) / speed`。 */
  timelineStart: Seconds;

  gainDb: number;
  fadeIn: FadeSpec | null;
  fadeOut: FadeSpec | null;
  /** 1 = 原速；>1 变快（玩具级变速，音高随之改变）。 */
  speed: number;
  /** BGM 铺满用。 */
  loop: boolean;
  effects: EffectInstance[];
  label?: string;
}

export interface FadeSpec {
  durationSec: Seconds;
  curve: 'linear' | 'equalPower';
}

export interface EffectInstance {
  id: Id;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
  presetName?: string;
}

export type EffectType =
  | 'gain'
  | 'highpass'
  | 'eq10'
  | 'compressor'
  | 'noiseGate'
  | 'denoise'
  | 'echo'
  | 'reverb'
  | 'limiter'
  | 'normalize';

export interface ExportSettings {
  format: 'wav' | 'mp3';
  sampleRate: 16000 | 22050 | 44100;
  channels: 1 | 2;
  mp3Bitrate?: 128 | 192 | 320;
  normalize: boolean;
  limiter: boolean;
  /** 只导出选区。 */
  range?: { startSec: Seconds; endSec: Seconds } | null;
}

/** 命令模式撤销栈的条目（docs/05 §6）。 */
export interface Command {
  id: Id;
  label: string;
  at: number;
  /** 合并键，如 `gain:${clipId}`：相同键且在合并窗口内视为一次操作。 */
  coalesceKey?: string;
  apply(edl: Edl): void;
  invert(edl: Edl): void;
}
