import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置。
 *
 * - `androidScheme: 'https'` 让 WebView 运行在安全上下文里，WebCrypto 才可用。
 * - 不设置 `server.url`，正式包不内置任何服务地址。
 * - 明文策略由 Android 的 debug/release 网络安全配置控制，不在这里放开。
 */
const config: CapacitorConfig = {
  appId: 'com.ptcgmobile.app',
  appName: 'PTCG简中对战',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    captureInput: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
