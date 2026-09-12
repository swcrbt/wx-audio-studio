import { describe, expect, it } from 'vitest';
import {
  PREVIEW_LEAD_SEC,
  PREVIEW_TAIL_SEC,
  PreviewCache,
  PreviewEmptyError,
  mergeRanges,
  type PreviewWindow,
} from '../../miniprogram/core/player/preview-cache';

function makeCache(options: { durationSec?: number; previewPath?: string } = {}): {
  cache: PreviewCache;
  renders: PreviewWindow[];
} {
  const renders: PreviewWindow[] = [];
  const cache = new PreviewCache({
    projectId: 'p1',
    previewPath: options.previewPath ?? '/data/renders/preview-p1.wav',
    durationSec: () => options.durationSec ?? 300,
    now: () => 1000,
    render: async (range) => {
      renders.push(range);
      return { filePath: '/data/renders/preview-p1.wav', bytes: 1024, frames: 512 };
    },
  });
  return { cache, renders };
}

describe('mergeRanges', () => {
  it('空输入返回空', () => {
    expect(mergeRanges([])).toEqual([]);
  });

  it('相交与相接的区间合并，分离的保留', () => {
    expect(
      mergeRanges([
        { startSec: 10, endSec: 20 },
        { startSec: 15, endSec: 25 },
        { startSec: 40, endSec: 50 },
      ]),
    ).toEqual([
      { startSec: 10, endSec: 25 },
      { startSec: 40, endSec: 50 },
    ]);
  });

  it('输入乱序也能正确合并', () => {
    expect(
      mergeRanges([
        { startSec: 30, endSec: 40 },
        { startSec: 0, endSec: 5 },
        { startSec: 3, endSec: 12 },
      ]),
    ).toEqual([
      { startSec: 0, endSec: 12 },
      { startSec: 30, endSec: 40 },
    ]);
  });

  it('被完全包含的区间不会撑大结果', () => {
    expect(
      mergeRanges([
        { startSec: 0, endSec: 100 },
        { startSec: 20, endSec: 30 },
      ]),
    ).toEqual([{ startSec: 0, endSec: 100 }]);
  });
});

describe('PreviewCache · 窗口计算', () => {
  it('播放头在中间时前后各留 lead / tail', () => {
    const { cache } = makeCache();
    expect(cache.windowFor(100)).toEqual({ startSec: 100 - PREVIEW_LEAD_SEC, endSec: 100 + PREVIEW_TAIL_SEC });
  });

  it('播放头在开头时不出现负数', () => {
    const { cache } = makeCache();
    const window = cache.windowFor(0);
    expect(window.startSec).toBe(0);
    expect(window.endSec).toBe(PREVIEW_LEAD_SEC + PREVIEW_TAIL_SEC);
  });

  it('接近结尾时窗口被夹到工程时长', () => {
    const { cache } = makeCache({ durationSec: 30 });
    const window = cache.windowFor(29);
    expect(window.endSec).toBe(30);
    expect(window.startSec).toBeGreaterThanOrEqual(0);
  });
});

describe('PreviewCache · 命中与失效', () => {
  it('首次 ensure 触发渲染，第二次同位置命中缓存', async () => {
    const { cache, renders } = makeCache();

    const first = await cache.ensure(10);
    expect(first.cached).toBe(false);
    expect(renders.length).toBe(1);
    expect(first.renderedAt).toBe(1000);

    const second = await cache.ensure(10);
    expect(second.cached).toBe(true);
    expect(renders.length).toBe(1);
  });

  it('播放头微动（小于容差）仍命中缓存，明显移动才重渲染', async () => {
    const { cache, renders } = makeCache();
    await cache.ensure(10);

    await cache.ensure(10.2);
    expect(renders.length).toBe(1);

    await cache.ensure(40);
    expect(renders.length).toBe(2);
  });

  it('脏区间在窗口之外时不重渲染', async () => {
    const { cache, renders } = makeCache();
    await cache.ensure(10);

    // 窗口为 [5, 70]：200s 处的编辑不应触发重渲染
    cache.markDirty(200, 210);
    const hit = await cache.ensure(10);
    expect(renders.length).toBe(1);
    expect(hit.cached).toBe(true);
  });

  it('窗口内的脏区间触发重渲染，并在渲染后清除', async () => {
    const { cache, renders } = makeCache();
    await cache.ensure(100);

    cache.markDirty(120, 130);
    const result = await cache.ensure(100);
    expect(result.cached).toBe(false);
    expect(renders.length).toBe(2);

    // 脏区间已被窗口覆盖 → 清除；再次同一窗口直接命中
    expect(cache.dirtyRanges).toEqual([]);
    const again = await cache.ensure(100);
    expect(again.cached).toBe(true);
    expect(renders.length).toBe(2);
  });

  it('窗口外的脏区间会保留，等窗口覆盖到才清除', async () => {
    const { cache } = makeCache();
    await cache.ensure(0);

    cache.markDirty(250, 260);
    await cache.ensure(255);
    expect(cache.dirtyRanges).toEqual([]);

    cache.markDirty(250, 260);
    await cache.ensure(0);
    expect(cache.dirtyRanges).toEqual([{ startSec: 250, endSec: 260 }]);
  });

  it('markAllDirty 使任何窗口失效', async () => {
    const { cache, renders } = makeCache();
    await cache.ensure(10);
    cache.markAllDirty();

    expect(cache.isFullyDirty).toBe(true);
    expect(cache.needsRender(cache.windowFor(10))).toBe(true);

    const result = await cache.ensure(10);
    expect(result.cached).toBe(false);
    expect(renders.length).toBe(2);
    expect(cache.isFullyDirty).toBe(false);
  });

  it('空工程（时长 0）拒绝生成预览', async () => {
    const { cache } = makeCache({ durationSec: 0 });
    await expect(cache.ensure(0)).rejects.toBeInstanceOf(PreviewEmptyError);
  });

  it('markDirty 忽略零长度区间，起止颠倒的区间被规范化', async () => {
    const { cache } = makeCache();
    await cache.ensure(10);

    cache.markDirty(20, 20);
    expect(cache.dirtyRanges).toEqual([]);

    cache.markDirty(30, 10);
    expect(cache.dirtyRanges).toEqual([{ startSec: 10, endSec: 30 }]);
  });
});

describe('PreviewCache · 并发', () => {
  it('并发 ensure 串行执行，后到的调用复用已渲染窗口', async () => {
    const renders: PreviewWindow[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const cache = new PreviewCache({
      projectId: 'p1',
      previewPath: '/data/renders/preview-p1.wav',
      durationSec: () => 300,
      render: async (range) => {
        renders.push(range);
        if (renders.length === 1) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return { filePath: '/data/renders/preview-p1.wav', bytes: 1, frames: 1 };
      },
    });

    const first = cache.ensure(10);
    const second = cache.ensure(10);
    // 让第一个渲染真正进入等待，再放行
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.release?.();

    const [a, b] = await Promise.all([first, second]);
    expect(renders.length).toBe(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
  });
});
