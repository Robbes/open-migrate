import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node.js environment for .js, .cjs and .mjs files
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Enforce architecture rule: core must not import drizzle-orm or @openmig/ledger directly
    // Only @openmig/shared is allowed from @openmig/* in packages/core/src (excluding tests)
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'drizzle-orm',
              message: 'Drizzle ORM imports are not allowed in core. Use the @openmig/shared ports instead.',
            },
            {
              name: '@openmig/ledger',
              message: 'Direct ledger imports are not allowed in core. Use the @openmig/shared ports instead.',
            },
          ],
          patterns: [
            {
              group: ['@openmig/ledger/*'],
              message: 'Direct ledger imports are not allowed in core. Use the @openmig/shared ports instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
