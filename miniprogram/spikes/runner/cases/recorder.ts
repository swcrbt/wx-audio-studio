/**
 * DB-08：录音 PCM 分帧行为。
 *
 * 这是录音管线最需要真机确认的一项：帧是否连续、每帧字节数是否恒定、
 * 落盘时长与墙钟时间是否吻合（有时间戳才能判断是否有丢帧）。
 *
 * 实验会真的录 15 秒（需要麦克风权限），中途不要切后台。
 */
import type { SpikeCase, SpikeLine } from '../types';
import { describeError, formatBytes } from '../types';
import { unlink } from '../util';

const TMP_DIR = () => `${wx.env.USER_DATA_PATH}/spikes`;
/** 与生产一致的录音参数（docs/03 §3）。 */
const RECORD_SECONDS = 15;
const FRAME_SIZE_KB = 64;
const SAMPLE_RATE = 44100;

interface FrameRecord {
  bytes: number;
  atMs: number;
}

function ensureTmpDir(): Promise<void> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().mkdir({
      dirPath: TMP_DIR(),
      recursive: true,
      success: () => resolve(),
      fail: () => resolve(),
    });
  });
}

function authorizeRecord(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.authorize({ scope: 'scope.record', success: () => resolve(true), fail: () => resolve(false) });
  });
}

export const db08: SpikeCase = {
  id: 'DB-08',
  title: `录音 PCM 分帧（${RECORD_SECONDS}s · frameSize ${FRAME_SIZE_KB}KB）`,
  criteria: '帧字节数恒定、总时长与墙钟误差 ≤ 50ms、无长时间空档',
  blocks: '录音落盘管线（IN-1/IN-3）',
  needsDevice: true,
  async run(log) {
    await ensureTmpDir();
    const lines: SpikeLine[] = [];

    const granted = await authorizeRecord();
    if (!granted) {
      lines.push({ label: '权限', value: '未授权麦克风，无法运行', ok: false });
      return {
        id: this.id,
        title: this.title,
        env: '',
        lines,
        conclusion: '未获得麦克风权限，本项需重新运行',
        failed: true,
      };
    }

    const frames: FrameRecord[] = [];
    const startedAt = Date.now();
    let firstFrameAt = 0;
    let lastFrameAt = 0;

    const done = new Promise<{ stopped: boolean; error: string }>((resolve) => {
      const manager = wx.getRecorderManager();
      manager.onFrameRecorded((res) => {
        const atMs = Date.now() - startedAt;
        if (firstFrameAt === 0) firstFrameAt = atMs;
        lastFrameAt = atMs;
        frames.push({ bytes: res.frameBuffer.byteLength, atMs });
      });
      manager.onStop(() => resolve({ stopped: true, error: '' }));
      manager.onError((error) => resolve({ stopped: false, error: describeError(error) }));
      // 中断（来电/切后台）也结束实验，但据实记录
      manager.onInterruptionBegin(() => resolve({ stopped: false, error: 'interruptionBegin（被系统抢占）' }));

      log(`开始录音 ${RECORD_SECONDS} 秒，请对着麦克风说话或制造持续声音…`);
      manager.start({
        duration: RECORD_SECONDS * 1000,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 1,
        encodeBitRate: 96000,
        format: 'PCM',
        frameSize: FRAME_SIZE_KB,
      });
    });

    const outcome = await done;
    const wallMs = Date.now() - startedAt;

    if (outcome.error) {
      lines.push({ label: '录音中断', value: outcome.error, ok: false });
    }
    if (frames.length === 0) {
      lines.push({ label: '帧回调', value: '一帧都没有收到', ok: false });
      return {
        id: this.id,
        title: this.title,
        env: '',
        lines,
        conclusion: '未收到任何分帧：`frameSize` + `format: PCM` 的组合在真机上不可用，录音管线需改回"整体文件 + 事后转换"',
        failed: true,
      };
    }

    const totalBytes = frames.reduce((sum, frame) => sum + frame.bytes, 0);
    const frameBytes = frames.map((frame) => frame.bytes);
    const uniqueSizes = [...new Set(frameBytes)];
    const bodySizes = frameBytes.slice(0, Math.max(0, frameBytes.length - 1));
    const uniformBody = new Set(bodySizes).size <= 1;
    const framesFromPcm = totalBytes / 2; // 单声道 16bit
    const durationSec = framesFromPcm / SAMPLE_RATE;
    const deltaMs = durationSec * 1000 - wallMs;

    // 帧间隔统计（看有没有长时间空档）
    const gaps: number[] = [];
    for (let i = 1; i < frames.length; i++) {
      const previous = frames[i - 1];
      const current = frames[i];
      if (previous && current) gaps.push(current.atMs - previous.atMs);
    }
    const maxGapMs = gaps.length > 0 ? Math.max(...gaps) : 0;
    const avgGapMs = gaps.length > 0 ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0;
    const expectedFrames = (RECORD_SECONDS * SAMPLE_RATE * 2) / (FRAME_SIZE_KB * 1024);

    lines.push({ label: '分帧数', value: `${frames.length} 帧（理论约 ${expectedFrames.toFixed(1)} 帧）`, ok: frames.length >= expectedFrames * 0.8 });
    lines.push({ label: '总字节', value: `${formatBytes(totalBytes)}（${framesFromPcm} 采样帧）` });
    lines.push({ label: '帧大小', value: uniqueSizes.map((size) => formatBytes(size)).join(' / '), ok: uniformBody });
    lines.push({ label: '帧间隔', value: `平均 ${avgGapMs.toFixed(0)}ms · 最大 ${maxGapMs.toFixed(0)}ms`, ok: maxGapMs < 2000 });
    lines.push({
      label: '时长误差（落盘 vs 墙钟）',
      value: `${durationSec.toFixed(3)}s vs ${(wallMs / 1000).toFixed(3)}s（差 ${deltaMs.toFixed(0)}ms）`,
      ok: Math.abs(deltaMs) <= 50,
    });

    const seekLine = { label: '首帧到达', value: `${firstFrameAt}ms（上一帧 ${lastFrameAt}ms）` };
    lines.push(seekLine);

    await unlink(`${TMP_DIR()}/spike-record.wav`);

    const pass = uniformBody && Math.abs(deltaMs) <= 50 && maxGapMs < 2000;
    const conclusion = pass
      ? `分帧行为与生产假设一致（帧大小恒定、时长误差 ${deltaMs.toFixed(0)}ms）：录音管线可直接流式落盘`
      : `与假设有偏差（帧大小种类 ${uniqueSizes.length}、时长误差 ${deltaMs.toFixed(0)}ms、最大空档 ${maxGapMs}ms）：需在 docs/03 §3 调整帧大小或加入"丢帧补偿"`;

    return { id: this.id, title: this.title, env: '', lines, conclusion };
  },
};
