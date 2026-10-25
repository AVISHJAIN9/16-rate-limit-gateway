import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'target/**',
      'vitest.config.ts',
      'scripts/**',
      'docs/**',
      'apps/web/dist/**',
      'examples/**',
      'frontend/**',
      'src/**'
    ]
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
        URL: 'readonly',
        console: 'readonly'
      }
    }
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
        tsconfigRootDir: new URL('.', import.meta.url).pathname
      }
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Date.now() is strictly forbidden outside clock.ts per Global Rule 0. Use Clock instead.'
        }
      ]
    }
  },
  {
    files: ['**/clock.ts'],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unused-vars': 'off'
    }
  }
];
