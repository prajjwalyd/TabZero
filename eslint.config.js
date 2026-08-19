// Flat config. Type-aware linting via typescript-eslint's project service, which picks up
// server/tsconfig.json and extension/tsconfig.json for the files each one owns.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['server/dist/**', 'extension/dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Underscore-prefixed args/vars are the project's "deliberately unused" marker.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The codebase handles plenty of `any` from JSON/HTTP boundaries on purpose; flagging every
      // hop through it drowns out the rules that catch real bugs. Tighten later if the types firm up.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Async event handlers / timer callbacks are idiomatic here; the rule still guards the cases
      // that actually lose errors (a promise returned where a sync value is consumed).
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  // Server, CLI, scripts, tests: Node.
  {
    files: ['server/**/*.{ts,mts}', 'bin/**/*.js', 'extension/build.mjs'],
    languageOptions: { globals: globals.node },
  },
  // Extension: browser + chrome.* (typed by @types/chrome).
  {
    files: ['extension/src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  // node:test's `test()` returns a promise nobody is meant to await, and `async` handler stubs
  // without an await are the normal way to fake a fetch response.
  {
    files: ['**/test/**/*.{ts,mts}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  // Plain JS/MJS files aren't in either tsconfig — lint them untyped.
  {
    files: ['**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
