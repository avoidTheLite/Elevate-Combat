import eslintJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import nPlugin from 'eslint-plugin-n';
import prettierConfig from 'eslint-config-prettier';

/** @type {import('typescript-eslint').ConfigArray} */
export default [
  eslintJs.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    plugins: {
      import: importPlugin,
      n: nPlugin,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      'import/extensions': ['error', 'always', { ignorePackages: true }],
      'n/prefer-node-protocol': 'error',
    },
  },
];
