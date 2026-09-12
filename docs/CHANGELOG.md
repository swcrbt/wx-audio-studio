# 文档变更记录（CHANGELOG）

> 本文件记录 `docs/` 下的**文档级变更**，用于审计"文档与代码是否同步"。
> 规范见 [AGENTS.md 第 0 节](../AGENTS.md#0-第一原则文档先行代码同步doc-first)。

## 登记规则

1. 任何文档改动（新增/修改/状态变更）都必须在下方表格登记一行。
2. 一行对应一次改动，字段齐全：日期 / 文档 / 类型 / 摘要 / 关联代码。
3. `关联代码` 填写该文档对应的代码路径或提交标识；设计阶段写 `未实现`。
4. 走了"紧急修复先改代码"例外路径的，类型标 `[补记]` 并说明原因。
5. 只增不改：历史行不删除、不修改（写错了就再加一行修正）。

**类型取值**：`新增` / `修改` / `状态变更` / `结论回填` / `[补记]`

## 变更记录

| 日期 | 文档 | 类型 | 摘要 | 关联代码 |
| --- | --- | --- | --- | --- |
| 2026-09-12 | `docs/03` `docs/04` `docs/05` `docs/06` | 新增 | “我的”页与导出后处理：`docs/03` **新增 §5.5 导出后处理**（为何变采样率/声道必须在渲染后做、内存与临时文件策略）；`docs/04` §4.5 补 M1 落地状态；`docs/05` §4 说明用户偏好存 Storage 不占数据目录配额；`docs/06` §1 目录树补 `fs/renders.ts` 与 `settings.ts` | `core/engine/export-resample.ts` `core/fs/renders.ts` `core/settings.ts` `pages/mine/**` |
| 2026-09-12 | `docs/03` `docs/04` `docs/06` | 新增 | 导出层落地：`docs/03` §6.6 效果链把总线写为“EQ → 归一化增益 → 限制器”并说明顺序理由、§8 的 `RenderJob` 补 `limiter` / `busGainDb`；`docs/04` §4.4 补导出页 M1 落地状态；`docs/06` §1 目录树补 `engine/export*.ts` | `core/engine/{export,export-plan}.ts` `pages/export/**` |
| 2026-09-12 | `docs/02` `docs/03` `docs/06` | 修正 | **平台事实修正**：`WebAudioContext` 不提供麦克风输入节点，`AnalyserNode` 拿不到录音流 → `docs/02 §1.2` 新增“实时电平/波形”行与来源 **S21**（§1 与 §1.7 的编号范围同步改为 S1～S21）；`docs/03 §7` 录音监听方案改为“从 `onFrameRecorded` 分帧计算峰值/RMS”；`docs/06 §1` 目录树补 `view/rolling-waveform.ts` | `core/view/rolling-waveform.ts` `pages/record/record.ts` |
| 2026-09-12 | `docs/04` `docs/06` | 新增 | 编辑器/主页落地：`docs/04` §3 补“M1 实现范围”（单素材切割视图）与 §7 组件落地状态；`docs/06` §1 目录树补 `core/view/`，§1.1 分层表拆出“视口与手势几何”，**§4.1 新增豁免登记表**（波形缩放手势的整幅重绘 + 播放位置叠加层重画） | `components/waveform-canvas/**` `pages/{index,editor}/**` `core/view/viewport.ts` `core/store/**` |
| 2026-09-12 | `docs/03` `docs/06` | 新增 | 播放层落地：`docs/03` §7 补实现位置（transport / clip-preview / preview-cache）与脏区间调度说明；`docs/06` §1 目录树细化 `core/player/` 与 `tests/player/` | `core/player/*.ts` |
| 2026-09-12 | `docs/05` `docs/06` | 新增 | 工程状态层：`docs/05` §7 补实现位置（命令必须经 `ProjectStore.commit`）；§4.1 索引新增 `lastOpenedProjectId`（会话恢复）；`docs/06` §1 目录树补 `core/store/` 与 `tests/{store,audio}/`，§1.1 分层表将 `core/store/` 归入“主线程调度与状态” | `core/store/project-store.ts` `core/fs/store.ts` |
| 2026-09-12 | `docs/03` | 修改 | §3 录音落盘补“PC 处理”说明：PC 微信不支持设置 `sampleRate`，无法保证中间格式采样率，因此录音在 PC 上明确拒绝（需 PC 录音时先录后重采样）；关联代码回填 `core/audio/record.ts` | `core/audio/record.ts` |
| 2026-09-12 | `docs/03` | 修改 | §4.1 明确峰值文件 body 的**多声道排列**（按声道分组，各声道级数与各级桶数必须一致，不一致时拒绝序列化）；§3 导入管线关联代码回填 `core/audio/import.ts` | `workers/render/peaks/codec.ts` `core/audio/import.ts` |
| 2026-09-12 | `docs/02` | 修改 | §5「怎么跑」补全凭据获取的两条路径（小程序测试号 / 个人主体账号）与 `npm run mp:doctor` 自检步骤；明确凭据文件不入库、拿不到上传密钥时需改用 PC 开发者工具 | `scripts/mp-doctor.mjs` |
| 2026-09-12 | `docs/02` `docs/06` `README.md` `docs/README` | 修改 | M0 落地：§5 新增“怎么跑这些实验”（miniprogram-ci 生成预览二维码 → 手机微信相册扫码 → 一键复制结果）；§6 §1 目录树补 `spikes/` 分包、`workers/spike/`、`scripts/`、`tests/bench/`；§2 工具链新增 `miniprogram-ci` 通道；根 README 与 docs/README 状态由“未开始编码”改为“实现中”（含开发命令） | `miniprogram/spikes/**` `scripts/mp-preview.mjs` |
| 2026-09-12 | `docs/05` | 修改 | 修正类型内部不一致：`EffectInstance.params` 的值类型由 `number \| string \| boolean` 改为 `EffectParamValue = number \| string \| boolean \| number[]`，否则 `eq10` 的 `bands`（十段增益数组）无法表达（原定义与同一节的参数注释矛盾） | `core/types.ts` `workers/render/edl/validate.ts` |
| 2026-09-12 | `docs/06` `docs/03` `docs/CHANGELOG` | 结论回填 | **DB-12（纯 JS 性能基准）Node 侧实测回填**：新增 §4 实测参考表（3 分钟音频：峰值构建 26ms、增益 41ms、高通 142ms、限制器 363ms、10 段 EQ 968ms、重采样 391ms、**完整分块渲染 2.07s**）；因实测发现重采样是瓶颈（8.4s），实现改为多相查表（21× 提速）并同步 §6.4 算法描述；DB-12 状态改“Node 侧已回填” | `tests/bench/render.bench.ts` `workers/render/codec/resample.ts` |
| 2026-09-12 | `AGENTS.md` | 新增 | §2.4 新增“注释只解释代码本身”：禁止用注释叙述设计文档的内容与章节号（唯一例外是算法公式、平台限制的外部出处短指针）；理由：把文档搬进注释会让改动两处维护，且读者在编辑器里看不到最新版文档。同时修正 §2.5 的表述 | 全部代码文件 |
| 2026-09-12 | `docs/03` `docs/05` | 修改 | 关联代码回填：补上已实现的重采样（`codec/resample.ts`）、撤销栈（`core/history/`）与渲染调度（`core/engine/controller.ts`） | 同名路径 |
| 2026-09-12 | `docs/06` | 修改 | 实现回填：§1 目录树补 `core/fs/io.ts`（通用读写与原子写）、`errors.ts`（错误码→用户文案）及各文件职责 | `miniprogram/core/fs/**` |
| 2026-09-12 | `docs/03` | 修改 | 实现回填：§5.2 调度图与传输约定改为“素材请求/回传统一用**帧号**”（字节偏移由主线程按声道数换算），§8 接口草案同步为 `initJob(job)` / `planChunk` / `chunkBounds` / `renderChunk(state, chunkIndex, AssetPcmMap)` 与 `SUPPORTED_EFFECTS`；§6.6 效果链新增实现说明 | `workers/render/render.ts` `workers/render/index.ts` `core/engine/worker-protocol.ts` |
| 2026-09-12 | `docs/05` `docs/06` | 修改 | 实现回填：`docs/05 §9` 新增“循环片段不参与区间切分”的 M1 取舍与理由；`docs/06 §2.1` 明确 EDL 不变量的正确表述（同轨片段**允许重叠**，交叉淡化需要） | `workers/render/edl/{query,ops,validate}.ts` |
| 2026-09-12 | `docs/03` `docs/05` | 修改 | 实现回填：§4.1 峰值层级表更正为“逐级 ×2”（原写 ×4，与 §4.2 合并算法矛盾）、补全二进制头字节布局（字段宽度/保留位/`bucketSize` 不落盘）；§4.2 参考实现修正 `buildUpperLevel` 的输出长度（原实现多分配一倍）与奇数桶处理；两份文档状态改为“实现中”并回填真实代码路径 | `workers/render/peaks/build.ts` `codec.ts` `sample.ts` |
| 2026-09-12 | `docs/02` | 修改 | **官方文档逐条核对与证据回填**（核对日期 2026-09-12）：新增 [§1.7 官方来源清单](./02-platform-capability.md#17-官方来源清单)（S1～S20，每条含接口名与官方 URL）并为 §1.1～§1.6 每张表加“来源”列；修正 `benchmarkLevel` 的获取接口（`getAppBaseInfo` 无此字段 → `getDeviceInfo`，且 3.4.5 起改用 `getDeviceBenchmarkInfo`）；删除无官方出处的“WebAudio 内存占用较大”断言；补登 `useWebAudioImplement`、`setInnerAudioOption` 不兼容 WebAudio、**本地用户文件+缓存文件合计 200MB 配额**、临时文件清理策略、`rename` 可用、Worker 官方限制（无 `wx` API、只能 require 目录内文件、单例、`useExperimentalWorker`、2.27.3 分包）、分包 2M/30M、`lazyCodeLoading` 版本；缩窄 DB-03/05/09/14；§3 补存储配额约束；§4 重写 R-04 | [ADR-0001](./adr/0001-worker-code-packaging.md) |
| 2026-09-12 | `docs/adr/0001-worker-code-packaging.md` | 新增 | 新建 ADR：因官方限制“Worker 只能 require Worker 目录内文件”，渲染引擎与其依赖的纯计算层（`dsp/`、`edl/`、`peaks/`、`codec/`）改为**物理位于 `miniprogram/workers/render/`**，主线程与单测反向复用同一份源码（方案 A，已接受） | `miniprogram/workers/render/` |
| 2026-09-12 | `AGENTS.md` `docs/03` `docs/05` `docs/06` `docs/README` | 修改 | 同步方案 A 的目录变更：AGENTS §1 分层规则改为按 `workers/render/**` 表述（新增“禁止 require 目录外路径”“消息类型仅 `import type`”“允许反向 require”三条），并同步 §2.1/§3.1/§7/§12；`docs/06 §1` 目录树与 §1.1 分层映射、§2/§2.1 测试与工具链路径、`docs/03 §5.2/§8`、`docs/05 §9` 路径同步；`docs/README` 文档地图加 ADR 行 | — |
| 2026-09-12 | `docs/02` `03` `04` | 修改 | SSOT 复查：三处跨文档重复的数值改为引用（导入内存阈值、存储警戒线、WAV 头长度），定义归回各自权威文档 | — |
| 2026-09-12 | `AGENTS.md` + `docs/README` + `docs/02` `03` `06` | 新增 | 新增 §0.7「单一权威来源（SSOT）」规范：定义/引用判定、12 类信息的归属表、7 条执行要求；并把 SSOT 检查写入提交清单、DoD、Anti-Patterns 与 agent 指令；同步修掉三处违反该规范的重复（§5 指标表、§7 测试表、§9 合规条与 06 重复） | — |
| 2026-09-12 | 全部文档 | 修改 | **边界收敛**：每份文档加「本文负责 / 本文不负责」声明；消除跨文档重复（平台硬约束、内存推导、效果链、MVP 复述、风险表、未决项）；每类信息确定唯一权威处，其余处改为引用 | — |
| 2026-09-12 | `02` `03` `04` `06` `AGENTS.md` | 修改 | 二次去重：里程碑验收标准不再复述指标/Spike 通过标准（改为引用 01 §6 与 02 §5）；M0 交付物清单简化为引用；章节标题不带附加说明（锚点稳定化，说明移入正文）；M1 表前插入的说明行位置修正 | — |
| 2026-09-12 | `AGENTS.md` | 新增 | 建立开发规范：文档先行与同步矩阵、分层规则、单位后缀约定、性能红线、提交与 DoD、合规红线、agent 指令 | — |
| 2026-09-12 | `docs/CHANGELOG.md` | 新增 | 建立文档变更记录机制 | — |
| 2026-09-12 | `docs/README.md` + `docs/01`~`06` | 状态变更 | 统一补充元信息头（状态 / 最后更新 / 关联代码），状态定为「已定稿」，关联代码标注为「未实现（设计阶段）」 | 未实现 |
| 2026-09-12 | `AGENTS.md`、根 `README.md` | 修改 | 将 0.2 标题改为无歧义形式（去除 `→` 与加粗），修正跨文档锚点链接 | — |
| 2026-09-12 | `docs/README.md`、`docs/01`~`06`、根 `README.md` | 新增 | 建立设计文档集：产品范围、平台能力与选型、引擎与 DSP、交互、数据模型、工程路线图 | 未实现 |

## 待回填项（Spike 状态跟踪）

> 只跟踪**状态**；问题的描述、方法、通过标准在 [02 §5 Spike 清单](./02-platform-capability.md#5-待实测验证清单spike-任务)（唯一权威处）。

| 编号 | 结论回填位置 | 状态 |
| --- | --- | --- |
| DB-01 | [02 §1.1](./02-platform-capability.md#11-音频解码与处理) | 未验证 |
| DB-02 | [02 §3](./02-platform-capability.md#3-容量估算与内存约束) | 未验证 |
| DB-03 | [02 §1.1](./02-platform-capability.md#11-音频解码与处理) | 未验证 |
| DB-04 | [02 §1.1](./02-platform-capability.md#11-音频解码与处理) | 未验证 |
| DB-05 | [02 §1.5](./02-platform-capability.md#15-输入选择与多线程) · [03 §5.2](./03-audio-engine.md#52-渲染调度模型) | 未验证 |
| DB-06 | [03 §5.2](./03-audio-engine.md#52-渲染调度模型) | 未验证 |
| DB-07 | [03 §5.4](./03-audio-engine.md#54-素材分块缓存) | 未验证 |
| DB-08 | [02 §1.2](./02-platform-capability.md#12-录音) · [03 §3](./03-audio-engine.md#3-素材导入管线) | 未验证 |
| DB-09 | [03 §7](./03-audio-engine.md#7-播放与试听策略) | 未验证 |
| DB-10 | [02 §1.4](./02-platform-capability.md#14-文件系统) | 未验证 |
| DB-11 | [02 §1.4](./02-platform-capability.md#14-文件系统) | 未验证 |
| DB-12 | [06 §4](./06-engineering-roadmap.md#4-性能与内存预算) | **Node 侧已回填**（2026-09-12，真机复测待做） |
| DB-13 | [03 §4.3](./03-audio-engine.md#43-绘制时的选择与采样) | 未验证 |
| DB-14 | [05 §5](./05-data-model.md#5-容量策略) | 未验证 |
