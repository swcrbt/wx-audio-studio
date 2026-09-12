/**
 * M0 Spike 页面：逐项运行实验并把结果导出为可粘贴文本。
 *
 * 它属于开发期页面（放在 `spikes` 分包里），M0 结论回填后整包删除。
 */
import { SPIKE_CASES } from '../runner/cases';
import { deviceEnvLine, formatAll, formatResult } from '../runner/report';
import { describeError, type SpikeResult } from '../runner/types';

interface CaseView {
  id: string;
  title: string;
  criteria: string;
  blocks: string;
  needsDevice: boolean;
  resultText: string;
}

Page({
  data: {
    env: '',
    cases: [] as CaseView[],
    results: [] as SpikeResult[],
    running: false,
    logText: '',
  },

  onLoad() {
    this.setData({
      env: deviceEnvLine(),
      cases: SPIKE_CASES.map((item) => ({
        id: item.id,
        title: item.title,
        criteria: item.criteria,
        blocks: item.blocks,
        needsDevice: item.needsDevice,
        resultText: '',
      })),
    });
  },

  async onRun(event: WechatMiniprogram.BaseEvent) {
    const id = (event.currentTarget.dataset as { id?: string }).id;
    if (!id) return;
    await this.runOne(id);
  },

  async onRunAll() {
    for (const item of SPIKE_CASES) {
      await this.runOne(item.id);
    }
  },

  async runOne(id: string) {
    if (this.data.running) return;
    const target = SPIKE_CASES.find((item) => item.id === id);
    if (!target) return;

    this.setData({ running: true, logText: `运行 ${id}：${target.title}…` });

    try {
      const result = await target.run((message) => {
        this.setData({ logText: `${id} · ${message}` });
      });
      const withEnv: SpikeResult = { ...result, env: deviceEnvLine() };
      const results = [...this.data.results.filter((item) => item.id !== id), withEnv];
      this.setData({
        results,
        cases: this.data.cases.map((item) =>
          item.id === id ? { ...item, resultText: formatResult(withEnv) } : item,
        ),
        logText: `${id} 完成`,
      });
    } catch (error) {
      const message = describeError(error);
      this.setData({
        logText: `${id} 异常：${message}`,
        cases: this.data.cases.map((item) =>
          item.id === id ? { ...item, resultText: `${id} 异常：${message}` } : item,
        ),
      });
    } finally {
      this.setData({ running: false });
    }
  },

  onCopyAll() {
    const text = formatAll(this.data.results);
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制结果', icon: 'success' });
      },
      fail: (error) => {
        wx.showModal({ title: '复制失败', content: describeError(error), showCancel: false });
      },
    });
  },

  onClear() {
    this.setData({
      results: [],
      cases: this.data.cases.map((item) => ({ ...item, resultText: '' })),
      logText: '',
    });
  },
});
