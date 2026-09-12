/**
 * DB-13：Canvas 2D 的绘制帧率与离屏画布可用性。
 *
 * 波形画布的实现依赖两件事：`type="2d"` 的 Canvas 与 `wx.createOffscreenCanvas`。
 * 这里在离屏画布上画满 360 列波形（与真实负载同量级），测每帧耗时，
 * 判断"手势期间重绘"是否会掉帧（docs/06 §4.1 豁免项的复查依据）。
 */
import type { SpikeCase, SpikeLine } from '../types';
import { describeError } from '../types';

/** 与真实波形区接近的尺寸（逻辑像素），dpr 按 2 估算。 */
const WIDTH_PX = 360;
const HEIGHT_PX = 210;
/** 绘制帧数：够长才能看出稳定态。 */
const FRAMES = 120;

interface Ctx2D {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  scale(x: number, y: number): void;
}

export const db13: SpikeCase = {
  id: 'DB-13',
  title: 'Canvas 2D 绘制帧率与离屏画布',
  criteria: '单帧 ≤ 33ms（30fps 以上），缩放手势期间的整绘才不会掉帧',
  blocks: '波形画布（docs/04 §3.2）与 docs/06 §4.1 豁免项复查',
  needsDevice: true,
  async run(log) {
    const lines: SpikeLine[] = [];
    const node = wx.getWindowInfo();

    try {
      const canvas = wx.createOffscreenCanvas({
        type: '2d',
        width: WIDTH_PX * 2,
        height: HEIGHT_PX * 2,
      }) as unknown as { getContext(type: '2d'): unknown; width: number; height: number };

      const ctx = canvas.getContext('2d') as Ctx2D;
      ctx.scale(2, 2);
      lines.push({ label: '离屏画布', value: `${WIDTH_PX}×${HEIGHT_PX}@2x 创建成功`, ok: true });

      // 预热（首次绘制包含着色器/缓存初始化，不能算进均值）
      for (let frame = 0; frame < 10; frame++) drawWaveformFrame(ctx, frame);

      const durations: number[] = [];
      const totalStart = Date.now();
      for (let frame = 0; frame < FRAMES; frame++) {
        const frameStart = Date.now();
        drawWaveformFrame(ctx, frame);
        durations.push(Date.now() - frameStart);
      }
      const totalMs = Date.now() - totalStart;

      durations.sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)] ?? 0;
      const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
      const worst = durations[durations.length - 1] ?? 0;
      const avgMs = totalMs / FRAMES;
      const fps = 1000 / Math.max(0.001, avgMs);

      lines.push({
        label: `绘制 ${FRAMES} 帧（每帧 ${WIDTH_PX} 列）`,
        value: `总 ${totalMs}ms · 平均 ${avgMs.toFixed(2)}ms/帧 · 中位 ${median}ms · P95 ${p95}ms · 最差 ${worst}ms`,
        ok: avgMs <= 33,
      });
      lines.push({ label: '等效帧率', value: `${fps.toFixed(1)}fps`, ok: fps >= 30 });

      // requestAnimationFrame 是否可用（播放头平滑插值要用）
      const hasRaf = typeof (canvas as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame === 'function';
      lines.push({ label: 'canvas.requestAnimationFrame', value: hasRaf ? '可用' : '不可用', ok: hasRaf });

      // 极端档：10 万条竖线（清单要求）——极深缩放下逐采样绘制的上限
      const extremeStart = Date.now();
      ctx.fillStyle = '#4C8DFF';
      for (let i = 0; i < 100000; i++) {
        const x = (i * 7) % WIDTH_PX;
        const y = (i * 13) % HEIGHT_PX;
        ctx.fillRect(x, y, 1, 1);
      }
      const extremeMs = Date.now() - extremeStart;
      lines.push({
        label: '10 万条竖线单帧耗时',
        value: `${extremeMs}ms`,
        ok: extremeMs <= 33,
      });

      const pass = avgMs <= 33;
      const conclusion = pass
        ? `常规负载单帧 ${avgMs.toFixed(1)}ms（约 ${fps.toFixed(0)}fps）；极深缩放（10 万条）单帧 ${extremeMs}ms，${extremeMs <= 33 ? '仍在预算内' : '超预算，深度缩放需降级为隔列绘制'}；docs/06 §4.1 豁免项据此复查`
        : `常规负载单帧 ${avgMs.toFixed(1)}ms，低于 30fps：缩放手势必须改为 CSS transform 视觉缩放（docs/06 §4.1 已登记为复查方案）`;

      return { id: this.id, title: this.title, env: '', lines, conclusion };
    } catch (error) {
      lines.push({ label: '离屏画布', value: describeError(error), ok: false });
      return {
        id: this.id,
        title: this.title,
        env: '',
        lines,
        conclusion: `离屏画布不可用（${describeError(error)}）：波形画布需改为"每次整绘 + 限帧"，放弃位图复用优化`,
        failed: true,
      };
    } finally {
      log(`设备像素比 ${node.pixelRatio}`);
    }
  },
};

/** 画一帧与真实负载同量级的波形（360 条 min..max 竖线 + 中线）。 */
function drawWaveformFrame(ctx: Ctx2D, frame: number): void {
  ctx.fillStyle = '#12151A';
  ctx.fillRect(0, 0, WIDTH_PX, HEIGHT_PX);

  const midY = HEIGHT_PX / 2;
  const amp = HEIGHT_PX * 0.35;
  ctx.fillStyle = '#4C8DFF';
  for (let x = 0; x < WIDTH_PX; x++) {
    const phase = (x + frame * 3) * 0.05;
    const peak = Math.abs(Math.sin(phase)) * amp;
    ctx.fillRect(x, midY - peak, 1, Math.max(1, peak * 2));
  }

  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, midY, WIDTH_PX, 1);
}
