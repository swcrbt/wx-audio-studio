# wx-audio-studio

微信小程序音频编辑器：**录音 → 波形剪辑 → 拼接混音 → 音效 → 导出分享**。

全端上处理（无后端）、非破坏性编辑、微信内闭环分享。

> 状态：**实现中** ｜ 最后更新：2026-09-12 ｜ 关联代码：`miniprogram/workers/render/**`、`miniprogram/core/**`
>
> **已开始编码。** 纯逻辑层（WAV 编解码、DSP、EDL、峰值金字塔、分块渲染引擎）已实现并有 219 项 Node 单测；
> 平台行为验证（[M0 Spike](./docs/02-platform-capability.md#5-待实测验证清单spike-任务)，13 项待跑）与导入/录音/播放/UI 待完成。
>
> ⚠️ 任何开发/改动前先读 [AGENTS.md](./AGENTS.md)（开发规范）。

## 开发

```bash
npm install
npm run check        # typecheck + lint + 219 项单测
npm run bench        # DB-12：3 分钟音频的处理链性能基准
npm run mp:preview   # 生成真机预览二维码（需 mp.config.json，见 docs/02 §5）
npm run mp:upload    # 上传体验版
```

## 文档

设计文档全部在 [`docs/`](./docs/)：

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](./docs/README.md) | 索引 · 一页速览 · 术语表 |
| [01 · 产品需求与范围](./docs/01-product-spec.md) | 目标用户、功能清单（P0/P1/P2）、MVP 边界、指标 |
| [02 · 平台能力与技术选型](./docs/02-platform-capability.md) | 官方 API 能力表、被否方案、内存预算、风险、**Spike 清单** |
| [03 · 音频引擎与 DSP](./docs/03-audio-engine.md) | 数据流、WAV 中间格式、峰值金字塔、分块渲染、DSP 算法、模块接口 |
| [04 · 界面与交互](./docs/04-ui-ux.md) | 页面流程、编辑器线框、手势映射、状态机、视觉规范 |
| [05 · 数据模型与存储](./docs/05-data-model.md) | EDL 类型、JSON 示例、存储布局、撤销重做、自动保存 |
| [06 · 工程与路线图](./docs/06-engineering-roadmap.md) | 目录结构、工具链、里程碑、测试、合规与审核 |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 文档变更记录 + 待回填的 Spike 结论清单 |

## 开发规范（必读）

[`AGENTS.md`](./AGENTS.md) 是本仓库最高优先级的开发约定，核心是 **文档先行、代码与文档同步**：

- 任何改动先落 `docs/`，再写代码；提交时**文档与代码在同一次提交内**
- 改动前对照 [改动与文档同步矩阵](./AGENTS.md#02-改动与文档同步矩阵提交前必须逐条对照检查)
- 文档变更登记到 [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)
- 任务完成以 [DoD 清单](./AGENTS.md#11-定义完成dod) 为准

## 设计要点与下一步

> 本文件只做入口导航。**架构要点、目录结构、里程碑、合规等细节一律以 `docs/` 内文档为准，不在此重复。**

- 全貌速览与术语 → [docs/README.md](./docs/README.md)
- 做什么、优先级、MVP 边界 → [01](./docs/01-product-spec.md)
- 为什么这么设计（平台约束与选型） → [02](./docs/02-platform-capability.md)
- 怎么实现（引擎与数据） → [03](./docs/03-audio-engine.md) · [05](./docs/05-data-model.md)
- 怎么做界面 → [04](./docs/04-ui-ux.md)
- 何时做什么、验收标准、合规 → [06](./docs/06-engineering-roadmap.md)

**下一步：M0 技术验证**（13 项平台行为，实验页已就绪）→ [02 §5 Spike 清单](./docs/02-platform-capability.md#5-待实测验证清单spike-任务)
