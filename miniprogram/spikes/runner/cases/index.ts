/**
 * M0 Spike 实验清单。
 *
 * 新增实验时：在这里注册，并确保 docs/02 §5 的清单里有对应编号。
 */
import type { SpikeCase } from '../types';
import { db01, db03 } from './audio-decode';
import { db05, db06 } from './worker';

export const SPIKE_CASES: readonly SpikeCase[] = [db01, db03, db05, db06];
