import { describe, expect, it } from 'vitest';
import { ImportError, sourceMixesForTarget } from '../../miniprogram/core/audio/import';

describe('sourceMixesForTarget（声道统一规则）', () => {
  it('单声道源：任意目标声道都取源 0，权重为 1（复制上混）', () => {
    expect(sourceMixesForTarget(1, 1, 0)).toEqual([{ index: 0, weight: 1 }]);
    expect(sourceMixesForTarget(1, 2, 0)).toEqual([{ index: 0, weight: 1 }]);
    expect(sourceMixesForTarget(1, 2, 1)).toEqual([{ index: 0, weight: 1 }]);
  });

  it('立体声源 → 立体声目标：直接对应，不混音', () => {
    expect(sourceMixesForTarget(2, 2, 0)).toEqual([{ index: 0, weight: 1 }]);
    expect(sourceMixesForTarget(2, 2, 1)).toEqual([{ index: 1, weight: 1 }]);
  });

  it('立体声源 → 单声道目标：等权平均，避免削波', () => {
    const mixes = sourceMixesForTarget(2, 1, 0);
    expect(mixes).toEqual([
      { index: 0, weight: 0.5 },
      { index: 1, weight: 0.5 },
    ]);
    const total = mixes.reduce((sum, mix) => sum + mix.weight, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it('多声道源（>2）下混只取前两个声道，权重合计仍为 1', () => {
    const mixes = sourceMixesForTarget(6, 1, 0);
    expect(mixes.map((mix) => mix.index)).toEqual([0, 1]);
    expect(mixes.reduce((sum, mix) => sum + mix.weight, 0)).toBeCloseTo(1, 12);
  });

  it('多声道源 → 立体声目标：索引被 clamp 到可用范围', () => {
    expect(sourceMixesForTarget(6, 2, 0)).toEqual([{ index: 0, weight: 1 }]);
    expect(sourceMixesForTarget(1, 2, 1)).toEqual([{ index: 0, weight: 1 }]);
  });
});

describe('ImportError', () => {
  it('携带错误码与建议动作，便于 UI 给出可执行提示', () => {
    const error = new ImportError('tooLong', '音频过长', 'shorten');
    expect(error.code).toBe('tooLong');
    expect(error.action).toBe('shorten');
    expect(error.message).toBe('音频过长');
    expect(error).toBeInstanceOf(Error);
  });

  it('默认动作为 none', () => {
    expect(new ImportError('decodeFailed', '不支持').action).toBe('none');
  });
});
