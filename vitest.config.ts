import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts']
  },
  resolve: {
    alias: {
      '@rlgw/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@rlgw/oracle': path.resolve(__dirname, 'packages/oracle/src/index.ts'),
      '@rlgw/store-memory': path.resolve(__dirname, 'packages/store-memory/src/index.ts'),
      '@rlgw/store-redis': path.resolve(__dirname, 'packages/store-redis/src/index.ts'),
      '@rlgw/obs': path.resolve(__dirname, 'packages/obs/src/index.ts'),
      '@rlgw/security': path.resolve(__dirname, 'packages/security/src/index.ts'),
      '@rlgw/control-plane': path.resolve(__dirname, 'packages/control-plane/src/index.ts'),
      '@rlgw/testutil': path.resolve(__dirname, 'packages/testutil/src/index.ts'),
      '@rlgw/aiml': path.resolve(__dirname, 'packages/aiml/src/index.ts')
    }
  }
});
