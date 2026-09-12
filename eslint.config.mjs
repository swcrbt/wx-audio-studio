import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 分层规则的可执行部分：
 * 1. 纯逻辑层 miniprogram/workers/render/** 禁止运行时依赖 wx.* 或 core/；
 * 2. 该目录内禁止 import/require 目录之外的路径（Worker 内只能引用本目录下的文件）；
 * 3. `import type` 允许：类型导入编译后被消除，不产生运行时 require。
 */
export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**', 'miniprogram/miniprogram_npm/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    // TS 编译器已经负责“未定义标识符”的检查，JS 规则在这里只会误报
    rules: { 'no-undef': 'off' },
  },
  {
    // Node 侧脚本（上传/预览等），非小程序运行环境
    files: ['scripts/**/*.mjs', '*.mjs', '*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    files: ['miniprogram/workers/render/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['wx', 'wx/*', '**/core/**'],
              // 类型导入允许：`core/types.ts` 与消息协议需要在两侧共享，
              // 而 `import type` 编译后被消除，不会在 Worker 里产生运行时 require（ADR-0001）
              allowTypeImports: true,
              message:
                '纯逻辑层禁止运行时依赖 wx.* 或 core/（类型可用 import type）',
            },
            {
              group: ['../../**'],
              allowTypeImports: true,
              message:
                'Worker 只能引用 workers/render/ 目录内的文件，禁止越出该目录',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'wx', message: '纯逻辑层禁止访问 wx.*' },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
