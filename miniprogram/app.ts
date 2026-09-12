/**
 * 小程序入口。属平台适配层（AGENTS §1）：只做启动期能力探测与全局单例装配，
 * 不放音频算法。
 */
import { applyBenchmarkInfo, detectCaps, fetchBenchmarkInfo, type Caps } from './core/caps';
import { logger } from './utils/logger';

interface GlobalData {
  caps: Caps | null;
}

App<{ globalData: GlobalData }>({
  globalData: {
    caps: null,
  },
  onLaunch() {
    const base = detectCaps();
    this.globalData.caps = base;

    // 机型档位要异步取（官方接口只有回调式，见 core/caps.ts），拿到后再精化一次。
    void fetchBenchmarkInfo().then((info) => {
      if (!info) return;
      this.globalData.caps = applyBenchmarkInfo(base, info);
      logger.info('app', 'caps refined', this.globalData.caps);
    });
  },
});
