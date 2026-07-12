import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Shared flat config. Consumers re-export this from their own
 * `eslint.config.mjs`; plugin packages resolve from this package's
 * dependencies, so consumers only need the `eslint` binary.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Fastify's pino logger is the only sanctioned output channel;
      // console.error stays allowed for pre-logger startup failures.
      'no-console': ['error', { allow: ['error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
