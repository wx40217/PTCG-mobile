import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * 开发期默认服务地址（Android 模拟器访问宿主机的回环别名）。
 *
 * 它只作为 `__DEV_DEFAULT_SERVICE_ADDRESS__` 注入到开发构建里；正式构建注入
 * 空字符串，地址字面量不会进入产物。
 */
const DEV_DEFAULT_SERVICE_ADDRESS = 'http://10.0.2.2:8787';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';
  return {
    plugins: [react()],
    define: {
      // 明文开关与默认地址都由构建 mode 决定，运行时的 .env 文件无法放行明文。
      __DEV_DEFAULT_SERVICE_ADDRESS__: JSON.stringify(isProduction ? '' : DEV_DEFAULT_SERVICE_ADDRESS),
      __ALLOW_INSECURE__: JSON.stringify(!isProduction),
    },
    resolve: {
      // 应用与测试都直接消费协议源码：开发期免去构建顺序耦合。
      // 服务的构建产物仍解析到协议已编译的 dist。
      alias: {
        '@ptcg/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      target: 'es2022',
      // Include the offline runtime in APK assets before the solo entry ticket wires UI.
      rollupOptions: {
        input: {
          app: fileURLToPath(new URL('./index.html', import.meta.url)),
          local: fileURLToPath(new URL('./src/local/session.ts', import.meta.url)),
        },
        preserveEntrySignatures: 'strict',
      },
    },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['./test/setup.ts'],
      testTimeout: 20_000,
    },
  };
});
