/**
 * DB-07 / DB-10 / DB-14：文件系统吞吐、单文件写入上限、存储配额。
 *
 * 三项都必须在真机上跑：配额与上限由平台实现决定，开发者工具不模拟真实限制。
 * 共同纪律：**每个实验结束前清理自己写的文件**，否则会把 200MB 配额吃光
 * （这正是 DB-14 顺手要验证的东西）。
 */
import type { SpikeCase, SpikeLine } from '../types';
import { describeError, formatBytes } from '../types';
import { fileSize, readFileBuffer, sleep, unlink, writeFileBuffer } from '../util';

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

function openFd(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().open({
      filePath,
      flag: 'r',
      success: (res) => resolve(res.fd),
      fail: (error) => reject(error),
    });
  });
}

function readFd(fd: string, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().read({
      fd,
      arrayBuffer: new ArrayBuffer(length),
      position,
      length,
      success: (res) => resolve(res.bytesRead),
      fail: (error) => reject(error),
    });
  });
}

function closeFd(fd: string): Promise<void> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().close({ fd, success: () => resolve(), fail: () => resolve() });
  });
}

/** 造一个指定字节数的可写缓冲（内容不重要，只测写入路径）。 */
function makeBuffer(bytes: number): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint8Array(buffer);
  // 写入零以外的内容，避免平台做稀疏文件优化而虚高可写量
  for (let i = 0; i < view.length; i += 4096) view[i] = i & 0xff;
  return buffer;
}

export const db07: SpikeCase = {
  id: 'DB-07',
  title: 'fd 分块读的吞吐（渲染读素材的性能基础）',
  criteria: '分块读吞吐 ≥ 20MB/s，且打开 fd 的次数可控',
  blocks: '渲染调度（docs/03 §5.2）',
  needsDevice: true,
  async run(log) {
    await ensureTmpDir();
    const lines: SpikeLine[] = [];
    // 30s 立体声 44.1k ≈ 5.3MB，接近一次预览渲染会读到的量级
    const filePath = `${TMP_DIR()}/throughput-30s.wav`;
    const seconds = 30;
    const channels = 2;
    const frames = seconds * 44100;
    const bytes = 44 + frames * channels * 2;

    try {
      log('生成 30 秒立体声素材…');
      await writeFileBuffer(filePath, makeBuffer(bytes));
      const actual = await fileSize(filePath);
      lines.push({ label: '文件大小', value: formatBytes(actual) });

      // ① 一次性读（对照）
      const wholeStart = Date.now();
      const whole = await readFileBuffer(filePath);
      const wholeMs = Date.now() - wholeStart;
      lines.push({
        label: 'readFile 整段',
        value: `${wholeMs}ms · ${(whole.byteLength / 1024 / 1024 / (wholeMs / 1000)).toFixed(1)}MB/s`,
      });

      // ② fd 分块读：按不同块大小各测一遍（清单要求 4KB / 64KB / 1MB）
      const chunkSizes = [4096, 65536, 1024 * 1024];
      let bestMbPerSec = 0;
      let bestChunk = 0;
      for (const chunkBytes of chunkSizes) {
        const fd = await openFd(filePath);
        let position = 44;
        let bytesRead = 0;
        let reads = 0;
        const chunkStart = Date.now();
        while (position < actual && reads < 20000) {
          const got = await readFd(fd, chunkBytes, position);
          if (got <= 0) break;
          bytesRead += got;
          position += got;
          reads++;
        }
        const chunkMs = Date.now() - chunkStart;
        await closeFd(fd);

        const mbPerSec = bytesRead / 1024 / 1024 / Math.max(0.001, chunkMs / 1000);
        if (mbPerSec > bestMbPerSec) {
          bestMbPerSec = mbPerSec;
          bestChunk = chunkBytes;
        }
        lines.push({
          label: `fd 分块读 ${formatBytes(chunkBytes)}×${reads}`,
          value: `${chunkMs}ms · ${formatBytes(bytesRead)} · ${mbPerSec.toFixed(1)}MB/s`,
          ok: mbPerSec >= 20,
        });
      }
      lines.push({
        label: '最优块大小',
        value: `${formatBytes(bestChunk)} · ${bestMbPerSec.toFixed(1)}MB/s`,
        ok: bestMbPerSec >= 20,
      });
      const mbPerSec = bestMbPerSec;

      // ③ 每次重新 open 的开销（渲染里会为每个素材块区间打开一次）
      const openStart = Date.now();
      for (let i = 0; i < 10; i++) {
        const handle = await openFd(filePath);
        await readFd(handle, 65536, 44);
        await closeFd(handle);
      }
      const openMs = Date.now() - openStart;
      lines.push({ label: '10 次 open+read(64KB)+close', value: `${openMs}ms`, ok: openMs < 200 });

      const conclusion =
        mbPerSec >= 20
          ? `最优分块 ${formatBytes(bestChunk)}，吞吐 ${mbPerSec.toFixed(1)}MB/s，每次 open+read 平均 ${(openMs / 10).toFixed(1)}ms：渲染逐块取素材不会成为瓶颈`
          : `最快也只有 ${mbPerSec.toFixed(1)}MB/s（分块 ${formatBytes(bestChunk)}），需在 docs/03 §5.4 加大单次读的块大小`;

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
      await unlink(filePath);
    }
  },
};

export const db10: SpikeCase = {
  id: 'DB-10',
  title: '单次 writeFile 的大小上限与 1300202',
  criteria: '确认 100MB 上限与错误码，导出前的体积校验要有依据',
  blocks: '导出（EX-1）与导入落盘',
  needsDevice: true,
  async run(log) {
    await ensureTmpDir();
    const lines: SpikeLine[] = [];
    // 从 10MB 起逐级加倍，直到失败；每级写完立即删除，避免影响后续配额实验
    const sizesMb = [10, 50, 90, 100, 110, 150, 210];
    let firstFailureMb: number | null = null;

    for (const mb of sizesMb) {
      const filePath = `${TMP_DIR()}/limit-${mb}mb.bin`;
      log(`尝试写入 ${mb}MB…`);
      try {
        const started = Date.now();
        await writeFileBuffer(filePath, makeBuffer(mb * 1024 * 1024));
        const written = await fileSize(filePath);
        lines.push({
          label: `${mb}MB`,
          ok: true,
          value: `OK ${Date.now() - started}ms · 实际 ${formatBytes(written)}`,
        });
        await unlink(filePath);
      } catch (error) {
        firstFailureMb = firstFailureMb ?? mb;
        lines.push({ label: `${mb}MB`, ok: false, value: `FAIL ${describeError(error)}` });
        await unlink(filePath);
      }
      await sleep(120);
    }

    // 平台错误码：1300202 = 存储空间不足（docs/02 §1.4）
    const hasQuotaCode = lines.some((line) => line.value.includes('1300202'));
    const conclusion = firstFailureMb
      ? `首次失败在 ${firstFailureMb}MB${hasQuotaCode ? '（出现 1300202）' : '（未出现 1300202，需在 docs/02 更正错误码表）'}；导出前体积校验应以该值收敛`
      : `到 ${sizesMb[sizesMb.length - 1]}MB 全部成功，单文件上限高于预期；导出体积校验可保持 100MB 保守值`;

    return { id: this.id, title: this.title, env: '', lines, conclusion };
  },
};

export const db14: SpikeCase = {
  id: 'DB-14',
  title: '本地用户文件的可写总量（200MB 配额验证）',
  criteria: '确认 200MB 配额与失败时的错误码，容量策略的百分比分母才成立',
  blocks: '容量策略（docs/05 §5）',
  needsDevice: true,
  async run(log) {
    await ensureTmpDir();
    const lines: SpikeLine[] = [];
    const chunkMb = 10;
    const maxChunks = 30;
    const written: string[] = [];
    let totalMb = 0;
    let failure: string | null = null;

    try {
      for (let i = 0; i < maxChunks; i++) {
        const filePath = `${TMP_DIR()}/quota-${i}.bin`;
        log(`累计写入 ${totalMb}MB…`);
        try {
          await writeFileBuffer(filePath, makeBuffer(chunkMb * 1024 * 1024));
          const size = await fileSize(filePath);
          if (size <= 0) {
            failure = `第 ${i + 1} 块写入后大小为 0（平台静默失败）`;
            break;
          }
          written.push(filePath);
          totalMb += size / 1024 / 1024;
        } catch (error) {
          failure = describeError(error);
          break;
        }
      }

      lines.push({ label: '累计可写', value: `${totalMb.toFixed(0)}MB`, ok: totalMb >= 190 });
      lines.push({
        label: '失败信息',
        value: failure ?? `写到 ${maxChunks * chunkMb}MB 仍未失败（未触到配额）`,
        ...(failure ? { ok: false } : {}),
      });

      const quotaHolds = totalMb >= 190 && totalMb <= 230;
      const conclusion = quotaHolds
        ? `实测约 ${totalMb.toFixed(0)}MB，与官方 200MB 吻合；docs/05 §5 的百分比阈值可用`
        : failure
          ? `在 ${totalMb.toFixed(0)}MB 失败：${failure}；若明显低于 200MB，需下调 docs/05 §5 的容量策略阈值`
          : `写到 ${maxChunks * chunkMb}MB 仍未失败，实际配额高于 200MB（按保守值使用即可）`;

      return { id: this.id, title: this.title, env: '', lines, conclusion };
    } finally {
      // 必须清理：这是容量实验，留着会把用户可写空间吃光
      for (const path of written) await unlink(path);
    }
  },
};
