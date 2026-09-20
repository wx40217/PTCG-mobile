import { describe, expect, it } from 'vitest';
import config from '../capacitor.config.ts';

/**
 * 原生壳层配置的隐私/传输不变量。
 *
 * 这些值会被 `cap sync` 写进 APK 的 `assets/capacitor.config.json`，直接决定
 * 原生桥是否把插件载荷写进 logcat、以及 WebView 是否允许混合内容。
 */
describe('Capacitor 原生配置', () => {
  it('关闭原生桥插件日志，恢复身份私钥不得进入 logcat', () => {
    // 默认 debug 行为会记录每次插件调用（包括 Preferences.set 的完整 JSON），
    // 因此必须在配置层禁用，而不是依赖 release 不可调试。
    expect(config.loggingBehavior).toBe('none');
  });

  it('WebView 运行在 https 源且默认不允许混合内容', () => {
    expect(config.server?.androidScheme).toBe('https');
    expect(config.android?.allowMixedContent).toBe(false);
  });

  it('包名与应用标识保持稳定', () => {
    expect(config.appId).toBe('com.ptcgmobile.app');
    expect(config.webDir).toBe('dist');
  });
});
