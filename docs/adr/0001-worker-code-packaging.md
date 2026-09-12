# ADR-0001：Worker 渲染代码的组织方式

> 状态：**已接受** ｜ 日期：2026-09-12 ｜ 关联：[docs/02 §1.5](../02-platform-capability.md#15-输入选择与多线程)、[docs/03 §5.2](../03-audio-engine.md#52-渲染调度模型)、[docs/06 §1](../06-engineering-roadmap.md#1-目录结构)

## 背景

平台事实（来源：[02 §1.5](../02-platform-capability.md#15-输入选择与多线程) 的 `S9`/`S10`，核对日期 2026-09-12）：

1. **Worker 内不支持 `wx` 系列的 API**（官方原文）。
2. **Worker 内代码只能 require 指定 Worker 路径内的文件，无法引用其他路径**；该目录内**只支持 JS 文件**；目录下所有 JS 最终被打包成一个 JS 文件，默认计入小程序首包（首包上限 2M）。

原设计（[06 §1](../06-engineering-roadmap.md#1-目录结构)）把渲染引擎放在 `miniprogram/core/engine/render.ts`，由 `miniprogram/workers/render/` 引用，并与 `core/dsp/**` 共享纯计算代码。按上述限制，这在真机上**不可行**：Worker 无法 `require` `core/**` 下的任何文件。

而渲染引擎依赖的纯计算代码（DSP、EDL 求值、Int16 编解码）与其同属一个调用链，**必须一同进入 Worker 的可见范围**，因此问题不只是"render.ts 放哪里"，而是"整条纯计算链放哪里"。

## 候选方案

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A（推荐）** | 纯计算层**物理放在** `miniprogram/workers/render/` 内（`dsp/`、`edl/`、`peaks/`、`wav.ts`、`render.ts`）；主线程与 Node 单测通过相对路径复用同一份源码 | 零构建步骤；同一份源码被 Worker、主线程、单测三方使用，不存在"两份产物漂移"；开发者工具直接编译 | 目录语义变化：`core/` 不再承载全部纯逻辑，[AGENTS §1](../..//AGENTS.md#1-目录与分层硬性规则) 的路径表述需同步更新 |
| B | 保留 `core/**` 语义，用构建脚本（esbuild/tsc/gulp）把纯逻辑 + 渲染引擎打包输出到 `workers/render/index.js` | 保留原目录语义；产物可按 Worker 需要裁剪 | 引入构建步骤与产物目录；源码/产物双份易漂移；与 [06 §2](../06-engineering-roadmap.md#2-技术栈与工具链)"工具链最简、零运行时依赖"的取向冲突；调试映射成本 |
| C | Worker 入口写成自包含单文件（手工内联全部 DSP） | 无构建 | 不可维护，直接否决 |

## 决策

采纳**方案 A**，配套约定：

1. **Worker 必需的纯计算代码全部物理位于 `miniprogram/workers/render/` 内**：`render.ts`（EDL 求值 + 分块混音）、`dsp/**`、`edl/**`（渲染侧求值与不变量）、`peaks/**`（构建与采样）、`codec/**`（`wav.ts` 头部与 Float↔Int16、`resample.ts`、`encoder.ts`）。
2. **主线程复用同一份文件**：`core/engine/controller.ts` 通过相对路径 `require('../workers/render/...')` 使用它们；`core/` 只保留平台适配（`fs/`、`player/`、`caps.ts`）、主线程调度与状态（`engine/controller.ts`、`store/`）。
3. **跨线程消息类型只作为类型使用**：`worker-protocol.ts` 允许放在 `core/`，但**只能 `import type`**（编译后类型消除，不产生运行时 `require`），以避免违反"只能 require Worker 目录内文件"的限制。
4. **单测位置不变**：`tests/` 在 Node 下直接 import `miniprogram/workers/render/**`，继续满足 [AGENTS §1](../..//AGENTS.md#1-目录与分层硬性规则)"纯逻辑可在 Node 单测"的要求。
5. **分层规则按新路径重述**：`workers/render/{dsp,codec,peaks,edl}` 为纯逻辑层，**禁止 import 任何 `wx.*`**、**禁止 require 该目录外的路径**；ESLint `no-restricted-imports` 按新路径配置（规则表述见 [AGENTS §1](../..//AGENTS.md#1-目录与分层硬性规则)）。

## 后果

**正面**

- 在当前平台限制下唯一"零构建、单份源码"的可行方案，Worker、主线程、Node 单测共用同一份代码。
- 单测能力不受影响（`workers/render/**` 依然是纯函数、可在 Node 直接跑）。

**负面**

- 目录语义上，"纯逻辑"从 `core/` 移到 `workers/render/`，`core/` 的名字与实际内容（平台适配 + 调度）存在偏差。
- 若将来平台放开限制（如允许 Worker 引用目录外文件），需要一次目录回迁。

**需要在代码里注意的约束**

- `workers/render/**` 内**禁止**出现任何 `wx.*`、DOM、小程序的全局对象调用；只允许 TypedArray / Math / 纯 JS 内建。
- `workers/render/**` 内的模块**禁止** `require` 该目录之外的任何路径（Worker 运行时会失败）。
- 主线程反向 `require` `workers/render/**` 是允许的（限制只作用于 Worker 内）。
- ⚠️ 待验证（[DB-05](../02-platform-capability.md#5-待实测验证清单spike-任务)）：`workers/` 目录内的 `.ts` 是否能被开发者工具正常编译、能否 require 同目录多个文件；Worker 分包（2.27.3+）与 `useExperimentalWorker` 的实际收益。若实测显示 TS 编译不可用，则本 ADR 需回到 `草案` 并改选方案 B。
