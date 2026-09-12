/**
 * 撤销 / 重做（命令模式）。
 *
 * 因为 EDL 变更是纯函数（`edl/ops.ts` 返回新 EDL），命令也表达为“正向/逆向两个纯函数”，
 * 而不是就地修改。
 *
 * 约定：
 * - 栈容量 `MAX_HISTORY`，超出丢弃最旧；
 * - 相同 `coalesceKey` 且在合并窗口内的命令合并为一条，避免滑杆拖动产生上百条历史；
 * - 素材相关操作的 `invert` 为空操作：素材文件会保留到历史被裁剪，保证撤销一定能恢复。
 */
import type { Command, Edl, Id } from '../types';

/** 历史栈容量上限。 */
export const MAX_HISTORY = 100;
/** 相同 coalesceKey 的合并窗口。 */
export const COALESCE_WINDOW_MS = 800;

/** 命令对象（与 docs/05 §6 对应，但正/逆操作为纯函数）。 */
export interface EditCommand {
  id: Id;
  label: string;
  at: number;
  /** 合并键，如 `gain:${clipId}`。 */
  coalesceKey?: string;
  /** 正向操作：接收当前 EDL，返回新 EDL。 */
  apply(edl: Edl): Edl;
  /** 逆向操作：接收被 apply 之后的 EDL，返回变更前的 EDL。 */
  invert(edl: Edl): Edl;
}

/** `core/types.ts` 中的 `Command` 与本文件的 `EditCommand` 语义一致，后者是运行时的可执行版本。 */
export type { Command };

interface HistoryEntry {
  command: EditCommand;
  /** 应用后产生的 EDL（用于深比较与调试）。 */
  after: Edl;
}

export interface HistoryOptions {
  maxEntries?: number;
  coalesceWindowMs?: number;
  /** 注入时钟（测试用）。 */
  now?: () => number;
}

export class HistoryStack {
  private readonly maxEntries: number;
  private readonly coalesceWindowMs: number;
  private readonly now: () => number;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(options: HistoryOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_HISTORY);
    this.coalesceWindowMs = Math.max(0, options.coalesceWindowMs ?? COALESCE_WINDOW_MS);
    this.now = options.now ?? (() => Date.now());
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.command.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.command.label ?? null;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /**
   * 应用并记录一条命令。
   *
   * @returns 应用后的 EDL
   */
  push(command: EditCommand, edl: Edl): Edl {
    const after = command.apply(edl);
    const top = this.undoStack[this.undoStack.length - 1];

    // 合并：同一合并键 + 时间窗内 → 保留最旧命令的 invert、使用最新命令的 apply
    if (
      top &&
      command.coalesceKey !== undefined &&
      top.command.coalesceKey === command.coalesceKey &&
      this.now() - top.command.at <= this.coalesceWindowMs
    ) {
      const merged: EditCommand = {
        id: top.command.id,
        label: command.label,
        at: command.at,
        coalesceKey: command.coalesceKey,
        apply: command.apply,
        invert: top.command.invert,
      };
      this.undoStack[this.undoStack.length - 1] = { command: merged, after };
    } else {
      this.undoStack.push({ command, after });
      if (this.undoStack.length > this.maxEntries) this.undoStack.shift();
    }

    // 新的编辑会让重做链失效
    this.redoStack = [];
    return after;
  }

  /** 撤销一步；无可撤销时返回原 EDL。 */
  undo(edl: Edl): Edl {
    const entry = this.undoStack.pop();
    if (!entry) return edl;
    const before = entry.command.invert(edl);
    this.redoStack.push({ command: entry.command, after: edl });
    return before;
  }

  /** 重做一步；无可重做时返回原 EDL。 */
  redo(edl: Edl): Edl {
    const entry = this.redoStack.pop();
    if (!entry) return edl;
    const after = entry.command.apply(edl);
    this.undoStack.push({ command: entry.command, after });
    return after;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** 供测试/调试：当前撤销栈的标签列表（从旧到新）。 */
  labels(): string[] {
    return this.undoStack.map((entry) => entry.command.label);
  }
}

/**
 * 创建一条"用纯函数表达"的命令。
 *
 * @param apply 正向变换
 * @param invert 逆向变换（`null` 表示不可逆，例如素材删除：撤销时不做任何事）
 */
export function defineCommand(spec: {
  id: Id;
  label: string;
  at?: number;
  coalesceKey?: string;
  apply(edl: Edl): Edl;
  invert?(edl: Edl): Edl;
}): EditCommand {
  const command: EditCommand = {
    id: spec.id,
    label: spec.label,
    at: spec.at ?? Date.now(),
    apply: spec.apply,
    invert: spec.invert ?? ((edl: Edl) => edl),
  };
  if (spec.coalesceKey !== undefined) command.coalesceKey = spec.coalesceKey;
  return command;
}
