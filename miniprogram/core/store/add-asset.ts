/**
 * 把素材挂到工程上（首页导入、录音结束、复制素材都走这里）。
 *
 * 一次提交同时登记素材与片段：如果分成两步，中间失败会留下"有素材没片段"或
 * "片段引用不存在素材"的中间态（后者会被 `validateEdl` 自动清掉，用户白忙一次）。
 */
import type { Asset, Clip, Id, Seconds } from '../types';
import { addClip, addTrack, removeAsset, removeClip, removeTrack, upsertAsset } from '../../workers/render/edl/ops';
import { clipEndSec, trackById } from '../../workers/render/edl/query';
import { defaultTrack } from './create-project';
import type { ProjectStore } from './project-store';

/** 为素材构造一个占满素材全长的片段。 */
export function buildClipForAsset(asset: Asset, timelineStartSec: Seconds, clipId: Id): Clip {
  return {
    id: clipId,
    assetId: asset.id,
    sourceStart: 0,
    sourceEnd: asset.durationSec,
    timelineStart: timelineStartSec,
    gainDb: 0,
    fadeIn: null,
    fadeOut: null,
    speed: 1,
    loop: false,
    effects: [],
  };
}

export interface AddAssetOptions {
  /** 目标轨道；缺省用第一条轨道，没有轨道时自动建一条。 */
  trackId?: Id;
  /** 插入位置；缺省追加到轨道末尾。 */
  timelineStartSec?: Seconds;
  /** 片段 id 生成器（测试可注入可预期 id）。 */
  clipId?: Id;
  label?: string;
}

/** 把素材与片段一起提交到工程（可撤销）。 */
export function commitAddAsset(
  store: ProjectStore,
  asset: Asset,
  options: AddAssetOptions = {},
): void {
  const edl = store.edl;
  const existingTrackId = options.trackId ?? edl.tracks[0]?.id;
  const track = existingTrackId ? trackById(edl, existingTrackId) : undefined;
  const newTrack = track ? null : defaultTrack();
  const trackId = track?.id ?? newTrack?.id ?? '';

  const timelineStartSec = options.timelineStartSec ?? (track ? trackEndSec(track.id) : 0);
  const clip = buildClipForAsset(asset, Math.max(0, timelineStartSec), options.clipId ?? `${asset.id}-clip`);

  store.commit({
    id: `add-asset-${asset.id}`,
    label: options.label ?? '添加素材',
    at: Date.now(),
    apply: (current) => {
      const withTrack = newTrack ? addTrack(current, newTrack) : current;
      const withAsset = upsertAsset(withTrack, asset);
      return addClip(withAsset, trackId, clip);
    },
    invert: (current) => {
      const withoutClip = removeClip(current, trackId, clip.id);
      const withoutAsset = removeAsset(withoutClip, asset.id);
      return newTrack ? removeTrack(withoutAsset, newTrack.id) : withoutAsset;
    },
  });

  function trackEndSec(id: Id): Seconds {
    const target = trackById(store.edl, id);
    if (!target || target.clips.length === 0) return 0;
    return target.clips.reduce((max, item) => Math.max(max, clipEndSec(item)), 0);
  }
}
