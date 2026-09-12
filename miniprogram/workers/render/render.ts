/**
 * 分块渲染引擎（Worker 侧，纯计算）。
 *
 * 约束：
 * - 本文件与其依赖的 `dsp/**`、`edl/**`、`codec/**` 都在 `workers/render/` 内，
 *   只允许依赖 TypedArray 与 Math，不得触碰平台 API；
 * - 文件 I/O 由主线程负责：`planChunk()` 声明本块需要的素材帧区间，主线程读盘后
 *   通过 `assets` 参数注入，再调用 `renderChunk()`。
 *
 * 效果链顺序固定为：
 * 片段增益/淡化 → 片段效果（EQ → 门 → 压缩）→ 轨道增益/声像 → 轨道效果
 * （EQ → 压缩 → 混响/回声）→ 总线（EQ → 限制器）→ 编码。
 */
import type { Clip, Edl, EffectInstance, Id } from '../../core/types';
import type { RenderJob } from '../../core/engine/worker-protocol';
import {
  applyEq10InPlace,
  biquadInPlace,
  createEq10Chain,
  highpassCoeffs,
  type BiquadState,
} from './dsp/biquad';
import { fadeGainAt } from './dsp/fade';
import { applyGainInPlace, dbToLinear } from './dsp/gain';
import { applyLimiterInPlace } from './dsp/limiter';
import { assetById, clipDurationSec, clipEndSec, isTrackAudible, tracksByOrder } from './edl/query';

/** 一帧素材 PCM 切片（交错存储）。 */
export interface AssetPcmSlice {
  /** 该切片首帧在素材中的绝对帧号。 */
  startFrame: number;
  /** 声道数。 */
  channels: number;
  /** 交错 PCM：`[L0, R0, L1, R1, …]`（单声道即纯序列）。 */
  data: Int16Array;
}

export type AssetPcmMap = Map<Id, AssetPcmSlice>;

/** `planChunk` 的输出：本块需要主线程提供的素材区间（帧号，绝对帧）。 */
export interface AssetFrameRequest {
  assetId: Id;
  startFrame: number;
  frameCount: number;
}

export type RenderJobSpec = RenderJob;
export interface RenderState {
  readonly job: RenderJobSpec;
  readonly edl: Edl;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly chunkFrames: number;
  readonly totalChunks: number;
  readonly totalFrames: number;
  /** 内部复用缓冲，外部不要读写。 */
  readonly scratch: {
    out: Float32Array[];
    track: Float32Array[];
    clip: Float32Array;
    interleavedInt16: Int16Array;
    /** 滤波器状态：`${scope}:${ownerId}:${effectId}` → 各段状态（跨块保持）。 */
    filterStates: Map<string, BiquadState[]>;
  };
}

export interface RenderChunkResult {
  /** 交错 Int16 输出（长度 = 帧数 × 声道数）。 */
  pcm: Int16Array;
  frames: number;
  isLast: boolean;
  /** 该块是否触发了限制器（用于 UI 提示"已防削波"）。 */
  limited: boolean;
}

/** 输出采样率必须等于工程采样率（跨采样率导出需先做重采样，见 docs/03 §6.4）。 */
export function assertSameSampleRate(job: RenderJobSpec): void {
  if (job.output.sampleRate !== job.edl.sampleRate) {
    throw new Error(
      `输出采样率 ${job.output.sampleRate} 与工程采样率 ${job.edl.sampleRate} 不一致：需先重采样`,
    );
  }
}

export function initJob(job: RenderJobSpec): RenderState {
  assertSameSampleRate(job);
  const sampleRate = job.edl.sampleRate;
  const channels = job.output.channels;
  const chunkFrames = Math.max(1, Math.round(job.chunkSec * sampleRate));

  const rangeStart = Math.max(0, Math.min(job.range.startSec, job.range.endSec));
  const rangeEnd = Math.max(job.range.startSec, job.range.endSec);
  const totalFrames = Math.max(0, Math.round((rangeEnd - rangeStart) * sampleRate));
  const totalChunks = Math.max(1, Math.ceil(totalFrames / chunkFrames));

  return {
    job: { ...job, range: { startSec: rangeStart, endSec: rangeEnd } },
    edl: job.edl,
    sampleRate,
    channels,
    chunkFrames,
    totalChunks,
    totalFrames,
    scratch: {
      out: Array.from({ length: channels }, () => new Float32Array(chunkFrames)),
      track: Array.from({ length: channels }, () => new Float32Array(chunkFrames)),
      clip: new Float32Array(chunkFrames),
      interleavedInt16: new Int16Array(chunkFrames * channels),
      filterStates: new Map(),
    },
  };
}

/** 第 `chunkIndex` 块在输出时间轴上的起止（秒）与该块的帧数。 */
export function chunkBounds(
  state: RenderState,
  chunkIndex: number,
): { startSec: number; endSec: number; frames: number } {
  const startFrame = chunkIndex * state.chunkFrames;
  const frames = Math.max(0, Math.min(state.chunkFrames, state.totalFrames - startFrame));
  const startSec = state.job.range.startSec + startFrame / state.sampleRate;
  return { startSec, endSec: startSec + frames / state.sampleRate, frames };
}

/**
 * 声明某块渲染所需的素材帧区间（供主线程按区间读盘）。
 * 只会请求与块相交的片段所覆盖的素材范围，跨块时区间按 speed 推得。
 */
export function planChunk(state: RenderState, chunkIndex: number): AssetFrameRequest[] {
  const { startSec, endSec } = chunkBounds(state, chunkIndex);
  const requests = new Map<Id, AssetFrameRequest>();

  for (const track of tracksByOrder(state.edl)) {
    if (!isTrackAudible(state.edl, track)) continue;
    for (const clip of track.clips) {
      const clipStart = clip.timelineStart;
      const clipStop = clipEndSec(clip);
      if (clipStop <= startSec || clipStart >= endSec) continue;

      const speed = clip.speed > 0 ? clip.speed : 1;
      const localStartSec = Math.max(0, startSec - clipStart);
      const localEndSec = Math.min(clipDurationSec(clip), endSec - clipStart);
      const spanSec = clip.sourceEnd - clip.sourceStart;

      // 循环片段可能覆盖任意源区间，这里保守地请求整段素材跨度
      const sourceStartFrame = clip.loop
        ? 0
        : Math.floor((clip.sourceStart + localStartSec * speed) * state.sampleRate);
      const sourceEndFrame = clip.loop
        ? Math.ceil(spanSec * state.sampleRate)
        : Math.ceil((clip.sourceStart + localEndSec * speed) * state.sampleRate) + 2;

      const startFrame = Math.max(0, sourceStartFrame);
      const frameCount = Math.max(1, sourceEndFrame - startFrame);
      const existing = requests.get(clip.assetId);
      if (!existing) {
        requests.set(clip.assetId, { assetId: clip.assetId, startFrame, frameCount });
      } else {
        const end = Math.max(existing.startFrame + existing.frameCount, startFrame + frameCount);
        existing.startFrame = Math.min(existing.startFrame, startFrame);
        existing.frameCount = end - existing.startFrame;
      }
    }
  }

  return Array.from(requests.values());
}

/** 从切片中按绝对帧号取一个采样（越界返回 0；帧号可为小数 → 线性插值）。 */
function sampleSlice(slice: AssetPcmSlice, frame: number, channel: number): number {
  const localFrame = frame - slice.startFrame;
  const frames = Math.floor(slice.data.length / slice.channels);
  if (localFrame < 0 || localFrame >= frames) return 0;

  const base = Math.floor(localFrame);
  const frac = localFrame - base;
  const index0 = (base * slice.channels + channel) * 1;
  const index1 = index0 + slice.channels;

  const s0 = (slice.data[index0] ?? 0) / 32768;
  if (frac === 0) return s0;
  const s1 = (slice.data[index1] ?? 0) / 32768;
  return s0 + (s1 - s0) * frac;
}

/** 取片段在某输出位置上的包络增益（片段增益 × 淡入 × 淡出）。 */
function clipEnvelopeGain(clip: Clip, localSec: number): number {
  let gain = dbToLinear(clip.gainDb);
  const duration = clipDurationSec(clip);

  if (clip.fadeIn && clip.fadeIn.durationSec > 0 && localSec < clip.fadeIn.durationSec) {
    gain *= fadeGainAt(localSec / clip.fadeIn.durationSec, clip.fadeIn.curve, 'in');
  }
  if (clip.fadeOut && clip.fadeOut.durationSec > 0) {
    const fromEnd = duration - localSec;
    if (fromEnd < clip.fadeOut.durationSec) {
      gain *= fadeGainAt(1 - fromEnd / clip.fadeOut.durationSec, clip.fadeOut.curve, 'out');
    }
  }
  return gain;
}

/** 把片段与当前块相交的部分渲染进 `dest`（单声道，长度 = 块帧数；未覆盖处保持原值）。 */
function renderClipInto(
  state: RenderState,
  clip: Clip,
  slice: AssetPcmSlice,
  dest: Float32Array,
  blockStartSec: number,
  blockFrames: number,
  channel: number,
): void {
  const sampleRate = state.sampleRate;
  const speed = clip.speed > 0 ? clip.speed : 1;
  const spanSec = Math.max(0, clip.sourceEnd - clip.sourceStart);
  const durationSec = clipDurationSec(clip);
  const sourceStartFrame = clip.sourceStart * sampleRate;

  for (let i = 0; i < blockFrames; i++) {
    const t = blockStartSec + i / sampleRate;
    const localSec = t - clip.timelineStart;
    if (localSec < 0 || localSec >= durationSec) continue;

    let sourceFrame: number;
    if (clip.loop && spanSec > 0) {
      const offsetSec = (localSec * speed) % spanSec;
      sourceFrame = sourceStartFrame + offsetSec * sampleRate;
    } else {
      sourceFrame = sourceStartFrame + localSec * speed * sampleRate;
    }

    const value = sampleSlice(slice, sourceFrame, channel);
    if (value === 0) continue;
    dest[i] = (dest[i] ?? 0) + value * clipEnvelopeGain(clip, localSec);
  }
}

function stateKey(scope: 'clip' | 'track', ownerId: Id, effectId: Id): string {
  return `${scope}:${ownerId}:${effectId}`;
}

/**
 * 应用一串效果（只处理已实现的类型；未实现类型直接跳过，
 * 由上层据 `SUPPORTED_EFFECTS` 给出提示）。
 * 逐声道处理，滤波器状态按 `${scope}:${ownerId}:${effectId}` 跨块保持。
 */
function applyEffectChain(
  state: RenderState,
  effects: readonly EffectInstance[],
  buf: Float32Array,
  scope: 'clip' | 'track',
  ownerId: Id,
): void {
  for (const effect of effects) {
    if (!effect.enabled) continue;
    const key = stateKey(scope, ownerId, effect.id);

    switch (effect.type) {
      case 'highpass': {
        const freq = numParam(effect.params.freq, 120);
        const coeffs = highpassCoeffs(state.sampleRate, freq);
        const next = biquadInPlace(buf, coeffs, state.scratch.filterStates.get(key)?.[0]);
        state.scratch.filterStates.set(key, [next]);
        break;
      }
      case 'eq10': {
        const gains = readBands(effect.params.bands);
        if (!gains) break;
        const chain = createEq10Chain(state.sampleRate, gains);
        const stored = state.scratch.filterStates.get(key);
        if (stored) chain.states = stored;
        applyEq10InPlace(buf, chain);
        state.scratch.filterStates.set(key, chain.states);
        break;
      }
      case 'gain': {
        applyGainInPlace(buf, dbToLinear(numParam(effect.params.gainDb, 0)));
        break;
      }
      default:
        // 未实现的效果类型（compressor/noiseGate/denoise/echo/reverb/normalize/limiter）
        // 在 M1 渲染路径中被跳过：由上层用 SUPPORTED_EFFECTS 提示用户
        break;
    }
  }
}

/** M1 渲染路径已实现的效果类型（其余类型会被跳过并提示）。 */
export const SUPPORTED_EFFECTS: readonly EffectInstance['type'][] = ['highpass', 'eq10', 'gain'];

function numParam(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBands(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 10) return null;
  return value.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0));
}

/** 等功率声像：`gL = cos((pan+1)·π/4)`、`gR = sin((pan+1)·π/4)`。 */
export function panGains(pan: number): { left: number; right: number } {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
  const angle = ((clamped + 1) * Math.PI) / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

function clearBuffers(buffers: Float32Array[], frames: number): void {
  for (const buf of buffers) buf.fill(0, 0, frames);
}

/**
 * 渲染一块并返回交错 Int16 PCM。
 *
 * @param assets 由 `planChunk` 声明的素材切片（缺失的素材会被跳过，输出对应位置为静音）
 */
export function renderChunk(
  state: RenderState,
  chunkIndex: number,
  assets: AssetPcmMap,
): RenderChunkResult {
  const { startSec, frames } = chunkBounds(state, chunkIndex);
  const isLast = chunkIndex >= state.totalChunks - 1;
  const { out, track: trackBuf, clip: clipBuf, interleavedInt16 } = state.scratch;

  clearBuffers(out, frames);
  if (frames === 0) {
    return { pcm: interleavedInt16.subarray(0, 0), frames: 0, isLast, limited: false };
  }

  const usePan = state.channels === 2;

  for (const track of tracksByOrder(state.edl)) {
    if (!isTrackAudible(state.edl, track)) continue;
    clearBuffers(trackBuf, frames);
    let trackHasContent = false;

    for (const clip of track.clips) {
      const clipStop = clipEndSec(clip);
      if (clipStop <= startSec || clip.timelineStart >= startSec + frames / state.sampleRate) continue;

      const asset = assetById(state.edl, clip.assetId);
      const slice = assets.get(clip.assetId);
      if (!asset || !slice) continue;

      // 片段级：先渲染到临时缓冲（单声道），跑效果链，再按声像/增益累加到轨道
      for (let channel = 0; channel < state.channels; channel++) {
        const sourceChannel = slice.channels === 1 ? 0 : channel;
        clipBuf.fill(0, 0, frames);
        renderClipInto(state, clip, slice, clipBuf, startSec, frames, sourceChannel);
        applyEffectChain(state, clip.effects, clipBuf, 'clip', clip.id);
        const target = trackBuf[channel];
        if (target) {
          for (let i = 0; i < frames; i++) {
            target[i] = (target[i] ?? 0) + (clipBuf[i] ?? 0);
          }
        }
      }
      trackHasContent = true;
    }

    if (!trackHasContent) continue;

    applyEffectChain(state, track.effects, trackBuf[0] ?? new Float32Array(0), 'track', track.id);
    if (state.channels === 2 && trackBuf[1]) {
      applyEffectChain(state, track.effects, trackBuf[1], 'track', track.id);
    }

    const trackGain = dbToLinear(track.gainDb);
    const pan = panGains(track.pan);
    for (let channel = 0; channel < state.channels; channel++) {
      const source = trackBuf[channel];
      const target = out[channel];
      if (!source || !target) continue;
      const channelGain = trackGain * (usePan ? (channel === 0 ? pan.left : pan.right) : 1);
      for (let i = 0; i < frames; i++) {
        target[i] = (target[i] ?? 0) + (source[i] ?? 0) * channelGain;
      }
    }
  }

  // 总线：归一化增益（导出时由主线程算好）——必须在限制器之前
  const busGainDb = state.job.busGainDb ?? 0;
  if (busGainDb !== 0) {
    const busGainLinear = dbToLinear(busGainDb);
    for (let channel = 0; channel < state.channels; channel++) {
      const buf = out[channel];
      if (!buf) continue;
      for (let i = 0; i < frames; i++) buf[i] = (buf[i] ?? 0) * busGainLinear;
    }
  }

  // 总线：限制器（限制器必须挂在总线上，不能只给单轨加）
  let limited = false;
  if (state.job.limiter !== false) {
    for (let channel = 0; channel < state.channels; channel++) {
      const buf = out[channel];
      if (!buf) continue;
      const slice = buf.subarray(0, frames);
      const result = applyLimiterInPlace(slice, { sampleRate: state.sampleRate });
      if (result.limitedSamples > 0) limited = true;
    }
  }

  // 各声道 Float32 → 交错 Int16（复用 scratch 缓冲，避免热路径分配）
  const interleaved = interleave(out, frames, state.channels, interleavedInt16);

  return { pcm: interleaved, frames, isLast, limited };
}

/**
 * 把各声道 Float32 交织成 Int16（`[L0, R0, L1, R1, …]`）。
 * `scratch` 会被复用，返回的就是该缓冲的视图。
 */
function interleave(
  channelsBuf: Float32Array[],
  frames: number,
  channels: number,
  scratch: Int16Array,
): Int16Array {
  const out = scratch.subarray(0, frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const buf = channelsBuf[channel];
      const v = buf ? (buf[i] ?? 0) : 0;
      const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
      out[i * channels + channel] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
  }
  return out;
}
