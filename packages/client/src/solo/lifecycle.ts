import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export interface SoloLifecycle { subscribe(listener: (active: boolean) => void): () => void }
export const soloLifecycle: SoloLifecycle = {
  subscribe(listener) {
    const visibility = () => listener(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    let cancelled = false;
    let remove: (() => void) | undefined;
    if (Capacitor.isNativePlatform()) {
      void App.addListener('appStateChange', state => listener(state.isActive)).then(handle => {
        if (cancelled) void handle.remove();
        else remove = () => { void handle.remove(); };
      }).catch(() => undefined);
    }
    return () => { cancelled = true; remove?.(); document.removeEventListener('visibilitychange', visibility); };
  },
};
