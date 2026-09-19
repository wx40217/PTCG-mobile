import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * 开发期默认服务地址（Android 模拟器访问宿主机的回环别名）。
 *
 * 它不是写死在应用源码里的：正式构建会把 `__DEV_DEFAULT_SERVICE_ADDRESS__`
 * 注入为空字符串，地址字面量不会进入产物。
 */
const DEV_DEFAULT_SERVICE_ADDRESS = 'http://10.0.2.2:8787';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __DEV_DEFAULT_SERVICE_ADDRESS__: JSON.stringify(mode === 'production' ? '' : DEV_DEFAULT_SERVICE_ADDRESS),
  },
  resolve: {
    alias: {
      // 直接消费协议源码，避免构建顺序耦合；发布包仍由协议自身构建负责。
      '@ptcg/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 20_000,
  },
}));
