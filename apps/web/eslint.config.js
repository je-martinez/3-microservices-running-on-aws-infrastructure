// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default defineConfig([
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    // CONTRACT: Only the lazily-imported rum-sdk.ts may import @opentelemetry/*
    // as a value. Anywhere else the import lands in the initial bundle for every
    // visitor, RUM flag on or off — one value import of @opentelemetry/api in
    // the interceptor adds ~26 kB to main. Type-only imports are erased.
    // See [[browser-rum]]
    files: ['src/**/*.ts'],
    ignores: ['src/app/core/observability/rum-sdk.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@opentelemetry/*'],
              allowTypeImports: true,
              message:
                'Value-import OTel only in rum-sdk.ts (lazy chunk); reach it through rum.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {},
  },
]);
