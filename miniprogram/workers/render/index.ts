/**
 * Worker 入口：消息分发与分块渲染调度（只放协议与调度，不放算法）。
 *
 * 两条平台限制决定了这个入口的形状：
 * - Worker 内没有 `wx` 系列 API，素材只能由主线程读盘后传进来；
 * - Worker 内只能引用本目录下的文件，所以纯计算代码全部放在 `workers/render/`。
 */
import type {
  MainToWorkerMessage,
  RenderJob,
  WorkerToMainMessage,
} from '../../core/engine/worker-protocol';
import {
  initJob,
  planChunk,
  renderChunk,
  type AssetFrameRequest,
  type AssetPcmMap,
  type AssetPcmSlice,
  type RenderState,
} from './render';

/** Worker 上下文的全局对象（小程序未提供 TS 类型，此处最小声明）。 */
interface WorkerScope {
  onMessage(listener: (res: unknown) => void): void;
  postMessage(message: unknown): void;
  onProcessKilled?(listener: () => void): void;
}

declare const worker: WorkerScope;

let state: RenderState | null = null;
let cancelled = false;
let currentChunk = 0;
const assets: AssetPcmMap = new Map();

function send(message: WorkerToMainMessage): void {
  worker.postMessage(message);
}

function sliceFrames(slice: AssetPcmSlice): number {
  return Math.floor(slice.data.length / Math.max(1, slice.channels));
}

/** 已缓存的切片是否完整覆盖该请求区间。 */
function covers(slice: AssetPcmSlice, request: AssetFrameRequest): boolean {
  return (
    slice.startFrame <= request.startFrame &&
    slice.startFrame + sliceFrames(slice) >= request.startFrame + request.frameCount
  );
}

function needsFetch(request: AssetFrameRequest): boolean {
  const slice = assets.get(request.assetId);
  return !slice || !covers(slice, request);
}

/** 开始渲染第 `chunkIndex` 块；素材不全则先向主线程要数据并挂起。 */
function startChunk(chunkIndex: number): void {
  if (!state || cancelled) return;
  currentChunk = chunkIndex;

  const requests = planChunk(state, chunkIndex);
  const missing = requests.filter(needsFetch);
  if (missing.length > 0) {
    for (const request of missing) {
      send({
        type: 'assetRequest',
        assetId: request.assetId,
        startFrame: request.startFrame,
        frameCount: request.frameCount,
      });
    }
    return; // 等主线程回传 assetChunk
  }

  renderAndSend(chunkIndex);
}

function renderAndSend(chunkIndex: number): void {
  if (!state || cancelled) return;

  const result = renderChunk(state, chunkIndex, assets);
  const nextChunk = result.isLast ? null : chunkIndex + 1;

  // 渲染缓冲会被下一块复用：先复制再回传（postMessage 本身是复制语义）
  send({
    type: 'chunkDone',
    chunkIndex,
    pcmBuffer: result.pcm.slice().buffer,
    nextChunk,
  });
  send({ type: 'progress', done: chunkIndex + 1, total: state.totalChunks });

  if (nextChunk === null) {
    send({ type: 'done', bytes: result.pcm.byteLength, frames: state.totalFrames });
    state = null;
    assets.clear();
    return;
  }

  startChunk(nextChunk);
}

function handleInit(job: RenderJob): void {
  try {
    state = initJob(job);
  } catch (error) {
    state = null;
    send({
      type: 'error',
      code: 'invalidJob',
      message: error instanceof Error ? error.message : 'invalid render job',
    });
    return;
  }

  cancelled = false;
  assets.clear();
  send({ type: 'progress', done: 0, total: state.totalChunks });
  startChunk(0);
}

/**
 * 官方示例中 `onMessage` 的回调参数就是消息本体，但不同基础库/包装层可能传 `{ data }`，
 * 因此两种形状都接受，避免因版本差异导致静默失效。
 */
function unwrap(res: unknown): MainToWorkerMessage | null {
  if (typeof res !== 'object' || res === null) return null;
  const wrapped = res as { data?: MainToWorkerMessage };
  const candidate = wrapped.data ?? (res as MainToWorkerMessage);
  return typeof candidate.type === 'string' ? candidate : null;
}

worker.onMessage((raw) => {
  const message = unwrap(raw);
  if (!message) return;

  switch (message.type) {
    case 'init':
      handleInit(message.job);
      return;

    case 'assetChunk': {
      assets.set(message.assetId, {
        startFrame: message.startFrame,
        channels: message.channels,
        data: new Int16Array(message.pcmBuffer),
      });
      if (!state || cancelled) return;
      // 当前块的素材齐了才继续渲染
      const requests = planChunk(state, currentChunk);
      if (requests.every((request) => !needsFetch(request))) {
        renderAndSend(currentChunk);
      }
      return;
    }

    case 'cancel':
      cancelled = true;
      state = null;
      assets.clear();
      send({ type: 'error', code: 'cancelled', message: '渲染已取消' });
      return;

    default:
      return;
  }
});

worker.onProcessKilled?.(() => {
  // 实验 Worker 可能被系统回收：复位状态，由主线程决定是否重新初始化
  state = null;
  cancelled = true;
  assets.clear();
});
