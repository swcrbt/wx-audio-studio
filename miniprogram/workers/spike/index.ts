/**
 * M0 专用测试 Worker。
 *
 * 用途：探测 Worker 内的可用能力（wx API 白名单、内建对象）与 postMessage 拷贝开销。
 * 它不参与业务逻辑，M0 结论回填后随 `spikes/` 一起删除。
 *
 * 消息协议（仅 M0 用）：
 *   主线程 → Worker: { type: 'probe' } | { type: 'echo', payload: ArrayBuffer } | { type: 'selfCheck' }
 *   Worker → 主线程: { type: 'probeResult', items } | { type: 'echoResult', bytes, workerMs } | { type: 'error' }
 */
interface WorkerScope {
  onMessage(listener: (res: unknown) => void): void;
  postMessage(message: unknown): void;
}

declare const worker: WorkerScope;

interface ProbeItem {
  name: string;
  available: boolean;
  detail: string;
}

function probe(name: string, fn: () => unknown): ProbeItem {
  try {
    const value = fn();
    return { name, available: true, detail: value === undefined ? 'ok' : String(value) };
  } catch (error) {
    return {
      name,
      available: false,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/** 探测 Worker 内可直接访问的全局能力。 */
function probeGlobals(): ProbeItem[] {
  const scope = globalThis as unknown as Record<string, unknown>;
  return [
    probe('typeof wx', () => typeof scope.wx),
    probe('wx 存在时能否读 env', () => {
      const wx = scope.wx as { env?: { USER_DATA_PATH?: string } } | undefined;
      if (!wx) return 'wx 不存在';
      return wx.env?.USER_DATA_PATH ?? 'wx.env 不存在';
    }),
    probe('Date.now()', () => Date.now()),
    probe('Math.sin(1)', () => Math.sin(1)),
    probe('Float32Array', () => new Float32Array([1, 2, 3]).length),
    probe('Int16Array', () => new Int16Array([1, 2, 3]).length),
    probe('TextEncoder', () => new TextEncoder().encode('x').length),
    probe('TextDecoder', () => new TextDecoder().decode(new Uint8Array([120]))),
    probe('console.log', () => {
      console.log('[spike worker] console works');
      return 'ok';
    }),
    probe('JSON.parse', () => JSON.parse('{"a":1}').a),
    probe('performance.now', () => (scope.performance as { now?: () => number } | undefined)?.now?.()),
  ];
}

/** 在 Worker 内做一段重计算，用于与主线程对比执行效率。 */
function selfCheck(): { iterations: number; ms: number; checksum: number } {
  const iterations = 3_000_000;
  const started = Date.now();
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    checksum += Math.sin(i * 0.001) * Math.cos(i * 0.002);
  }
  return { iterations, ms: Date.now() - started, checksum };
}

worker.onMessage((res: unknown) => {
  const message = (res as { data?: unknown }).data ?? res;
  if (typeof message !== 'object' || message === null) return;
  const typed = message as { type?: string; payload?: ArrayBuffer };

  if (typed.type === 'probe') {
    worker.postMessage({ type: 'probeResult', items: probeGlobals() });
    return;
  }

  if (typed.type === 'selfCheck') {
    worker.postMessage({ type: 'selfCheckResult', result: selfCheck() });
    return;
  }

  if (typed.type === 'echo' && typed.payload) {
    const started = Date.now();
    // 触碰字节，避免被优化掉
    const view = new Uint8Array(typed.payload);
    let sum = 0;
    for (let i = 0; i < view.length; i += 4096) sum += view[i] ?? 0;
    worker.postMessage({
      type: 'echoResult',
      bytes: typed.payload.byteLength,
      workerMs: Date.now() - started,
      checksum: sum,
      payload: typed.payload,
    });
    return;
  }

  worker.postMessage({ type: 'error', message: 'unknown message type' });
});
