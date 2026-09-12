/**
 * M0 Spike 实验清单。
 *
 * 新增实验时：在这里注册，并确保 docs/02 §5 的清单里有对应编号。
 */
import type { SpikeCase } from '../types';
import { db01, db02, db03 } from './audio-decode';
import { db04, db09, db11 } from './playback';
import { db07, db10, db14 } from './storage';
import { db08 } from './recorder';
import { db13 } from './canvas';
import { db05, db06 } from './worker';

/** 按"先跑便宜且不依赖人工操作"的顺序排列，便于一次坐下来跑完全部。 */
export const SPIKE_CASES: readonly SpikeCase[] = [
  db05,
  db06,
  db07,
  db03,
  db02,
  db01,
  db04,
  db13,
  db10,
  db14,
  db08,
  db09,
  db11,
];
