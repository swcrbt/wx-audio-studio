/**
 * 轨道行：名称与控制（音量/静音/Solo/删除）+ 片段泳道。
 *
 * 只做渲染与事件转发，所有变更都由页面转成 `ProjectStore.commit` 的命令，
 * 这样撤销重做与自动保存天然生效。
 */
Component({
  properties: {
    /** `TrackLayout`（见 core/view/timeline-layout.ts）。 */
    track: { type: Object, value: null },
    selectedClipId: { type: String, value: '' },
    /** 泳道总宽度（像素）：决定可滚动范围。 */
    laneWidthPx: { type: Number, value: 0 },
    /** 播放头位置（像素）；`showPlayhead` 为 false 时不画。 */
    playheadPx: { type: Number, value: 0 },
    showPlayhead: { type: Boolean, value: false },
  },

  data: {
    gainLabel: '0.0 dB',
  },

  observers: {
    track(this: WechatMiniprogram.Component.TrivialInstance, track: { gainDb?: number; muted?: boolean } | null) {
      const gainDb = track?.gainDb ?? 0;
      this.setData({
        gainLabel: track?.muted ? '静音' : `${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`,
      });
    },
  },

  methods: {
    handleTrackAction(event: WechatMiniprogram.TouchEvent): void {
      const action = (event.currentTarget.dataset as { action?: string }).action;
      const track = this.data.track as { trackId?: string } | null;
      if (!action || !track?.trackId) return;
      this.triggerEvent('trackaction', { trackId: track.trackId, action });
    },

    handleClipAction(event: WechatMiniprogram.CustomEvent): void {
      const detail = event.detail as { action: string; clipId: string };
      const track = this.data.track as { trackId?: string } | null;
      if (!track?.trackId) return;
      this.triggerEvent('clipaction', { trackId: track.trackId, clipId: detail.clipId, action: detail.action });
    },
  },
});
