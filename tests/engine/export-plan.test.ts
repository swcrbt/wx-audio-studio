import { describe, expect, it } from 'vitest';
import {
  MAX_NORMALIZE_GAIN_DB,
  NORMALIZE_TARGET_DB,
  estimatePeakFromPeaks,
  planExport,
} from '../../miniprogram/core/engine/export-plan';
import type { Edl, Id } from '../../miniprogram/core/types';
import type { PeaksLevel } from '../../miniprogram/workers/render/peaks/build';
import { dbToLinear, linearToDb } from '../../miniprogram/workers/render/dsp/gain';
import { makeAsset, makeClip, makeTrack } from '../edl/fixtures';

/** 造一份所有桶都是 ±`absValue` 的 level 0。 */
function makeLevel0(absValue: number, count = 8, bucketSize = 1024): PeaksLevel {
  const data = new Int16Array(count * 2);
  for (let i = 0; i < count; i++) {
    data[i * 2] = -absValue;
    data[i * 2 + 1] = absValue;
  }
  return { bucketSize, count, data };
}

function peaksMap(assetId: Id, level0: PeaksLevel): Map<Id, PeaksLevel[]> {
  return new Map([[assetId, [level0]]]);
}

function buildEdl(overrides: Partial<Edl> = {}): Edl {
  const edl: Edl = {
    sampleRate: 44100,
    channels: 1,
    assets: [makeAsset('a1', 10)],
    tracks: [makeTrack('t1', [makeClip()])],
  };
  return { ...edl, ...overrides };
}

const OUTPUT = { sampleRate: 44100 as const, channels: 1 as const };

describe('estimatePeakFromPeaks', () => {
  it('取素材峰值 × 片段增益 × 轨道增益', () => {
    const edl = buildEdl({
      tracks: [makeTrack('t1', [makeClip({ gainDb: -6 })], { gainDb: -6 })],
    });
    const peakDb = estimatePeakFromPeaks(edl, peaksMap('a1', makeLevel0(16384)));

    // 素材峰值 0.5，再乘以片段与轨道各自的 -6dB（≈0.5012，不是精确 0.5）
    const expected = 0.5 * dbToLinear(-6) * dbToLinear(-6);
    expect(peakDb).toBeCloseTo(linearToDb(expected), 6);
  });

  it('跳过静音轨道与 solo 之外的轨道', () => {
    const muted = buildEdl({
      tracks: [makeTrack('t1', [makeClip()], { muted: true })],
    });
    expect(estimatePeakFromPeaks(muted, peaksMap('a1', makeLevel0(32767)))).toBeNull();

    const soloOther = buildEdl({
      tracks: [
        makeTrack('t1', [makeClip()]),
        makeTrack('t2', [], { solo: true }),
      ],
    });
    expect(estimatePeakFromPeaks(soloOther, peaksMap('a1', makeLevel0(32767)))).toBeNull();
  });

  it('只统计片段覆盖的桶，不把素材其余部分算进来', () => {
    // 素材 10s，但片段只取 [0, 1)：level0 的桶 0 响，其余桶静音
    const data = new Int16Array(16 * 2);
    data[0] = -32767;
    data[1] = 32767;
    const level0: PeaksLevel = { bucketSize: 1024, count: 16, data };
    const edl = buildEdl({ tracks: [makeTrack('t1', [makeClip({ sourceEnd: 1 })])] });

    const peakDb = estimatePeakFromPeaks(edl, peaksMap('a1', level0));
    expect(peakDb).toBeCloseTo(linearToDb(32767 / 32768), 6);
  });

  it('素材没有峰值数据时返回 null', () => {
    expect(estimatePeakFromPeaks(buildEdl(), new Map())).toBeNull();
  });

  it('全零峰值返回 null（没有可用信息）', () => {
    expect(estimatePeakFromPeaks(buildEdl(), peaksMap('a1', makeLevel0(0)))).toBeNull();
  });
});

describe('planExport · 归一化', () => {
  it('把偏轻的工程拉到目标峰值', () => {
    const plan = planExport({ edl: buildEdl(), peaksByAsset: peaksMap('a1', makeLevel0(16384)), output: OUTPUT });

    expect(plan.estimatedPeakDb).toBeCloseTo(-6.02, 1);
    expect(plan.busGainDb).toBeCloseTo(NORMALIZE_TARGET_DB - (plan.estimatedPeakDb ?? 0), 6);
    expect(plan.normalizeApplied).toBe(true);
  });

  it('已经足够响时不衰减', () => {
    const plan = planExport({ edl: buildEdl(), peaksByAsset: peaksMap('a1', makeLevel0(32767)), output: OUTPUT });
    expect(plan.busGainDb).toBe(0);
    expect(plan.normalizeApplied).toBe(false);
  });

  it('极轻音频的增益被夹在上限并给出提示', () => {
    const plan = planExport({
      edl: buildEdl(),
      peaksByAsset: peaksMap('a1', makeLevel0(20)),
      output: OUTPUT,
    });
    expect(plan.busGainDb).toBe(MAX_NORMALIZE_GAIN_DB);
    expect(plan.warnings.some((text) => text.includes('上限'))).toBe(true);
  });

  it('关闭归一化时不估算峰值也不加增益', () => {
    const plan = planExport({
      edl: buildEdl(),
      peaksByAsset: peaksMap('a1', makeLevel0(16384)),
      output: OUTPUT,
      normalize: false,
    });
    expect(plan.busGainDb).toBe(0);
    expect(plan.estimatedPeakDb).toBeNull();
  });

  it('缺少峰值数据时提示无法归一化', () => {
    const plan = planExport({ edl: buildEdl(), peaksByAsset: new Map(), output: OUTPUT });
    expect(plan.busGainDb).toBe(0);
    expect(plan.warnings.some((text) => text.includes('归一化'))).toBe(true);
  });
});

describe('planExport · 体积与区间', () => {
  it('估算体积随采样率与声道数变化', () => {
    const mono = planExport({ edl: buildEdl(), peaksByAsset: new Map(), output: OUTPUT });
    const stereo = planExport({
      edl: buildEdl(),
      peaksByAsset: new Map(),
      output: { sampleRate: 44100, channels: 2 },
    });
    expect(stereo.estimatedBytes).toBeGreaterThan(mono.estimatedBytes);
    expect(mono.estimatedBytes).toBe(44 + Math.round(5 * 44100) * 2);
  });

  it('超过单文件 100MB 上限时阻止导出并给建议', () => {
    const longEdl: Edl = {
      sampleRate: 44100,
      channels: 2,
      assets: [makeAsset('a1', 3600)],
      tracks: [makeTrack('t1', [makeClip({ sourceEnd: 3600 })])],
    };
    const plan = planExport({
      edl: longEdl,
      peaksByAsset: new Map(),
      output: { sampleRate: 44100, channels: 2 },
    });
    expect(plan.blocked).toBe(true);
    expect(plan.warnings[0]).toContain('100MB');
  });

  it('空工程被阻止并提示先导入素材', () => {
    const empty: Edl = { sampleRate: 44100, channels: 1, assets: [], tracks: [] };
    const plan = planExport({ edl: empty, peaksByAsset: new Map(), output: OUTPUT });
    expect(plan.blocked).toBe(true);
    expect(plan.durationSec).toBe(0);
  });

  it('区间被夹到工程范围内', () => {
    const plan = planExport({
      edl: buildEdl(),
      peaksByAsset: new Map(),
      output: OUTPUT,
      range: { startSec: -5, endSec: 999 },
    });
    expect(plan.range).toEqual({ startSec: 0, endSec: 5 });
    expect(plan.durationSec).toBeCloseTo(5, 6);
  });

  it('限制器默认开启，可显式关闭', () => {
    expect(planExport({ edl: buildEdl(), peaksByAsset: new Map(), output: OUTPUT }).limiter).toBe(true);
    expect(
      planExport({ edl: buildEdl(), peaksByAsset: new Map(), output: OUTPUT, limiter: false }).limiter,
    ).toBe(false);
  });
});
