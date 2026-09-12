/**
 * EDL 查询：时长推导、可听性判定与区间相交。纯函数。
 *
 * 约定：EDL 中的时间一律为秒（float），帧换算只在显式处做。
 */
import type { Asset, Clip, Edl, Id, Seconds, Track } from '../../../core/types';

export function assetById(edl: Edl, assetId: Id): Asset | undefined {
  return edl.assets.find((asset) => asset.id === assetId);
}

export function trackById(edl: Edl, trackId: Id): Track | undefined {
  return edl.tracks.find((track) => track.id === trackId);
}

export function clipById(edl: Edl, trackId: Id, clipId: Id): Clip | undefined {
  return trackById(edl, trackId)?.clips.find((clip) => clip.id === clipId);
}

/** 片段引用的素材跨度（秒，未考虑变速）。 */
export function clipSourceSpanSec(clip: Clip): Seconds {
  return Math.max(0, clip.sourceEnd - clip.sourceStart);
}

/** 片段在时间轴上的时长（秒）：`素材跨度 / speed`。 */
export function clipDurationSec(clip: Clip): Seconds {
  const speed = clip.speed > 0 ? clip.speed : 1;
  return clipSourceSpanSec(clip) / speed;
}

export function clipEndSec(clip: Clip): Seconds {
  return clip.timelineStart + clipDurationSec(clip);
}

export function trackDurationSec(track: Track): Seconds {
  let max = 0;
  for (const clip of track.clips) {
    const end = clipEndSec(clip);
    if (end > max) max = end;
  }
  return max;
}

/** 工程时长：所有轨道时长的最大值（docs/05 §1：时长由 tracks 推导，不冗余存储）。 */
export function edlDurationSec(edl: Edl): Seconds {
  let max = 0;
  for (const track of edl.tracks) {
    const end = trackDurationSec(track);
    if (end > max) max = end;
  }
  return max;
}

/** 是否存在独奏轨道（solo 优先于静音）。 */
export function hasSolo(edl: Edl): boolean {
  return edl.tracks.some((track) => track.solo);
}

/**
 * 轨道是否可听：未静音，且当存在 solo 时自身必须 solo。
 */
export function isTrackAudible(edl: Edl, track: Track): boolean {
  if (track.muted) return false;
  return hasSolo(edl) ? track.solo : true;
}

/** 按 `order` 升序返回轨道（不修改原数组）。 */
export function tracksByOrder(edl: Edl): Track[] {
  return [...edl.tracks].sort((a, b) => a.order - b.order);
}

/** 返回与 `[startSec, endSec)` 相交的片段（按 timelineStart 升序）。 */
export function clipsInRange(track: Track, startSec: Seconds, endSec: Seconds): Clip[] {
  if (!(endSec > startSec)) return [];
  return track.clips
    .filter((clip) => clip.timelineStart < endSec && clipEndSec(clip) > startSec)
    .sort((a, b) => a.timelineStart - b.timelineStart);
}

/** 指定时间轴位置命中的片段（取最靠前者；重叠时取 timelineStart 最大者）。 */
export function clipAt(track: Track, timelineSec: Seconds): Clip | undefined {
  let hit: Clip | undefined;
  for (const clip of track.clips) {
    if (clip.timelineStart <= timelineSec && clipEndSec(clip) > timelineSec) {
      if (!hit || clip.timelineStart > hit.timelineStart) hit = clip;
    }
  }
  return hit;
}

/**
 * 由时间轴位置求片段内的素材时间（秒）。
 * `loop` 片段按素材跨度取模。
 */
export function sourceTimeAt(clip: Clip, timelineSec: Seconds): Seconds {
  const span = clipSourceSpanSec(clip);
  const speed = clip.speed > 0 ? clip.speed : 1;
  if (span === 0) return clip.sourceStart;
  const delta = (timelineSec - clip.timelineStart) * speed;
  if (!clip.loop) return clip.sourceStart + delta;
  const wrapped = ((delta % span) + span) % span;
  return clip.sourceStart + wrapped;
}

export function countClips(edl: Edl): number {
  let total = 0;
  for (const track of edl.tracks) total += track.clips.length;
  return total;
}

/** 被任何片段引用的素材 id 集合（用于清理未引用素材）。 */
export function referencedAssetIds(edl: Edl): Set<Id> {
  const ids = new Set<Id>();
  for (const track of edl.tracks) {
    for (const clip of track.clips) ids.add(clip.assetId);
  }
  return ids;
}
