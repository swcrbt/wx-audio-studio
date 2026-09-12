# 02 · 平台能力盘点与技术选型

> 状态：**已定稿** ｜ 最后更新：2026-09-12 ｜ 关联代码：未实现（设计阶段，规划于 `miniprogram/core/caps.ts`、`core/audio/import.ts`）
>
> **本文负责**：平台能力事实（接口、版本、限制）、技术选型与被否方案、容量估算与由平台约束推出的设计决策、风险登记、Spike 验证清单。
> **本文不负责**：功能优先级与 MVP 边界 → [01](./01-product-spec.md)；算法与实现细节 → [03](./03-audio-engine.md)；验收指标口径 → [06](./06-engineering-roadmap.md)；流程规范 → [../AGENTS.md](../AGENTS.md)。
>
> 本文所有平台事实均来自微信官方文档，**逐条附来源编号与链接**（见 [§1.7 官方来源清单](#17-官方来源清单)）。凡是**未经真机验证**的推断，一律标注 `⚠️ 待验证` 并汇总到文末的 Spike 清单，**编码前必须先跑完**。

## 1. 平台能力总表

> **来源规则**：本节所有平台事实均取自微信官方文档，逐条附来源编号（`S1`～`S20`），编号对应的接口名与 URL 见 [§1.7 官方来源清单](#17-官方来源清单)（核对日期：2026-09-12）。
> 官方文档未覆盖、只能靠真机实测的行为，一律标注 `⚠️ 待验证` 并归入 [§5 Spike 清单](#5-待实测验证清单spike-任务)；**禁止**把推断写成事实（见 [AGENTS §10](../AGENTS.md#10-文档编写规范)）。

### 1.1 音频解码与处理

| 能力 | 接口 | 版本要求 | 关键限制 | 来源 |
| --- | --- | --- | --- | --- |
| 创建音频上下文 | `wx.createWebAudioContext()` | 基础库 **2.19.0** | **小程序插件中不支持**；微信 Windows 版 / Mac 版支持 | [S1](#17-官方来源清单) |
| 解码音频为 PCM | `WebAudioContext.decodeAudioData(audioData, successCallback, errorCallback)` | 2.19.0 | 只接受 `ArrayBuffer`（需自行 `wx.request`/`readFile` 取二进制）；**一次性全量解码**，无流式/部分解码；异步回调式，无 Promise 风格；**官方未给出支持的容器格式列表** | [S2](#17-官方来源清单) |
| 创建内存缓冲区 | `WebAudioContext.createBuffer(numOfChannels, length, sampleRate)` | 2.19.0 | 手动分配，受内存约束 | [S2](#17-官方来源清单) |
| 读取 PCM 采样 | `AudioBuffer.getChannelData(channel)`、`copyFromChannel()`、`copyToChannel()` | 2.19.0 | `getChannelData` 返回 Float32Array（-1.0 ～ 1.0）；官方方法表确认 `copyFromChannel` / `copyToChannel` **存在** | [S3](#17-官方来源清单) |
| 播放节点 | `createBufferSource()` → `BufferSourceNode.start(when, offset, duration)` | 2.19.0 | 支持 `offset/duration` → **可精确播放任意时间区间**（编辑器试听的基础）| [S2](#17-官方来源清单) |
| 增益 | `createGain()` | 2.19.0 | `GainNode` | [S2](#17-官方来源清单) |
| 均衡/滤波 | `createBiquadFilter()`、`createIIRFilter(feedforward, feedback)` | 2.19.0 | 可实现 EQ、高低通 | [S2](#17-官方来源清单) |
| 动态处理 | `createDynamicsCompressor()` | 2.19.0 | 压缩/限幅 | [S2](#17-官方来源清单) |
| 延迟 | `createDelay(maxDelayTime)` | 2.19.0 | 回声/混响基础块 | [S2](#17-官方来源清单) |
| 失真/整形 | `createWaveShaper()` | 2.19.0 | 软削波 | [S2](#17-官方来源清单) |
| 声道拆分/合并 | `createChannelSplitter()`、`createChannelMerger()` | 2.19.0 | 声像、立体声处理 | [S2](#17-官方来源清单) |
| 分析 | `createAnalyser()` | 2.19.0 | 电平表、频谱可视化 | [S2](#17-官方来源清单) |
| 实时脚本处理 | `createScriptProcessor(bufferSize, inCh, outCh)` | 2.19.0 | 已废弃但**是小程序内唯一的实时自定义处理入口**（无 `AudioWorklet`）| [S2](#17-官方来源清单) |
| 声源/振荡器 | `createOscillator()`、`createConstantSource()`、`createPeriodicWave()` | 2.19.0 | 测试信号、节拍器 | [S2](#17-官方来源清单) |
| 空间音频 | `createPanner()`、`listener` | 2.19.0 | 本产品不使用 | [S2](#17-官方来源清单) |
| 上下文控制 | `suspend()` / `resume()` / `close()` / `state` / `onstatechange` / `currentTime` / `sampleRate` | 2.19.0 | 后台切换需处理；官方提示 `close()` 后不要再访问 `state` | [S2](#17-官方来源清单) |

**❌ 平台不提供**：`OfflineAudioContext`（离线渲染）、`AudioWorklet`、`MediaStreamAudioDestinationNode`、`MediaElementAudioSourceNode`、音频编码 API、`decodeAudioData` 的流式版本。

> 依据：[S2](#17-官方来源清单) 的 `WebAudioContext` 属性与方法总表中**不存在**上述任何方法（该表列出的工厂方法仅 18 个 `create*` 加 `decodeAudioData`），也没有任何音频编码入口 → **离线渲染与编码只能自研**（被否方案与理由见 [§2.2](#22-被否方案与理由)）。

**本节核对结论（2026-09-12）**

1. **选型前提成立**：无 `OfflineAudioContext` / `AudioWorklet` / 编码 API 已由官方方法总表逐项确认 [S2](#17-官方来源清单)，"自研 JS DSP + 分块渲染"的结论不变。
2. **`AudioBuffer` 读取面已确认**：`copyFromChannel` / `copyToChannel` 官方存在（初稿标为待验证）→ [DB-03](#5-待实测验证清单spike-任务) 缩窄为"真机测读取行为与耗时"。
3. **删去一句无出处的话**：初稿写"官方提示 WebAudio 内存占用较大，建议用于短音频/音效"，在官方文档中**找不到出处**，故删除。有出处的相近表述只存在于 `wx.createInnerAudioContext` 的 `useWebAudioImplement` 说明（见 [§1.3](#13-播放)）。
4. `decodeAudioData` 的**格式支持矩阵官方未给**，必须真机实测（[DB-01](#5-待实测验证清单spike-任务)）。
5. ⚠️ 该接口早期为 Beta、Android 灰度（官方社区回复 [S20](#17-官方来源清单)），同帖后续官方回复"目前已全量"；**接口文档未标注 Beta**，机型覆盖仍须真机确认（[DB-02](#5-待实测验证清单spike-任务)）。

### 1.2 录音

| 能力 | 接口 | 关键限制（官方原文要点） | 来源 |
| --- | --- | --- | --- |
| 录音 | `wx.getRecorderManager()` → `start(options)` | — | [S5](#17-官方来源清单) |
| 时长 | `duration` | 默认 60000ms，**最大 600000ms（10 分钟）** | [S5](#17-官方来源清单) |
| 采样率 | `sampleRate` | 默认 **8000**；合法值：8000/11025/12000/16000/22050/24000/32000/44100/48000；**PC 不支持设置该参数** | [S5](#17-官方来源清单) |
| 声道数 | `numberOfChannels` | 默认 **2** | [S5](#17-官方来源清单) |
| 格式 | `format` | `mp3` / `aac`（默认）/ `wav` / **`PCM`** | [S5](#17-官方来源清单) |
| 分帧回调 | `frameSize`（KB） | **仅 `mp3`、`PCM` 支持**，指定后每录满一帧回调一次文件内容 → 可流式落盘 | [S5](#17-官方来源清单) |
| 码率 | `encodeBitRate` | 默认 48000；**与采样率强绑定**，如 44100 只接受 64000～320000，配错直接录音失败 | [S5](#17-官方来源清单) |
| 输入源 | `audioSource` | 2.1.0+；取值受平台限制（`buildInMic`/`headsetMic` 仅 iOS，`mic`/`camcorder`/`voice_communication`/`voice_recognition` 仅 Android）；可用取值由 `wx.getAvailableAudioSources()` 返回 | [S5](#17-官方来源清单) [S19](#17-官方来源清单) |
| 事件 | `onStart` / `onPause` / `onResume` / `onStop` / `onFrameRecorded` / `onError` / `onInterruptionBegin` / `onInterruptionEnd` | `onFrameRecorded` 仅在设置 `frameSize` 时回调，回调字段为 `res.frameBuffer`；中断事件覆盖微信语音/视频通话抢占场景 | [S6](#17-官方来源清单) |

⚠️ **已知社区反馈（非官方结论）**：有开发者报告 `getRecorderManager` 产出的 mp3/wav 文件"头不规范"，导致后端 SDK 校验失败。
→ **本项目的规避设计**：录音一律使用 `format: 'PCM'` + `frameSize`，由我们自己拼接标准 WAV 头落盘（头部写法见 [03 §2](./03-audio-engine.md#2-中间格式规范)）。这样既避开封装不可靠的问题，又天然支持流式写入与内存控制。

**本节核对结论（2026-09-12，[S5](#17-官方来源清单) [S6](#17-官方来源清单)）**：官方参数表与本项目录音配置逐项比对**全部一致**，设计无需修改：

| 参数 | 官方默认 / 范围 | 本项目取值（[03 §3](./03-audio-engine.md#3-素材导入管线)） | 结论 |
| --- | --- | --- | --- |
| `duration` | 默认 60000ms，最大 600000ms | 600000 | ✅ |
| `sampleRate` | 默认 8000；PC 不支持设置 | 44100 | ✅ 需 PC 降级路径 |
| `numberOfChannels` | 默认 2 | 1 | ✅ |
| `format` | 默认 aac | PCM | ✅ |
| `frameSize` | 单位 KB，仅 mp3/pcm 支持 | 64 | ✅ 与 PCM 匹配 |
| `encodeBitRate` | 默认 48000；44100 → 64000～320000 | 96000 | ✅ 落在合法区间 |
| `audioSource` | 默认 auto | auto | ✅ |

**帧连续性、总字节数与落盘时长误差仍须真机实测**（[DB-08](#5-待实测验证清单spike-任务)）。

⚠️ **已知社区反馈（非官方结论）**：有开发者报告 `getRecorderManager` 产出的 mp3/wav 文件"头不规范"，导致后端 SDK 校验失败。
→ **本项目的规避设计**：录音一律使用 `format: 'PCM'` + `frameSize`，由我们自己拼接标准 WAV 头落盘（头部写法见 [03 §2](./03-audio-engine.md#2-中间格式规范)）。这样既避开封装不可靠的问题，又天然支持流式写入与内存控制。

### 1.3 播放

| 能力 | 接口 | 关键限制 | 来源 |
| --- | --- | --- | --- |
| 长音频播放 | `wx.createInnerAudioContext()` | 1.6.0 起支持；`src` 支持本地路径/云文件 ID（2.2.3+）；`startTime` 指定起始秒；`currentTime` **2.26.2 起可写，等同 seek**；`playbackRate` 0.5～2.0（2.11.0+，Android 6+）；`volume` 0～1；`obeyMuteSwitch` 自 2.3.0 起由 `wx.setInnerAudioOption` 统一控制；**实例不会自动释放，不再用时须 `destroy()`** | [S4](#17-官方来源清单) |
| 支持格式（官方表） | wav：iOS √ / Android √；mp3：√/√；m4a：√/√；aac：√/√；flac：iOS ✗ / Android √；amr/ogg/ape/wma/mp4：iOS ✗ / Android √ | 导出成 WAV 是跨平台最安全的选择 | [S4](#17-官方来源清单) |
| 系统中断 | `wx.onAudioInterruptionBegin` / `wx.onAudioInterruptionEnd` | 来电/其他 App 抢占声音时必须处理，否则 UI 状态错乱 | [S4](#17-官方来源清单) |
| WebAudio 驱动播放 | `wx.createInnerAudioContext({ useWebAudioImplement: true })` | 2.19.0 起；官方说明：**短音频、播放频繁**时建议开启（性能更优），**会带来一定内存增长，长音频建议关闭** | [S4](#17-官方来源清单) |
| 全局音频选项 | `wx.setInnerAudioOption({ mixWithOther, obeyMuteSwitch, speakerOn })` | 2.3.0 起，全局生效；官方注意事项：**不兼容 `wx.createWebAudioContext`**，也不兼容开启了 `useWebAudioImplement` 的 InnerAudioContext | [S4](#17-官方来源清单) |

**播放策略结论**：编辑器的"整体试听"用 `InnerAudioContext` 播放渲染出的预览 WAV（可靠、支持长音频、支持 seek）；"短片段循环试听/效果对比"用 WebAudio `BufferSourceNode.start(when, offset, duration)`（毫秒级精度、可无缝循环）。

**本节核对结论（2026-09-12，[S4](#17-官方来源清单)）**：原表三项（`playbackRate` 范围与版本、`currentTime` 2.26.2 起可写、格式支持表）均已逐项对照官方页，**无偏差**；另**新增登记两项**（已并入上表）：`useWebAudioImplement`、`wx.setInnerAudioOption`。

> ⚠️ 由上表最后一行推出的约束：**`wx.setInnerAudioOption` 管不到 WebAudio 试听链路**（静音开关、混播策略对它不生效），两条试听路径的行为差异需真机确认（并入 [DB-09](#5-待实测验证清单spike-任务)）。


### 1.4 文件系统

| 能力 | 接口 | 关键限制 | 来源 |
| --- | --- | --- | --- |
| 用户数据目录 | `wx.env.USER_DATA_PATH` | 指向**本地用户文件**目录（1.7.0 起提供），开发者对该目录有完全读写权限 | [S7](#17-官方来源清单) |
| 存储配额 | 本地用户文件 + 本地缓存文件 | **两者合计上限 200MB**；清理时机与代码包相同（仅在代码包被清理时清理）→ 本项目存储策略的硬上限（见 [05 §5](./05-data-model.md#5-容量策略)） | [S7](#17-官方来源清单) |
| 本地临时文件 | `wx.chooseMessageFile` / `wx.chooseMedia` 等产出的 `tempFilePath` | 只能读不能写；运行时最多 4GB，小程序退出后若占用超 2GB 会按最近使用时间清理到 < 2GB → **导入中转文件必须尽快转存为本地用户文件** | [S7](#17-官方来源清单) |
| 读整个文件 | `FileSystemManager.readFile({filePath, encoding})` | 可读 `ArrayBuffer` | [S8](#17-官方来源清单) |
| **分块读** | `FileSystemManager.open()` 拿 `fd` → `FileSystemManager.read({fd, arrayBuffer, offset, length, position})` | 基础库 **2.16.1+**；`arrayBuffer` 为写入缓冲；`position` 指定起始字节（传正整数时文件指针保持不变）→ **可随机访问，是分块渲染的基石** | [S8](#17-官方来源清单) |
| 写文件 | `FileSystemManager.writeFile({filePath, data: ArrayBuffer})` | 支持 `ArrayBuffer`/`string`；**单文件上限 100MB**（错误码 1300202） | [S8](#17-官方来源清单) |
| 重命名 / 移动 | `FileSystemManager.rename({oldPath, newPath})` | 支持本地路径，可把文件从 oldPath 移动到 newPath → 原子保存（写 `.tmp` → `rename`）可用 | [S8](#17-官方来源清单) |
| 大小/存在/删除 | `stat` / `access` / `unlink` / `rmdir` / `mkdir` | — | [S8](#17-官方来源清单) |
| 保存到电脑 | `wx.saveFileToDisk({filePath})` | 2.11.0 起；**仅在 PC 端支持**（微信 Windows / Mac 版），移动端不可用 | [S18](#17-官方来源清单) |
| 保存到小程序本地 | `FileSystemManager.saveFile` | 把本地临时文件保存为本地缓存文件 | [S8](#17-官方来源清单) |
| 转发文件到聊天 | `wx.shareFileMessage({filePath, fileName})` | 2.16.1 起；`filePath` 必须为本地路径或临时路径 | [S17](#17-官方来源清单) |

**导出后的"给用户"路径（产品必须讲清楚）**：

| 平台 | 可行路径 | 说明 | 来源 |
| --- | --- | --- | --- |
| iOS / Android | `wx.shareFileMessage` 分享到聊天；成品保留在小程序"我的成品"并可再次分享 | **小程序无法把音频直接写入手机文件管理器/音乐库**，这是平台限制（官方仅提供上述两个文件落盘接口） | [S17](#17-官方来源清单) [S18](#17-官方来源清单) |
| PC 微信 | 额外支持 `wx.saveFileToDisk` 直接存盘 | — | [S18](#17-官方来源清单) |

> 产品结论：导出的成功态文案应引导"发送给朋友 / 保存在我的成品 + 再次分享"，而不是"已保存到手机"。避免用户预期落空导致的差评与投诉。

**本节核对结论（2026-09-12，[S7](#17-官方来源清单) [S8](#17-官方来源清单) [S17](#17-官方来源清单) [S18](#17-官方来源清单)）**：`read` 的版本与 `position` 语义、`writeFile` 的 100MB 上限与错误码 `1300202`、`saveFileToDisk` 仅 PC、`shareFileMessage` 的 2.16.1 四项均与原文档一致。**新增登记两条**：存储配额 200MB、临时文件清理策略。

> 两点结论：① 200MB 存储配额比内存预算更容易触顶（10 分钟 44.1k 立体声素材落盘即 105.8MB，已占配额一半）→ 容量硬上限以配额为准，见 [§3](#3-容量估算与内存约束) 与 [05 §5](./05-data-model.md#5-容量策略)；② [05 §7](./05-data-model.md#7-自动保存与恢复) 标注的"⚠️ 待验证 `rename`"**可以关闭**：官方已确认支持，原子保存方案可用，无需 spike。


### 1.5 输入选择与多线程

| 能力 | 接口 | 版本要求 | 关键限制（官方原文要点） | 来源 |
| --- | --- | --- | --- | --- |
| 选聊天文件 | `wx.chooseMessageFile({count, type:'file', extension})` | 2.5.0（`extension` 2.6.0） | 从客户端会话选文件；`count` 可 0～100；`extension` 仅 `type: 'file'` 时有效 | [S19](#17-官方来源清单) |
| 选相册媒体 | `wx.chooseMedia({mediaType, sourceType})` | 2.10.0 | 拍摄或从相册选图片/视频 | [S19](#17-官方来源清单) |
| 查询可用输入源 | `wx.getAvailableAudioSources()` | 2.1.0 | 返回值即 `RecorderManager.start` 的 `audioSource` 合法值 | [S19](#17-官方来源清单) |
| 创建 Worker | `wx.createWorker(scriptPath, options)` | 1.9.90 | `scriptPath` 为入口文件的**绝对路径**且不以 `/` 开头；**目前最多只能创建 1 个 Worker**，创建下一个前必须先 `terminate()` | [S10](#17-官方来源清单) |
| Worker 代码目录 | `app.json` 的 `workers` 字段 | 1.9.90 | 目录下所有 JS 最终被打包成**一个 JS 文件**并作为**小程序首包**的一部分；目录内**只支持 JS 文件**，其他静态文件必须放目录外 | [S9](#17-官方来源清单) [S13](#17-官方来源清单) |
| **Worker 内可用 API** | — | — | 官方明确：**"Worker 内不支持 `wx` 系列的 API"**；Worker 内代码**只能 require 指定 Worker 路径内的文件，无法引用其他路径**；Workers 之间不支持互相发消息 | [S9](#17-官方来源清单) |
| 实验 Worker | `wx.createWorker(path, { useExperimentalWorker: true })` | 2.13.0 | iOS 下 JS 运行效率比非实验 Worker **提升数倍**，需在 Worker 内做重度计算时建议开启；极小概率在系统资源紧张时被回收 → 需配合 `Worker.onProcessKilled` 重建 | [S10](#17-官方来源清单) |
| Worker 分包 | `app.json` 中 worker 配为分包 + `wx.preDownloadSubpackage` | 2.27.3 | 可把 Worker 代码打包为分包以不占首包（需开发者工具 nightly）；需先下载分包再初始化 Worker | [S9](#17-官方来源清单) [S11](#17-官方来源清单) |
| 分包体积 | `subPackages` | 微信客户端 6.6.0 / 基础库 1.7.3 | **单个分包或主包 ≤ 2M，所有分包合计 ≤ 30M**（服务商代开发 ≤ 20M）→ `lamejs`(≈156KB) 等可选依赖建议放分包 | [S12](#17-官方来源清单) |
| 跨线程传输 | `Worker.postMessage` | — | **数据复制而非共享**（transferable 是否生效官方未说明，需实测） | [S9](#17-官方来源清单) |

**本节核对结论（2026-09-12）**：初稿写"Worker 内不能使用 WebAudio / wx 的大多数 API（⚠️ 待验证白名单）"，现已被官方文档**确定为一条硬限制**：不是"大多数"，而是"**Worker 内不支持 `wx` 系列 API**"。由此产生两条硬约束，已同步到架构文档：

1. **渲染架构被官方约束反向确认**：Worker 内既无文件系统也无解码能力 → [03 §5.2](./03-audio-engine.md#52-渲染调度模型) 的"主线程负责文件 I/O 与解码、Worker 只做纯计算（TypedArray / Math）"不是权衡结果而是**唯一可行方案**；[DB-05](#5-待实测验证清单spike-任务) 由"架构阻塞项"降级为"确认项"（只需确认内建对象可用性与 TS→JS 编译方式）。
2. **渲染代码必须物理位于 `workers/` 目录内**：初稿规划的 `core/engine/render.ts` 被 Worker 引用，违反"只能 require Worker 路径内文件" → 目录归属调整见 [ADR-0001](./adr/0001-worker-code-packaging.md)，并已修正 [03 §5.2](./03-audio-engine.md#52-渲染调度模型) 与 [06 §1](./06-engineering-roadmap.md#1-目录结构)。

### 1.6 权限与合规

| 项 | 说明 | 来源 |
| --- | --- | --- |
| 录音授权 | `scope.record` 对应 `RecorderManager.start`、`wx.startRecord`、`live-pusher` 组件、`wx.joinVoIPChat`；用户拒绝后不再弹窗而是直接进 fail 回调，需用 `wx.getSetting` 查状态并引导 `wx.openSetting` | [S15](#17-官方来源清单) |
| 隐私协议 | 需在小程序后台配置《用户隐私保护指引》并声明"麦克风"用途；调隐私接口前按官方指南完成隐私授权流程 | [S16](#17-官方来源清单) |
| 音频内容审核 | 用户生成内容（UGC）可能触发内容安全要求，需评估是否需要 `msgSecCheck` 类能力（本项目为本地处理，但分享出去的成品属于传播内容，需留存合规说明） | — |
| 版权 | 内置 BGM/音效若来自第三方需授权；本项目 MVP **不内置任何音乐素材**，规避风险 | — |

### 1.7 官方来源清单

> 本节是 [§1](#1-平台能力总表) 中 `S1`～`S20` 引用的展开处，**核对日期：2026-09-12**。官方页面如更新，以官方为准并同步修订本节（见 [AGENTS §10](../AGENTS.md#10-文档编写规范)）。
> 引用优先级：官方接口/框架文档 > 官方开放社区回复。当前仅 `S20` 属社区来源，已单独标注。

| 编号 | 来源（官方页面） | URL |
| --- | --- | --- |
| S1 | `wx.createWebAudioContext()` | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createWebAudioContext.html |
| S2 | `WebAudioContext`（属性与方法总表，含 `decodeAudioData`） | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/WebAudioContext.html |
| S3 | `AudioBuffer`（`getChannelData` / `copyFromChannel` / `copyToChannel`） | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/AudioBuffer.html |
| S4 | `InnerAudioContext`；`wx.createInnerAudioContext`（`useWebAudioImplement`）；`wx.setInnerAudioOption` | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/InnerAudioContext.html<br>https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createInnerAudioContext.html<br>https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.setInnerAudioOption.html |
| S5 | `RecorderManager.start`（参数表与采样率/码率对应表） | https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html |
| S6 | `RecorderManager`（事件清单与 `onFrameRecorded`） | https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.html |
| S7 | 文件系统（本地文件三类、200MB 配额、清理策略） | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html |
| S8 | `FileSystemManager.read`；`writeFile`；`rename`（均含错误码表） | https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.read.html<br>https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.writeFile.html<br>https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.rename.html |
| S9 | 多线程 Worker（使用流程与 7 条注意事项） | https://developers.weixin.qq.com/miniprogram/dev/framework/workers.html |
| S10 | `wx.createWorker`（并发上限、`useExperimentalWorker`） | https://developers.weixin.qq.com/miniprogram/dev/api/worker/wx.createWorker.html |
| S11 | `wx.preDownloadSubpackage` | https://developers.weixin.qq.com/miniprogram/dev/api/base/subpackage/wx.preDownloadSubpackage.html |
| S12 | 分包加载（体积限制） | https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html |
| S13 | 全局配置 `app.json`（`workers` / `lazyCodeLoading` / `requiredBackgroundModes`） | https://developers.weixin.qq.com/miniprogram/dev/reference/configuration/app.html |
| S14 | `wx.getAppBaseInfo`；`wx.getDeviceInfo`（`benchmarkLevel`）；`wx.getDeviceBenchmarkInfo` | https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getAppBaseInfo.html<br>https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getDeviceInfo.html<br>https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getDeviceBenchmarkInfo.html |
| S15 | 授权（scope 列表、拒绝后的处理与 `wx.openSetting`） | https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/authorize.html |
| S16 | 小程序隐私协议开发指南 | https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html |
| S17 | `wx.shareFileMessage` | https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.shareFileMessage.html |
| S18 | `wx.saveFileToDisk` | https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.saveFileToDisk.html |
| S19 | `wx.chooseMessageFile`；`wx.chooseMedia`；`wx.getAvailableAudioSources` | https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html<br>https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseMedia.html<br>https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.getAvailableAudioSources.html |
| S20 | **官方开放社区回复**（非接口文档）：`createWebAudioContext` 曾为 Beta、Android 灰度；同帖后续官方回复"目前已全量" | https://developers.weixin.qq.com/community/develop/doc/000620660b0e1017081a6095e5d000 |

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
6. **存储配额是另一个硬上限**：本地用户文件与本地缓存文件合计 **200MB**（官方原文，见 [§1.4](#14-文件系统) / [S7](#17-官方来源清单)），而素材必须以 WAV 形态落盘 → 10 分钟 44.1k 立体声素材（105.8MB）单条就占掉配额一半，再叠加成品与预览渲染文件极易触顶。因此：单工程素材总量按 200MB 配额反推控制，落盘体积敏感场景（长音频/立体声）需转单声道或降采样率，具体策略见 [05 §5](./05-data-model.md#5-容量策略)。

⚠️ 待验证：小程序 `WebAudioContext` 单次 `decodeAudioData` 的实际内存上限与失败行为（是抛错、OOM 崩溃还是回调 fail）—— [DB-02](#5-待实测验证清单spike-任务)；存储配额的**实际**可用空间与 `1300202` 触发点 —— [DB-14](#5-待实测验证清单spike-任务)。

## 4. 风险登记表

| 编号 | 风险 | 影响 | 概率 | 缓解措施 |
| --- | --- | --- | --- | --- |
| R-01 | `decodeAudioData` 对某些真实格式（m4a/aac/amr/带 ID3 的 mp3）解码失败或不支持 | 高 | 中 | M0 建格式矩阵实测；失败时给出明确错误与"转成 WAV 再试"的引导 |
| R-02 | 长音频解码 OOM 导致小程序崩溃 | 高 | 中 | 时长/内存前置校验、串行解码、降采样处理链、崩溃可恢复的自动保存 |
| R-03 | Worker 传大 `ArrayBuffer` 的拷贝开销超预期 | 中 | 中 | 分块传输 + 只在必要时跨线程；实测拷贝耗时，必要时把渲染退回主线程但用时间分片 |
| R-04 | Worker 代码必须自包含在 `workers/` 目录内（不能 require 目录外文件），渲染引擎与 DSP 的物理归属需要重构 | 中 | **已发生**（官方限制） | 限制原文与影响见 [§1.5](#15-输入选择与多线程)；已据此调整目录结构，见 [ADR-0001](./adr/0001-worker-code-packaging.md)；剩余不确定性（TS 文件组织与分包）由 [DB-05](#5-待实测验证清单spike-任务) 验证 |
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
> 本清单已按 **2026-09-12 的官方文档核对结果同步缩窄**：已被官方文档回答的部分（DB-03 的接口存在性、DB-05 的 `wx` API 可用性、DB-14 的配额数值）只保留必须真机确认的部分，其余不再重复实验。

| 编号 | 待验证问题 | 方法 | 通过标准 | 阻塞的功能 |
| --- | --- | --- | --- | --- |
| DB-01 | `decodeAudioData` 支持哪些格式？ | 准备 mp3/m4a/aac/wav/flac/ogg/amr/带 ID3 的 mp3，逐个解码并校验时长与采样点数 | 明确"支持/不支持"格式矩阵 | 导入（IN-4/IN-5） |
| DB-02 | 长音频解码的内存上限？ | 逐步解码 1/3/5/10 分钟 44.1k 立体声，记录内存与失败点 | 得出可安全解码的最大时长 | 内存策略（第 3 节） |
| DB-03 | `AudioBuffer` 的**真机读取行为**（接口存在性已由官方文档确认 [S3](#17-官方来源清单)） | 用 `getChannelData` 与 `copyFromChannel` 各读取一次大 buffer，对比耗时、是否需要额外拷贝 | 明确导入管线取 PCM 的写法与耗时 | 导入管线 |
| DB-04 | `createScriptProcessor` 在真机能否稳定运行并采到输出？ | 构造 ScriptProcessor 回采，校验数据完整性 | 结论（可行性 + 延迟 + 稳定性） | P1 实时监听 |
| DB-05 | Worker 内**非 wx** 能力的可用面与代码装载方式（"不支持 wx 系列 API" 已由官方确认 [S9](#17-官方来源清单)） | ① 在 Worker 中逐个尝试 `Date`/`Math`/TypedArray/`TextEncoder`/`console` 等内建对象；② 验证 `workers/` 目录内的 `.ts` 是否被开发者工具编译、能否 require 同目录多个文件；③ 验证 worker 分包（2.27.3+）与 `useExperimentalWorker` 的实机表现 | 得到可用内建对象清单 + 确定的 Worker 代码组织形式（[ADR-0001](./adr/0001-worker-code-packaging.md)） | 渲染架构（D-06） |
| DB-06 | Worker 传 `ArrayBuffer` 的实际拷贝耗时 | 传 1MB/10MB buffer 往返计时；测试 transferable 是否生效 | 得出 单块最优大小 | 渲染架构 |
| DB-07 | `FileSystemManager.read` 分块读 10MB WAV 的吞吐 | 按 4KB/64KB/1MB 分块读计时 | 得出最优分块读大小 | 分块渲染 |
| DB-08 | 录音 `PCM` + `frameSize` 的实际行为 | 录 60s，检查帧数量、总字节、拼接后 WAV 时长与音质 | 帧连续无丢失、时长误差 < 50ms | 录音（IN-1） |
| DB-09 | 自产 WAV 在 `InnerAudioContext` 上的播放与 seek；两条试听路径与 `wx.setInnerAudioOption` 的关系 | 播放 + `seek` + `currentTime` 校验时间点与听感是否一致；在系统静音开关开启时对比 InnerAudioContext 与 WebAudio 两条路径的表现 | seek 误差 < 100ms；两路径行为差异有明确结论 | 试听（ED-2/ED-3） |
| DB-10 | `writeFile` 写大 `ArrayBuffer` 的耗时与上限 | 写 10/50/100MB | 确认 100MB 上限与实际耗时 | 导出（EX-1） |
| DB-11 | `shareFileMessage` 分享自产 WAV 的可用性 | 真机分享到聊天并播放 | 双端可分享可播放 | 导出（EX-5） |
| DB-12 | 纯 JS 重采样/EQ 的性能基准 | Node 中跑 3 分钟音频的完整处理链，记录耗时 | 明确降级阈值 | DSP 链（R-05） |
| DB-13 | Canvas 2D 绘制 10 万级竖线波形的帧率 | 真机实测不同缩放级别的绘制耗时 | 得出分帧/降级策略 | 波形（ED-1） |
| DB-14 | `USER_DATA_PATH` 的**实际可用空间与失败行为**（官方配额 200MB 已知 [S7](#17-官方来源清单)） | 占位写入至 200MB 附近，记录实际可写量、`1300202` 的触发点与失败时的错误结构 | 确认实际阈值是否严格为 200MB，得出清理提示档位 | 存储策略（D-10） |

## 6. 基础库与兼容策略

- `app.json` 不配置 `requiredBackgroundModes`（字段定义见 [S13](#17-官方来源清单)：仅 `audio` 后台音乐播放与 `location` 后台定位两项；本项目不做后台播放）。**最低基础库定为 2.19.0**（`createWebAudioContext` 起点）[S1](#17-官方来源清单)，实际建议提示用户升级到 2.30.0+。
- 在 `app.json` 配置 `"lazyCodeLoading": "requiredComponents"`（2.11.1 起，官方仅支持该值）以启用按需注入，降低启动开销 [S13](#17-官方来源清单)。
- 启动时探测基础库版本与设备性能等级（**接口与字段依据 [S14](#17-官方来源清单)**），据此选择：
  - 基础库版本：`wx.getAppBaseInfo().SDKVersion`（2.20.1 起；低版本降级 `wx.getSystemInfoSync`）
  - 设备性能等级：`wx.getDeviceInfo().benchmarkLevel`（2.20.1 起，**仅 Android**，`-1` = 性能未知、`>=1` = 性能值且移动端最高不超过 50；iOS 不返回该字段）
  - ⚠️ 官方声明**自基础库 3.4.5 起 `benchmarkLevel` 停止维护**，要求改用 `wx.getDeviceBenchmarkInfo()`（3.4.5 起，另返回 `modelLevel`：1 高档 / 2 中档 / 3 低档 / 0 未知）→ 探测逻辑须实现为"新接口可用则用 `modelLevel`，否则回退 `benchmarkLevel`"
  - `benchmarkLevel < 0`（未知）或低端机 → 22.05k 处理链、低帧率波形、禁用 MP3 导出
  - 中高端机 → 44.1k 处理链、完整功能
- 音频能力不可用时（基础库过低）走**降级模式**：仅提供"截取 + 格式转换"的简易编辑，而非直接白屏报错。
