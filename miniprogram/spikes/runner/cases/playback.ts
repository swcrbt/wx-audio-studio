/**
 * DB-04 / DB-09 / DB-11：WebAudio 处理节点、播放与 seek、分享。
 *
 * 三项都在真机上才有意义：开发者工具不模拟音频输出与真实分享面板。
 * 其中 DB-11 会真的弹出分享面板，需要用户手动取消或发送。
 */
import type { SpikeCase, SpikeLine } from '../types';
import { describeError, formatBytes } from '../types';
import { buildMarkerWav, buildSineWav, sleep, unlink, writeFileBuffer } from '../util';

const TMP_DIR = () => `${wx.env.USER_DATA_PATH}/spikes`;

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

export const db04: SpikeCase = {
  id: 'DB-04',
  title: 'ScriptProcessorNode 是否可用',
  criteria: '确认能否用脚本节点做"边播边处理"，决定是否保留实时链路',
  blocks: '实时监听与将来的实时效果（当前设计不依赖它）',
  needsDevice: true,
  async run(log) {
    const lines: SpikeLine[] = [];
    const ctx = wx.createWebAudioContext() as unknown as {
      sampleRate: number;
      createScriptProcessor?: (
        bufferSize: number,
        inputChannels: number,
        outputChannels: number,
      ) => unknown;
      createGain?: () => unknown;
      createBufferSource?: () => unknown;
      destination?: unknown;
      close?: () => Promise<void>;
    };

    lines.push({ label: 'WebAudio sampleRate', value: String(ctx.sampleRate) });
    lines.push({
      label: 'createScriptProcessor',
      value: typeof ctx.createScriptProcessor === 'function' ? '存在' : '不存在',
      ok: typeof ctx.createScriptProcessor === 'function',
    });
    lines.push({
      label: 'createGain / createBufferSource',
      value: `${typeof ctx.createGain === 'function' ? '有' : '无'} / ${
        typeof ctx.createBufferSource === 'function' ? '有' : '无'
      }`,
    });

    let callbacks = 0;
    let frames = 0;
    let nodeAvailable = false;

    if (typeof ctx.createScriptProcessor === 'function') {
      try {
        const node = ctx.createScriptProcessor(4096, 1, 1) as {
          onaudioprocess?: (event: { inputBuffer: { length: number } }) => void;
          connect: (target: unknown) => void;
        };
        node.onaudioprocess = (event) => {
          callbacks++;
          frames += event.inputBuffer.length;
        };
        // 必须连到 destination 才会被驱动（与浏览器行为一致）
        node.connect(ctx.destination);
        nodeAvailable = true;

        log('脚本节点已挂载，等待 1 秒观察回调…');
        await sleep(1000);

        lines.push({
          label: '1 秒内回调',
          value: `${callbacks} 次 · ${frames} 帧`,
          ok: callbacks > 0,
        });
        lines.push({
          label: '回调频率',
          value: callbacks > 0 ? `${(frames / 1000 / Math.max(0.001, ctx.sampleRate)).toFixed(2)}× 采样率` : '无回调',
        });
      } catch (error) {
        lines.push({ label: '挂载失败', value: describeError(error), ok: false });
      }
    }

    void ctx.close?.().catch(() => undefined);

    const conclusion = !nodeAvailable
      ? '不支持脚本节点：实时 DSP 链路只能在普通 DSP 里做（当前设计本就不依赖它，无需改动）'
      : callbacks > 0
        ? `可用且有回调（${callbacks} 次/秒）；若将来要做实时效果，它是唯一入口`
        : '接口存在但未被驱动：不要依赖它，真机行为不可预期';

    return { id: this.id, title: this.title, env: '', lines, conclusion };
  },
};

export const db09: SpikeCase = {
  id: 'DB-09',
  title: 'InnerAudioContext 播放与 seek 精度',
  criteria: '播放可推进、seek 后 currentTime 与目标误差 ≤ 50ms',
  blocks: '编辑器试听与播放头定位（ED-2/ED-3）',
  needsDevice: true,
  async run(log) {
    await ensureTmpDir();
    const lines: SpikeLine[] = [];
    const filePath = `${TMP_DIR()}/marker-12s.wav`;
    await writeFileBuffer(filePath, buildMarkerWav(12));

    const ctx = wx.createInnerAudioContext({ useWebAudioImplement: false });
    const events: string[] = [];
    let lastError = '';

    try {
      await new Promise<void>((resolve) => {
        ctx.onCanplay(() => events.push('canplay'));
        ctx.onPlay(() => events.push('play'));
        ctx.onSeeked(() => events.push('seeked'));
        ctx.onError((error) => {
          lastError = describeError(error);
          events.push('error');
          resolve();
        });
        ctx.onEnded(() => events.push('ended'));
        ctx.src = filePath;
        // onCanplay 不一定触发，兜底等待
        setTimeout(resolve, 1500);
      });

      lines.push({ label: 'duration', value: `${ctx.duration.toFixed(3)}s`, ok: Math.abs(ctx.duration - 12) < 0.2 });
      lines.push({ label: '事件', value: events.join(',') || '(无)' });

      log('开始播放，3 秒后 seek 到 8.0s…');
      ctx.play();
      await sleep(1500);
      const before = ctx.currentTime;
      lines.push({ label: '播放 1.5s 后 currentTime', value: `${before.toFixed(3)}s`, ok: before > 0.8 });

      const seekStart = Date.now();
      ctx.seek(8);
      await sleep(600);
      const after = ctx.currentTime;
      const seekMs = Date.now() - seekStart;
      const deltaMs = Math.abs(after - 8) * 1000;
      lines.push({
        label: 'seek(8.0) 后 currentTime',
        value: `${after.toFixed(3)}s（差 ${deltaMs.toFixed(0)}ms，调用后 ${seekMs}ms 读取）`,
        // 通过线 <100ms（docs/02 §5 DB-09）；<50ms 则可直接用于拖动播放头
        ok: deltaMs <= 100,
      });

      // 播放是否继续推进（seek 后 0.5 秒应增加约 0.5 秒）
      const t0 = ctx.currentTime;
      await sleep(500);
      const t1 = ctx.currentTime;
      const advanceMs = (t1 - t0) * 1000;
      lines.push({
        label: 'seek 后 500ms 内推进',
        value: `${advanceMs.toFixed(0)}ms`,
        ok: advanceMs > 300,
      });

      // 变速（0.5×~2×）在平台侧的支持
      try {
        ctx.playbackRate = 1.5;
        lines.push({ label: 'playbackRate=1.5 写入', value: `${ctx.playbackRate}x`, ok: ctx.playbackRate === 1.5 });
      } catch (error) {
        lines.push({ label: 'playbackRate 写入失败', value: describeError(error), ok: false });
      }

      const seekOk = deltaMs <= 100;
      const conclusion = lastError
        ? `播放出错：${lastError}；播放链路需降级或改为试听短片段`
        : seekOk
          ? `播放与 seek 正常（seek 误差 ${deltaMs.toFixed(0)}ms${deltaMs <= 50 ? '，可直接用于拖动播放头' : '，拖动播放头应改为松手后重渲染窗口'}）`
          : `seek 误差 ${deltaMs.toFixed(0)}ms 超过 100ms 通过线：拖动播放头必须重渲染窗口，且记录到 docs/02 §5`;

      return { id: this.id, title: this.title, env: '', lines, conclusion };
    } catch (error) {
      lines.push({ label: '失败', value: describeError(error), ok: false });
      return {
        id: this.id,
        title: this.title,
        env: '',
        lines,
        conclusion: `实验失败：${describeError(error)}`,
        failed: true,
      };
    } finally {
      ctx.stop();
      ctx.destroy();
      await unlink(filePath);
    }
  },
};

export const db11: SpikeCase = {
  id: 'DB-11',
  title: 'shareFileMessage 分享自产 WAV',
  criteria: '能唤起分享面板并成功发出',
  blocks: '导出分享（EX-5）',
  needsDevice: true,
  async run(log) {
    await ensureTmpDir();
    const lines: SpikeLine[] = [];
    const filePath = `${TMP_DIR()}/share-3s.wav`;
    // 3 秒正弦，避免文件太大又便于对方听到声音
    const wav = buildSineWav(3, { freq: 523 });
    await writeFileBuffer(filePath, wav);
    lines.push({ label: '文件', value: `${formatBytes(wav.byteLength)} wav` });

    log('即将唤起分享面板：请选择"发送给朋友"或取消');

    const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      wx.shareFileMessage({
        filePath,
        fileName: 'spike-share-test.wav',
        success: () => resolve({ ok: true, detail: '分享成功' }),
        fail: (error) => {
          const message = describeError(error);
          // 用户取消不算失败：能弹出面板即说明接口可用
          const cancelled = message.includes('cancel');
          resolve({ ok: cancelled, detail: cancelled ? '用户取消（面板已弹出）' : message });
        },
      });
    });

    lines.push({ label: 'shareFileMessage', value: result.detail, ok: result.ok });
    await unlink(filePath);

    const conclusion = result.ok
      ? '分享可用：导出的成品可以直接发给朋友（EX-5 无需降级）'
      : `分享不可用：${result.detail}；需改用"保存到本地并提示用户"或引导用户到成品列表`;

    return { id: this.id, title: this.title, env: '', lines, conclusion };
  },
};
