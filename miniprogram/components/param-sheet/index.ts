/**
 * 通用参数面板（底部抽屉）。
 *
 * 只做"渲染字段 + 上报变更"，不含任何业务判断：字段由页面给，值由页面消费。
 *
 * 关键约定（性能相关，见 docs/04 §3.5）：滑杆拖动中只上报 `committed: false`，
 * 页面据此只更新数字回显、**不触发渲染**；松手才上报 `committed: true` 触发一次提交。
 * 底层 `bindchanging` / `bindchange` 正好对应这两个时机。
 */
export interface ParamFieldOption {
  label: string;
  value: string | number;
}

export interface ParamField {
  key: string;
  label: string;
  type: 'slider' | 'switch' | 'segmented' | 'action';
  value: number | boolean | string;
  /** 展示文案（由页面格式化，带单位）。 */
  displayValue?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: ParamFieldOption[];
}

Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '' },
    /** `ParamField[]` */
    fields: { type: Array, value: [] },
  },

  methods: {
    handleSliderChanging(event: WechatMiniprogram.SliderChanging): void {
      this.emitChange(readKey(event), event.detail.value, false);
    },

    handleSliderChange(event: WechatMiniprogram.SliderChange): void {
      this.emitChange(readKey(event), event.detail.value, true);
    },

    handleSwitchChange(event: WechatMiniprogram.SwitchChange): void {
      this.emitChange(readKey(event), event.detail.value, true);
    },

    handleSegmentTap(event: WechatMiniprogram.TouchEvent): void {
      const dataset = event.currentTarget.dataset as { key?: string; value?: string | number };
      if (!dataset.key) return;
      this.emitChange(dataset.key, dataset.value ?? '', true);
    },

    handleAction(event: WechatMiniprogram.TouchEvent): void {
      const key = readKey(event);
      if (!key) return;
      this.triggerEvent('action', { key });
    },

    handleClose(): void {
      this.triggerEvent('close');
    },

    /** 遮罩上的滑动不穿透到页面。 */
    noop(): void {
      // 空实现：仅用于 catchtouchmove 阻止滚动穿透
    },

    emitChange(key: string, value: number | boolean | string, committed: boolean): void {
      if (!key) return;
      this.triggerEvent('change', { key, value, committed });
    },
  },
});

function readKey(event: WechatMiniprogram.CustomEvent): string {
  const dataset = (event.currentTarget as { dataset?: { key?: string } } | undefined)?.dataset;
  return dataset?.key ?? '';
}
