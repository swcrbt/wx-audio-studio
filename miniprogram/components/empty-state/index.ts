/**
 * 空态：插画位 + 文案 + 动作按钮。
 *
 * 文案与按钮都由调用方给（不同页面的空态语气不同），组件只负责版式与事件转发。
 */
Component({
  properties: {
    /** 场景标识（用于选择插画，M1 用简单图形代替）。 */
    type: { type: String, value: 'generic' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    /** `[{ key, label, primary }]`，最多两个按钮。 */
    actions: { type: Array, value: [] },
  },

  methods: {
    handleAction(event: WechatMiniprogram.TouchEvent): void {
      const key = (event.currentTarget.dataset as { key?: string }).key;
      if (!key) return;
      this.triggerEvent('action', { key });
    },
  },
});
