import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    setupFiles: ['./test/support/e2e-setup.ts'],
    include: ['**/*.e2e-spec.ts'],
  },
});