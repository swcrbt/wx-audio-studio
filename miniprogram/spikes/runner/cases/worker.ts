/**
 * DB-05 / DB-06 实验：Worker 内可用能力与跨线程拷贝开销。
 */
import type { SpikeCase, SpikeLine } from '../types';
import { describeError, formatBytes } from '../types';
import { WorkerClient } from '../worker-client';

const SPIKE_WORKER = 'workers/spike/index.js';
const SELF_CHECK_ITERATIONS = 3_000_000;

/** 与 Worker 内相同的计算，用于对比主线程与 Worker 的执行效率。 */
function mainThreadSelfCheck(): number {
  let checksum = 0;
  for (let i = 0; i < SELF_CHECK_ITERATIONS; i++) {
    checksum += Math.sin(i * 0.001) * Math.cos(i * 0.002);
  }
  return checksum;
}

function makePayload(bytes: number): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i += 1024) view[i] = i & 0xff;
  return buffer;
}

export const db05: SpikeCase = {
  id: 'DB-05',
  title: 'Worker 内可用能力与代码装载',
  criteria: '得到可用内建对象清单 + 确定的 Worker 代码组织方式',
  blocks: '渲染架构（D-06）',
  needsDevice: false,
  async run(log) {
    const lines: SpikeLine[] = [];
    let client: WorkerClient | null = null;

    try {
      client = new WorkerClient(SPIKE_WORKER);
      lines.push({
        label: '创建 Worker（workers/spike/index.js）',
        value: '成功 —— 说明 workers 目录内的 .ts 已被编译，且多入口可共存',
        ok: true,
      });
    } catch (error) {
      lines.push({
        label: '创建 Worker',
        value: `失败：${describeError(error)}`,
        ok: false,
      });
      return {
        id: this.id,
        title: this.title,
        env: '',
        lines,
        conclusion: 'Worker 不可用：渲染必须退回主线程分片方案',
        failed: true,
      };
    }

    try {
      const probe = await client.request<{ type: string; items: Array<{ name: string; available: boolean; detail: string }> }>(
        { type: 'probe' },
        'probeResult',
      );
      for (const item of probe.items) {
        lines.push({ label: item.name, value: `${item.available ? '可用' : '不可用'} (${item.detail})`, ok: item.available });
      }

      const workerStart = Date.now();
      const workerCheck = await client.request<{ type: string; result: { ms: number; checksum: number } }>(
        { type: 'selfCheck' },
        'selfCheckResult',
      );
      const workerRoundTripMs = Date.now() - workerStart;

      const mainStart = Date.now();
      const mainChecksum = mainThreadSelfCheck();
      const mainMs = Date.now() - mainStart;

      lines.push({
        label: `重计算 ${SELF_CHECK_ITERATIONS.toLocaleString()} 次 sin/cos`,
        value: `Worker ${workerCheck.result.ms}ms（往返 ${workerRoundTripMs}ms）vs 主线程 ${mainMs}ms`,
      });
      lines.push({
        label: '校验和一致性',
        value: Math.abs(workerCheck.result.checksum - mainChecksum) < 1e-6 ? '一致' : '不一致（需排查）',
        ok: Math.abs(workerCheck.result.checksum - mainChecksum) < 1e-6,
      });
      log(`Worker 探测完成：${lines.length} 行结果`);

      const unavailable = probe.items.filter((item) => !item.available).map((item) => item.name);
      const conclusion = [
        `Worker 可用（workers 目录内 TS 编译正常，多入口可用）`,
        unavailable.length > 0 ? `不可用：${unavailable.join('、')}` : '探测项全部可用',
        `Worker 重计算耗时为主线程的 ${(workerCheck.result.ms / Math.max(1, mainMs)).toFixed(2)}×`,
      ].join('；');

      return { id: this.id, title: this.title, env: '', lines, conclusion };
    } catch (error) {
      lines.push({ label: '探测失败', value: describeError(error), ok: false });
      return {
        id: this.id,
        title: this.title,
        env: '',
        lines,
        conclusion: `探测中断：${describeError(error)}`,
        failed: true,
      };
    } finally {
      client.terminate();
    }
  },
};

export const db06: SpikeCase = {
  id: 'DB-06',
  title: 'Worker 传 ArrayBuffer 的实际拷贝耗时',
  criteria: '得出单块最优大小（2s @44.1k 单声道 = 176KB，立体声 352KB）',
  blocks: '渲染架构',
  needsDevice: true,
  async run() {
    const lines: SpikeLine[] = [];
    const sizes = [176 * 1024, 352 * 1024, 1024 * 1024, 10 * 1024 * 1024];
    const rounds = 5;
    let client: WorkerClient | null = null;

    try {
      client = new WorkerClient(SPIKE_WORKER);
    } catch (error) {
      return {
        id: this.id,
        title: this.title,
        env: '',
        lines: [{ label: '创建 Worker', value: describeError(error), ok: false }],
        conclusion: 'Worker 不可用，无法测拷贝耗时',
        failed: true,
      };
    }

    try {
      for (const size of sizes) {
        const samples: number[] = [];
        for (let round = 0; round < rounds; round++) {
          const payload = makePayload(size);
          const started = Date.now();
          await client.request(
            { type: 'echo', payload },
            'echoResult',
            60000,
          );
          samples.push(Date.now() - started);
        }
        const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        lines.push({
          label: formatBytes(size),
          value: `往返平均 ${average.toFixed(1)}ms（${samples.join('/')}ms）`,
        });
      }

      const chunkLine = lines[0];
      const conclusion = [
        '按"每块一次往返"估算：单块 176KB 与 352KB 的耗时决定 2s 块是否合适',
        chunkLine ? `176KB 往返 ${chunkLine.value}` : '',
        '若往返耗时接近块计算耗时，应增大块大小以减少往返次数',
      ]
        .filter((part) => part.length > 0)
        .join('；');

      return { id: this.id, title: this.title, env: '', lines, conclusion };
    } catch (error) {
      lines.push({ label: '测量失败', value: describeError(error), ok: false });
      return { id: this.id, title: this.title, env: '', lines, conclusion: describeError(error), failed: true };
    } finally {
      client.terminate();
    }
  },
};
