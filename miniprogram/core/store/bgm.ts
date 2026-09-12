/**
 * 背景音乐轨：把一段音乐循环铺满到目标时长（docs/01 MX-5）。
 *
 * 为什么不靠 `clip.loop` 铺满：渲染引擎对 loop 片段的处理是"在片段自身时长内取模"
 * （[03 §5.3](../../../docs/03-audio-engine.md)），片段的时间轴长度仍等于一个循环体长度，
 * 不会自动延长。所以铺满的做法是**生成一串首尾相接的片段**，最后一段按剩余时长截断。
 *
 * 这样做的额外好处：不动 EDL schema（无需迁移），且用户能像普通片段一样删掉多余的部分。
 */
import type { Asset, Clip, Edl, Id, Seconds } from '../types';
import { addClip, addTrack, createTrack, upsertAsset } from '../../workers/render/edl/ops';
import { edlDurationSec } from '../../workers/render/edl/query';
import { createId } from '../fs/paths';
import type { ProjectStore } from './project-store';

/** 铺满的片段数上限：防止异常时长的素材生成成千上万条命令。 */
export const MAX_BGM_CLIPS = 200;
/** 最后一段短于该长度就不铺（避免出现 10ms 的碎片）。 */
const MIN_TAIL_SEC = 0.05;

/**
 * 生成铺满到 `untilSec` 的片段序列。
 *
 * @param asset 音乐素材
 * @param untilSec 目标总时长（秒）
 * @param idFactory 片段 id 生成器（测试可注入）
 */
export function buildBgmClips(asset: Asset, untilSec: Seconds, idFactory: () => Id): Clip[] {
  const bodySec = asset.durationSec;
  if (!(bodySec > 0) || !(untilSec > 0)) return [];

  const clips: Clip[] = [];
  let startSec = 0;
  let guard = 0;

  while (startSec < untilSec - MIN_TAIL_SEC && guard < MAX_BGM_CLIPS) {
    const remainingSec = untilSec - startSec;
    const lengthSec = Math.min(bodySec, remainingSec);
    if (lengthSec <= MIN_TAIL_SEC) break;

    clips.push({
      id: idFactory(),
      assetId: asset.id,
      sourceStart: 0,
      sourceEnd: lengthSec,
      timelineStart: startSec,
      gainDb: 0,
      fadeIn: null,
      fadeOut: null,
      speed: 1,
      // 用连续片段表达循环，因此不需要 loop 标记（也便于用户单独剪掉某几段）
      loop: false,
      effects: [],
    });

    startSec += lengthSec;
    guard++;
  }

  return clips;
}

/** 主轨时长：除 BGM 轨之外最长的轨道（决定要铺多长）。 */
export function mainDurationSec(edl: Edl, excludeTrackIds: readonly Id[] = []): Seconds {
  const excluded = new Set(excludeTrackIds);
  const others: Edl = { ...edl, tracks: edl.tracks.filter((track) => !excluded.has(track.id)) };
  return edlDurationSec(others);
}

export interface AddBgmOptions {
  /** 铺满到的总时长；缺省用当前工程里除 BGM 轨外的最长轨道。 */
  untilSec?: Seconds;
  trackName?: string;
  /** 已有 BGM 轨 id：再次铺满时复用它而不是新建。 */
  trackId?: Id;
}

/**
 * 添加/重铺 BGM 轨（一次提交，可撤销）。
 *
 * @returns 铺满的片段数；0 表示没有铺任何东西（素材或目标时长无效）
 */
export function commitAddBgm(store: ProjectStore, asset: Asset, options: AddBgmOptions = {}): number {
  const edl = store.edl;
  const trackId = options.trackId ?? createId();
  const untilSec = options.untilSec ?? mainDurationSec(edl, options.trackId ? [options.trackId] : []);
  if (!(untilSec > 0)) return 0;

  const clips = buildBgmClips(asset, untilSec, createId);
  if (clips.length === 0) return 0;

  const existingTrack = edl.tracks.find((track) => track.id === trackId);
  const track = createTrack({
    id: trackId,
    name: options.trackName ?? existingTrack?.name ?? '背景音乐',
    order: existingTrack?.order ?? edl.tracks.length,
  });

  const before = store.edl;
  store.commit({
    id: `bgm-${asset.id}-${Date.now()}`,
    label: options.trackId ? '重新铺满背景音乐' : '添加背景音乐',
    at: Date.now(),
    apply: (current) => {
      let next = upsertAsset(current, asset);
      // 重铺时先清掉旧片段，否则会与旧的循环段重叠
      if (existingTrack) {
        next = { ...next, tracks: next.tracks.map((item) => (item.id === trackId ? { ...item, clips: [] } : item)) };
      } else {
        next = addTrack(next, track);
      }
      return clips.reduce((acc, clip) => addClip(acc, trackId, clip), next);
    },
    invert: () => before,
  });

  return clips.length;
}
