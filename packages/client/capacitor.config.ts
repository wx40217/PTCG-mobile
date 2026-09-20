import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置。
 *
 * - `androidScheme: 'https'` 让 WebView 运行在安全上下文里，WebCrypto 才可用。
 * - 不设置 `server.url`，正式包不内置任何服务地址。
 * - 明文策略由 Android 的 debug/release 网络安全配置控制，不在这里放开。
 * - `loggingBehavior: 'none'` 关闭 Capacitor 原生桥的插件调用日志。默认的 debug
 *   行为会把 `Preferences.set` 载荷（含恢复身份私钥）打进 logcat；恢复凭据只
 *   允许留在设备本地存储，任何构建变体都不写日志。
 */
const config: CapacitorConfig = {
  appId: 'com.ptcgmobile.app',
  appName: 'PTCG简中对战',
  webDir: 'dist',
  loggingBehavior: 'none',
  android: {
    allowMixedContent: false,
    captureInput: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
