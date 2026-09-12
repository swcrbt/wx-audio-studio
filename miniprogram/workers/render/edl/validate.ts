/**
 * EDL 加载校验、自动修复与 schema 迁移。纯函数。
 *
 * 规则来源：docs/05 §8（版本迁移）与 §9（一致性要点）。原则：
 * - 校验失败**不抛错**：尽量修复并记录 `issue`，把选择权交回 UI；
 * - 读取时忽略未知字段（向前兼容），不因新版本写过的工程直接崩溃；
 * - schema 版本高于当前时不猜测，返回 `null` 让上层提示"工程版本过新"。
 *
 * 本文件承载 `CURRENT_SCHEMA_VERSION` 与迁移函数：它属于 EDL 逻辑，
 * 需要被主线程与 Worker 两侧共用（放这里可避免跨目录 require，见 ADR-0001）。
 */
import type {
  Asset,
  Clip,
  Edl,
  EffectInstance,
  ExportSettings,
  FadeSpec,
  Id,
  Project,
  Track,
} from '../../../core/types';

/** 当前工程结构版本（docs/05 §8）。结构变更时必须 +1 并补迁移函数与单测。 */
export const CURRENT_SCHEMA_VERSION = 1;

const VALID_SAMPLE_RATES = [16000, 22050, 44100] as const;

export type EdlIssueCode =
  | 'assetMissing'
  | 'rangeClamped'
  | 'negativeStart'
  | 'invalidSpeed'
  | 'duplicateClipId'
  | 'duplicateTrackId';

export interface EdlIssue {
  code: EdlIssueCode;
  detail: string;
  trackId?: Id;
  clipId?: Id;
}

export interface ValidateResult {
  edl: Edl;
  issues: EdlIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readFade(value: unknown): FadeSpec | null {
  if (!isRecord(value)) return null;
  const durationSec = num(value.durationSec, 0);
  if (!(durationSec > 0)) return null;
  const curve = value.curve === 'linear' ? 'linear' : 'equalPower';
  return { durationSec, curve };
}

function readEffects(value: unknown): EffectInstance[] {
  if (!Array.isArray(value)) return [];
  const out: EffectInstance[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) return;
    const params: Record<string, number | string | boolean> = {};
    if (isRecord(item.params)) {
      for (const [key, raw] of Object.entries(item.params)) {
        if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') {
          params[key] = raw;
        }
      }
    }
    out.push({
      id: str(item.id, `fx-${index}`),
      type: str(item.type, 'gain') as EffectInstance['type'],
      enabled: bool(item.enabled, true),
      params,
      ...(typeof item.presetName === 'string' ? { presetName: item.presetName } : {}),
    });
  });
  return out;
}

function readClip(value: unknown, index: number): Clip | null {
  if (!isRecord(value)) return null;
  const assetId = typeof value.assetId === 'string' ? value.assetId : '';
  if (!assetId) return null;
  const sourceStart = Math.max(0, num(value.sourceStart, 0));
  const sourceEnd = Math.max(sourceStart, num(value.sourceEnd, sourceStart));
  return {
    id: str(value.id, `clip-${index}`),
    assetId,
    sourceStart,
    sourceEnd,
    timelineStart: Math.max(0, num(value.timelineStart, 0)),
    gainDb: num(value.gainDb, 0),
    fadeIn: readFade(value.fadeIn),
    fadeOut: readFade(value.fadeOut),
    speed: num(value.speed, 1) > 0 ? num(value.speed, 1) : 1,
    loop: bool(value.loop, false),
    effects: readEffects(value.effects),
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
  };
}

function readTrack(value: unknown, index: number): Track | null {
  if (!isRecord(value)) return null;
  const clips: Clip[] = [];
  if (Array.isArray(value.clips)) {
    value.clips.forEach((item, clipIndex) => {
      const clip = readClip(item, clipIndex);
      if (clip) clips.push(clip);
    });
  }
  return {
    id: str(value.id, `track-${index}`),
    name: str(value.name, `轨道 ${index + 1}`),
    order: num(value.order, index),
    gainDb: num(value.gainDb, 0),
    pan: Math.max(-1, Math.min(1, num(value.pan, 0))),
    muted: bool(value.muted, false),
    solo: bool(value.solo, false),
    effects: readEffects(value.effects),
    clips,
  };
}

function readAsset(value: unknown, index: number): Asset | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  if (!id) return null;
  const path = str(value.path, `assets/${id}.wav`);
  const peakRefRaw = isRecord(value.peakRef) ? value.peakRef : {};
  const levels: Array<{ bucketSize: number; count: number }> = [];
  if (Array.isArray(peakRefRaw.levels)) {
    for (const item of peakRefRaw.levels) {
      if (!isRecord(item)) continue;
      levels.push({ bucketSize: num(item.bucketSize, 0), count: num(item.count, 0) });
    }
  }
  const sampleRate = num(value.sampleRate, 44100);
  const durationSec = Math.max(0, num(value.durationSec, 0));
  return {
    id,
    name: str(value.name, `素材 ${index + 1}`),
    origin: (value.origin === 'record' || value.origin === 'messageFile' || value.origin === 'local'
      ? value.origin
      : 'duplicate') as Asset['origin'],
    path,
    sampleRate,
    channels: value.channels === 2 ? 2 : 1,
    durationSec,
    frames: Math.max(0, Math.round(num(value.frames, durationSec * sampleRate))),
    bytes: Math.max(0, num(value.bytes, 0)),
    peakRef: { path: str(peakRefRaw.path, `peaks/${id}.pk`), levels },
    createdAt: num(value.createdAt, Date.now()),
  };
}

function readExportSettings(value: unknown): Partial<ExportSettings> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Partial<ExportSettings> = {};
  if (value.format === 'wav' || value.format === 'mp3') out.format = value.format;
  if (value.sampleRate === 16000 || value.sampleRate === 22050 || value.sampleRate === 44100) {
    out.sampleRate = value.sampleRate;
  }
  if (value.channels === 1 || value.channels === 2) out.channels = value.channels;
  return out;
}

/** V0 → V1：早期草案没有 `summary` 与 `peakRef`，补齐即可（docs/05 §8）。 */
function migrateV0toV1(doc: Record<string, unknown>): Record<string, unknown> {
  return { ...doc, schemaVersion: 1 };
}

/**
 * 把任意 JSON 强制成合法 `Project`。
 *
 * @returns 合法工程；结构不可用（非对象 / 版本过新 / 缺少 id）时返回 `null`
 */
export function migrateProject(raw: unknown): Project | null {
  if (!isRecord(raw)) return null;

  const version = num(raw.schemaVersion, 0);
  if (version > CURRENT_SCHEMA_VERSION) return null;

  const doc = version < 1 ? migrateV0toV1(raw) : raw;

  const id = typeof doc.id === 'string' ? doc.id : '';
  if (!id) return null;

  const sampleRateRaw = num(doc.sampleRate, 44100);
  const sampleRate = (VALID_SAMPLE_RATES as readonly number[]).includes(sampleRateRaw)
    ? (sampleRateRaw as Project['sampleRate'])
    : 44100;

  const assets: Asset[] = [];
  if (Array.isArray(doc.assets)) {
    doc.assets.forEach((item, index) => {
      const asset = readAsset(item, index);
      if (asset) assets.push(asset);
    });
  }

  const tracks: Track[] = [];
  if (Array.isArray(doc.tracks)) {
    doc.tracks.forEach((item, index) => {
      const track = readTrack(item, index);
      if (track) tracks.push(track);
    });
  }
  tracks.sort((a, b) => a.order - b.order);

  const summaryRaw = isRecord(doc.summary) ? doc.summary : {};
  const clipCount = tracks.reduce((sum, track) => sum + track.clips.length, 0);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    name: str(doc.name, '未命名工程'),
    createdAt: num(doc.createdAt, Date.now()),
    updatedAt: num(doc.updatedAt, Date.now()),
    sampleRate,
    channels: doc.channels === 2 ? 2 : 1,
    assets,
    tracks,
    summary: {
      durationSec: num(summaryRaw.durationSec, 0),
      assetCount: assets.length,
      clipCount,
      ...(typeof summaryRaw.thumbnailPeaksPath === 'string'
        ? { thumbnailPeaksPath: summaryRaw.thumbnailPeaksPath }
        : {}),
    },
    ...(readExportSettings(doc.exportDefaults)
      ? { exportDefaults: readExportSettings(doc.exportDefaults) }
      : {}),
  };
}

/**
 * 校验并修复 EDL（docs/05 §9）：
 * - 引用不存在素材的片段 → 移除并记 `assetMissing`
 * - 素材区间越界 / 起点为负 / `speed <= 0` → clamp 并记录
 * - 重复 id → 重新生成第二处 id 并记录
 * - 轨道内片段按 `timelineStart` 稳定排序
 */
export function validateEdl(edl: Edl): ValidateResult {
  const issues: EdlIssue[] = [];
  const assetMap = new Map(edl.assets.map((asset) => [asset.id, asset]));
  const seenTrackIds = new Set<Id>();
  const seenClipIds = new Set<Id>();

  const tracks = edl.tracks.map((track) => {
    let trackId = track.id;
    if (seenTrackIds.has(trackId)) {
      trackId = `${trackId}-dup${seenTrackIds.size}`;
      issues.push({ code: 'duplicateTrackId', detail: `轨道 id 重复，已重命名`, trackId: track.id });
    }
    seenTrackIds.add(trackId);

    const clips: Clip[] = [];
    for (const clip of track.clips) {
      const asset = assetMap.get(clip.assetId);
      if (!asset) {
        issues.push({
          code: 'assetMissing',
          detail: `片段引用的素材 ${clip.assetId} 不存在，已移除`,
          trackId,
          clipId: clip.id,
        });
        continue;
      }

      let clipId = clip.id;
      if (seenClipIds.has(clipId)) {
        clipId = `${clipId}-dup${seenClipIds.size}`;
        issues.push({ code: 'duplicateClipId', detail: '片段 id 重复，已重命名', trackId, clipId: clip.id });
      }
      seenClipIds.add(clipId);

      const maxEnd = Math.max(0, asset.durationSec);
      let sourceStart = clip.sourceStart;
      let sourceEnd = clip.sourceEnd;
      if (sourceStart < 0) {
        issues.push({ code: 'rangeClamped', detail: 'sourceStart < 0，已归零', trackId, clipId });
        sourceStart = 0;
      }
      if (sourceEnd > maxEnd) {
        issues.push({
          code: 'rangeClamped',
          detail: `sourceEnd 超出素材时长 ${maxEnd}s，已 clamp`,
          trackId,
          clipId,
        });
        sourceEnd = maxEnd;
      }
      if (sourceEnd <= sourceStart) {
        issues.push({ code: 'rangeClamped', detail: '素材区间为空，已按最小长度修正', trackId, clipId });
        sourceEnd = Math.min(maxEnd, sourceStart + 1 / edl.sampleRate);
      }

      let timelineStart = clip.timelineStart;
      if (timelineStart < 0) {
        issues.push({ code: 'negativeStart', detail: 'timelineStart < 0，已归零', trackId, clipId });
        timelineStart = 0;
      }

      let speed = clip.speed;
      if (!(speed > 0)) {
        issues.push({ code: 'invalidSpeed', detail: 'speed <= 0，已重置为 1', trackId, clipId });
        speed = 1;
      }

      clips.push({ ...clip, id: clipId, sourceStart, sourceEnd, timelineStart, speed });
    }

    clips.sort((a, b) => a.timelineStart - b.timelineStart);
    return { ...track, id: trackId, clips };
  });

  return { edl: { ...edl, tracks }, issues };
}
