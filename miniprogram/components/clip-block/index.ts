/**
 * 片段块：时间轴上的一个可拖片段（只负责渲染与事件转发）。
 *
 * 几何（位置与宽度）由 `core/view/timeline-layout.ts` 算好后通过 `clip` 传入，
 * 组件不做时间换算，避免"两处各算一遍"导致的漂移。
 */
Component({
  properties: {
    /** `ClipLayout`（见 core/view/timeline-layout.ts）。 */
    clip: { type: Object, value: null },
    selected: { type: Boolean, value: false },
  },

  methods: {
    handleTap(): void {
      const clip = this.data.clip as { clipId?: string } | null;
      if (!clip?.clipId) return;
      this.triggerEvent('action', { action: 'select', clipId: clip.clipId });
    },

    handleLongPress(): void {
      const clip = this.data.clip as { clipId?: string } | null;
      if (!clip?.clipId) return;
      this.triggerEvent('action', { action: 'menu', clipId: clip.clipId });
    },
  },
});
