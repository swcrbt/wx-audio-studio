/**
 * Spike 用的构造与读写辅助（仅 M0 使用）。
 */
import { WAV_HEADER_BYTES, floatToInt16, writeWavHeader } from '../../workers/render/codec/wav';

export interface ToneOptions {
  sampleRate?: number;
  freq?: number;
  amplitude?: number;
  channels?: number;
}

/** 生成一段正弦 WAV（在本机内存里构造，用于喂给 decodeAudioData）。 */
export function buildSineWav(seconds: number, options: ToneOptions = {}): ArrayBuffer {
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 1;
  const freq = options.freq ?? 440;
  const amplitude = options.amplitude ?? 0.5;

  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const dataBytes = frames * channels * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeWavHeader(view, { sampleRate, channels, dataBytes });

  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  const pcm = new Int16Array(frames * channels);
  floatToInt16(mono, pcm);
  if (channels > 1) {
    for (let i = 0; i < frames; i++) {
      const value = pcm[i] ?? 0;
      for (let c = 1; c < channels; c++) pcm[i * channels + c] = value;
    }
  }
  new Uint8Array(buffer, WAV_HEADER_BYTES).set(new Uint8Array(pcm.buffer));

  return buffer;
}

/**
 * 生成"每秒一个短促标记音"的 WAV：用来验证 seek 精度
 * （听到/分析到标记音的位置就是实际播放位置）。
 */
export function buildMarkerWav(seconds: number, options: ToneOptions = {}): ArrayBuffer {
  const sampleRate = options.sampleRate ?? 44100;
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + frames * 2);
  const view = new DataView(buffer);
  writeWavHeader(view, { sampleRate, channels: 1, dataBytes: frames * 2 });

  const mono = new Float32Array(frames);
  const markerFrames = Math.round(0.05 * sampleRate);
  for (let second = 0; second < Math.ceil(seconds); second++) {
    const start = Math.round(second * sampleRate);
    for (let i = 0; i < markerFrames; i++) {
      const index = start + i;
      if (index >= frames) break;
      // 标记音频率随秒数变化（1kHz + 200Hz×秒），便于听辨与频域分析
      mono[index] = 0.8 * Math.sin((2 * Math.PI * (1000 + second * 200) * i) / sampleRate);
    }
  }
  const pcm = new Int16Array(frames);
  floatToInt16(mono, pcm);
  new Uint8Array(buffer, WAV_HEADER_BYTES).set(new Uint8Array(pcm.buffer));
  return buffer;
}

function fs(): WechatMiniprogram.FileSystemManager {
  return wx.getFileSystemManager();
}

export function writeFileBuffer(filePath: string, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    fs().writeFile({
      filePath,
      data,
      success: () => resolve(),
      fail: (err) => reject(err),
    });
  });
}

export function readFileBuffer(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    fs().readFile({
      filePath,
      success: (res) => resolve(res.data as ArrayBuffer),
      fail: (err) => reject(err),
    });
  });
}

export function fileSize(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    fs().stat({
      path: filePath,
      success: (res) => {
        const stats = Array.isArray(res.stats) ? res.stats[0] : res.stats;
        const size = (stats as { size?: unknown } | undefined)?.size;
        resolve(typeof size === 'number' ? size : 0);
      },
      fail: () => resolve(0),
    });
  });
}

export function unlink(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    fs().unlink({
      filePath,
      success: () => resolve(),
      fail: () => resolve(),
    });
  });
}

export interface DecodedAudio {
  sampleRate: number;
  numberOfChannels: number;
  duration: number;
  length: number;
  getChannelData(channel: number): Float32Array;
  copyFromChannel?: (destination: Float32Array, channelNumber: number, startInChannel?: number) => void;
}

/**
 * 解码一段二进制为 AudioBuffer。
 *
 * 平台类型定义未完全覆盖 WebAudio 的方法签名，这里用结构断言而不是依赖 typings。
 */
export function decodeAudio(ctx: unknown, data: ArrayBuffer): Promise<DecodedAudio> {
  const target = ctx as {
    decodeAudioData: (
      audioData: ArrayBuffer,
      success: (buffer: DecodedAudio) => void,
      fail: (error: unknown) => void,
    ) => void;
  };
  return new Promise((resolve, reject) => {
    target.decodeAudioData(data, (buffer) => resolve(buffer), (error) => reject(error));
  });
}

/** 等待指定毫秒。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
