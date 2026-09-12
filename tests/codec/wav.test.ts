import { describe, expect, it } from 'vitest';
import {
  BITS_PER_SAMPLE,
  PCM_AUDIO_FORMAT,
  WAV_HEADER_BYTES,
  createWavHeaderBuffer,
  floatToInt16,
  int16ToFloat,
  parseWav,
  patchWavHeaderSizes,
  writeWavHeader,
} from '../../miniprogram/workers/render/codec/wav';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/** 构造一个 44 字节标准头 + 指定样本数据的完整 WAV。 */
function buildWav(opts: {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}): Uint8Array {
  const dataBytes = opts.samples.length * 2;
  const head = new Uint8Array(createWavHeaderBuffer({
    sampleRate: opts.sampleRate,
    channels: opts.channels,
    dataBytes,
  }));
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  out.set(head, 0);
  out.set(new Uint8Array(opts.samples.buffer, opts.samples.byteOffset, dataBytes), WAV_HEADER_BYTES);
  return out;
}

describe('writeWavHeader', () => {
  it('写出符合 docs/03 §2 规定的 44 字节 PCM 头', () => {
    const buffer = createWavHeaderBuffer({ sampleRate: 44100, channels: 2, dataBytes: 176400 });
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    expect(buffer.byteLength).toBe(WAV_HEADER_BYTES);
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 176400);
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(PCM_AUDIO_FORMAT);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(44100 * 4); // byteRate = sr × blockAlign
    expect(view.getUint16(32, true)).toBe(4); // blockAlign = 2ch × 16bit / 8
    expect(view.getUint16(34, true)).toBe(BITS_PER_SAMPLE);
    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(176400);
  });

  it('支持带偏移写入，供流式回填使用', () => {
    const buffer = new ArrayBuffer(WAV_HEADER_BYTES * 2);
    const view = new DataView(buffer);
    writeWavHeader(view, { sampleRate: 16000, channels: 1, dataBytes: 320 }, WAV_HEADER_BYTES);
    expect(ascii(new Uint8Array(buffer), WAV_HEADER_BYTES, 4)).toBe('RIFF');
    expect(view.getUint32(WAV_HEADER_BYTES + 40, true)).toBe(320);
  });
});

describe('patchWavHeaderSizes', () => {
  it('只回填 RIFF.chunkSize 与 data.dataSize', () => {
    const buffer = createWavHeaderBuffer({ sampleRate: 44100, channels: 1, dataBytes: 0 });
    const view = new DataView(buffer);
    patchWavHeaderSizes(view, 88200);
    expect(view.getUint32(4, true)).toBe(36 + 88200);
    expect(view.getUint32(40, true)).toBe(88200);
    expect(view.getUint32(24, true)).toBe(44100); // 其余字段不受影响
  });
});

describe('parseWav', () => {
  it('解析标准 44 字节头', () => {
    const wav = buildWav({ sampleRate: 44100, channels: 1, samples: new Int16Array(1000) });
    const parsed = parseWav(wav);
    expect(parsed).not.toBeNull();
    expect(parsed?.audioFormat).toBe(PCM_AUDIO_FORMAT);
    expect(parsed?.bitsPerSample).toBe(16);
    expect(parsed?.sampleRate).toBe(44100);
    expect(parsed?.channels).toBe(1);
    expect(parsed?.dataOffset).toBe(WAV_HEADER_BYTES);
    expect(parsed?.dataBytes).toBe(2000);
    expect(parsed?.frames).toBe(1000);
  });

  it('跳过 data 之前的附加块（LIST，含奇数长度的 1 字节对齐）', () => {
    // 布局：12..35 fmt | 36..49 LIST(8 + 5 + 1 填充) | 50..57 data 头 | 58..61 数据
    const wav = new Uint8Array(62);
    const head = new Uint8Array(
      createWavHeaderBuffer({ sampleRate: 22050, channels: 2, dataBytes: 4 }),
    );
    wav.set(head.subarray(0, 36), 0);
    const view = new DataView(wav.buffer);
    for (let i = 0; i < 4; i++) wav[36 + i] = 'LIST'.charCodeAt(i);
    view.setUint32(40, 5, true);
    for (let i = 0; i < 5; i++) wav[44 + i] = 'INFOx'.charCodeAt(i);
    // 49 为对齐填充字节（保持 0）
    for (let i = 0; i < 4; i++) wav[50 + i] = 'data'.charCodeAt(i);
    view.setUint32(54, 4, true);

    const parsed = parseWav(wav);
    expect(parsed?.sampleRate).toBe(22050);
    expect(parsed?.channels).toBe(2);
    expect(parsed?.dataOffset).toBe(58);
    expect(parsed?.dataBytes).toBe(4);
    expect(parsed?.frames).toBe(1); // 4B / (2ch × 2B)
  });

  it('支持 fmt 块长 18（含 cbSize）', () => {
    // 布局：12..37 fmt(8 + 18) | 38..45 data 头 | 46..49 数据
    const wav = new Uint8Array(50);
    const head = new Uint8Array(
      createWavHeaderBuffer({ sampleRate: 16000, channels: 1, dataBytes: 4 }),
    );
    wav.set(head.subarray(0, 36), 0);
    const view = new DataView(wav.buffer);
    view.setUint32(16, 18, true); // fmt 块长 18
    view.setUint16(36, 0, true); // cbSize
    for (let i = 0; i < 4; i++) wav[38 + i] = 'data'.charCodeAt(i);
    view.setUint32(42, 4, true);

    const parsed = parseWav(wav);
    expect(parsed?.sampleRate).toBe(16000);
    expect(parsed?.bitsPerSample).toBe(16);
    expect(parsed?.dataOffset).toBe(46);
    expect(parsed?.frames).toBe(2); // 4B / (1ch × 2B)
  });

  it('chunkSize 超出实际长度时按可用字节数截断', () => {
    const wav = buildWav({ sampleRate: 8000, channels: 1, samples: new Int16Array(10) });
    new DataView(wav.buffer).setUint32(40, 999999, true);
    expect(parseWav(wav)?.dataBytes).toBe(20);
  });

  it('非法输入返回 null', () => {
    expect(parseWav(new Uint8Array(0))).toBeNull();
    expect(parseWav(new Uint8Array(11))).toBeNull();
    const notRiff = buildWav({ sampleRate: 44100, channels: 1, samples: new Int16Array(4) });
    new Uint8Array(notRiff.buffer)[0] = 0x58; // 'X'
    expect(parseWav(notRiff)).toBeNull();
    const noData = buildWav({ sampleRate: 44100, channels: 1, samples: new Int16Array(4) });
    for (let i = 36; i < 40; i++) new Uint8Array(noData.buffer)[i] = 0x20;
    expect(parseWav(noData)).toBeNull();
  });
});

describe('floatToInt16 / int16ToFloat', () => {
  it('满量程与零点精确映射', () => {
    const dst = new Int16Array(5);
    floatToInt16(new Float32Array([1, -1, 0, 0.5, -0.5]), dst);
    expect(dst[0]).toBe(32767);
    expect(dst[1]).toBe(-32768);
    expect(dst[2]).toBe(0);
    expect(dst[3]).toBe(16383);
    expect(dst[4]).toBe(-16384);
  });

  it('超范围硬削波、非有限值归零', () => {
    const dst = new Int16Array(5);
    floatToInt16(new Float32Array([2, -3, Number.NaN, Number.POSITIVE_INFINITY, 0]), dst);
    expect(dst[0]).toBe(32767);
    expect(dst[1]).toBe(-32768);
    expect(dst[2]).toBe(0);
    expect(dst[3]).toBe(0);
    expect(dst[4]).toBe(0);
  });

  it('零长度输入不越界也不修改目标', () => {
    const dst = new Int16Array([5, 6]);
    floatToInt16(new Float32Array(0), dst);
    expect(Array.from(dst)).toEqual([5, 6]);
  });

  it('支持写入偏移', () => {
    const dst = new Int16Array([9, 9, 9]);
    floatToInt16(new Float32Array([1, -1]), dst, 1);
    expect(Array.from(dst)).toEqual([9, 32767, -32768]);
  });

  it('往返转换误差不超过 1 LSB', () => {
    const src = new Float32Array([0, 0.25, -0.25, 0.999, -0.999, 1, -1]);
    const i16 = new Int16Array(src.length);
    const back = new Float32Array(src.length);
    floatToInt16(src, i16);
    int16ToFloat(i16, back);
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs((back[i] ?? 0) - (src[i] ?? 0))).toBeLessThan(1 / 32767);
    }
  });

  it('int16ToFloat 非对称分母保证 ±1 精确往返', () => {
    const back = new Float32Array(2);
    int16ToFloat(new Int16Array([32767, -32768]), back);
    expect(back[0]).toBe(1);
    expect(back[1]).toBe(-1);
  });
});
