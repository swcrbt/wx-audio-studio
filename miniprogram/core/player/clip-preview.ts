/**
 * 短片段试听：用 WebAudio `BufferSourceNode` 循环播放一小段，用于"调参数时反复听"。
 *
 * 为什么不复用 `Transport`：`InnerAudioContext` 从文件播放，循环点与起播精度受平台实现影响；
 * 而 `BufferSourceNode.start(0, offset, duration)` + `loop` 能做到毫秒级精度与无缝循环，
 * 这正是效果参数调试的关键手感。
 *
 * 内存纪律：只把**试听区间**读进内存（`MAX_CLIP_PREVIEW_SEC` 上限），不读整段素材。
 */
import type { Seconds } from '../types';
import { readPcmFrames, readWavMeta } from '../fs/wav-file';
import { logger } from '../../utils/logger';
import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE, PlayerError } from './transport';

/** 单次试听区间上限：更长既不适合常驻内存，也会让起播明显变慢。 */
export const MAX_CLIP_PREVIEW_SEC = 30;

export interface ClipPreviewOptions {
  onStateChange?: (playing: boolean) => void;
  onError?: (error: PlayerError) => void;
}

export class ClipPreviewPlayer {
  private readonly options: ClipPreviewOptions;
  private context: WechatMiniprogram.WebAudioContext | null = null;
  private buffer: WechatMiniprogram.AudioBuffer | null = null;
  private source: WechatMiniprogram.BufferSourceNode | null = null;
  private playing = false;

  constructor(options: ClipPreviewOptions = {}) {
    this.options = options;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get loaded(): boolean {
    return this.buffer !== null;
  }

  /** 装载试听区间（只读该区间的 PCM，并转成 Float32 写入 AudioBuffer）。 */
  async load(assetPath: string, startSec: Seconds, durationSec: Seconds): Promise<void> {
    const clippedSec = Math.min(durationSec, MAX_CLIP_PREVIEW_SEC);
    if (clippedSec <= 0) {
      throw new PlayerError('noSource', '试听区间为空，请先选择片段范围', 'none');
    }

    const meta = await readWavMeta(assetPath);
    const startFrame = Math.max(0, Math.round(startSec * meta.sampleRate));
    const frameCount = Math.max(1, Math.round(clippedSec * meta.sampleRate));
    const pcm = await readPcmFrames(meta, startFrame, frameCount);
    const frames = Math.floor(pcm.length / meta.channels);

    const context = this.ensureContext();
    const buffer = context.createBuffer(meta.channels, frames, meta.sampleRate);
    for (let channel = 0; channel < meta.channels; channel++) {
      const target = buffer.getChannelData(channel);
      for (let i = 0; i < frames; i++) {
        target[i] = (pcm[i * meta.channels + channel] ?? 0) / 0x8000;
      }
    }

    this.stop();
    this.buffer = buffer;
  }

  /**
   * 开始播放。
   *
   * @param loop 是否无缝循环（调参试听用 `true`，A/B 对比用 `false`）
   * @param rate 播放倍速，越界收紧到 0.5~2
   */
  play(loop = true, rate = 1): void {
    const buffer = this.buffer;
    if (!buffer) throw new PlayerError('noSource', '还没有装载试听片段', 'none');

    const context = this.ensureContext();
    this.stop();

    const clampedRate = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(context.destination);
    // 部分基础库不返回 playbackRate 节点，此时平台按 1.0 处理
    if (source.playbackRate) source.playbackRate.value = clampedRate;
    source.onended = () => {
      if (!loop && this.source === source) {
        this.source = null;
        this.setPlaying(false);
      }
    };

    try {
      source.start(0, 0);
    } catch (error) {
      const mapped = new PlayerError('playFailed', '试听播放失败，请重试', 'retry');
      logger.warn('player', 'clip preview start failed', error);
      this.options.onError?.(mapped);
      throw mapped;
    }

    this.source = source;
    this.setPlaying(true);
  }

  stop(): void {
    const source = this.source;
    this.source = null;
    if (source) {
      try {
        source.onended = undefined;
        source.stop();
        source.disconnect();
      } catch (error) {
        // 已经停止过的节点再 stop 会抛错，属正常情况
        logger.debug('player', 'clip preview stop ignored', error);
      }
    }
    if (this.playing) this.setPlaying(false);
  }

  /** 释放 WebAudio 上下文与缓冲。 */
  destroy(): void {
    this.stop();
    this.buffer = null;
    const context = this.context;
    this.context = null;
    if (context) {
      void Promise.resolve(context.close()).catch((error: unknown) => {
        logger.warn('player', 'webAudio close failed', error);
      });
    }
  }

  private ensureContext(): WechatMiniprogram.WebAudioContext {
    this.context = this.context ?? wx.createWebAudioContext();
    return this.context;
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.options.onStateChange?.(playing);
  }
}
