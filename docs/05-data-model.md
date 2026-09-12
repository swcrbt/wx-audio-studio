# 05 · 数据模型与本地存储

> 状态：**实现中** ｜ 最后更新：2026-09-12 ｜ 关联代码：`miniprogram/core/types.ts`（类型已落地）、`workers/render/edl/`、`core/fs/`
>
> **本文负责**：EDL 类型与字段语义、工程 JSON 结构、存储布局与命名、容量与清理策略、撤销重做、自动保存与版本迁移。
> **本文不负责**：平台文件 API 限制与配额 → [02](./02-platform-capability.md)；DSP 与渲染 → [03](./03-audio-engine.md)；页面如何呈现 → [04](./04-ui-ux.md)；性能指标 → [06](./06-engineering-roadmap.md)。

## 1. 实体关系

```
                    ┌─────────────┐
                    │   Project   │ 工程（EDL 的根）
                    │  id / name  │
                    │ sampleRate  │
                    │ channels    │
                    └──┬───────┬──┘
          assets[]     │       │     tracks[]
        ┌──────────────▼┐     ┌▼──────────────────┐
        │    Asset      │     │      Track        │
        │  素材（只读）  │     │ id/name/gain/mute │
        │ path/sr/ch/dur│     │ solo/pan/effects[]│
        └───────┬───────┘     └────────┬──────────┘
                │ 被引用 1..n           │ 包含 0..n
                │              ┌────────▼──────────┐
                │              │       Clip        │
                └──────────────┤ assetId/sourceRange│
                               │ timelineStart     │
                               │ fades/gain/effects│
                               │ speed/loop        │
                               └───────────────────┘

  ┌──────────────┐   ┌────────────────┐   ┌──────────────┐
  │  PeakRef     │   │  RenderCache   │   │ HistoryEntry │
  │ 峰值金字塔    │   │ 预览渲染缓存    │   │ 撤销栈条目    │
  └──────────────┘   └────────────────┘   └──────────────┘
```

**核心约束**
1. `Asset` **只增不改不删**（除非引用计数归零且用户执行清理）。
2. `Clip` 通过 `assetId` 引用素材，删除 Clip 不影响素材数据。
3. 时长由 `tracks` 内容推导，**不冗余存储**（避免不一致）；仅在列表页缓存 `durationSec` 用于展示。

## 2. TypeScript 类型定义

```ts
// core/types.ts
export type Id = string;              // 时间戳 + 随机后缀
export type Seconds = number;

export interface Project {
  schemaVersion: number;              // 当前为 1
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;

  // 工程级音频参数（决定处理链，创建后不可改，除非重新导入全部素材）
  sampleRate: 16000 | 22050 | 44100;
  channels: 1 | 2;

  assets: Asset[];
  tracks: Track[];

  // 展示与恢复用的轻量摘要
  summary: {
    durationSec: Seconds;
    assetCount: number;
    clipCount: number;
    thumbnailPeaksPath?: string;      // 列表页缩略波形
  };

  // 导出默认设置
  exportDefaults?: Partial<ExportSettings>;
}

export interface Asset {
  id: Id;
  name: string;                       // 用户可见名（如"录音 2024-05-01"）
  origin: 'record' | 'messageFile' | 'local' | 'duplicate';
  path: string;                       // assets/{id}.wav（中间格式）
  sampleRate: number;                 // 与工程一致
  channels: 1 | 2;
  durationSec: Seconds;
  frames: number;                     // 总采样帧数
  bytes: number;
  peakRef: { path: string; levels: { bucketSize: number; count: number }[] };
  createdAt: number;
  refCount?: number;                  // 运行时计算，不落盘
}

export interface Track {
  id: Id;
  name: string;                       // "人声" / "BGM"
  order: number;
  gainDb: number;                     // -60 .. +12，默认 0
  pan: number;                        // -1 .. 1，默认 0
  muted: boolean;
  solo: boolean;
  effects: EffectInstance[];
  clips: Clip[];
}

export interface Clip {
  id: Id;
  assetId: Id;

  // 素材侧区间（秒）
  sourceStart: Seconds;
  sourceEnd: Seconds;

  // 时间轴侧
  timelineStart: Seconds;
  // 时长由推导：duration = (sourceEnd - sourceStart) / speed

  gainDb: number;                     // 片段增益
  fadeIn: FadeSpec | null;
  fadeOut: FadeSpec | null;
  speed: number;                      // 1 = 原速；>1 变快（变调，玩具级）
  loop: boolean;                      // BGM 铺满用
  effects: EffectInstance[];          // 片段级效果
  label?: string;                     // 片段备注
}

export interface FadeSpec {
  durationSec: Seconds;
  curve: 'linear' | 'equalPower';
}

export interface EffectInstance {
  id: Id;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
  presetName?: string;
}

export type EffectType =
  | 'gain'            // 无 UI 参数，走 clip.gainDb / track.gainDb
  | 'highpass'        // { freq }
  | 'eq10'            // { bands: number[10] }
  | 'compressor'      // { threshold, ratio, attack, release, knee, makeup }
  | 'noiseGate'       // { threshold, attack, release, hold, floor }
  | 'denoise'         // { strength, profileId }
  | 'echo'            // { delayMs, feedback, mix }
  | 'reverb'          // { roomSize, damping, mix }
  | 'limiter'         // { ceilingDb, lookaheadMs }
  | 'normalize';      // { targetDb, mode: 'peak' | 'rms' }

export interface ExportSettings {
  format: 'wav' | 'mp3';
  sampleRate: 16000 | 22050 | 44100;
  channels: 1 | 2;
  mp3Bitrate?: 128 | 192 | 320;
  normalize: boolean;
  limiter: boolean;
  range?: { startSec: Seconds; endSec: Seconds } | null;  // 只导出选区
}
```

## 3. 工程 JSON 示例

```json
{
  "schemaVersion": 1,
  "id": "1751360000000-a3f9c1",
  "name": "播客第03期",
  "createdAt": 1751360000000,
  "updatedAt": 1751363600000,
  "sampleRate": 44100,
  "channels": 1,
  "assets": [
    {
      "id": "1751360001000-b7d2e4",
      "name": "录音 05-01 10:23",
      "origin": "record",
      "path": "assets/1751360001000-b7d2e4.wav",
      "sampleRate": 44100,
      "channels": 1,
      "durationSec": 86.42,
      "frames": 3811122,
      "bytes": 7622244,
      "peakRef": {
        "path": "peaks/1751360001000-b7d2e4.pk",
        "levels": [
          { "bucketSize": 1024, "count": 3722 },
          { "bucketSize": 4096, "count": 931 },
          { "bucketSize": 16384, "count": 233 }
        ]
      },
      "createdAt": 1751360001000
    }
  ],
  "tracks": [
    {
      "id": "t1",
      "name": "人声",
      "order": 0,
      "gainDb": 0,
      "pan": 0,
      "muted": false,
      "solo": false,
      "effects": [
        { "id": "e1", "type": "highpass", "enabled": true, "params": { "freq": 120 } },
        { "id": "e2", "type": "compressor", "enabled": true, "presetName": "口播",
          "params": { "threshold": -18, "ratio": 3, "attack": 10, "release": 120, "knee": 6, "makeup": 3 } }
      ],
      "clips": [
        {
          "id": "c1",
          "assetId": "1751360001000-b7d2e4",
          "sourceStart": 2.15,
          "sourceEnd": 24.8,
          "timelineStart": 0,
          "gainDb": 1.5,
          "fadeIn": { "durationSec": 0.35, "curve": "equalPower" },
          "fadeOut": { "durationSec": 0.5, "curve": "equalPower" },
          "speed": 1,
          "loop": false,
          "effects": []
        },
        {
          "id": "c2",
          "assetId": "1751360001000-b7d2e4",
          "sourceStart": 31.0,
          "sourceEnd": 55.4,
          "timelineStart": 22.65,
          "gainDb": 1.5,
          "fadeIn": null,
          "fadeOut": null,
          "speed": 1,
          "loop": false,
          "effects": []
        }
      ]
    }
  ],
  "summary": { "durationSec": 47.05, "assetCount": 1, "clipCount": 2 }
}
```

> **注意**：JSON 中**不存 PCM、不存峰值数据本体**，只存路径与元信息。这是保证工程文件小（通常 < 10KB）且读写快速的关键。

## 4. 存储布局

```
${wx.env.USER_DATA_PATH}/
├── assets/                     素材（16-bit PCM WAV）
│   └── {assetId}.wav
├── peaks/                      峰值金字塔（二进制）
│   └── {assetId}.pk
├── projects/                   工程 EDL
│   └── {projectId}.json
├── renders/                    预览与成品
│   ├── preview-{projectId}.wav     当前预览缓存（可随时删除重建）
│   └── out-{projectId}-{ts}.wav    用户成品（受保护，除非用户删除）
├── tmp/                        中间产物（启动时清理）
│   ├── import-{ts}.pcm
│   └── render-{projectId}.state    未完成渲染的续跑状态
└── index.json                  项目索引与统计（见下）
```

### 4.1 索引文件 `index.json`

列表页需要"不读全部工程文件就能渲染列表"，因此维护一个轻量索引：

```ts
export interface StoreIndex {
  schemaVersion: number;
  projects: Array<{
    id: Id;
    name: string;
    updatedAt: number;
    durationSec: number;
    thumbnailPeaksPath?: string;
    sizeBytes: number;          // 该项目相关文件总占用（估算，异步刷新）
  }>;
  stats: {
    assetsBytes: number;
    peaksBytes: number;
    rendersBytes: number;
    quotaWarned: boolean;
  };
}
```
- 索引在每次保存工程时同步更新（`writeFile` 一个几 KB 的 JSON，成本极低）。
- 若 `index.json` 损坏 → 全目录扫描 `projects/*.json` 重建（降级路径，必须有）。

### 4.2 命名规则

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| `assetId` / `projectId` | `{Date.now()}-{6位随机base36}` | `1751360001000-b7d2e4` |
| 成品文件 | `out-{projectId}-{yyyyMMddHHmmss}.wav` | `out-1751...-20250501102345.wav` |
| 渲染续跑状态 | `render-{projectId}.state` | — |

> 随机后缀避免同毫秒创建冲突；不允许使用用户输入作为文件名（安全与兼容性）。

## 5. 容量策略

| 项 | 值 / 策略 |
| --- | --- |
| **存储配额上限** | **本地用户文件 + 本地缓存文件合计 200MB**（官方原文与来源见 [02 §1.4](./02-platform-capability.md#14-文件系统)）—— 本表所有百分比均以此为分母 |
| 单次写入上限 | 100MB（平台硬限制，错误码 1300202；来源同 [02 §1.4](./02-platform-capability.md#14-文件系统)） |
| 单素材上限 | 受平台单文件 100MB 与录音 10 分钟上限约束；体积换算与内存推导见 [02 §3](./02-platform-capability.md#3-容量估算与内存约束)（**结论：立体声素材限在约 9 分钟或降采样率**） |
| 工程预估占用 | 素材 WAV + 峰值（约素材的 0.2%）+ 工程 JSON（<10KB）+ 成品 |
| 容量警戒 | 总占用 > 80%（≈160MB）时首页提示；> 95%（≈190MB）时导出前强制提示清理 |
| 清理策略 | ① 启动时清空 `tmp/`；② 删除工程时若某素材引用计数为 0 → 询问或直接删除素材与峰值；③ 提供"清理未引用素材"入口；④ `preview-*.wav` 超过 3 个或超过 2 天自动清理 |
| 保护策略 | `renders/out-*.wav`（用户成品）永不自动删除 |

⚠️ 待验证（[DB-14](./02-platform-capability.md#5-待实测验证清单spike-任务)）：200MB 是官方文档给出的配额数值，但**实际可写量与 `1300202` 的触发点**仍须真机确认（是否严格等于 200MB、是否包含本地缓存文件）。本表策略以"占用百分比"驱动，不硬编码具体字节数。

## 6. 撤销 / 重做

### 6.1 方案：命令模式 + 逆操作（不做全量快照）

```ts
export interface Command {
  id: Id;
  label: string;               // UI 显示："裁剪"、"调整音量"
  at: number;                  // 时间戳
  coalesceKey?: string;        // 合并键，如 `gain:${clipId}`，用于滑杆连续调整合并
  apply(edl: EditableEdl): void;
  invert(edl: EditableEdl): void;   // 逆操作
}
```

**实现要点**
| 项 | 设计 |
| --- | --- |
| 栈容量 | 上限 100 步（`MAX_HISTORY`），超出丢弃最旧 |
| 合并（coalesce） | 相同 `coalesceKey` 且在 800ms 内产生的命令合并为一条（滑杆拖动不会产生 100 条历史） |
| 逆操作 vs 快照 | 素材相关操作（导入/删除素材）不做逆操作，而是**保留素材文件**直到历史被裁剪 → 保证撤销一定能恢复 |
| 落盘 | 历史栈**不落盘**（内存中，工程重新打开时清空）；但每次提交命令后立即保存 EDL（自动保存） |
| 内存占用 | 命令对象很小（< 1KB）；唯一风险是引用了已删除素材，用引用计数保护 |

**必须被命令覆盖的操作**：裁剪、分割、删除片段、静音、复制粘贴、拖动排序、调整增益、淡入淡出、效果参数增删改、轨道增删改、选区变更（**不进入历史**，属于视图状态）。

### 6.2 视图状态 vs 文档状态

| 状态 | 是否进入历史 | 是否落盘 |
| --- | --- | --- |
| `tracks` / `clips` / `effects` / 素材 | ✅ | ✅ |
| 选区、播放头位置、缩放级别、当前轨道 | ❌ | 可选（`uiState`，为"恢复上次编辑位置"体验，独立字段且失败可忽略） |

## 7. 自动保存与恢复

```
用户操作 → 提交命令（内存 EDL 变更）
        → 标记 dirty
        → 防抖 1s → 序列化 EDL → writeFile(projects/{id}.json) → 更新 index.json
```
| 项 | 设计 |
| --- | --- |
| 防抖 | 1s；导出/退出页面/`onHide` 时强制立即保存 |
| 原子性 | 先写 `{id}.json.tmp` 再 `rename` —— 官方已确认 `FileSystemManager.rename` 支持本地路径且可移动文件（来源见 [02 §1.4](./02-platform-capability.md#14-文件系统)），**原标注的待验证项已关闭**；失败时回退"先写新文件 → 写成功后删旧" |
| 崩溃恢复 | 启动时检查 `tmp/render-*.state` 与工程的 `updatedAt` 差异；发现"上次异常退出"提示"检测到未保存的编辑，是否恢复？" |
| 会话恢复 | 记录 `lastOpenedProjectId`，首页顶部显示"继续编辑：播客第03期" |
| 保存失败 | 提示"保存失败（存储空间不足）"+ 提供清理入口；连续失败 3 次降级为只读模式并明确告知 |

## 8. 版本迁移

```ts
export const CURRENT_SCHEMA_VERSION = 1;

export function migrate(raw: any): Project {
  let doc = raw;
  if (doc.schemaVersion < 1) doc = migrateV0toV1(doc);
  // 未来：if (doc.schemaVersion < 2) doc = migrateV1toV2(doc);
  doc.schemaVersion = CURRENT_SCHEMA_VERSION;
  return doc;
}
```
**迁移原则**
- 每次结构变更必须写 `migrateVxtoVy` 并附单测（用旧版本 JSON 样本）。
- 迁移失败 → 不覆盖原文件，提示"工程版本过新/数据损坏"，并允许用户导出原始 JSON 用于排查。
- **向前兼容**：读取时忽略未知字段（不抛错），避免新版本编辑过的工程在旧版本小程序里直接崩溃（旧版本应提示升级）。

## 9. 一致性要点（易出错清单）

| 风险 | 对策 |
| --- | --- |
| EDL 与素材不一致（素材被删但 Clip 仍引用） | 加载工程时校验：`Clip.assetId` 必须存在于 `assets`（或素材文件存在），否则把该 Clip 标记为"缺失"并允许用户删除 |
| 素材采样率与工程不一致（手工改过工程参数） | 加载时校验并拒绝，或提示"需重新导入素材" |
| `sourceEnd` 超出素材时长 | 加载时 clamp 到素材时长并记录一条警告 |
| 预览缓存与 EDL 不同步 | 每次命令提交时把 `previewDirtyFrom = min(受影响区间起)`，播放时只重渲染脏区间 |
| 时间轴出现负数或重叠错误 | 所有写入 `timelineStart` 的路径统一走 `edlOps` 层（`workers/render/edl/ops.ts`）并做 clamp + 排序，禁止在 UI 层直接改 EDL |
| 浮点累积误差导致片段间出现 1 采样空隙 | 渲染时对相邻片段边界做"帧对齐"（`round(t * sampleRate)`），相邻片段共享同一帧边界；EDL 侧由 `workers/render/edl/ops.ts` 在写入 `timelineStart` 时统一对齐 |
| 循环（BGM）片段的区间切分语义歧义 | `loop: true` 的片段在 M1 **不参与** `deleteRange` / `trimToRange` 的区间切分（相交即整体处理）：取模映射会产生"半段循环"的不可解释结果。需要对 BGM 做精细剪辑时先关闭 `loop`（M2 再评估） |

## 10. 未决问题

1. 工程是否支持"打包导出"（把素材与 EDL 打成一个 zip 便于跨设备迁移）？MVP 不做，因无账号/云端。
2. 是否需要"多工程复制"（复制工程时素材是引用还是复制文件）？倾向 M2 用引用计数共享素材。
3. `Asset.name` 与文件名解耦，但用户可能想"重命名素材"——是否需要在 UI 暴露？倾向不暴露（素材对普通用户是透明概念）。
