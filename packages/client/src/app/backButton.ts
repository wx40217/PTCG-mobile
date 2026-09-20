/** 返回键来源抽象：原生端由 Capacitor 提供，测试里可直接注入。 */
export interface BackButtonSource {
  subscribe(handler: () => void): () => void;
}

/**
 * Android 硬件返回键。
 *
 * 使用动态 import，Web/测试环境不需要加载原生插件；插件缺失时退化为不拦截
 * （由系统默认行为处理），不会因为缺少原生层而白屏。
 */
export function createCapacitorBackButtonSource(): BackButtonSource {
  return {
    subscribe(handler: () => void): () => void {
      let dispose: (() => void) | undefined;
      let cancelled = false;
      void import('@capacitor/app')
        .then(async ({ App }) => {
          const listener = await App.addListener('backButton', () => handler());
          if (cancelled) {
            void listener.remove();
            return;
          }
          dispose = () => void listener.remove();
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
        dispose?.();
      };
    },
  };
}

/** 退出应用：仅在设置页的返回键触发。 */
export async function exitApp(): Promise<void> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    const { App } = await import('@capacitor/app');
    await App.exitApp();
  } catch {
    /* Web 或插件缺失时无操作 */
  }
}
