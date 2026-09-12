# 02 · 平台能力盘点与技术选型

> 状态：**已定稿** ｜ 最后更新：2026-09-12 ｜ 关联代码：未实现（设计阶段，规划于 `miniprogram/core/caps.ts`、`core/audio/import.ts`）
>
> **本文负责**：平台能力事实（接口、版本、限制）、技术选型与被否方案、容量估算与由平台约束推出的设计决策、风险登记、Spike 验证清单。
> **本文不负责**：功能优先级与 MVP 边界 → [01](./01-product-spec.md)；算法与实现细节 → [03](./03-audio-engine.md)；验收指标口径 → [06](./06-engineering-roadmap.md)；流程规范 → [../AGENTS.md](../AGENTS.md)。
>
> 本文所有平台事实均来自微信官方文档（已核对，标注接口名与版本号）。凡是**未经真机验证**的推断，一律标注 `⚠️ 待验证` 并汇总到文末的 Spike 清单，**编码前必须先跑完**。

## 1. 平台能力总表

### 1.1 音频解码与处理

| 能力 | 接口 | 版本要求 | 关键限制 |
| --- | --- | --- | --- |
| 创建音频上下文 | `wx.createWebAudioContext()` | 基础库 **2.19.0** | **小程序插件中不支持**；官方提示 WebAudio 内存占用较大，建议用于短音频/音效 |
| 解码音频为 PCM | `WebAudioContext.decodeAudioData(arrayBuffer, success, fail)` | 2.19.0 | 只接受 `ArrayBuffer`（需自行 `wx.request`/`readFile` 取二进制）；**一次性全量解码**，无流式/部分解码；异步回调式，无 Promise 风格 |
| 创建内存缓冲区 | `WebAudioContext.createBuffer(numOfChannels, length, sampleRate)` | 2.19.0 | 手动分配，受内存约束 |
| 读取 PCM 采样 | `AudioBuffer.getChannelData(channel)` | 2.19.0 | 返回 Float32Array（-1.0 ～ 1.0）⚠️ 待验证是否支持 `copyFromChannel` |
| 播放节点 | `createBufferSource()` → `BufferSourceNode.start(when, offset, duration)` | 2.19.0 | 支持 `offset/duration` → **可精确播放任意时间区间**（编辑器试听的基础）|
| 增益 | `createGain()` | 2.19.0 | `GainNode` |
| 均衡/滤波 | `createBiquadFilter()`、`createIIRFilter(feedforward, feedback)` | 2.19.0 | 可实现 EQ、高低通 |
| 动态处理 | `createDynamicsCompressor()` | 2.19.0 | 压缩/限幅 |
| 延迟 | `createDelay(maxDelayTime)` | 2.19.0 | 回声/混响基础块 |
| 失真/整形 | `createWaveShaper()` | 2.19.0 | 软削波 |
| 声道拆分/合并 | `createChannelSplitter()`、`createChannelMerger()` | 2.19.0 | 声像、立体声处理 |
| 分析 | `createAnalyser()` | 2.19.0 | 电平表、频谱可视化 |
| 实时脚本处理 | `createScriptProcessor(bufferSize, inCh, outCh)` | 2.19.0 | 已废弃但**是小程序内唯一的实时自定义处理入口**（无 `AudioWorklet`）|
| 声源/振荡器 | `createOscillator()`、`createConstantSource()`、`createPeriodicWave()` | 2.19.0 | 测试信号、节拍器 |
| 空间音频 | `createPanner()`、`listener` | 2.19.0 | 本产品不使用 |
| 上下文控制 | `suspend()` / `resume()` / `close()` / `state` / `onstatechange` | 2.19.0 | 后台切换需处理 |

**❌ 平台不提供**：`OfflineAudioContext`（离线渲染）、`AudioWorklet`、`MediaStreamAudioDestinationNode`、`MediaElementAudioSourceNode`、音频编码 API、`decodeAudioData` 的流式版本。

### 1.2 录音

| 能力 | 接口 | 关键限制（官方原文要点） |
| --- | --- | --- |
| 录音 | `wx.getRecorderManager()` → `start(options)` | — |
| 时长 | `duration` | 默认 60000ms，**最大 600000ms（10 分钟）** |
| 采样率 | `sampleRate` | 默认 **8000**；合法值：8000/11025/12000/16000/22050/24000/32000/44100/48000；**PC 不支持设置该参数** |
| 声道数 | `numberOfChannels` | 默认 **2** |
| 格式 | `format` | `mp3` / `aac`（默认）/ `wav` / **`PCM`** |
| 分帧回调 | `frameSize`（KB） | **仅 `mp3`、`PCM` 支持**，指定后每录满一帧回调一次文件内容 → 可流式落盘 |
| 码率 | `encodeBitRate` | 默认 48000；**与采样率强绑定**，如 44100 只接受 64000～320000，配错直接录音失败 |
| 输入源 | `audioSource` | 2.1.0+；取值受平台限制（`buildInMic`/`headsetMic` 仅 iOS，`mic`/`camcorder`/`voice_communication`/`voice_recognition` 仅 Android） |
| 事件 | `onStart/onPause/onResume/onStop/onFrameRecorded/onError/onInterruptionBegin` | — |

⚠️ **已知社区反馈（非官方结论）**：有开发者报告 `getRecorderManager` 产出的 mp3/wav 文件"头不规范"，导致后端 SDK 校验失败。
→ **本项目的规避设计**：录音一律使用 `format: 'PCM'` + `frameSize`，由我们自己拼接标准 WAV 头落盘（头部写法见 [03 §2](./03-audio-engine.md#2-中间格式规范)）。这样既避开封装不可靠的问题，又天然支持流式写入与内存控制。

### 1.3 播放

| 能力 | 接口 | 关键限制 |
| --- | --- | --- |
| 长音频播放 | `wx.createInnerAudioContext()` | `src` 支持本地路径/云文件 ID；`startTime` 指定起始秒；`currentTime` **2.26.2 起可写，等同 seek**；`playbackRate` 0.5～2.0（2.11.0+，Android 6+）；`volume` 0～1；`obeyMuteSwitch` 自 2.3.0 起由 `wx.setInnerAudioOption` 统一控制 |
| 支持格式（官方表） | wav：iOS √ / Android √；mp3：√/√；m4a：√/√；aac：√/√；flac：iOS ✗；amr/ogg/ape/wma：iOS ✗ | 导出成 WAV 是跨平台最安全的选择 |
| 系统中断 | `wx.onAudioInterruptionBegin` / `onAudioInterruptionEnd` | 来电/其他 App 抢占声音时必须处理，否则 UI 状态错乱 |

**播放策略结论**：编辑器的"整体试听"用 `InnerAudioContext` 播放渲染出的预览 WAV（可靠、支持长音频、支持 seek）；"短片段循环试听/效果对比"用 WebAudio `BufferSourceNode.start(when, offset, duration)`（毫秒级精度、可无缝循环）。

### 1.4 文件系统

| 能力 | 接口 | 关键限制 |
| --- | --- | --- |
| 用户数据目录 | `wx.env.USER_DATA_PATH` | 小程序可读写目录，用于存放素材/工程/成品 |
| 读整个文件 | `FileSystemManager.readFile({filePath, encoding})` | 可读 `ArrayBuffer` |
| **分块读** | `FileSystemManager.open()` 拿 `fd` → `FileSystemManager.read({fd, arrayBuffer, offset, length, position})` | 基础库 **2.16.1+**；`arrayBuffer` 为写入缓冲；`position` 指定起始字节 → **可随机访问，是分块渲染的基石** |
| 写文件 | `FileSystemManager.writeFile({filePath, data: ArrayBuffer})` | 支持 `ArrayBuffer`/`string`；**单文件上限 100MB**（错误码 1300202） |
| 大小/存在/删除 | `stat` / `access` / `unlink` / `rmdir` / `mkdir` | — |
| 保存到电脑 | `wx.saveFileToDisk` | 仅 PC 微信可用，移动端不可用 |
| 保存到小程序本地 | `FileSystemManager.saveFile` | 存到本地用户目录 |

**导出后的"给用户"路径（产品必须讲清楚）**：

| 平台 | 可行路径 | 说明 |
| --- | --- | --- |
| iOS / Android | `wx.shareFileMessage`（2.16.1+）分享到聊天；成品保留在小程序"我的成品"并可再次分享 | **小程序无法把音频直接写入手机文件管理器/音乐库**，这是平台限制 |
| PC 微信 | 额外支持 `wx.saveFileToDisk` 直接存盘 | — |

> 产品结论：导出的成功态文案应引导"发送给朋友 / 保存在我的成品 + 再次分享"，而不是"已保存到手机"。避免用户预期落空导致的差评与投诉。

### 1.5 输入选择与多线程

| 能力 | 接口 | 关键限制 |
| --- | --- | --- |
| 选聊天文件 | `wx.chooseMessageFile({count, type:'file', extension})` | 从微信会话里选文件 |
| 选相册媒体 | `wx.chooseMedia({mediaType, sourceType})` | 用于取本地音视频 |
| Worker | `app.json` 的 `workers` 字段 + `wx.createWorker(path)` | 独立上下文，**不能调用主线程方法**；`postMessage` 是**数据复制**而非共享；Worker 内**不能使用 WebAudio / wx 的大多数 API**（⚠️ 待验证可用 API 白名单） |
| 分包 | `subPackages` | 主包体积限制，`lamejs`(≈156KB) 建议放分包或主包按需引入 |

### 1.6 权限与合规

| 项 | 说明 |
| --- | --- |
| 录音授权 | `scope.record`，首次调用 `RecorderManager.start` 触发；拒绝后需引导到 `wx.openSetting` |
| 隐私协议 | 需在小程序后台配置《用户隐私保护指引》，声明"麦克风"用途；调隐私接口前按规范调用隐私授权流程（微信隐私协议要求） |
| 音频内容审核 | 用户生成内容（UGC）可能触发内容安全要求，需评估是否需要 `msgSecCheck` 类能力（本项目为本地处理，但分享出去的成品属于传播内容，需留存合规说明） |
| 版权 | 内置 BGM/音效若来自第三方需授权；本项目 MVP **不内置任何音乐素材**，规避风险 |

## 2. 技术选型决策

### 2.1 主选方案（已确认）

**端上 WebAudio 解码 + 自研 JS DSP + Worker 分块渲染 + WAV 导出。**

数据流、架构图、三条不变量与分块渲染的实现细节见 [03 §1](./03-audio-engine.md#1-架构总览) 与 [03 §5](./03-audio-engine.md#5-分块渲染管线导出与预览的核心)。本节只记录选型结论、理由与被否方案。

### 2.2 被否方案与理由

| 方案 | 否决理由 |
| --- | --- |
| **WebView + H5 WebAudio** | 可拿到完整 WebAudio（含 `OfflineAudioContext`），但需 `web-view` 承载：与小程序通信复杂、无法直接用小程序文件系统（要落地中转）、包体与加载更重、`web-view` 有业务域名要求、审核与体验均更差。**保留为"如果端上渲染不可行"的 Plan B。** |
| **`ScriptProcessorNode` 实时采集渲染** | 唯一可行的"实时"路线，但：必须按真实时间等待（渲染 3 分钟音频就要等 3 分钟）、小程序后台会中断、采集稳定性 ⚠️ 待验证。**仅用于 P1 的"实时效果监听"场景，不作为导出路径。** |
| **云函数/服务端处理** | 能力最强（ffmpeg），但引入后端成本、上传流量、隐私与合规负担、离线不可用。违背"纯端上、即用即走"的产品定位。**仅作为超长音频/复杂降噪的远期兜底。** |
| **小程序原生插件** | `wx.createWebAudioContext` **在小程序插件中不支持**（官方明示），插件市场也无成熟音频 DSP 插件。 |
| **只做"截取+换格式"** | 实现成本低，但同质化严重、无差异化，不做。 |

### 2.3 关键工程决策

| 决策 | 内容 | 理由 |
| --- | --- | --- |
| D-01 | 主语言 **TypeScript** | DSP 与 EDL 逻辑复杂，类型是第一道防线 |
| D-02 | 中间格式统一 **16-bit PCM WAV** | 内存减半（vs Float32）、`InnerAudioContext` 双端可播、可分块随机读、无需第三方解码器 |
| D-03 | 处理采样率 **默认 44.1k**，可选 22.05k 省内存 | 44.1k 与主流素材一致，避免重复重采样；低端机/长音频可降级 |
| D-04 | **非破坏性编辑（EDL）** | 剪辑只改 JSON，撤销重做与参数调整几乎零成本 |
| D-05 | 波形数据 **预计算 + 多级金字塔 + 落盘缓存** | 避免每次打开项目都重新解码整个文件 |
| D-06 | 渲染在 **Worker** 中分块执行 | 避免长任务卡主线程（滑块、动画卡顿） |
| D-07 | 导出默认 **WAV**，MP3 走 **lamejs** 作为可选 | 平台无编码 API；WAV 零依赖且无损 |
| D-08 | 试听走"**渲染预览文件 + InnerAudioContext**" | 绕过无 OfflineAudioContext 且 WebAudio 长音频播放不可靠的问题 |
| D-09 | 所有 DSP **自研纯函数**，在 Node 里可单测 | 平台 API 无法在 Node 中测试，DSP 必须与平台解耦 |
| D-10 | 素材与工程均存 `USER_DATA_PATH`，总量设上限并定期清理 | 单文件 100MB 上限 + 小程序存储存在配额 |

## 3. 容量估算与内存约束

> 本节做**容量估算**（给定采样率与时长，数据有多大），并据此推出平台约束类的硬性设计决策。
> **验收指标口径**（内存峰值、耗时红线）见 [06 §4](./06-engineering-roadmap.md#4-性能与内存预算)，此处不重复。

内存是最容易翻车的地方，先算清楚（44.1kHz）：

| 数据形态 | 1 分钟 | 10 分钟 | 说明 |
| --- | --- | --- | --- |
| Float32 单声道 | 10.6 MB | **105.8 MB** | `decodeAudioData` 的解码产物 |
| Float32 立体声 | 21.2 MB | **211.7 MB** | 极易 OOM |
| Int16 单声道（WAV 落盘形态） | 5.3 MB | 52.9 MB | 不读进内存，只占磁盘 |
| Int16 立体声 | 10.6 MB | 105.8 MB | 同上 |
| **峰值金字塔（1024 采样/桶，min+max，单声道）** | ≈ 0.02 MB | **≈ 0.2 MB** | 常驻内存的主角，可忽略不计 |
| 渲染块（1s，Float32 立体声） | — | — | 0.35 MB / 块，可忽略 |

**由此推出的硬性设计约束**：

1. `decodeAudioData` 的产物（Float32 AudioBuffer）**必须尽快转成 Int16 写入 WAV 文件，然后释放引用**，绝不长期持有。
2. 同一时刻内存中最多只允许 **1 个完整解码的 AudioBuffer**（导入管线加互斥锁/串行队列）。
3. 立即拒绝超过 **10 分钟**或解码后预计内存超过 **120MB** 的素材，并给出明确提示。
4. 渲染必须分块，单块 Float32 输出，块处理完立刻编码写入 `fd` 并复用缓冲（块大小等引擎参数见 [03 §5.2](./03-audio-engine.md#52-渲染调度模型)）。
5. 低端机与长工程需要降级处理链 —— 降级策略与触发条件见 [§6](#6-基础库与兼容策略)。

⚠️ 待验证：小程序 `WebAudioContext` 单次 `decodeAudioData` 的实际内存上限与失败行为（是抛错、OOM 崩溃还是回调 fail）。

## 4. 风险登记表

| 编号 | 风险 | 影响 | 概率 | 缓解措施 |
| --- | --- | --- | --- | --- |
| R-01 | `decodeAudioData` 对某些真实格式（m4a/aac/amr/带 ID3 的 mp3）解码失败或不支持 | 高 | 中 | M0 建格式矩阵实测；失败时给出明确错误与"转成 WAV 再试"的引导 |
| R-02 | 长音频解码 OOM 导致小程序崩溃 | 高 | 中 | 时长/内存前置校验、串行解码、降采样处理链、崩溃可恢复的自动保存 |
| R-03 | Worker 传大 `ArrayBuffer` 的拷贝开销超预期 | 中 | 中 | 分块传输 + 只在必要时跨线程；实测拷贝耗时，必要时把渲染退回主线程但用时间分片 |
| R-04 | Worker 内可用 API 白名单不足（如无 `FileSystemManager`） | 高 | 中 | M0 验证：若 Worker 不能读写文件，则采用"主线程读块 → 传 Worker 计算 → 回传结果 → 主线程写块"的模式 |
| R-05 | 纯 JS DSP（重采样/EQ/压缩）在低端机上过慢 | 中 | 中 | 基准测试 + 降级（减少处理链、降采样率、简化算法）、进度可取消 |
| R-06 | 录音 PCM 分帧回调的顺序/丢帧问题 | 高 | 低 | 校验帧序号与总长度，落盘后校验 WAV 时长达标；异常时提示重录 |
| R-07 | 波形绘制在长音频上卡顿 | 中 | 中 | 峰值金字塔 + 仅重绘可视区 + 低端机降帧率 |
| R-08 | 导出文件 > 100MB（`writeFile` 上限） | 中 | 低 | 导出前按格式预算体积，超限则提示降低采样率/声道/时长 |
| R-09 | 后台切换/来电导致录音或渲染中断 | 中 | 高 | 监听 `onAudioInterruptionBegin/End` 与 `onHide`，渲染可续跑（记录已完成块偏移） |
| R-10 | 审核驳回（隐私说明缺失、麦克风用途不明、UGC 内容安全） | 高 | 中 | 后台配置隐私指引；首次录音前有明确用途提示；不内置版权素材 |
| R-11 | lamejs（LGPL）引入的许可证合规问题 | 中 | 低 | 默认不打包，作为可选能力单独评估；或改用自研/其他许可的编码方案 |
| R-12 | `InnerAudioContext` 对自产 WAV 的 seek 精度不足（用于精确试听） | 中 | 中 | 试听精度要求高时改用 `BufferSourceNode.start(when, offset, duration)` |

## 5. 待实测验证清单（Spike 任务）

> **M0 里程碑的全部内容。这些实验必须在写业务代码前完成**，每个实验产出"结论 + 实测数据 + 复现代码片段"，回填进本文档。

| 编号 | 待验证问题 | 方法 | 通过标准 | 阻塞的功能 |
| --- | --- | --- | --- | --- |
| DB-01 | `decodeAudioData` 支持哪些格式？ | 准备 mp3/m4a/aac/wav/flac/ogg/amr/带 ID3 的 mp3，逐个解码并校验时长与采样点数 | 明确"支持/不支持"格式矩阵 | 导入（IN-4/IN-5） |
| DB-02 | 长音频解码的内存上限？ | 逐步解码 1/3/5/10 分钟 44.1k 立体声，记录内存与失败点 | 得出可安全解码的最大时长 | 内存策略（第 3 节） |
| DB-03 | `AudioBuffer` API 的完整可用面 | 验证 `getChannelData`、`copyFromChannel`、`length`、`numberOfChannels`、`sampleRate`、`duration` | 确认 PCM 读取方式 | 导入管线 |
| DB-04 | `createScriptProcessor` 在真机能否稳定运行并采到输出？ | 构造 ScriptProcessor 回采，校验数据完整性 | 结论（可行性 + 延迟 + 稳定性） | P1 实时监听 |
| DB-05 | Worker 内可用 API 白名单？ | 在 Worker 中尝试 `wx.getFileSystemManager`、`Date`、`Math`、TypedArray、`wx.createWorker` 等 | 明确哪些能用 | 渲染架构（D-06） |
| DB-06 | Worker 传 `ArrayBuffer` 的实际拷贝耗时 | 传 1MB/10MB buffer 往返计时；测试 transferable 是否生效 | 得出 单块最优大小 | 渲染架构 |
| DB-07 | `FileSystemManager.read` 分块读 10MB WAV 的吞吐 | 按 4KB/64KB/1MB 分块读计时 | 得出最优分块读大小 | 分块渲染 |
| DB-08 | 录音 `PCM` + `frameSize` 的实际行为 | 录 60s，检查帧数量、总字节、拼接后 WAV 时长与音质 | 帧连续无丢失、时长误差 < 50ms | 录音（IN-1） |
| DB-09 | 自产 WAV 在 `InnerAudioContext` 上的播放与 seek | 播放 + `seek` + `currentTime` 校验时间点音画一致 | seek 误差 < 100ms | 试听（ED-2/ED-3） |
| DB-10 | `writeFile` 写大 `ArrayBuffer` 的耗时与上限 | 写 10/50/100MB | 确认 100MB 上限与实际耗时 | 导出（EX-1） |
| DB-11 | `shareFileMessage` 分享自产 WAV 的可用性 | 真机分享到聊天并播放 | 双端可分享可播放 | 导出（EX-5） |
| DB-12 | 纯 JS 重采样/EQ 的性能基准 | Node 中跑 3 分钟音频的完整处理链，记录耗时 | 明确降级阈值 | DSP 链（R-05） |
| DB-13 | Canvas 2D 绘制 10 万级竖线波形的帧率 | 真机实测不同缩放级别的绘制耗时 | 得出分帧/降级策略 | 波形（ED-1） |
| DB-14 | 小程序存储配额与 `USER_DATA_PATH` 实际可用空间 | 写入直到失败，记录上限 | 得出清理阈值 | 存储策略（D-10） |

## 6. 基础库与兼容策略

- `app.json` 中设置 `"requiredBackgroundModes"` 无需（不做后台播放）；**最低基础库定为 2.19.0**（`createWebAudioContext` 起点），实际建议提示用户升级到 2.30.0+。
- 在 `app.json` 配置 `"lazyCodeLoading": "requiredComponents"` 降低启动开销。
- 启动时通过 `wx.getAppBaseInfo()`（或 `wx.getSystemInfoSync` 的降级）校验基础库版本与设备性能等级（`benchmarkLevel`），据此选择：
  - `benchmarkLevel < 0`（未知）或低端机 → 22.05k 处理链、低帧率波形、禁用 MP3 导出
  - 中高端机 → 44.1k 处理链、完整功能
- 音频能力不可用时（基础库过低）走**降级模式**：仅提供"截取 + 格式转换"的简易编辑，而非直接白屏报错。
