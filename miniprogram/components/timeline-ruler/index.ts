/**
 * 时间标尺。
 *
 * 刻度的时间与像素位置由页面用 `core/view/viewport.ts` 的 `tickTimes` 算好后传入
 * （刻度步长依赖视口与画布宽度，属于几何计算而非渲染职责）。
 */
Component({
  properties: {
    /** `[{ xPx, label }]`：xPx 为相对波形区左边缘的逻辑像素。 */
    ticks: { type: Array, value: [] },
  },
  data: {},
});
