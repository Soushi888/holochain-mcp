import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['index.ts', 'src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/node_modules/**', '**/build/**', 'tests/**'],
      reporter: ['text', 'json', 'html']
    },
    testTimeout: 30000,
    setupFiles: ['tests/setup.ts']
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname
    }
  }
})