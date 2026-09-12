/**
 * 极简 Worker 请求/响应客户端（仅 M0 使用）。
 * 小程序 Worker 是纯消息式的，这里用一个 pending 表把"发消息 → 等特定类型回包"包装成 Promise。
 */
export interface WorkerMessage {
  type: string;
  [key: string]: unknown;
}

export class WorkerClient {
  private readonly worker: WechatMiniprogram.Worker;
  private readonly pending = new Map<string, (message: WorkerMessage) => void>();
  private readonly inbox: WorkerMessage[] = [];

  constructor(scriptPath: string, options: { useExperimentalWorker?: boolean } = {}) {
    this.worker = wx.createWorker(scriptPath, options);
    this.worker.onMessage((res: unknown) => {
      const unwrapped = (res as { data?: unknown }).data ?? res;
      if (typeof unwrapped !== 'object' || unwrapped === null) return;
      const message = unwrapped as WorkerMessage;
      const handler = this.pending.get(message.type);
      if (handler) {
        this.pending.delete(message.type);
        handler(message);
        return;
      }
      this.inbox.push(message);
    });
  }

  send(message: WorkerMessage): void {
    this.worker.postMessage(message);
  }

  /** 发送并等待指定类型的回包。 */
  request<T extends WorkerMessage>(message: WorkerMessage, expectedType: string, timeoutMs = 20000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(expectedType);
        reject(new Error(`等待 ${expectedType} 回包超时（${timeoutMs}ms）`));
      }, timeoutMs);

      this.pending.set(expectedType, (received) => {
        clearTimeout(timer);
        resolve(received as T);
      });

      this.worker.postMessage(message);
    });
  }

  terminate(): void {
    try {
      this.worker.terminate();
    } catch {
      // 忽略：终止失败不影响实验结论
    }
  }
}
