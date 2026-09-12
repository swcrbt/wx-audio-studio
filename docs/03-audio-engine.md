# 03 · 音频引擎架构与 DSP 算法

> 状态：**实现中** ｜ 最后更新：2026-09-12 ｜ 关联代码：`miniprogram/workers/render/{codec,dsp,edl,peaks}/**`、`workers/render/render.ts`、`workers/render/index.ts`、`core/engine/controller.ts`、`core/audio/import.ts`
>
> **本文负责**：中间格式、导入与录音管线、峰值结构、分块渲染调度、DSP 算法与参数、播放与试听策略、模块接口、错误降级。
> **本文不负责**：平台能力与限制（版本、格式支持、内存上限） → [02](./02-platform-capability.md)；EDL 字段与存储布局 → [05](./05-data-model.md)；性能验收指标 → [06](./06-engineering-roadmap.md)；交互与视觉 → [04](./04-ui-ux.md)。
> 平台前提：无 `OfflineAudioContext`、无音频编码 API、Worker 跨线程数据为复制（唯一权威处：[02 §1.1](./02-platform-capability.md#11-音频解码与处理)）。

## 1. 架构总览

```
┌──────────────────────── 主线程（UI 与调度） ────────────────────────┐
│                                                                    │
│  pages/           components/                core/                 │
│  ├ index(项目)     ├ WaveformCanvas          ├ store/  (EDL 状态)   │
│  ├ record(录音)    ├ TransportBar(播放条)     ├ engine/ (调度)       │
│  ├ editor(编辑)    ├ ToolBar(工具栏)          ├ fs/     (文件读写)   │
│  └ export(导出)    ├ TimelineRuler(标尺)      ├ peaks/  (峰值金字塔) │
│                   ├ TrackList(轨道列表)      └ player/ (播放器)     │
│                   └ ParamSheet(效果参数)                            │
└───────────┬────────────────────────────────────────────────────────┘
            │ ① 素材落盘（ArrayBuffer）      ② 分块请求 / 进度回调
            ▼                                        ▼
┌──────────────────────┐              ┌──────────────────────────────┐
│  WebAudio 解码层      │              │  Worker：渲染引擎             │
│  decodeAudioData      │              │  ├ renderGraph (EDL 求值)     │
│  → Float32 PCM        │              │  ├ dsp/*（纯函数，可单测）    │
│  → Int16 → WAV 落盘   │              │  └ wavEncoder                 │
└──────────┬───────────┘              └───────────┬──────────────────┘
           ▼                                      ▼
┌────────────────────────────────────────────────────────────────────┐
│  USER_DATA_PATH 文件系统                                            │
│  assets/*.wav（16-bit PCM 中间格式）  peaks/*.pk（峰值金字塔）        │
│  projects/*.json（EDL 工程）          renders/*.wav（预览/成品）      │
└────────────────────────────────────────────────────────────────────┘
```

### 1.1 三条不变量

1. **素材只写不改**：任何编辑都不修改 `assets/*.wav`，只改 EDL。
2. **PCM 不常驻**：主线程内存里永远没有完整 PCM，只有峰值金字塔 + 当前渲染块。
3. **渲染分块可续**：渲染以块为单位提交，中断后可从已完成块偏移继续。

## 2. 中间格式规范

**所有素材统一为：`WAV / PCM / 16-bit / 小端 / 无附加 chunk`。**

| 项 | 值 |
| --- | --- |
| 容器 | RIFF WAVE（标准 44 字节头，无 `LIST`/`fact` 等附加块） |
| 编码 | `audioFormat = 1`（线性 PCM） |
| 位深 | 16-bit signed little-endian |
| 采样率 | 工程采样率（默认 44100，可选 22050 / 16000） |
| 声道 | 1 或 2（工程内统一，混音时上混到工程声道数） |
| 命名 | `assets/{assetId}.wav`，`assetId = {timestamp}-{rand6}` |
| 上限 | 单文件 ≤ 100MB（平台限制），同时受 10 分钟时长限制 |

### 44 字节头写法（参考实现）

```ts
// core/audio/wav.ts
export function writeWavHeader(view: DataView, opts: {
  channels: number; sampleRate: number; dataBytes: number;
}): void {
  const { channels, sampleRate, dataBytes } = opts;
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);   // 文件总长 - 8
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);              // fmt 块大小
  view.setUint16(20, 1, true);               // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
}
```

> **流式写入技巧**：录音/导入时先写占位头，落数据，结束后用 `FileSystemManager.write` + `position: 0` 回填 `RIFF.chunkSize`(offset 4) 与 `data.dataSize`(offset 40) 两个 `uint32`，避免二次生成文件。

### Float32 → Int16 转换

```ts
export function floatToInt16(src: Float32Array, dst: Int16Array, offset = 0): void {
  for (let i = 0; i < src.length; i++) {
    let s = src[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;      // 硬削波保护
    dst[offset + i] = s < 0 ? s * 0x8000 : s * 0x7fff; // 非对称缩放，避免正峰溢出
  }
}
```
> 可选：转换前叠加 TPDF dither（±1 LSB 均匀噪声相减），提升极低电平的听感。默认关闭以省算力。

## 3. 素材导入管线

```
输入（录音文件 / chooseMessageFile 路径）
   ↓ 1. 读入 ArrayBuffer（>32MB 走 fd 分块读后拼接，避免 readFile 压力）
   ↓ 2. decodeAudioData → AudioBuffer（Float32，⚠️ 必须串行，全局互斥）
   ↓ 3. 提取声道 → Float32Array[]（不复制，直接引用 getChannelData 结果）
   ↓ 4. 重采样到工程采样率（若不是整数倍，走多相-FIR；整数倍走半带 FIR）
   ↓ 5. 声道统一（多→单：按 -3dB 平均；单→双：复制）
   ↓ 6. 生成峰值金字塔（多级）→ 序列化落盘
   ↓ 7. Float32 → Int16 → 写 assets/{id}.wav
   ↓ 8. 释放 AudioBuffer 引用（置 null）并触发一次内存回收时机
   ↓ 9. 写工程 EDL：新增 Asset 记录 + 一个覆盖全长的初始 Clip
```

**关键实现细节**

| 项 | 设计 |
| --- | --- |
| 串行化 | `ImportQueue` 保证同时只有一个解码在跑；等待中的任务显示排队状态 |
| 前置校验 | 按 [02 §3](./02-platform-capability.md#3-容量估算与内存约束) 的内存阈值拒绝超限素材（预估内存 = 采样率 × 声道 × 4 × 时长），提示"音频过长，请先裁剪" |
| 重采样 | 44.1k↔22.05k 为 2:1，用半带 FIR（31 抽头）质量足够且便宜；44.1k↔16k 用 64 段多相 FIR + 窗函数 |
| 单声道上混 | 复制而非求平均，避免整体电平 -6dB 的意外变化（由 EDL 的声道策略决定） |
| 峰值生成时机 | 在 Int16 转换的同一趟循环里顺手算出，避免多遍历一次 |
| 失败回退 | `decodeAudioData` 失败 → 尝试降级：转单声道 / 降采样 / 提示用户换格式 |

### 录音落盘（独立管线，不走 decodeAudioData）

录音与导入是两条独立管线：录音**不做解码**，把平台产出的 PCM 帧直接拼装成标准 WAV。

| 项 | 设计 |
| --- | --- |
| 参数 | `format: 'PCM'`、`sampleRate: 44100`、`numberOfChannels: 1`（人声场景，省内存）、`frameSize: 64` |
| 编码码率 | `encodeBitRate: 96000` —— 必须落在对应采样率的合法区间内（44.1k → 64000～320000），配错会直接录音失败（见 [02 §1.2](./02-platform-capability.md#12-录音)） |
| 分帧落盘 | `onFrameRecorded` 的帧按序追加写入 `assets/{id}.wav` 的 data 区；先写占位头，`onStop` 时回填 `RIFF.chunkSize` 与 `data.dataSize`（写法见 [§2](#44-字节头写法参考实现)） |
| 帧序校验 | 累计字节数必须等于 `帧数 × 帧字节数`；落盘后校验 WAV 时长误差 < 50ms，异常提示重录 |
| 暂停 | `pause/resume` 期间不产生帧，时间轴不出现空隙 |
| 中断 | `onInterruptionBegin` → 停止并保存已录部分 |
| 上限 | `duration: 600000`（10 分钟，平台上限） |

> **PC 的处理**：PC 微信不支持设置 `sampleRate`（[02 §1.2](./02-platform-capability.md#12-录音)），无法保证中间格式的采样率，因此录音管线在 PC 上直接拒绝并提示用手机录音（需要 PC 录音时，先录后重采样到工程采样率再入库）。

## 4. 峰值金字塔（波形数据）

### 4.1 数据结构

每个声道、每个缩放级别存一组 `min/max` 对（Int16）：

```
level 0（基础桶）：1024 samples/bucket
level 1：2048（= 2 × 1024）
level 2：4096
...
level N：bucketSize = BASE_BUCKET << N，逐级构建到只剩 1 个桶
```

> 为什么是 ×2 而不是 ×4：上级由**相邻 2 个桶合并**得到（见 §4.2），因此 bucketSize 逐级翻倍。
> 合并只取 min 的较小者与 max 的较大者，**相对本级无精度损失**。

存储形态（二进制，便于分块 read；字段宽度与字节序定义见 `workers/render/peaks/codec.ts`）：

```
header: magic('PK01', 4B) | version(uint16) | channels(uint16) | baseBucket(uint32)
        | levelCount(uint16) | reserved(uint16, 置 0) | 每级 bucket 数[]（uint32 × levelCount）
body  : 先排列声道 0 的全部 level，再排列声道 1，依此类推；
        每个 level 内每 bucket 为 int16 min + int16 max（交错，小端）
```

所有声道的级别数与各级桶数必须一致，因此 `levelCounts` 只存一份；`bucketSize` 由 `baseBucket << level` 推出，同样不落盘；
写盘时若各声道结构不一致则直接报错（宁可不写，也不写出结构损坏的文件）。

`bucketSize` **不落盘**：它等于 `baseBucket << level`，存两份会带来不一致风险（AGENTS §0.7）。

### 4.2 构建算法

```ts
// workers/render/peaks/build.ts
const BASE_BUCKET = 1024;

export function buildPeaksLevel0(pcm: Int16Array, baseBucket = BASE_BUCKET): Int16Array {
  const bucketCount = Math.ceil(pcm.length / baseBucket);
  const out = new Int16Array(bucketCount * 2); // [min, max] 交错
  for (let b = 0; b < bucketCount; b++) {
    const start = b * baseBucket;
    const end = Math.min(start + baseBucket, pcm.length);
    let min = 32767, max = -32768;
    for (let i = start; i < end; i++) {
      const v = pcm[i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[b * 2] = min; out[b * 2 + 1] = max;
  }
  return out;
}

// 上级由下级「每 2 个桶合并为 1 个」得到（bucketSize ×2），O(n) 且无精度损失顾虑。
// 桶数为奇数时，最后一个桶单独成为一个上级桶（取原值）。
export function buildUpperLevel(lower: Int16Array): Int16Array {
  const lowerCount = lower.length >> 1;
  if (lowerCount === 0) return new Int16Array(0);
  const upperCount = Math.ceil(lowerCount / 2);
  const out = new Int16Array(upperCount * 2); // 输出长度 = 上级桶数 × 2，不多分配
  for (let b = 0; b < upperCount; b++) {
    const i = b * 4;
    const min0 = lower[i] ?? 0, max0 = lower[i + 1] ?? 0;
    const min1 = i + 3 < lower.length ? (lower[i + 2] ?? 0) : min0;
    const max1 = i + 3 < lower.length ? (lower[i + 3] ?? 0) : max0;
    out[b * 2] = Math.min(min0, min1);
    out[b * 2 + 1] = Math.max(max0, max1);
  }
  return out;
}

// 逐级构建直到只剩 1 个桶或达到 maxLevels（默认 16）
export function buildPyramid(pcm, opts): PeaksLevel[] { /* 见实现 */ }
```

### 4.3 绘制时的选择与采样

```
每像素代表的采样数 = 采样率 / (缩放级别 pxPerSecond)
目标 level = floor(log2(samplesPerPixel / BASE_BUCKET))
1) 若 samplesPerPixel < BASE_BUCKET（放大很深）→ 用 level 0，并在前端做逐采样插值/直接画点
2) 否则用对应 level，每像素聚合 `samplesPerPixel / levelBucketSize` 个桶的 min/max
3) 若 samplesPerPixel 极大（如整段 10 分钟塞进 375px）→ 直接用最高 level，一次聚合
```

**性能要点**
- 绘制用 `Canvas 2D` + `ctx.beginPath()` 逐像素 `moveTo/lineTo` 画竖向线段，**每像素 1 条竖线**（不是每采样）。
- 只绘制可视区 + 左右各 1 屏余量；缩放/拖动时复用上一次的 path 数据做位移（离屏 canvas 平移）。
- 波形数据按可视区间从内存中的峰值数组切片（峰值全量常驻，体积换算见 [02 §3](./02-platform-capability.md#3-容量估算与内存约束)）；**无需分块读文件，也不用重新解码素材**。
- 低端机降级：`benchmarkLevel` 低于阈值时，把绘制频率限制在 30fps，并跳过 `min/max` 到 1px 的精确聚合（改用抽样）。

## 5. 分块渲染管线（导出与预览的核心）

### 5.1 为什么必须分块

三个前提（无 `OfflineAudioContext`、长音频无法全量驻留、单次长任务会卡死 UI）的事实与论证见 [02 §1.1](./02-platform-capability.md#11-音频解码与处理) 与 [02 §3](./02-platform-capability.md#3-容量估算与内存约束)。本节只给出由此确定的分块调度模型。

### 5.2 渲染调度模型

```ts
export interface RenderJob {
  projectId: string;
  edl: Edl;
  output: { sampleRate: number; channels: 1 | 2 };
  range: { startSec: number; endSec: number };   // 支持只渲染选区
  chunkSec: number;                              // 默认 2s（可据性能自适应 1~4s）
  targetPath: string;                            // 输出 WAV 路径
  onProgress?: (done: number, total: number) => void;
}
```

```
主线程                                     Worker
  │  open(targetPath, 'w+')  → fd            │
  │  writeWavHeader(占位, 总长按EDL估算)      │
  │ ── postMessage({type:'init', job}) ────► │
  │                                          │ ① 计算该块覆盖的时间区间
  │                                          │ ② 求值 EDL：找出有交集的 Clip
  │  ◄── {assetRequest, assetId,             │ ③ 声明需要的素材**帧区间**
  │      startFrame, frameCount} ─────────── │    （planChunk）
  │  ④ fd 分块 read（按帧号换算字节偏移）      │
  │ ── {assetChunk, assetId, startFrame,     │
  │     channels, pcmBuffer} ──────────────► │ ⑤ DSP 处理 + 混音叠加到块缓冲
  │                                          │ ⑥ 各声道 Float32 → 交错 Int16
  │  ◄── {chunkDone, pcmBuffer, nextChunk} ─ │
  │  ⑦ write(fd, buffer, {position})         │
  │  ⑧ 回到 ①（直到 nextChunk === null）      │
  │  ⑨ write 回填头 → close(fd)               │
```

**为什么让主线程读文件、Worker 只算**：官方已明确“Worker 内不支持 `wx` 系列的 API”，且 Worker 内代码**只能 require Worker 目录内的文件**（依据：[02 §1.5](./02-platform-capability.md#15-输入选择与多线程) 的 `S9`）。因此这个模式不是权衡结果而是**唯一可行方案**：把文件 I/O 留在主线程，Worker 退化为**纯计算单元**（只依赖 TypedArray / Math），且 Worker 内代码可在 Node 环境下直接单测。

> **传输约定**：素材请求与回传统一用**帧号**（`startFrame` / `frameCount`），字节偏移由主线程根据素材声道数换算 —— Worker 不必知道 WAV 头布局；`pcmBuffer` 为**交错 Int16**。消息与 `RenderJob` 的唯一定义处是 `core/engine/worker-protocol.ts`（AGENTS §1）。

> **目录归属约束**：由于“只能 require Worker 目录内的文件”，渲染引擎与其依赖的纯计算代码（`dsp/`、`edl/`、`codec/`、`peaks/`）必须**物理位于 `workers/render/` 内**，主线程与单测反向 require 同一份源码 —— 方案与理由见 [ADR-0001](./adr/0001-worker-code-packaging.md)，目录树见 [06 §1](./06-engineering-roadmap.md#1-目录结构)。

**数据面优化**
- 跨线程只传 **PCM 块（ArrayBuffer）+ 少量元数据**，绝不逐采样通信。
- 每块 2s @44.1k 单声道 Int16 = 176KB，立体声 352KB；这个量级拷贝开销可接受（DB-06 验证）。
- 主线程复用 2～3 个 ArrayBuffer 池，避免频繁 GC。
- 进度上报节流：每块上报一次（2s 音频 ≈ 数十毫秒计算），不做更细的进度。

### 5.3 EDL 求值（渲染的核心逻辑）

对时间轴区间 `[tStart, tEnd)`：

```
1. 输出块清零：out[ch][0 .. blockSamples) = 0
2. 对每条未静音轨道（考虑 solo 优先级）：
   a. 对轨道内每个与区间相交的 Clip：
        i.   映射到素材时间：srcT = clip.sourceStart + (t - clip.timelineStart) × speed
        ii.  从素材块缓冲取需要的采样（跨素材块边界时请求相邻块）
        iii. 应用片段增益/淡入淡出包络（在片段内相对位置求值）
        iv.  应用片段级效果链（若有）
        v.   按 clip.timelineStart 对齐，累加到轨道缓冲 trackBuf
   b. 应用轨道级效果链（EQ → 压缩 → 其他）
   c. 应用轨道增益 / 声像
   d. 累加到 out（交叉淡化通过 clip 的 fadeIn/fadeOut 在重叠区形成等功率合成）
3. 总线处理：总线 EQ（可选）→ 限制器（-0.3dBFS）→ 可选整体增益归一
4. Float32 → Int16（含削波保护）→ 交给主线程写盘
```

**边界情况清单（必须写测试）**
- Clip 起点在块中间、终点在块中间、跨整个块
- 两个 Clip 重叠（交叉淡化）与相邻但无缝（必须无空隙、无咔哒声）
- 素材块边界与输出块边界不对齐（需跨块请求与缓存最近 2 块）
- 变速片段的时间映射（`speed != 1` 时间轴长度 ≠ 素材长度）
- BGM 循环铺满（`loop: true` 时的源偏移取模）
- 空轨道 / 全静音工程 → 输出静音而非报错

### 5.4 素材分块缓存

```ts
class AssetChunkCache {
  private chunks = new Map<number, Int16Array>();  // chunkIndex -> PCM
  private lru: number[] = [];
  constructor(private asset: AssetMeta, private chunkSamples = 44100 * 2, private maxChunks = 4) {}
  async get(chunkIndex: number): Promise<Int16Array> { /* 命中直接返回，否则触发主线程读盘 */ }
}
```
- 素材分块大小固定（2s），通过 `fd.read({position: headerBytes + chunkIndex * 2 * bytesPerSample * channels})` 精确定位。
- LRU 上限 4 块（立体声 ≈ 1.4MB），保证内存恒定。

## 6. DSP 算法清单

所有 DSP 均为**纯函数**，签名统一为就地操作或返回新缓冲，不依赖任何平台 API，可在 Node + Vitest 下直接测试。

### 6.1 增益与包络

| 算法 | 说明 | 优先级 |
| --- | --- | --- |
| `applyGain(buf, gainLinear)` | 逐采样乘 | P0 |
| `dbToLinear(db)` / `linearToDb(x)` | `10^(db/20)` / `20·log10(x)` | P0 |
| `applyFadeIn/Out(buf, samples, curve)` | `linear`：`t`；`equalPower`：`sin(π/2·t)`（淡入）/ `cos(π/2·t)`（淡出） | P0 |
| `applyGainEnvelope(buf, keyframes[])` | 线性插值的关键帧增益，用于 ducking | P2 |
| `applyPan(bufL, bufR, pan)` | 等功率：`gL = cos((pan+1)·π/4)`，`gR = sin((pan+1)·π/4)` | P2 |

> 淡入淡出的 `equalPower` 是**拼接/交叉淡化的默认曲线**：两条等功率曲线相加的功率恒定，听感上无音量凹陷（线性曲线在交叉点会有 −6dB 凹陷）。

### 6.2 滤波与均衡

Biquad 采用 RBJ Audio EQ Cookbook 系数，**Direct Form I**，逐声道一个状态：

```
峰值（Peaking EQ）：A = 10^(dB/40)，w0 = 2π·f0/fs，α = sin(w0)/(2Q)
  b0 = 1 + αA,      b1 = -2cos(w0),  b2 = 1 - αA
  a0 = 1 + α/A,     a1 = -2cos(w0),  a2 = 1 - α/A
高通（HPF，Q=0.707）：b0 = (1+cos w0)/2, b1 = -(1+cos w0), b2 = (1+cos w0)/2
  a0 = 1+α,         a1 = -2cos(w0),  a2 = 1-α
低架 / 高架（Shelf）：按 cookbook 公式（S=1 简化）
```

```ts
export interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number; }
export function peakingCoeffs(sampleRate: number, f0: number, q: number, gainDb: number): BiquadCoeffs;
export function highpassCoeffs(sampleRate: number, f0: number, q?: number): BiquadCoeffs;
export function lowShelfCoeffs(...) / highShelfCoeffs(...);
export function biquadInPlace(buf: Float32Array, c: BiquadCoeffs, state?: BiquadState): BiquadState;
```

| 效果 | 实现 | 优先级 |
| --- | --- | --- |
| 10 段图形 EQ | 10 个 peaking biquad 串联（中心频率 31.5/63/125/250/500/1k/2k/4k/8k/16k，Q≈1.4） | P1 |
| 高通去隆隆声 | 1 个 highpass（80/120/200Hz） | P1 |
| 预设 | 人声提亮 = 上述参数的固定组合，序列化为 `EffectPreset` | P1 |

### 6.3 动态处理

**压缩器**（dB 域，软膝）：

```
每采样：level = |x| → 包络跟随（attack/release 一阶平滑）
若 envDb > threshold：
  over = envDb - threshold
  gainDb = -over * (1 - 1/ratio)   // 软膝：膝宽内二次插值
gain = 10^((gainDb + makeupDb)/20)
```
参数：`threshold(-60..0dB)`、`ratio(1..20)`、`attack(0.1..100ms)`、`release(10..1000ms)`、`knee(0..24dB)`、`makeupGain`。

**噪声门**：与压缩器同构，但 `env < threshold` 时衰减到 `floorDb`（如 -60dB），带独立的 hold 时间防抖。

**限制器**：前瞻（look-ahead）10ms + 硬限幅 -0.3dBFS 的简化实现，防导出削波；必须挂在总线上。

| 效果 | 优先级 |
| --- | --- |
| 压缩器 | P1 |
| 噪声门 | P1 |
| 限制器 | P1（导出必经） |

### 6.4 时间与音高

| 算法 | 实现思路 | 优先级 |
| --- | --- | --- |
| **重采样（固定比例）** | windowed-sinc 多相实现：2:1 用 31 抽头半带 FIR，其他比例用 63 抽头；**权重按 512 个相位预计算成查表**，运行时每个输出采样只做乘加；两端越界处退回精确卷积并按有效权重归一化（避免边缘幅度塔陷）。实测耗时见 [06 §4](./06-engineering-roadmap.md#4-性能与内存预算) | P0（导入必经） |
| **变速（变调，玩具级）** | 仅改变播放速率（`resample`），音高随之改变。简单、极快 | P2 |
| **变速（保音高，WSOLA）** | 帧长 40ms、重叠 50%、搜索窗 ±10ms。步骤：① 按合成帧长取帧 ② 在源信号搜索窗内找与上一帧尾部最相似的起点（互相关） ③ Hann 窗 OLA 叠加 ④ 输出长度由 speed 决定 | P2 |
| **变调（Pitch Shift）** | = WSOLA 变速 + 重采样补偿（升 n 半音：先按 `2^(n/12)` 变速拉伸，再按同比例重采样回原时长） | P2 |
| **简单降噪（谱减）** | STFT(1024/2048, hop 256/512, Hann) → 噪声幅度谱估计（用户选区或前 300ms）→ `G = max(1 - α·N̂/|X|, β)`，α≈2、β≈0.05 → ISTFT + OLA。需自研 radix-2 FFT（约 100 行） | P2 |
| **回声** | `y[n] = x[n] + fb · y[n - D]`，D 由延迟时间决定（10ms～1s），`fb` 0～0.9 | P2 |
| **混响（Schroeder）** | 4 个并联 comb（不同延迟 29.7/37.1/41.1/43.7ms）+ 2 个串联 allpass（5.0/1.7ms），房间大小调 comb 延迟，湿度调反馈 | P2 |

> **FFT 是 P2 的前置依赖**（降噪必需）。建议在 M3 阶段实现 `core/dsp/fft.ts` 并单独测试（与 `Math` 之外无依赖，可在 Node 里验证与参考实现的一致性）。

### 6.5 分析与工具

| 函数 | 用途 |
| --- | --- |
| `computePeak(buf)` → dBFS | 导出前的削波检查、归一化 |
| `computeRms(buf, windowMs)` | 静音检测、响度估计、波形着色 |
| `detectSilence(buf, {thresholdDb, minSilenceMs, padMs})` → `Range[]` | 自动去停顿（ED-13） |
| `normalizePeak(buf, targetDb)` | 峰值归一（FX-2） |
| `approximateLoudness(buf)` | 简化响度（K-weighting 近似 + 门控 RMS），用于 MX-10 |
| `estimateFileSize(seconds, sampleRate, channels, bits)` | 导出前体积预估与上限校验 |

### 6.6 效果链的顺序约定（必须在文档与代码中固化）

```
素材 → 片段增益/淡化 → 片段效果（EQ → 门 → 压缩） → 轨道增益/声像
     → 轨道效果（EQ → 压缩 → 混响/回声） → 总线（EQ → 限制器） → 编码
```

顺序变化会显著影响听感（例如"先压缩后 EQ"与"先 EQ 后压缩"不同）。UI 上以固定管线呈现、用户只调参数，**MVP 不提供自由连线**，避免复杂度和不可预期的结果。

## 7. 播放与试听策略

| 场景 | 方案 | 理由 |
| --- | --- | --- |
| 整体试听（编辑器主播放） | 渲染"预览 WAV"（选区或前 N 秒，默认预渲染播放头前 5s + 后续 60s）→ `InnerAudioContext` 播放 | 长音频稳定、支持 seek、`playbackRate` 0.5～2 可做变速预听 |
| 拖动播放头时的即时反馈 | 播放预览文件 + `seek()`（`currentTime` 可写，2.26.2+） | 避免每秒重渲染 |
| 短片段循环试听（调参数时） | WebAudio `BufferSourceNode.start(0, offset, duration)` + `loop` | 毫秒级精度、可无缝循环 |
| 效果 A/B 对比 | 渲染两份短预览（干/湿），`BufferSourceNode` 交替播放 | 确定性强于实时链路 |
| 录音时的监听/电平 | 从 `RecorderManager` 的 `onFrameRecorded` 分帧数据计算峰值/ RMS + Canvas 波形与电平表（**不做耳返**，避免回授） | 平台无麦克风输入节点（`AnalyserNode` 拿不到录音流，依据见 [02 §1.2](./02-platform-capability.md#12-录音)）；分帧数据本来就要写盘，顺带算电平零额外开销 |

**缓存失效规则**：任何编辑操作把对应区间的预览标记为脏；播放时若命中脏区间 → 先渲染该区间（约 100～500ms）再播，UI 显示“正在准备…”。

**实现位置**：`core/player/transport.ts`（单例 `InnerAudioContext` 播放通道，中断与倍速）、`core/player/clip-preview.ts`（`BufferSourceNode` 循环试听，只读区间 PCM）、`core/player/preview-cache.ts`（脏区间、窗口计算与渲染调度，渲染函数由调用方注入）。

**必须处理的音频事件**
- `wx.onAudioInterruptionBegin` → 暂停播放、记录位置，UI 切到暂停态；`onAudioInterruptionEnd` → 恢复（或提示用户手动继续）。
- `onHide` → 渲染任务暂停（记录已完成块），回到前台可续跑。
- 播放器实例**全局单例**，`createInnerAudioContext()` 不宜反复创建（会泄漏）；页面卸载时 `destroy`。

## 8. 模块接口草案（TypeScript）

```ts
// core/fs/paths.ts
export const paths: {
  assets(id: string): string;      // ${USER_DATA_PATH}/assets/{id}.wav
  peaks(assetId: string): string;  // ${USER_DATA_PATH}/peaks/{assetId}.pk
  project(id: string): string;     // ${USER_DATA_PATH}/projects/{id}.json
  render(name: string): string;    // ${USER_DATA_PATH}/renders/{name}.wav
  tmp(name: string): string;
};

// core/fs/wavFile.ts —— 分块读写 WAV
export interface WavMeta { sampleRate: number; channels: number; dataOffset: number; dataBytes: number; frames: number; }
export async function readWavMeta(filePath: string): Promise<WavMeta>;
export async function openWavWriter(filePath: string, meta: Omit<WavMeta,'dataOffset'|'dataBytes'|'frames'>, estFrames: number): Promise<WavWriter>;
export interface WavWriter {
  write(buf: Int16Array): Promise<void>;   // 追加数据
  finalize(): Promise<void>;               // 回填头 + 关闭
  abort(): Promise<void>;
}

// core/audio/import.ts
export interface ImportResult { asset: Asset; peaks: PeaksRef; }
export async function importAudio(opts: {
  srcPath: string; projectSampleRate: number; projectChannels: 1 | 2; assetId: string;
  onProgress?: (stage: ImportStage, ratio: number) => void;
}): Promise<ImportResult>;

// workers/render/peaks/index.ts
export interface PeaksRef { levels: { bucketSize: number; count: number }[]; filePath: string; }
export async function buildAndSavePeaks(channels: { dataPath: string; meta: WavMeta }, outPath: string): Promise<PeaksRef>;
export function samplePeaks(peaks: PeakBuffer[], fromSample: number, toSample: number, px: number, out: Float32Array): void;

// workers/render/render.ts（Worker 侧，纯计算；类型与 core/engine/worker-protocol.ts 对齐）
export function initJob(job: RenderJobSpec): RenderState;
/** 声明某块渲染所需的素材帧区间（主线程据此读盘并回传 assetChunk）。 */
export function planChunk(state: RenderState, chunkIndex: number): AssetFrameRequest[];
export function chunkBounds(state: RenderState, chunkIndex: number): { startSec: number; endSec: number; frames: number };
/** 返回的 pcm 是**复用缓冲的视图**：调用方需在下一次 renderChunk 之前使用或拷贝。 */
export function renderChunk(state: RenderState, chunkIndex: number, assets: AssetPcmMap): RenderChunkResult;

/** M1 渲染路径已实现的效果类型（其余类型会被安全跳，由 UI 提示）。 */
export const SUPPORTED_EFFECTS: readonly EffectType[]; // = ['highpass', 'eq10', 'gain']

// core/engine/controller.ts（主线程侧，负责 I/O 与调度）
export class RenderController {
  constructor(private opts: RenderOptions) {}
  start(): Promise<{ filePath: string; bytes: number; meta: WavMeta }>;
  cancel(): void;
  onProgress(cb: (p: { done: number; total: number; etaSec: number }) => void): void;
}
```

## 9. 错误处理与降级

| 错误 | 处理 |
| --- | --- |
| `decodeAudioData` 失败 | 提示"该格式暂不支持，可先转为 WAV/MP3 再导入"，并记录格式用于后续支持评估 |
| 预估内存超限 | 拒绝导入，建议裁剪/降低采样率，或让用户选择"仅导入前 3 分钟" |
| 渲染中 `writeFile` 空间不足（1300202） | 中止渲染、删除半成品、提示清理存储并给出占用明细 |
| Worker 创建失败 | 降级到主线程分块渲染（用 `setTimeout(0)` 分片让出主线程，进度条保持响应） |
| 渲染中途被中断 | 保留已完成块与 `RenderState`（序列化到临时文件），恢复时续跑 |
| 导出体积超 100MB | 导出前用 `estimateFileSize` 拦截，建议降采样率/转单声道/缩短时长 |
| 播放器报错（onError） | 重建播放器实例一次；再失败则提示"试听不可用，可直接导出" |
| 录音被打断 | `onInterruptionBegin` 停止并保存已录部分，提示用户 |

## 10. 未决技术问题

平台能力类问题的清单、方法与判据统一在 [02 §5 Spike 清单](./02-platform-capability.md#5-待实测验证清单spike-任务)，此处只记引擎自身的未决项：

1. **是否引入 WebAssembly 做重采样/FFT 加速** —— 当前结论：**MVP 不引入**（WASM 支持度与体积成本需评估）。若 [02 DB-12](./02-platform-capability.md#5-待实测验证清单spike-任务) 基准显示纯 JS 无法在 15s 内渲染 3 分钟音频，再重新评估。
2. **渲染块边界是否需要预取素材** —— 取决于 [02 DB-06/DB-07](./02-platform-capability.md#5-待实测验证清单spike-任务) 实测的分块读与跨线程拷贝耗时。
3. **峰值金字塔是否需要按需加载**（当前设计为全量常驻内存） —— 仅在素材时长上限被放宽时才需要重新考虑。
5. MP3 导出（lamejs）在 Worker 中运行的可行性与耗时——P1 阶段评估。
