import { defineConfig } from 'vitest/config';

// 单测只覆盖纯逻辑层（miniprogram/workers/render/**），见 AGENTS §7 与 docs/06 §2.1。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
