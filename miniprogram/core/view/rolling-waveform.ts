/**
 * 录音时的滚动波形：把 PCM 分帧压成"每列 min/max"的环形缓冲。
 *
 * 为什么不用 `AnalyserNode`：小程序的 WebAudio 没有麦克风输入节点（没有 `getUserMedia`
 * 之类的入口），录音只能走 `RecorderManager` 的 PCM 分帧，因此电平与波形都从分帧数据算。
 * 详见 docs/03 §7。
 *
 * 内存纪律：只保留最近 `capacityColumns` 列（默认 400 列），与录音时长无关。
 */
export interface RollingFrameInfo {
  /** 本帧峰值（线性，0～1）。 */
  peakLinear: number;
  /** 本帧是否为削波（≥ 0.999 满量程）。 */
  clipped: boolean;
}

export interface RollingWaveformOptions {
  /** 环形缓冲的列数。 */
  capacityColumns?: number;
  /** 每列聚合多少采样帧。 */
  samplesPerColumn?: number;
  /** 声道数（交错数据按帧聚合，不区分声道）。 */
  channels?: number;
}

const CLIP_THRESHOLD = 0.999;

export class RollingWaveform {
  private readonly capacityColumns: number;
  private readonly samplesPerColumn: number;
  private readonly channels: number;
  /** 交错 `[min, max]`，归一化到 [-1, 1]。 */
  private readonly data: Float32Array;
  private writeIndex = 0;
  private filled = 0;
  /** 当前列内已累积的采样帧数与极值（跨帧拼接，列边界不丢数据）。 */
  private columnFrames = 0;
  private columnMin = Number.POSITIVE_INFINITY;
  private columnMax = Number.NEGATIVE_INFINITY;

  constructor(options: RollingWaveformOptions = {}) {
    this.capacityColumns = Math.max(1, Math.floor(options.capacityColumns ?? 400));
    this.samplesPerColumn = Math.max(1, Math.floor(options.samplesPerColumn ?? 512));
    this.channels = Math.max(1, Math.floor(options.channels ?? 1));
    this.data = new Float32Array(this.capacityColumns * 2);
  }

  get columnCount(): number {
    return this.filled;
  }

  /**
   * 写入一帧 PCM（交错 Int16）。
   *
   * @returns 本帧的峰值与削波标记（电平表直接用，无需再遍历一次）
   */
  push(pcm: Int16Array): RollingFrameInfo {
    let framePeak = 0;
    const frames = Math.floor(pcm.length / this.channels);

    for (let frame = 0; frame < frames; frame++) {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let channel = 0; channel < this.channels; channel++) {
        const value = pcm[frame * this.channels + channel] ?? 0;
        const abs = Math.abs(value);
        if (abs > framePeak) framePeak = abs;
        if (value < min) min = value;
        if (value > max) max = value;
      }

      if (min < this.columnMin) this.columnMin = min;
      if (max > this.columnMax) this.columnMax = max;
      this.columnFrames++;

      if (this.columnFrames >= this.samplesPerColumn) this.flushColumn();
    }

    const peakLinear = framePeak / 32768;
    return { peakLinear, clipped: peakLinear >= CLIP_THRESHOLD };
  }

  /** 把未满一列的残余也提交（停止录音时调用，避免尾部丢一列）。 */
  flush(): void {
    if (this.columnFrames > 0) this.flushColumn();
  }

  /**
   * 取最近若干列（按时间从左到右），输出交错 `[min, max]`。
   *
   * @param out 复用缓冲（长度 ≥ 列数 × 2），避免每帧分配
   */
  snapshot(out?: Float32Array): Float32Array {
    const count = this.filled;
    const target = out && out.length >= count * 2 ? out : new Float32Array(count * 2);
    target.fill(0, 0, count * 2);

    const start = this.filled < this.capacityColumns ? 0 : this.writeIndex;
    for (let i = 0; i < count; i++) {
      const index = (start + i) % this.capacityColumns;
      target[i * 2] = this.data[index * 2] ?? 0;
      target[i * 2 + 1] = this.data[index * 2 + 1] ?? 0;
    }
    return target;
  }

  reset(): void {
    this.data.fill(0);
    this.writeIndex = 0;
    this.filled = 0;
    this.columnFrames = 0;
    this.columnMin = Number.POSITIVE_INFINITY;
    this.columnMax = Number.NEGATIVE_INFINITY;
  }

  private flushColumn(): void {
    const min = Number.isFinite(this.columnMin) ? this.columnMin : 0;
    const max = Number.isFinite(this.columnMax) ? this.columnMax : 0;
    this.data[this.writeIndex * 2] = min / 32768;
    this.data[this.writeIndex * 2 + 1] = max / 32768;
    this.writeIndex = (this.writeIndex + 1) % this.capacityColumns;
    if (this.filled < this.capacityColumns) this.filled++;

    this.columnFrames = 0;
    this.columnMin = Number.POSITIVE_INFINITY;
    this.columnMax = Number.NEGATIVE_INFINITY;
  }
}
