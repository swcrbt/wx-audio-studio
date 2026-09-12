/**
 * 播放通道（Transport）：单例 `InnerAudioContext` 的封装，用于播放预览 WAV 与成品。
 *
 * 为什么只保留一个底层上下文：`createInnerAudioContext()` 反复创建会泄漏内存
 * （官方建议全局单例），因此模块内共享一个上下文，`Transport` 实例只是它的"接管者"——
 * 新实例接管后旧实例自动解绑，页面卸载时调用 `destroy()` 释放。
 *
 * 平台约束：
 * - `playbackRate` 有效范围 `0 < rate <= 2.0`，产品再收紧到 0.5 起（更慢听不清细节）；
 * - `seek` / `currentTime` 需要基础库 2.26.2+（[02 §1.2](./docs/02-platform-capability.md)）；
 * - 系统抢占（来电、其他 App 播放）必须暂停，`onAudioInterruptionEnd` 后**不自动恢复**：
 *   用户可能已经离开页面，突然出声是事故，恢复与否交给 UI 决定。
 */
import type { Seconds } from '../types';
import { logger } from '../../utils/logger';

export type TransportState = 'idle' | 'playing' | 'paused' | 'ended' | 'error';

export type PlayerErrorCode = 'noSource' | 'fileMissing' | 'playFailed' | 'unsupportedRate';

export class PlayerError extends Error {
  readonly code: PlayerErrorCode;
  readonly action: 'retry' | 'reimport' | 'none';

  constructor(code: PlayerErrorCode, message: string, action: PlayerError['action'] = 'none') {
    super(message);
    this.name = 'PlayerError';
    this.code = code;
    this.action = action;
  }
}

/** 播放倍速区间：下限 0.5 便于听清细节，上限为平台支持的最大值。 */
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 2;

export interface TransportOptions {
  onStateChange?: (state: TransportState) => void;
  onPosition?: (sec: Seconds) => void;
  onDuration?: (sec: Seconds) => void;
  onEnded?: () => void;
  onError?: (error: PlayerError) => void;
  /** 播放被系统抢占而暂停（UI 据此提示"播放已暂停"）。 */
  onInterrupted?: () => void;
}

/**
 * 共享上下文与“当前接管者”。
 *
 * 用汇（sink）而不是直接持有 Transport 实例：避免把 `this` 别名为模块级变量。
 */
let sharedContext: WechatMiniprogram.InnerAudioContext | null = null;
let activeSink: { detach(): void; interruptionBegin(): void; interruptionEnd(): void } | null = null;
let interruptionHandlersAttached = false;

function ensureContext(): WechatMiniprogram.InnerAudioContext {
  if (!sharedContext) {
    // 显式关闭 WebAudio 实现：预览/成品是完整文件播放，走平台默认实现更稳定
    sharedContext = wx.createInnerAudioContext({ useWebAudioImplement: false });
    sharedContext.autoplay = false;
  }
  return sharedContext;
}

function ensureInterruptionHandlers(): void {
  if (interruptionHandlersAttached) return;
  interruptionHandlersAttached = true;
  wx.onAudioInterruptionBegin(() => activeSink?.interruptionBegin());
  wx.onAudioInterruptionEnd(() => activeSink?.interruptionEnd());
}

/** 平台错误文案 → 用户可读错误。 */
function toPlayerError(error: unknown): PlayerError {
  const message =
    typeof error === 'object' && error !== null
      ? String((error as { errMsg?: string }).errMsg ?? '播放失败')
      : String(error);

  if (/no such file|not found|src is empty|文件不存在/i.test(message)) {
    return new PlayerError('fileMissing', '音频文件已丢失，请重新导入素材', 'reimport');
  }
  return new PlayerError('playFailed', `播放失败：${message}`, 'retry');
}

export class Transport {
  private readonly options: TransportOptions;
  private context: WechatMiniprogram.InnerAudioContext | null = null;
  private state: TransportState = 'idle';
  private sourcePath: string | null = null;
  private rate: number = 1;
  /** 是否正在接管共享上下文（决定 destroy 时要不要销毁底层实例）。 */
  private isActive = false;

  constructor(options: TransportOptions = {}) {
    this.options = options;
  }

  get currentState(): TransportState {
    return this.state;
  }

  /** 当前播放位置（秒）。 */
  get positionSec(): Seconds {
    return this.context?.currentTime ?? 0;
  }

  get durationSec(): Seconds {
    return this.context?.duration ?? 0;
  }

  get playbackRate(): number {
    return this.rate;
  }

  get filePath(): string | null {
    return this.sourcePath;
  }

  /** 装载音源；装载同一文件不会打断当前播放。 */
  load(filePath: string): void {
    const context = this.attach();
    if (this.sourcePath === filePath) return;

    context.stop();
    this.sourcePath = filePath;
    context.src = filePath;
    this.setState('idle');
  }

  /**
   * 播放。
   *
   * @param fromSec 起始位置（秒）；拖动播放头后立即反馈时使用
   * @param rate 播放倍速（0.5~2），越界会被收紧到区间边界
   */
  play(options: { fromSec?: Seconds; rate?: number } = {}): void {
    const context = this.attach();
    if (!this.sourcePath) throw new PlayerError('noSource', '还没有加载音频', 'none');

    if (options.rate !== undefined) this.setRate(options.rate);
    if (options.fromSec !== undefined && options.fromSec > 0) this.seek(options.fromSec);

    try {
      context.play();
    } catch (error) {
      const mapped = toPlayerError(error);
      this.setState('error');
      this.options.onError?.(mapped);
    }
  }

  pause(): void {
    this.context?.pause();
  }

  stop(): void {
    this.context?.stop();
    this.setState('idle');
  }

  /** 定位（秒）。播放中调用会继续播放，暂停时只改位置。 */
  seek(sec: Seconds): void {
    const context = this.context ?? this.attach();
    const target = Math.max(0, sec);
    try {
      context.seek(target);
    } catch (error) {
      logger.warn('player', 'seek failed', error);
    }
  }

  /** 设置播放倍速，返回实际生效值（越界收紧，不做静默失败）。 */
  setRate(rate: number): number {
    if (!Number.isFinite(rate)) {
      throw new PlayerError('unsupportedRate', '播放倍速必须是有限数值', 'none');
    }
    const clamped = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
    this.rate = clamped;
    if (this.context) this.context.playbackRate = clamped;
    return clamped;
  }

  /** 释放：解绑事件并销毁底层上下文（下次使用会重新创建）。 */
  destroy(): void {
    const wasActive = this.isActive;
    this.isActive = false;

    if (this.context) {
      this.unbindEvents(this.context);
      this.context = null;
    }
    if (wasActive) {
      activeSink = null;
      try {
        sharedContext?.destroy();
      } catch (error) {
        logger.warn('player', 'destroy innerAudioContext failed', error);
      }
      sharedContext = null;
    }
    this.sourcePath = null;
    this.setState('idle');
  }

  /** 接管共享上下文：先让上一个接管者解绑，保证事件不串页。 */
  private attach(): WechatMiniprogram.InnerAudioContext {
    const context = ensureContext();
    if (this.context === context) return context;

    if (activeSink) activeSink.detach();
    ensureInterruptionHandlers();

    this.context = context;
    this.bindEvents(context);
    context.playbackRate = this.rate;
    this.isActive = true;
    activeSink = {
      detach: () => this.detach(),
      interruptionBegin: () => this.handleInterruption(),
      interruptionEnd: () => this.handleInterruptionEnd(),
    };
    return context;
  }

  /** 只解绑事件，不销毁上下文（给“被接管”的场景用）。 */
  private detach(): void {
    this.isActive = false;
    if (this.context) this.unbindEvents(this.context);
    this.context = null;
    this.setState('idle');
  }

  private handlers: {
    play: () => void;
    pause: () => void;
    stop: () => void;
    ended: () => void;
    error: (res: unknown) => void;
    timeUpdate: () => void;
    canplay: () => void;
    seeked: () => void;
  } | null = null;

  private bindEvents(context: WechatMiniprogram.InnerAudioContext): void {
    const handlers = {
      play: () => this.setState('playing'),
      pause: () => this.setState('paused'),
      stop: () => this.setState('idle'),
      ended: () => {
        this.setState('ended');
        this.options.onEnded?.();
      },
      error: (res: unknown) => {
        const mapped = toPlayerError(res);
        logger.warn('player', 'playback error', mapped.code);
        this.setState('error');
        this.options.onError?.(mapped);
      },
      timeUpdate: () => this.options.onPosition?.(this.positionSec),
      canplay: () => this.options.onDuration?.(this.durationSec),
      seeked: () => this.options.onPosition?.(this.positionSec),
    };

    this.handlers = handlers;
    context.onPlay(handlers.play);
    context.onPause(handlers.pause);
    context.onStop(handlers.stop);
    context.onEnded(handlers.ended);
    context.onError(handlers.error);
    context.onTimeUpdate(handlers.timeUpdate);
    context.onCanplay(handlers.canplay);
    context.onSeeked(handlers.seeked);
  }

  private unbindEvents(context: WechatMiniprogram.InnerAudioContext): void {
    const handlers = this.handlers;
    if (!handlers) return;
    context.offPlay(handlers.play);
    context.offPause(handlers.pause);
    context.offStop(handlers.stop);
    context.offEnded(handlers.ended);
    context.offError(handlers.error);
    context.offTimeUpdate(handlers.timeUpdate);
    context.offCanplay(handlers.canplay);
    context.offSeeked(handlers.seeked);
    this.handlers = null;
  }

  private handleInterruption(): void {
    if (this.state !== 'playing') return;
    this.pause();
    this.options.onInterrupted?.();
  }

  private handleInterruptionEnd(): void {
    // 不自动恢复播放：用户可能已离开页面，恢复出声属于意外行为
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
