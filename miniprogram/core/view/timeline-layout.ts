/**
 * 时间轴布局：把 EDL 转成可直接渲染的「轨道 → 片段」几何。
 *
 * 纯计算（只有时间↔像素换算与可见性判断），因此可以单测；页面与组件只负责把
 * 结果摆到屏幕上、把手势映射成命令，不再自己算位置。
 */
import type { Clip, Edl, Id, Px, Seconds } from '../types';
import { clipDurationSec, isTrackAudible, tracksByOrder } from '../../workers/render/edl/query';
import { timeToX, visibleRange, type Viewport } from './viewport';

export interface ClipLayout {
  clipId: Id;
  /** 时间轴位置与宽度（相对轨道左边缘的逻辑像素，可为负）。 */
  leftPx: Px;
  widthPx: Px;
  /** 与当前视口是否有交集（`false` 时 UI 可跳过渲染）。 */
  visible: boolean;
  timelineStartSec: Seconds;
  durationSec: Seconds;
  label: string;
  gainDb: number;
  /** 静音表现为增益已到底。 */
  muted: boolean;
  fadeInSec: Seconds;
  fadeOutSec: Seconds;
  /** 淡入/淡出的像素宽度（斜角标记的宽度）。 */
  fadeInPx: Px;
  fadeOutPx: Px;
  isLoop: boolean;
  /** 引用的素材是否还在（缺失时 UI 应提示重新导入）。 */
  assetPresent: boolean;
}

export interface TrackLayout {
  trackId: Id;
  name: string;
  gainDb: number;
  muted: boolean;
  solo: boolean;
  /** 按当前 solo/mute 状态是否会被听见。 */
  audible: boolean;
  clipCount: number;
  /** 轨道最右端（秒），用于时间轴总长与"追加到末尾"判断。 */
  endSec: Seconds;
  clips: ClipLayout[];
}

/** 增益低到该值即视为静音（与 `MIN_GAIN_DB` 一致）。 */
const MUTE_GAIN_DB = -60;

export interface LayoutOptions {
  /** 片段标签（默认用素材名，找不到则用"片段"）。 */
  labelOf?: (clip: Clip, edl: Edl) => string;
}

export function layoutTimeline(edl: Edl, viewport: Viewport, options: LayoutOptions = {}): TrackLayout[] {
  return tracksByOrder(edl).map((track) => {
    const clips: ClipLayout[] = track.clips.map((clip) => {
      const durationSec = clipDurationSec(clip);
      const asset = edl.assets.find((item) => item.id === clip.assetId);
      const label = options.labelOf
        ? options.labelOf(clip, edl)
        : (asset?.name ?? '片段');

      return {
        clipId: clip.id,
        leftPx: timeToX(viewport, clip.timelineStart),
        widthPx: Math.max(1, durationSec * viewport.pxPerSecond),
        visible: true,
        timelineStartSec: clip.timelineStart,
        durationSec,
        label,
        gainDb: clip.gainDb,
        muted: clip.gainDb <= MUTE_GAIN_DB,
        fadeInSec: clip.fadeIn?.durationSec ?? 0,
        fadeOutSec: clip.fadeOut?.durationSec ?? 0,
        fadeInPx: Math.min(durationSec, clip.fadeIn?.durationSec ?? 0) * viewport.pxPerSecond,
        fadeOutPx: Math.min(durationSec, clip.fadeOut?.durationSec ?? 0) * viewport.pxPerSecond,
        isLoop: clip.loop,
        assetPresent: asset !== undefined,
      };
    });

    return {
      trackId: track.id,
      name: track.name,
      gainDb: track.gainDb,
      muted: track.muted,
      solo: track.solo,
      audible: isTrackAudible(edl, track),
      clipCount: clips.length,
      endSec: clips.reduce((max, clip) => Math.max(max, clip.timelineStartSec + clip.durationSec), 0),
      clips,
    };
  });
}

/**
 * 只更新可见性（滚动/缩放时不必重算全部几何）。
 *
 * `assetPresent` 由 `layoutTimeline` 在读取素材时一并确定，这里不重复判断。
 */
export function markVisibility(
  tracks: TrackLayout[],
  viewport: Viewport,
  widthPx: Px,
): TrackLayout[] {
  const range = visibleRange(viewport, widthPx);

  return tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => ({
      ...clip,
      visible: clip.timelineStartSec < range.endSec && clip.timelineStartSec + clip.durationSec > range.startSec,
    })),
  }));
}

/** 时间轴总长（所有轨道的最右端）。 */
export function timelineEndSec(tracks: readonly TrackLayout[]): Seconds {
  return tracks.reduce((max, track) => Math.max(max, track.endSec), 0);
}
