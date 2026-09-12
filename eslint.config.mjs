import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 分层规则的可执行部分（规则的唯一权威处是 AGENTS.md §1）：
 * 1. 纯逻辑层 miniprogram/workers/render/** 禁止依赖 wx.*；
 * 2. 同一层内禁止 require/import 该目录之外的路径（官方限制：Worker 内只能
 *    引用 Worker 目录内的文件，见 docs/02 §1.5 与 ADR-0001）；
 * 3. 类型导入（import type）允许，因为它编译后被消除。
 */
export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**', 'miniprogram/miniprogram_npm/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['miniprogram/workers/render/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['wx', 'wx/*', '**/core/**'],
              message: '纯逻辑层禁止依赖 wx.* 或 core/（见 AGENTS §1）',
            },
            {
              group: ['../../**'],
              allowTypeImports: true,
              message:
                'Worker 只能引用 workers/render/ 目录内的文件，禁止越出该目录（见 docs/02 §1.5 与 ADR-0001）',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'wx', message: '纯逻辑层禁止访问 wx.*（见 AGENTS §1）' },
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
