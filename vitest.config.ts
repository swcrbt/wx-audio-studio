import { defineConfig } from 'vitest/config';

// 单测只覆盖纯逻辑层（miniprogram/workers/render/**）。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
