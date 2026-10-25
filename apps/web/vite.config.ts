import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@rlgw/core/algorithms': path.resolve(__dirname, '../../packages/core/src/algorithms/index.ts'),
      '@rlgw/core/clock': path.resolve(__dirname, '../../packages/core/src/clock.ts'),
      '@rlgw/core': path.resolve(__dirname, '../../packages/core/src/index.ts')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 3000
  }
});
