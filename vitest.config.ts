import { defineConfig } from 'vitest/config';
const common = { testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false };
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...common,
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/*.e2e.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          ...common,
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
          globalSetup: ['tests/postgres-setup.ts'],
        },
      },
      {
        test: {
          ...common,
          name: 'e2e',
          include: ['**/*.e2e.test.ts'],
          exclude: ['**/node_modules/**'],
          globalSetup: ['tests/postgres-setup.ts'],
        },
      },
    ],
  },
});
