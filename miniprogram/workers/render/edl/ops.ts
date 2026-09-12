/**
 * EDL 变更的**唯一入口**（AGENTS §1）。
 *
 * 设计约定：
 * 1. 全部为**纯函数**：接收 EDL 返回新的 EDL，绝不就地修改调用方的对象；
 * 2. 所有写入 `timelineStart` / 素材区间的路径都在这里做 **clamp + 帧对齐 + 排序**
 *    （docs/05 §9），避免 UI 层直接改 EDL 造成越界与重叠错误；
 * 3. 时间参数一律为秒；帧对齐用显式 `Math.round(t * sampleRate)`（AGENTS §2.3）。
 *
 * 不变量（由 `validate.ts` 复核）：
 * - `sourceStart < sourceEnd` 且落在素材时长内
 * - `timelineStart >= 0`、`speed > 0`
 * - 同一轨道的片段**允许重叠**（用于交叉淡化，docs/03 §5.3），但按 `timelineStart` 升序存放
 */
import type { Asset, Clip, Edl, FadeSpec, Id, Seconds, Track } from '../../../core/types';
import { clipDurationSec, clipEndSec, isTrackAudible, trackById, trackDurationSec } from './query';

/** 时间轴网格步长（吸附用，docs/01 ED-10：0.1s 网格）。 */
export const SNAP_GRID_SEC = 0.1;

export interface TimeRange {
  startSec: Seconds;
  endSec: Seconds;
}

/** 把秒对齐到采样帧边界：`round(t × sampleRate) / sampleRate`（docs/05 §9）。 */
export function frameAlignSec(sec: Seconds, sampleRate: number): Seconds {
  if (!Number.isFinite(sec) || !(sampleRate > 0)) return 0;
  return Math.round(sec * sampleRate) / sampleRate;
}

/** 深拷贝一个片段（避免跨 EDL 共享可变对象）。 */
function cloneClip(clip: Clip): Clip {
  return {
    ...clip,
    fadeIn: clip.fadeIn ? { ...clip.fadeIn } : null,
    fadeOut: clip.fadeOut ? { ...clip.fadeOut } : null,
    effects: clip.effects.map((effect) => ({ ...effect, params: { ...effect.params } })),
  };
}

function cloneTrack(track: Track): Track {
  return {
    ...track,
    effects: track.effects.map((effect) => ({ ...effect, params: { ...effect.params } })),
    clips: track.clips.map(cloneClip),
  };
}

/** 浅拷贝 EDL 骨架（tracks/assets 数组是新数组，元素按需拷贝）。 */
export function cloneEdl(edl: Edl): Edl {
  return {
    sampleRate: edl.sampleRate,
    channels: edl.channels,
    assets: edl.assets.map((asset) => ({ ...asset, peakRef: { ...asset.peakRef, levels: [...asset.peakRef.levels] } })),
    tracks: edl.tracks.map(cloneTrack),
  };
}

export function createEmptyEdl(sampleRate: 16000 | 22050 | 44100, channels: 1 | 2): Edl {
  return { sampleRate, channels, assets: [], tracks: [] };
}

export function createTrack(opts: { id: Id; name: string; order: number }): Track {
  return {
    id: opts.id,
    name: opts.name,
    order: opts.order,
    gainDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    effects: [],
    clips: [],
  };
}

/** 把素材区间 clamp 到素材范围内，并保证 `sourceStart < sourceEnd`。 */
function normalizeClipRange(clip: Clip, asset: Asset | undefined): Clip {
  const limit = asset ? asset.durationSec : clip.sourceEnd;
  const maxEnd = Math.max(0, limit);
  let start = Number.isFinite(clip.sourceStart) ? Math.max(0, clip.sourceStart) : 0;
  let end = Number.isFinite(clip.sourceEnd) ? Math.min(maxEnd, clip.sourceEnd) : maxEnd;
  if (!(end > start)) {
    // 退化区间：至少保留 1 个采样帧（由调用方负责给出有意义的输入）
    end = Math.min(maxEnd, start);
    start = Math.max(0, end - 1 / 44100);
  }
  return {
    ...clip,
    sourceStart: start,
    sourceEnd: end,
    speed: clip.speed > 0 ? clip.speed : 1,
    timelineStart: Math.max(0, Number.isFinite(clip.timelineStart) ? clip.timelineStart : 0),
  };
}

function replaceTrack(edl: Edl, trackId: Id, update: (track: Track) => Track): Edl {
  const next = cloneEdl(edl);
  const index = next.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) return edl;
  const current = next.tracks[index];
  if (!current) return edl;
  next.tracks[index] = update(current);
  return next;
}

/** 素材列表（只增不改不删，docs/05 §1）：已存在同 id 时覆盖元信息。 */
export function upsertAsset(edl: Edl, asset: Asset): Edl {
  const next = cloneEdl(edl);
  const index = next.assets.findIndex((item) => item.id === asset.id);
  if (index >= 0) next.assets[index] = { ...asset };
  else next.assets.push({ ...asset });
  return next;
}

export function removeAsset(edl: Edl, assetId: Id): Edl {
  const next = cloneEdl(edl);
  next.assets = next.assets.filter((asset) => asset.id !== assetId);
  return next;
}

export function addTrack(edl: Edl, track: Track): Edl {
  const next = cloneEdl(edl);
  next.tracks.push(cloneTrack(track));
  next.tracks.sort((a, b) => a.order - b.order);
  return next;
}

export function removeTrack(edl: Edl, trackId: Id): Edl {
  const next = cloneEdl(edl);
  next.tracks = next.tracks.filter((track) => track.id !== trackId);
  return next;
}

export interface TrackPatch {
  name?: string;
  order?: number;
  gainDb?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
}

export function updateTrack(edl: Edl, trackId: Id, patch: TrackPatch): Edl {
  return replaceTrack(edl, trackId, (track) => {
    const next: Track = { ...track, ...patch };
    next.gainDb = Number.isFinite(next.gainDb) ? next.gainDb : track.gainDb;
    next.pan = Number.isFinite(next.pan) ? Math.max(-1, Math.min(1, next.pan)) : track.pan;
    return next;
  });
}

/** 在轨道内加入片段：区间 clamp、帧对齐、按 timelineStart 排序。 */
export function addClip(edl: Edl, trackId: Id, clip: Clip): Edl {
  const asset = edl.assets.find((item) => item.id === clip.assetId);
  return replaceTrack(edl, trackId, (track) => {
    const normalized = normalizeClipRange(cloneClip(clip), asset);
    normalized.timelineStart = frameAlignSec(normalized.timelineStart, edl.sampleRate);
    const clips = [...track.clips, normalized].sort((a, b) => a.timelineStart - b.timelineStart);
    return { ...track, clips };
  });
}

export function removeClip(edl: Edl, trackId: Id, clipId: Id): Edl {
  return replaceTrack(edl, trackId, (track) => ({
    ...track,
    clips: track.clips.filter((clip) => clip.id !== clipId),
  }));
}

export interface ClipPatch {
  gainDb?: number;
  fadeIn?: FadeSpec | null;
  fadeOut?: FadeSpec | null;
  speed?: number;
  loop?: boolean;
  label?: string;
  sourceStart?: Seconds;
  sourceEnd?: Seconds;
  timelineStart?: Seconds;
}

/** 局部更新片段；区间类字段会被重新 clamp、时间轴起点会帧对齐并重排。 */
export function updateClip(edl: Edl, trackId: Id, clipId: Id, patch: ClipPatch): Edl {
  const asset = edl.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId);
  const assetMeta = asset ? edl.assets.find((item) => item.id === asset.assetId) : undefined;

  return replaceTrack(edl, trackId, (track) => {
    const clips = track.clips.map((clip) => {
      if (clip.id !== clipId) return clip;
      const merged: Clip = { ...clip, ...patch };
      const normalized = normalizeClipRange(merged, assetMeta);
      normalized.timelineStart = frameAlignSec(normalized.timelineStart, edl.sampleRate);
      return normalized;
    });
    clips.sort((a, b) => a.timelineStart - b.timelineStart);
    return { ...track, clips };
  });
}

/** 移动片段到新的时间轴位置（帧对齐，clamp 到 ≥ 0）。 */
export function moveClip(edl: Edl, trackId: Id, clipId: Id, timelineStart: Seconds): Edl {
  const aligned = Math.max(0, frameAlignSec(timelineStart, edl.sampleRate));
  return updateClip(edl, trackId, clipId, { timelineStart: aligned });
}

/** 吸附到网格与给定候选边界（docs/01 ED-10 / MX-9）。 */
export function snapSec(value: Seconds, candidates: readonly Seconds[], toleranceSec = 0.08): Seconds {
  let best = value;
  let bestDistance = toleranceSec;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const grid = Math.round(value / SNAP_GRID_SEC) * SNAP_GRID_SEC;
  if (Math.abs(grid - value) <= bestDistance) return grid;
  return best;
}

/**
 * 在时间轴位置 `atSec` 处把片段切成两段（ED-7）。
 * 切点会被 clamp 到片段开区间内；无效切点返回原 EDL。
 *
 * @param newClipId 第二段的 id（由调用方生成，便于命令模式做逆操作）
 */
export function splitClipAt(
  edl: Edl,
  trackId: Id,
  clipId: Id,
  atSec: Seconds,
  newClipId: Id,
): Edl {
  const track = trackById(edl, trackId);
  const clip = track?.clips.find((item) => item.id === clipId);
  if (!track || !clip) return edl;

  const start = clip.timelineStart;
  const end = clipEndSec(clip);
  const at = frameAlignSec(atSec, edl.sampleRate);
  if (!(at > start) || !(at < end)) return edl;

  const offsetSec = at - start; // 时间轴上的相对位置
  const sourceSplit = clip.loop
    ? clip.sourceStart + (((offsetSec * clip.speed) % (clip.sourceEnd - clip.sourceStart)) + (clip.sourceEnd - clip.sourceStart)) % (clip.sourceEnd - clip.sourceStart)
    : clip.sourceStart + offsetSec * clip.speed;

  const left: Clip = { ...cloneClip(clip), sourceEnd: sourceSplit, fadeOut: null };
  const right: Clip = {
    ...cloneClip(clip),
    id: newClipId,
    sourceStart: sourceSplit,
    timelineStart: at,
    fadeIn: null,
  };

  return replaceTrack(edl, trackId, (current) => {
    const clips = current.clips
      .filter((item) => item.id !== clipId)
      .concat([left, right])
      .sort((a, b) => a.timelineStart - b.timelineStart);
    return { ...current, clips };
  });
}

/** 把片段在时间轴上的区间切掉 `[fromSec, toSec)`，返回保留的片段（可能 0/1/2 段）。 */
function cutClipByRange(clip: Clip, range: TimeRange, idFactory: () => Id): Clip[] {
  const start = clip.timelineStart;
  const end = clipEndSec(clip);

  // 不相交
  if (end <= range.startSec || start >= range.endSec) return [clip];

  // 循环片段（BGM 铺满）：M1 不做区间切分，相交即整体处理，避免取模映射带来的语义歧义
  if (clip.loop) return [];

  const keepLeft = start < range.startSec;
  const keepRight = end > range.endSec;
  const out: Clip[] = [];

  if (keepLeft) {
    const cutAt = range.startSec;
    const sourceCut = clip.sourceStart + (cutAt - start) * clip.speed;
    out.push({ ...cloneClip(clip), sourceEnd: Math.min(clip.sourceEnd, sourceCut) });
  }
  if (keepRight) {
    const cutAt = range.endSec;
    const sourceCut = clip.sourceStart + (cutAt - start) * clip.speed;
    out.push({
      ...cloneClip(clip),
      id: keepLeft ? idFactory() : clip.id,
      sourceStart: Math.max(clip.sourceStart, sourceCut),
      timelineStart: cutAt,
    });
  }
  return out;
}

export interface DeleteRangeOptions {
  /** true = 波纹删除（后续片段前移，ED-6）；false = 静音（保留时间轴长度，ED-9）。 */
  ripple: boolean;
}

/**
 * 删除时间轴区间 `[startSec, endSec)`（ED-6 波纹删除 / ED-9 静音）。
 *
 * @returns 新的 EDL；`ripple=false` 时后续片段位置不变（等于把该区间置为静音）
 */
export function deleteRange(
  edl: Edl,
  range: TimeRange,
  options: DeleteRangeOptions,
  idFactory: () => Id,
): Edl {
  const from = frameAlignSec(Math.max(0, Math.min(range.startSec, range.endSec)), edl.sampleRate);
  const to = frameAlignSec(Math.max(range.startSec, range.endSec), edl.sampleRate);
  if (!(to > from)) return edl;
  const span = to - from;

  const next = cloneEdl(edl);
  next.tracks = next.tracks.map((track) => {
    const clipped: Clip[] = [];
    for (const clip of track.clips) {
      clipped.push(...cutClipByRange(clip, { startSec: from, endSec: to }, idFactory));
    }
    const shifted = options.ripple
      ? clipped.map((clip) =>
          clip.timelineStart >= to
            ? { ...clip, timelineStart: frameAlignSec(clip.timelineStart - span, edl.sampleRate) }
            : clip,
        )
      : clipped;
    shifted.sort((a, b) => a.timelineStart - b.timelineStart);
    return { ...track, clips: shifted };
  });
  return next;
}

/** 只保留时间轴区间 `[startSec, endSec)`（ED-5 裁剪到选区）。 */
export function trimToRange(edl: Edl, range: TimeRange, idFactory: () => Id): Edl {
  const from = frameAlignSec(Math.max(0, Math.min(range.startSec, range.endSec)), edl.sampleRate);
  const to = frameAlignSec(Math.max(range.startSec, range.endSec), edl.sampleRate);
  if (!(to > from)) return edl;

  const next = cloneEdl(edl);
  next.tracks = next.tracks.map((track) => {
    const kept: Clip[] = [];
    for (const clip of track.clips) {
      const start = clip.timelineStart;
      const end = clipEndSec(clip);
      if (end <= from || start >= to) continue;

      if (clip.loop) {
        // 循环片段整体保留（M1 不做区间切分），仅平移起点
        kept.push({ ...clip, timelineStart: Math.max(0, start - from) });
        continue;
      }

      const sourceStart = clip.sourceStart + Math.max(0, from - start) * clip.speed;
      const sourceEnd = clip.sourceStart + Math.min(clipDurationSec(clip), to - start) * clip.speed;
      const startsBefore = start < from;
      kept.push({
        ...cloneClip(clip),
        id: startsBefore ? idFactory() : clip.id,
        sourceStart: Math.max(clip.sourceStart, sourceStart),
        sourceEnd: Math.min(clip.sourceEnd, sourceEnd),
        timelineStart: Math.max(0, start - from),
        fadeIn: startsBefore ? null : clip.fadeIn,
      });
    }
    kept.sort((a, b) => a.timelineStart - b.timelineStart);
    return { ...track, clips: kept };
  });
  return next;
}

/** 片段增益（FX-1）：-60 ～ +12 dB，超出被 clamp。 */
export function setClipGainDb(edl: Edl, trackId: Id, clipId: Id, gainDb: number): Edl {
  const clamped = Number.isFinite(gainDb) ? Math.max(-60, Math.min(12, gainDb)) : 0;
  return updateClip(edl, trackId, clipId, { gainDb: clamped });
}

/** 片段淡入/淡出（ED-11）：`null` 表示取消。 */
export function setClipFade(
  edl: Edl,
  trackId: Id,
  clipId: Id,
  side: 'in' | 'out',
  fade: FadeSpec | null,
): Edl {
  const sampleRate = edl.sampleRate;
  let normalized: FadeSpec | null = null;
  if (fade && fade.durationSec > 0) {
    const maxSec = (() => {
      const track = trackById(edl, trackId);
      const clip = track?.clips.find((item) => item.id === clipId);
      return clip ? clipDurationSec(clip) : 0;
    })();
    const durationSec = frameAlignSec(Math.min(fade.durationSec, maxSec), sampleRate);
    if (durationSec > 0) normalized = { durationSec, curve: fade.curve };
  }
  return updateClip(edl, trackId, clipId, side === 'in' ? { fadeIn: normalized } : { fadeOut: normalized });
}

/** 轨道时长（供 UI 显示与 BGM 铺满计算使用）。 */
export function trackDuration(edl: Edl, trackId: Id): Seconds {
  const track = trackById(edl, trackId);
  return track ? trackDurationSec(track) : 0;
}

/** 该轨道是否参与渲染（供控制器过滤可听轨道用）。 */
export function isAudible(edl: Edl, trackId: Id): boolean {
  const track = trackById(edl, trackId);
  return track ? isTrackAudible(edl, track) : false;
}
