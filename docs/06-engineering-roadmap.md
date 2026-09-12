# 06 · 工程结构、里程碑与合规

> 状态：**已定稿** ｜ 最后更新：2026-09-12 ｜ 关联代码：未实现（设计阶段，涉及全仓库结构）
>
> **本文负责**：代码目录结构、工具链与测试策略、里程碑与验收标准、性能指标口径、合规与审核、项目级风险。
> **本文不负责**：功能优先级 → [01](./01-product-spec.md)；平台能力与 Spike 清单 → [02](./02-platform-capability.md)；算法与引擎 → [03](./03-audio-engine.md)；领域数据 → [05](./05-data-model.md)；开发流程与规范 → [../AGENTS.md](../AGENTS.md)。

## 1. 目录结构（规划）

```
wx-audio-studio/
├── docs/                             本设计文档集
├── miniprogram/                      小程序源码（开发者工具指向此目录）
│   ├── app.ts / app.json / app.wxss
│   ├── pages/
│   │   ├── index/                    项目列表（TabBar）
│   │   ├── record/                   录音（TabBar）
│   │   ├── editor/                   波形编辑器
│   │   ├── mixer/                    多轨拼接与混音
│   │   ├── export/                   导出配置与进度
│   │   ├── mine/                     成品 / 设置 / 关于（TabBar）
│   │   └── settings/
│   ├── components/
│   │   ├── waveform-canvas/          波形画布（核心组件）
│   │   ├── timeline-ruler/
│   │   ├── transport-bar/
│   │   ├── tool-bar/
│   │   ├── param-sheet/
│   │   ├── track-row/ · clip-block/
│   │   ├── progress-task/
│   │   └── empty-state/
│   ├── workers/                       ★ `app.json` 的 `workers` 目录：Worker 内只能 require 本目录内的文件
│   │   ├── render/                   Worker 入口 + 渲染所需的全部纯计算代码
│   │   │   ├── index.ts              Worker 入口（onMessage → 分块渲染 → 回传）
│   │   │   ├── render.ts             ★ 分块渲染（EDL 求值 + 混音，纯计算）
│   │   │   ├── codec/                wav.ts（头读写与样本转换）· resample.ts · encoder.ts
│   │   │   ├── dsp/                  gain · fade · biquad · limiter · analyze（后续：compressor · gate · fft · wsola · echo · reverb）
│   │   │   ├── peaks/                build.ts · codec.ts · sample.ts
│   │   │   └── edl/                  ops.ts（变更唯一入口）· query.ts · validate.ts
│   │   └── spike/                    M0 专用测试 Worker（探测 Worker 内可用能力，M0 后删除）
│   ├── spikes/                       M0 实验页（**独立分包**，M0 后整包删除）
│   │   ├── index/                    实验列表页（逐项运行 + 一键复制结果）
│   │   └── runner/                   各实验（cases/）· 结果导出 · Worker 客户端
│   ├── core/                         ★ 平台适配 + 主线程调度（纯计算层在 `workers/render/`，见 ADR-0001）
│   │   ├── types.ts                  全部数据模型类型（仅类型声明）
│   │   ├── engine/                   controller.ts（调度与 I/O）· export.ts（导出编排）· export-plan.ts（归一化与体积估算）· worker-protocol.ts（消息唯一定义处）
│   │   ├── history/                  命令模式撤销栈
│   │   ├── store/                    工程状态（EDL + 撤销栈 + 自动保存）· 打开/新建/导入工程
│   │   ├── view/                     viewport.ts（视口与手势几何）· timeline-layout.ts（轨道/片段几何）· rolling-waveform.ts（录音滚动波形）
│   │   ├── audio/                    import.ts（导入管线）· record.ts（录音管线）
│   │   ├── fs/                       paths · io · errors · wav-file · store · quota · renders（成品扫描）
│   │   ├── player/                   transport · clip-preview · preview-cache · preview-session（编辑器与混音页共用）
│   │   ├── caps.ts                   基础库与设备能力探测
│   │   └── settings.ts               用户偏好（Storage，不占数据目录配额）
│   ├── utils/                        logger · format · throttle · dom 查询助手
│   └── assets/                       图标、插画（注意主包体积）
├── tests/                            Node 端单测与基准（Vitest）
│   ├── codec/ · dsp/ · edl/ · peaks/ · engine/ · history/ · store/ · player/ · view/ · audio/ · fs/ · core/
│   └── bench/render.bench.ts         DB-12 性能基准（`npm run bench`）
├── scripts/
│   └── mp-preview.mjs                真机预览二维码 / 体验版上传（miniprogram-ci）
├── project.config.json
├── package.json / tsconfig.json / eslint.config.mjs / vitest.config.ts
└── README.md
```

> **目录与官方平台限制的对应关系**：`workers/` 目录内的代码不能引用目录外文件（官方限制，来源见 [02 §1.5](./02-platform-capability.md#15-输入选择与多线程)），因此纯计算层物理上落在 `workers/render/` 内、由主线程与单测反向复用。方案取舍见 [ADR-0001](./adr/0001-worker-code-packaging.md)。

### 1.1 架构分层

分层规则（含原因与强制检查方式）的唯一权威处是 [AGENTS.md §1](../AGENTS.md#1-目录与分层硬性规则)。本节仅说明**物理目录如何映射到这些层**：

| 目录 | 层次 | 允许依赖 |
| --- | --- | --- |
| `workers/render/dsp/` `workers/render/codec/` `workers/render/peaks/` `workers/render/edl/` | 纯逻辑（可在 Node 单测） | 仅 TypedArray / Math / 自身；**禁止** `wx.*`；**禁止** require 本目录之外的任何路径 |
| `workers/render/render.ts` `workers/render/index.ts` | 渲染引擎与 Worker 入口 | 同目录纯逻辑 + 仅类型的协议定义 |
| `core/engine/` `core/history/` `core/store/` | 主线程调度与状态 | 纯逻辑（反向 require `workers/render/**`）+ `core/fs` |
| `core/view/` | 视口与手势几何（纯计算） | 仅 `core/types` 类型 |
| `core/audio/` `core/fs/` `core/player/` `core/caps.ts` | 平台适配 | `wx.*` 仅允许出现在这几处 |
| `core/types.ts` | 数据模型类型 | 仅类型声明，无运行时代码 |
| `pages/` `components/` | 视图与交互 | `core/**`，不直接触碰 `wx.*` 文件/音频 API |

## 2. 技术栈与工具链

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 语言 | **TypeScript** | 编码规范（strict、禁 `any`、单位后缀等）见 [AGENTS §2](../AGENTS.md#2-编码规范) |
| 框架 | 原生小程序（不用跨端框架） | 音频/Canvas/Worker 都贴近平台能力，跨端框架收益低、风险高 |
| UI | 原生 WXML/WXSS + 自定义组件 | 不引入 UI 库（体积与可控性） |
| 测试 | **Vitest**（Node 环境） | 只测纯逻辑层（`workers/render/**`，与平台解耦），覆盖 DSP、EDL、峰值、渲染调度 |
| 静态检查 | ESLint + Prettier | `no-restricted-imports` 强制纯逻辑层不许引 wx、不许 require `workers/render/` 目录外的路径 |
| 构建 | 微信开发者工具内置 TS 编译（无额外构建步骤） | MVP 用工具链最简方案；⚠️ `workers/` 目录内 `.ts` 的编译支持由 [DB-05](./02-platform-capability.md#5-待实测验证清单spike-任务) 验证，若不可用则回退 [ADR-0001](./adr/0001-worker-code-packaging.md) 的方案 B |
| 真机调试与上传 | `miniprogram-ci`（`npm run mp:preview` / `npm run mp:upload`） | 无 PC 微信开发者工具时的通道：本地生成预览二维码，手机微信「扫一扫 → 右上角相册 → 选二维码图片」打开。凭据放 `mp.config.json`（已在 `.gitignore`） |
| 依赖 | 默认**零运行时依赖**；`lamejs` 仅 P1 按需引入 | 主包体积与供应链安全 |

### 2.1 测试策略

| 层次 | 手段 | 覆盖目标 |
| --- | --- | --- |
| DSP 正确性 | 合成信号断言：正弦波过 EQ 后频响偏移 < ±0.5dB；脉冲响应长度正确；淡入淡出边界增益精确为 0/1 | `workers/render/dsp/**` 行覆盖 ≥ 80% |
| EDL 逻辑 | 属性式断言：任意随机操作序列后 `时长非负`、`片段不重叠/不越界`、`撤销后 EDL 完全等于操作前（深比较）` | `workers/render/edl/**` |
| 峰值 | 用已知 PCM 校验桶 min/max 精确值；随机区间抽样与暴力计算一致 | `workers/render/peaks/**` |
| 渲染 | 用内存中的假素材（正弦）渲染，断言输出长度、静音区间、交叉淡化区功率恒定、限制器不超 ceiling | `workers/render/render.ts` |
| 平台集成 | **只能在真机/开发者工具手测**：格式矩阵（DB-01）、内存上限（DB-02）、Worker 能力（DB-05）、导出分享（DB-11） | Spike 清单 |
| 回归 | 建立"真机冒烟用例表"（每次发版必跑 15 条核心路径） | 全流程 |

### 2.2 真机测试矩阵

| 维度 | 覆盖 |
| --- | --- |
| 平台 | iOS（微信最新 + 前一版本）、Android（高端 / 中端 / 低端各一）、PC 微信（1 台） |
| 场景 | 录音 30s / 3min；导入 mp3 / m4a / wav / 微信聊天文件；裁剪 + 拼接 + 导出 WAV；分享到聊天 |
| 边界 | 10 分钟满长录音；导入 12 分钟音频（应被拒绝）；存储接近满；渲染中切后台；渲染中来电（用开发者工具模拟 + 真机通话） |
| 性能 | 导入耗时、波形拖动帧率、渲染 3 分钟音频耗时、内存峰值（用开发者工具性能面板 + 真机助手） |

## 3. 里程碑与验收标准

### M0 · 技术验证 Spike（**编码前必须完成**，预计 3～5 天）

交付物：

1. `spikes/` 下的实验页面（可复现的验证代码）；
2. 一份实测结论表，回填进 [02 §5 Spike 清单](./02-platform-capability.md#5-待实测验证清单spike-任务) —— **14 项的方法与通过标准以该表为准，此处不重复**；
3. 对技术方案的修正（若实测与假设不符）。

优先跑通三条闭环（其余见 [02 §5](./02-platform-capability.md#5-待实测验证清单spike-任务)）：格式矩阵（DB-01）、Worker 能力与跨线程开销（DB-05/06）、录音→播放→导出→分享全链路（DB-08/09/10/11）。

**M0 的 Go/No-Go 判据**：
- 若 DB-01 显示 `decodeAudioData` **不支持 mp3 或 m4a** → 产品定位需要重大调整（导入能力是核心），触发 Plan B 讨论。
- 若 DB-02 显示可安全处理时长 < 3 分钟 → 需重新设计中间格式（如全程 16k 单声道）或接受更短的限制。
- 若 DB-05/06 显示 Worker 方案不可行 → 渲染退回主线程分片方案，M2 工作量增加约 20%。

### M1 · MVP（单轨编辑可用）

> 本表只列**功能性**验收标准；**性能数值以 [01 §6](./01-product-spec.md#6-关键产品指标) 为准**，此处不重复。

| 内容 | 验收标准 |
| --- | --- |
| 录音（PCM 流式落盘）+ 导入微信文件 | 10 分钟录音稳定完成；常见格式导入有明确成功/失败结论 |
| 中间格式转码 + 峰值金字塔 + 波形显示 | 波形分层与缩放正确，拖动不卡顿（帧率见 [01 §6](./01-product-spec.md#6-关键产品指标)） |
| 单轨编辑：选区、裁剪、删除、分割、淡入淡出、片段增益 | 每条操作有单测；撤销/重做 50 步后 EDL 与操作前深比较相等 |
| 拼接：单轨内拖动排序 + BGM 叠加轨 | 片段边界无空隙无爆音；BGM 能铺满主轨长度 |
| 分块渲染 + 导出 WAV | 进度可取消；产物在 iOS/Android 双端可播放且时长正确（耗时见 [01 §6](./01-product-spec.md#6-关键产品指标)） |
| 分享 + 成品列表 + 自动保存 | 分享链路可用；`onHide` 后重进不丢数据 |

### M2 · 多轨与体验打磨

多轨（≥4 轨）、轨道增益/静音/独奏、交叉淡化、吸附对齐、静音检测去停顿、复制粘贴、崩溃恢复、容量管理、低端机性能模式。

### M3 · 音效

10 段 EQ（含预设）、压缩器、噪声门、高通、限制器、归一化、变速、FFT 与谱减降噪、回声/混响。（按 [03 文档 6.6 节](./03-audio-engine.md) 的固定管线顺序实现）

### M4 · 发布准备

MP3 导出（lamejs）、隐私协议与合规自查、审核问题修复、埋点与错误上报（脱敏）、文档与帮助、灰度发布。

### 工作量粗估（单人开发，仅供参考）

| 阶段 | 预估 |
| --- | --- |
| M0 Spike | 3～5 天 |
| M1 MVP | 3～4 周 |
| M2 多轨与打磨 | 2～3 周 |
| M3 音效 | 3～4 周 |
| M4 发布准备 | 1～2 周 |

> 最大不确定性在 **M0**：如果平台能力与预期有较大偏差，M1 之后的工作量都会变化。因此 M0 必须先做，且不做业务代码。

## 4. 性能与内存预算

> **本节是指标口径的唯一权威处**：定义验收指标（目标值 + 监控方式）。**容量估算与内存推导**（数据有多大、为何不能常驻）见 [02 §3](./02-platform-capability.md#3-容量估算与内存约束)，此处不重复推导。

| 指标 | 目标 | 监控方式 |
| --- | --- | --- |
| 主线程单次任务 | ≤ 16ms（保证 60fps 交互） | 开发者工具 Performance |
| 内存峰值 | ≤ 120MB（导入阶段）—— 阈值推导见 [02 §3](./02-platform-capability.md#3-容量估算与内存约束) | 真机性能面板 |
| 导入时同时驻留的解码结果 | 恰好 1 个 | 代码审查 + 串行队列 |
| 渲染块大小 | 见 [03 §5.2](./03-audio-engine.md#52-渲染调度模型)（默认 2s） | 运行时可调 |
| 峰值数据内存 | ≤ 1MB / 10 分钟音频 | 公式保障 |
| Worker 消息频率 | ≤ 1 条 / 块（约每 30～80ms 一条） | 计数打点 |
| 工程 JSON 体积 | ≤ 50KB | 保存时校验并告警 |
| 波形重绘 | 手势期间不做全量重绘（例外见下方“豁免登记”） | 代码审查 |

**实测参考（2026-09-12）**

环境：Node on Android/Termux（ARM，接近中端手机 JS 引擎），单声道 44.1kHz，3 分钟音频（7,938,000 采样），运行 `npm run bench`（脚本在 `tests/bench/render.bench.ts`）：

| 操作 | 耗时 | 备注 |
| --- | --- | --- |
| 峰值金字塔构建 | 26 ms | |
| 逐采样增益（-6dB） | 41 ms | |
| 高通 biquad（120Hz） | 142 ms | |
| 总线限制器 | 363 ms | |
| 10 段 EQ 串联链 | 968 ms | |
| 重采样 44.1k→22.05k | 391 ms | 多相查表优化后；优化前 8,402 ms（**21×**） |
| **完整分块渲染**（2s 块 + 高通 + 10 段 EQ + 限制器） | **2.07 s** | 对应“导出 3 分钟音频 ≤ 15s”（[01 §6](./01-product-spec.md#6-关键产品指标)）约有 7 倍余量 |

结论：① **暂不引入 WebAssembly**（[03 §10](./03-audio-engine.md#10-未决技术问题)的未决项可保持“不引入”，待真机复测再评估）；② 低端机需按 [§6](#6-基础库与兼容策略) 降级，因本次数据未覆盖低端机。

⚠️ 上述数据来自 Node，**不能替代真机**：真机的 JS 引擎（iOS JavaScriptCore / Android V8）与内存约束不同。DB-12 的真机复测仍待完成（方法：在 spike 页中跑同一处理链并对比耗时）。

> 本节仅记录**已获得**的实测值；尚未实测的项不在此处出现。

### 4.1 豁免登记

绕过红线或指标的例外必须在此登记（依据 [AGENTS §5](../AGENTS.md#5-性能与内存红线)）：

| 豁免项 | 原因 | 责任人 | 复查时间 | 关联代码 |
| --- | --- | --- | --- | --- |
| 双指缩放波形时**整幅重绘** | 缩放改变像素密度，离屏位图无法平移复用；不重绘就看不到缩放结果。已用限帧（约 30fps）+ 隔列降级（每 2px 一列）把单帧成本压到一半 | swcrbt | M1 真机验证后（DB-13 Canvas 帧率结论回填时；不达标则改为 CSS transform 视觉缩放） | `components/waveform-canvas/index.ts` |
| 播放位置更新时重画叠加层 | 每 100ms 一次 `drawImage` + 叠加层，**不重绘波形**（波形位图来自离屏 canvas） | swcrbt | 同上行 | `components/waveform-canvas/index.ts` |

## 5. 合规与审核

| 项 | 要求 | 落地动作 |
| --- | --- | --- |
| 麦克风权限 | 需在小程序后台《用户隐私保护指引》中声明；调用前需按规范完成隐私授权 | 首次进入录音页展示用途说明；拒绝后引导 `wx.openSetting`；`app.json` 配置隐私相关字段 |
| 隐私政策 | 提供可访问的隐私政策页面 | 「我的 → 隐私与关于」内置完整文本，说明：录音数据仅在本机处理、不上传、删除方式 |
| 数据出境/上传 | 本产品**全端上处理，不上传音频** | 明确写入隐私说明；代码层面不引入任何上传逻辑（可审查） |
| 用户生成内容 | 分享出去的音频属于传播内容 | 提供"举报/反馈"入口；评估是否需要内容安全接口（若后续加入任何服务端传播功能则必须） |
| 版权素材 | 不得内置未授权音乐 | MVP 不内置任何 BGM；如需内置，必须使用可商用授权素材并保留授权凭证 |
| 开源许可 | 列明第三方组件许可 | 「关于」页列出 `lamejs`(LGPL) 等；LGPL 静态打包需法务确认，或改为可选项 |
| 类目与资质 | 小程序服务类目选择 | 建议类目：工具 → 音频/视频编辑类（以最新类目要求为准） |
| 审核易踩坑 | ① 功能需可完整体验，不能有"敬请期待"；② 不能诱导分享；③ 首页不能白屏；④ 基础库过低要有降级而非崩溃 | 提审前跑"审核视角清单"：全新用户从 0 到导出成品，全程无死路 |

### 5.1 提交审核前的自查清单

- [ ] 全新用户（无录音权限）能走通：拒绝权限 → 引导 → 授权 → 录音 → 编辑 → 导出 → 分享
- [ ] 存储满、音频过长、格式不支持等错误态均有明确文案且不死循环
- [ ] 不存在的权限/API（基础库过低）有降级方案
- [ ] 隐私政策、麦克风用途说明可访问
- [ ] 无"测试数据"、"开发中"等字样
- [ ] 真机冒烟用例表 15 条全通过
- [ ] 每个页面的返回路径清晰，无死路
- [ ] 无未使用的敏感权限申请

## 6. 项目风险与依赖

技术风险（影响/概率/缓解）的唯一权威处是 [02 §4 风险登记表](./02-platform-capability.md#4-风险登记表)，此处不重复。仅列**项目与交付层面**的风险：

| 项 | 说明 | 影响阶段 |
| --- | --- | --- |
| M0 验证结论可能推翻架构假设 | 触发点与 Go/No-Go 判据见 [02 §5](./02-platform-capability.md#5-待实测验证清单spike-任务) | M0，阻塞后续 |
| 单人开发依赖 | 进度受个人时间影响，本文章节中的工期均为估算值 | 全程 |
| 内置素材的授权准备 | 若后续要内置 BGM/音效，需先取得可商用授权（见 §5） | M4 |

## 7. 开放问题（项目级）

> 技术未决项在 [02 §5](./02-platform-capability.md#5-待实测验证清单spike-任务) 与 [03 §10](./03-audio-engine.md#10-未决技术问题)；产品未决项在 [01 §8](./01-product-spec.md#8-开放的产品问题)。本节只列项目与交付层面：

1. **处理采样率默认值**：44.1k 音质最好但内存翻倍，是否默认 22.05k 换取更长可处理时长？（建议：默认 44.1k，超过 5 分钟自动建议 22.05k；依赖 [02 DB-02](./02-platform-capability.md#5-待实测验证清单spike-任务) 结论）
2. **是否需要埋点**：产品指标（[01 §6](./01-product-spec.md#6-关键产品指标)）需数据支撑，但需评估隐私合规成本。建议仅采集匿名化的性能与失败率数据，不含音频内容。
3. **多端体验差异**：PC 微信上 `sampleRate` 不可设置、`saveFileToDisk` 可用，是否需要为 PC 做专门导出路径？建议 P2。
