// Flat config. Keep rules machine-readable and deterministic for agents:
// a failed lint should name the file, rule, and fix path without human context.
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'assets/**',
      // Generated / vendor-ish; not hand-edited.
      'package-lock.json',
      // Plain Node ESM helpers without a TS project service.
      'scripts/**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: '18.3' },
    },
    rules: {
      // tsc already enforces unused locals/params with noUnusedLocals.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Explicit any is rare and always intentional in this codebase; still flag it.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Prefer ts for unused enums / namespaces noise.
      'no-unused-vars': 'off',
      // Agents and humans both ship clearer diffs without floating promises.
      // Without type-aware lint we only catch obvious empty catch / console.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      // React 17+ JSX transform; no need to import React in every file.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/jsx-uses-react': 'off',
      'react/jsx-key': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/no-unknown-property': 'error',
      // The SDK is one transport behind one seam. Importing it anywhere else
      // spreads its error classes and session types through the app, and the
      // engine stops being able to swap transports.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factory/droid-sdk', '@factory/droid-sdk/*'],
              message:
                'Import @factory/droid-sdk only under src/main/droid/sdk/ (and its tests); the rest of the app talks to SdkSession.',
            },
          ],
        },
      ],
      ...reactHooks.configs.recommended.rules,
    },
  },
  // The transport seam itself, and the tests that script it.
  {
    files: ['src/main/droid/sdk/**/*.ts', 'tests/sdk-*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // Main process and tests are Node, not DOM-first.
  {
    files: ['src/main/**/*.{ts,tsx}', 'tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // CLI demos are meant to print; keep no-console for the app itself.
  {
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // Preload is a small CJS-shaped bridge; still authored as TS ESM.
  {
    files: ['src/preload/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  // Prettier last so it disables conflicting stylistic rules.
  eslintConfigPrettier,
);
