/**
 * DB-01 / DB-03 实验：解码格式矩阵与 AudioBuffer 读取面。
 */
import type { SpikeCase, SpikeLine } from '../types';
import { describeError, extensionOf, formatBytes } from '../types';
import { buildSineWav, decodeAudio, readFileBuffer, unlink, writeFileBuffer } from '../util';

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

/** 解码一个文件，返回单行结果。 */
async function decodeOne(label: string, filePath: string): Promise<SpikeLine> {
  const ctx = wx.createWebAudioContext();
  const started = Date.now();
  try {
    const data = await readFileBuffer(filePath);
    const audio = await decodeAudio(ctx, data);
    const ms = Date.now() - started;
    void ctx.close();
    return {
      label,
      ok: true,
      value: `OK ${ms}ms ${audio.sampleRate}Hz ${audio.numberOfChannels}ch ${audio.duration.toFixed(3)}s`,
    };
  } catch (error) {
    const ms = Date.now() - started;
    void ctx.close();
    return { label, ok: false, value: `FAIL ${ms}ms ${describeError(error)}` };
  }
}

function chooseMessageFiles(): Promise<Array<{ path: string; size: number }>> {
  return new Promise((resolve) => {
    wx.chooseMessageFile({
      count: 10,
      type: 'file',
      extension: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'amr', 'ape', 'wma', 'mp4', 'silk'],
      success: (res) => resolve(res.tempFiles.map((file) => ({ path: file.path, size: file.size }))),
      fail: () => resolve([]),
    });
  });
}

export const db01: SpikeCase = {
  id: 'DB-01',
  title: 'decodeAudioData 支持哪些格式',
  criteria: '明确"支持/不支持"格式矩阵',
  blocks: '导入（IN-4/IN-5）',
  needsDevice: false,
  async run(log) {
    await ensureTmpDir();
    const lines: SpikeLine[] = [];

    // ① 自产 WAV（验证我们的中间格式能被自己解出来，这是导入降级路径的基础）
    const monoPath = `${TMP_DIR()}/self-made-1s-mono.wav`;
    const stereoPath = `${TMP_DIR()}/self-made-5s-stereo.wav`;
    await writeFileBuffer(monoPath, buildSineWav(1, { channels: 1 }));
    await writeFileBuffer(stereoPath, buildSineWav(5, { channels: 2, freq: 220 }));
    lines.push(await decodeOne('自产 WAV 1s 单声道', monoPath));
    lines.push(await decodeOne('自产 WAV 5s 立体声', stereoPath));

    // ② 用户从微信聊天里选真实文件（覆盖产品主路径）
    log('请选择微信聊天里的音频文件（可多选，建议含 mp3 / m4a / wav / amr）');
    const files = await chooseMessageFiles();
    if (files.length === 0) {
      lines.push({ label: '聊天文件', value: '未选择（该行不计入结论）' });
    }
    for (const file of files) {
      const label = `${extensionOf(file.path)} ${formatBytes(file.size)}`;
      lines.push(await decodeOne(label, file.path));
    }

    const supported = new Set<string>();
    const unsupported = new Set<string>();
    for (const line of lines) {
      if (line.label.startsWith('自产')) continue;
      const ext = line.label.split(' ')[0] ?? '?';
      if (line.ok === true) supported.add(ext);
      else if (line.ok === false) unsupported.add(ext);
    }

    await unlink(monoPath);
    await unlink(stereoPath);

    const conclusion = [
      `支持: ${[...supported].join(', ') || '（未测到）'}`,
      `不支持: ${[...unsupported].join(', ') || '（未测到）'}`,
      '自产 WAV 能否被解码决定"降级再解码"路线是否可行',
    ].join('；');

    return { id: this.id, title: this.title, env: '', lines, conclusion };
  },
};

export const db03: SpikeCase = {
  id: 'DB-03',
  title: 'AudioBuffer 的读取行为与耗时',
  criteria: '确认 PCM 读取方式（getChannelData / copyFromChannel）与耗时',
  blocks: '导入管线',
  needsDevice: true,
  async run(log) {
    await ensureTmpDir();
    const lines: SpikeLine[] = [];
    const filePath = `${TMP_DIR()}/self-made-60s.wav`;
    await writeFileBuffer(filePath, buildSineWav(60, { channels: 2, freq: 330 }));

    const ctx = wx.createWebAudioContext();
    try {
      const data = await readFileBuffer(filePath);
      const decodeStart = Date.now();
      const audio = await decodeAudio(ctx, data);
      lines.push({
        label: '解码 60s 立体声 WAV',
        value: `${Date.now() - decodeStart}ms`,
        ok: true,
      });
      lines.push({
        label: '属性',
        value: `sampleRate=${audio.sampleRate} channels=${audio.numberOfChannels} length=${audio.length} duration=${audio.duration.toFixed(3)}s`,
      });

      // getChannelData 读取整个声道（若返回的是内部引用的视图，耗时应极短）
      const readStart = Date.now();
      const channel0 = audio.getChannelData(0);
      const viewMs = Date.now() - readStart;
      let sum = 0;
      const scanStart = Date.now();
      for (let i = 0; i < channel0.length; i += 64) sum += channel0[i] ?? 0;
      const scanMs = Date.now() - scanStart;
      log(`getChannelData 返回长度 ${channel0.length}，抽样遍历 checksum=${sum.toFixed(2)}`);
      lines.push({ label: 'getChannelData', value: `${viewMs}ms（返回长度 ${channel0.length}）`, ok: true });
      lines.push({ label: '遍历 1/64 采样耗时', value: `${scanMs}ms` });

      const copyAvailable = typeof audio.copyFromChannel === 'function';
      lines.push({ label: 'copyFromChannel 可用', value: copyAvailable ? '是' : '否', ok: copyAvailable });
      if (copyAvailable && audio.copyFromChannel) {
        const dst = new Float32Array(audio.length);
        const copyStart = Date.now();
        audio.copyFromChannel(dst, 1, 0);
        lines.push({ label: 'copyFromChannel 整声道耗时', value: `${Date.now() - copyStart}ms`, ok: true });
      }

      const conclusion = copyAvailable
        ? '两种读取方式都可用；copyFromChannel 存在明确的整段拷贝入口'
        : '只有 getChannelData 可用，需自行做整段拷贝';
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
      void ctx.close();
      await unlink(filePath);
    }
  },
};
