/**
 * 工程状态：内存中唯一的工程真相 + 撤销栈 + 自动保存。
 *
 * 三条纪律：
 * 1. **不可变替换**：状态整体替换（不就地改字段），UI 拿到的引用变化即可判定需要重绘；
 * 2. **变更必经 `commit`**：命令内部调用 `workers/render/edl/ops.ts` 的纯函数，
 *    任何绕过命令直接改 EDL 的写法都会破坏撤销链；
 * 3. **落盘策略集中在这里**：防抖保存、强制保存、失败降级只读，调用方不需要自己计时。
 *
 * 持久化通过 `persist` 注入：生产用文件系统实现（`createFsProjectPersist`），
 * 单测注入假实现即可验证调度与失败降级，无需触碰 `wx.*`。
 */
import type { Asset, Edl, Id, Project } from '../types';
import { HistoryStack, type EditCommand } from '../history/history';
import { countClips, edlDurationSec, referencedAssetIds } from '../../workers/render/edl/query';
import { removeAsset as removeAssetOp, upsertAsset } from '../../workers/render/edl/ops';
import { MAX_SAVE_FAILURES, SAVE_DEBOUNCE_MS } from '../../workers/render/constants';
import { readStoreIndex, upsertProjectEntry, writeProjectFile, type StoreIndex } from '../fs/store';
import { logger } from '../../utils/logger';

/** 视图状态：不进历史、不影响落盘（"恢复上次编辑位置"是体验项，失败可忽略）。 */
export interface UiState {
  playheadSec: number;
  selectionStartSec: number | null;
  selectionEndSec: number | null;
  pxPerSecond: number;
  activeTrackId: Id | null;
}

export function createUiState(): UiState {
  return {
    playheadSec: 0,
    selectionStartSec: null,
    selectionEndSec: null,
    pxPerSecond: 60,
    activeTrackId: null,
  };
}

export type ProjectStoreErrorCode = 'readOnly';

/** 状态层错误：只读模式下拒绝一切编辑。 */
export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode;

  constructor(code: ProjectStoreErrorCode, message: string) {
    super(message);
    this.name = 'ProjectStoreError';
    this.code = code;
  }
}

export interface ProjectSnapshot {
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  saveFailureCount: number;
  lastSavedAt: number | null;
  durationSec: number;
  clipCount: number;
}

export interface ProjectStoreOptions {
  project: Project;
  /** 落盘实现；缺省为内存模式（测试或临时工程）。 */
  persist?: (project: Project) => Promise<void>;
  now?: () => number;
  debounceMs?: number;
  maxSaveFailures?: number;
}

/** 落盘前剔除运行时字段（`refCount` 由内存计算，写进 JSON 会变成陈旧数据）。 */
export function serializeProject(project: Project): Project {
  return {
    ...project,
    // 显式列出落盘字段：Asset 新增字段时必须主动决定是否入库
    assets: project.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      origin: asset.origin,
      path: asset.path,
      sampleRate: asset.sampleRate,
      channels: asset.channels,
      durationSec: asset.durationSec,
      frames: asset.frames,
      bytes: asset.bytes,
      peakRef: asset.peakRef,
      createdAt: asset.createdAt,
    })),
  };
}

/** 生产用持久化：原子写工程 JSON + 更新索引（索引只读一次后常驻本闭包）。 */
export function createFsProjectPersist(): (project: Project) => Promise<void> {
  let index: StoreIndex | null = null;
  return async (project: Project): Promise<void> => {
    // 传入的 project 已由 store 剔除运行时字段，这里直接落盘
    await writeProjectFile(project);
    index = index ?? (await readStoreIndex());
    index = await upsertProjectEntry(index, project);
  };
}

export class ProjectStore {
  private state: Project;
  private readonly history: HistoryStack;
  private readonly persist: (project: Project) => Promise<void>;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly maxSaveFailures: number;
  private readonly listeners = new Set<(snapshot: ProjectSnapshot) => void>();

  private uiState: UiState = createUiState();
  /** 修订号：每次编辑递增，作为“待落盘目标”的标识（不依赖时钟）。 */
  private revision = 0;
  /** 待落盘的修订号；`null` 表示无未保存改动。 */
  private pendingRevision: number | null = null;
  /** 已尝试落盘的修订号：避免同一改动被 flush 反复重试（失败计数会虚高）。 */
  private attemptedRevision: number | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private saving = false;
  private readOnly = false;
  private saveFailureCount = 0;
  private lastSavedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProjectStoreOptions) {
    this.state = options.project;
    this.persist = options.persist ?? (async () => undefined);
    this.now = options.now ?? (() => Date.now());
    this.debounceMs = Math.max(0, options.debounceMs ?? SAVE_DEBOUNCE_MS);
    this.maxSaveFailures = Math.max(1, options.maxSaveFailures ?? MAX_SAVE_FAILURES);
    this.history = new HistoryStack({ now: this.now });
  }

  get project(): Project {
    return this.state;
  }

  get edl(): Edl {
    const { sampleRate, channels, assets, tracks } = this.state;
    return { sampleRate, channels, assets, tracks };
  }

  get snapshot(): ProjectSnapshot {
    return {
      dirty: this.pendingRevision !== null,
      saving: this.saving,
      readOnly: this.readOnly,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel,
      redoLabel: this.history.redoLabel,
      saveFailureCount: this.saveFailureCount,
      lastSavedAt: this.lastSavedAt,
      durationSec: this.state.summary.durationSec,
      clipCount: this.state.summary.clipCount,
    };
  }

  subscribe(listener: (snapshot: ProjectSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 视图状态不进历史、不落盘。 */
  get ui(): UiState {
    return this.uiState;
  }

  setUiState(patch: Partial<UiState>): void {
    this.uiState = { ...this.uiState, ...patch };
    this.notify();
  }

  /**
   * 应用并记录一条命令，随后调度自动保存。
   *
   * @throws {ProjectStoreError} 只读模式下抛出（连续保存失败已达上限）
   */
  commit(command: EditCommand): void {
    if (this.readOnly) {
      throw new ProjectStoreError('readOnly', '存储空间不足，已停止保存；请清理空间后重开工程');
    }
    const nextEdl = this.history.push(command, this.edl);
    this.state = this.deriveProject(nextEdl, this.now());
    this.markDirty();
  }

  undo(): boolean {
    if (!this.history.canUndo) return false;
    this.state = this.deriveProject(this.history.undo(this.edl), this.now());
    this.markDirty();
    return true;
  }

  redo(): boolean {
    if (!this.history.canRedo) return false;
    this.state = this.deriveProject(this.history.redo(this.edl), this.now());
    this.markDirty();
    return true;
  }

  /** 新增/替换素材（素材文件本身由调用方落盘，这里只登记元数据）。 */
  addAsset(asset: Asset): void {
    this.commit({
      id: `asset-add-${asset.id}`,
      label: '导入素材',
      at: this.now(),
      apply: (edl) => upsertAsset(edl, asset),
      invert: (edl) => removeAssetOp(edl, asset.id),
    });
  }

  /** 移除素材元数据；被片段引用的素材要先删掉引用它的片段。 */
  removeAsset(assetId: Id): void {
    const removed = this.state.assets.find((asset) => asset.id === assetId);
    if (!removed) return;
    if (this.referencedAssetIds().has(assetId)) return;

    this.commit({
      id: `asset-remove-${assetId}`,
      label: '删除素材',
      at: this.now(),
      apply: (edl) => removeAssetOp(edl, assetId),
      invert: (edl) => upsertAsset(edl, removed),
    });
  }

  setProjectName(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === this.state.name) return;
    this.state = { ...this.state, name: trimmed, updatedAt: this.now() };
    this.markDirty();
  }

  /** 当前 EDL 中被片段引用的素材 id。 */
  referencedAssetIds(): Set<Id> {
    return referencedAssetIds(this.edl);
  }

  /** 无片段引用、可以安全删除的素材（容量清理入口用）。 */
  unreferencedAssets(): Asset[] {
    const referenced = this.referencedAssetIds();
    return this.state.assets.filter((asset) => !referenced.has(asset.id));
  }

  /** 立即落盘（导出前、页面 `onHide`、退出编辑时调用）。 */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.saveChain;
    // 已排队的保存若已覆盖当前改动就不再补一次：失败时保留 dirty，等用户动作或下次编辑再试
    if (this.pendingRevision !== null && this.pendingRevision !== this.attemptedRevision) {
      await this.enqueueSave();
    }
  }

  /** 是否允许继续编辑（只读降级后为 `false`）。 */
  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** 人工解除只读（用户在容量提示里清理完空间后调用）。 */
  clearReadOnly(): void {
    this.readOnly = false;
    this.saveFailureCount = 0;
    this.notify();
  }

  /** 释放定时器；调用方如需保存请先 `await flush()`。 */
  dispose(): void {
    this.clearTimer();
    this.listeners.clear();
  }

  private deriveProject(edl: Edl, now: number): Project {
    const previous = this.state;
    return {
      ...previous,
      sampleRate: edl.sampleRate,
      channels: edl.channels,
      assets: edl.assets,
      tracks: edl.tracks,
      updatedAt: now,
      summary: {
        durationSec: edlDurationSec(edl),
        assetCount: edl.assets.length,
        clipCount: countClips(edl),
        ...(previous.summary.thumbnailPeaksPath
          ? { thumbnailPeaksPath: previous.summary.thumbnailPeaksPath }
          : {}),
      },
    };
  }

  private markDirty(): void {
    this.revision += 1;
    this.pendingRevision = this.revision;
    this.notify();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.debounceMs === 0) {
      void this.enqueueSave();
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueSave();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 串行化保存：并发调用只会按顺序执行，不会互相覆盖。 */
  private enqueueSave(): Promise<void> {
    this.saveChain = this.saveChain.then(
      () => this.performSave(),
      () => this.performSave(),
    );
    return this.saveChain;
  }

  private async performSave(): Promise<void> {
    const target = this.pendingRevision;
    if (target === null) return;

    this.pendingRevision = null;
    this.attemptedRevision = target;
    this.saving = true;
    this.notify();

    try {
      await this.persist(serializeProject(this.state));
      this.lastSavedAt = this.now();
      this.saveFailureCount = 0;
      this.attemptedRevision = null;
    } catch (error) {
      this.saveFailureCount++;
      // 保留待保存标记，等下次编辑或 flush 再试，避免失败后无限重试
      this.pendingRevision = target;
      logger.warn('store', 'project save failed', error);
      if (this.saveFailureCount >= this.maxSaveFailures) {
        this.readOnly = true;
        logger.error('store', 'project downgraded to read-only after repeated save failures');
      }
    } finally {
      this.saving = false;
      this.notify();
    }
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
