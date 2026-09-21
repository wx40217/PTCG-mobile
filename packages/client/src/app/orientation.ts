import { Capacitor } from '@capacitor/core';

export type ScreenOrientationMode = 'landscape' | 'portrait';

/**
 * 运行时方向切换：对战横屏、组卡竖屏。
 *
 * 只在原生平台调用插件；浏览器/测试环境（jsdom）或设备不支持时静默保持系统方向，
 * 不阻塞界面，也不改变规则。返回是否成功切换，便于测试与诊断。
 */
export async function lockScreenOrientation(mode: ScreenOrientationMode): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }
  try {
    const { ScreenOrientation } = await import('@capacitor/screen-orientation');
    await ScreenOrientation.lock({ orientation: mode });
    return true;
  } catch {
    // 设备/系统不支持锁定方向时保持系统方向，不阻断对局。
    return false;
  }
}
