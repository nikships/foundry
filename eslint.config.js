// Flat config. Keep rules machine-readable and deterministic for agents:
// a failed lint should name the file, rule, and fix path without human context.
import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const PI_IMPORTS = {
  group: ['@earendil-works/pi-*', '@earendil-works/pi-*/*'],
  message:
    'Import @earendil-works/pi-* only under apps/desktop/src/main/pi/ (and its tests); the rest of the app talks to AgentTransport.',
};

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'assets/**',
      // Standalone marketing site: its own toolchain and tsconfig, and
      // deliberately outside the app build, `npm run check`, and CI.
      'apps/website/**',
      // Android companion app scaffold (separate Kotlin toolchain).
      'apps/android/**',
      // Local run worktrees and codegraph pointer — not part of the app.
      '.foundry-worktrees/**',
      '.codegraph',
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
      import: importPlugin,
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
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
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: ['variable', 'function'],
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'parameter',
          format: ['camelCase', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
      ],
      // Prefer ts for unused enums / namespaces noise.
      'no-unused-vars': 'off',
      // Agents and humans both ship clearer diffs without floating promises.
      // Without type-aware lint we only catch obvious empty catch / console.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      // A function above this ceiling must be split before it becomes harder
      // for an autonomous change to reason about and verify safely.
      complexity: ['error', { max: 20, variant: 'modified' }],
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
      // The agent runtime sits behind one seam. Importing it anywhere else
      // spreads its error classes and session types through the app, and the
      // runtime stops being replaceable without touching every layer.
      'no-restricted-imports': ['error', { patterns: [PI_IMPORTS] }],
      // Keep the pre-v7 plugin contract. The v7 recommended preset also
      // enables React Compiler rules, which require a separate code migration.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // The pi seam, and the tests that exercise it directly: the only places
  // allowed to name the runtime package.
  {
    files: [
      'apps/desktop/src/main/pi/**/*.ts',
      'apps/desktop/tests/main/pi/**/*.ts',
      'apps/desktop/tests/**/pi-*.test.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // Main process and tests are Node, not DOM-first.
  {
    files: [
      'apps/desktop/src/main/**/*.{ts,tsx}',
      'apps/desktop/tests/**/*.ts',
      'scripts/**/*.ts',
      'playwright.config.ts',
    ],
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
    files: ['apps/desktop/src/preload/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: './apps/desktop/src/preload',
              from: './apps/desktop/src/main',
              message: 'Preload may not import main-process implementation.',
            },
            {
              target: './apps/desktop/src/preload',
              from: './apps/desktop/src/renderer',
              message: 'Preload may not import renderer implementation.',
            },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            PI_IMPORTS,
            {
              group: ['@main/*', '@renderer/*'],
              message: 'Preload may import shared contracts, not main or renderer implementation.',
            },
          ],
        },
      ],
    },
  },
  // Electron process boundaries are a linted contract, not only prose.
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: './apps/desktop/src/renderer',
              from: './apps/desktop/src/main',
              message: 'Renderer privilege must go through the typed preload IPC bridge.',
            },
            {
              target: './apps/desktop/src/renderer',
              from: './apps/desktop/src/preload',
              message: 'Renderer imports shared contracts, never preload implementation.',
            },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            PI_IMPORTS,
            {
              group: ['@main/*', '@main/*/*'],
              message: 'Renderer privilege must go through the typed preload IPC bridge.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/shared/**/*.ts'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: './apps/desktop/src/shared',
              from: './apps/desktop/src/main',
              message: 'Shared modules must remain process-neutral and side-effect free.',
            },
            {
              target: './apps/desktop/src/shared',
              from: './apps/desktop/src/preload',
              message: 'Shared modules must remain process-neutral and side-effect free.',
            },
            {
              target: './apps/desktop/src/shared',
              from: './apps/desktop/src/renderer',
              message: 'Shared modules must remain process-neutral and side-effect free.',
            },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            PI_IMPORTS,
            {
              group: ['node:*', 'electron', 'react', 'react/*', '@main/*', '@renderer/*'],
              message: 'Shared modules may contain only pure, process-neutral code.',
            },
          ],
        },
      ],
    },
  },
  // Route dispatchers, schema validators, and declarative JSX naturally carry
  // more branches than ordinary domain functions. These are migration
  // ceilings, not exemptions: the worst existing outliers were split to fit.
  {
    files: [
      'apps/desktop/src/main/companion/host.ts',
      'apps/desktop/src/main/smith/present-tools.ts',
      'apps/desktop/src/renderer/**/*.{ts,tsx}',
    ],
    rules: {
      complexity: ['error', { max: 45, variant: 'modified' }],
    },
  },
  // Standards-compliant QR encoding is a branch-heavy algorithm with focused
  // tests; keep a finite ceiling without distorting it into one-use helpers.
  {
    files: ['apps/desktop/src/renderer/components/media/qr-matrix.ts'],
    rules: {
      complexity: ['error', { max: 60, variant: 'modified' }],
    },
  },
  // Prettier last so it disables conflicting stylistic rules.
  eslintConfigPrettier,
);
