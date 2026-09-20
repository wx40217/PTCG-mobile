import { Clipboard } from '@capacitor/clipboard';
import { Capacitor } from '@capacitor/core';

/** 复制一段文本到系统剪贴板；失败时抛出，由调用方决定用户可见的回退。 */
export type CopyText = (text: string) => Promise<void>;

/** 复制函数可注入的底层能力，用来在测试里区分原生与浏览器路径。 */
export interface ClipboardAdapters {
  /** 当前是否运行在 Capacitor 原生壳层里。 */
  readonly isNativePlatform: () => boolean;
  /** 官方 Capacitor Clipboard 插件的原生写入。 */
  readonly writeNative: (text: string) => Promise<void>;
  /** 浏览器 Web Clipboard API 写入。 */
  readonly writeBrowser: (text: string) => Promise<void>;
}

const defaultAdapters: ClipboardAdapters = {
  isNativePlatform: () => Capacitor.isNativePlatform(),
  writeNative: async (text) => {
    await Clipboard.write({ string: text });
  },
  writeBrowser: async (text) => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      throw new Error('Clipboard API unavailable');
    }
    await navigator.clipboard.writeText(text);
  },
};

/**
 * 构造复制函数。
 *
 * 原生 Android WebView（已验证 MuMu Player 12）即使收到真实 ADB 触控也可能拒绝
 * `navigator.clipboard`，因此原生平台必须走官方插件的 `ClipboardManager`；浏览器
 * 环境保留 Web Clipboard API。原生写入失败时再退到 Web API 一次，两者都失败才
 * 抛错，由界面提示手动抄写。
 */
export function createCopyText(adapters: ClipboardAdapters = defaultAdapters): CopyText {
  return async (text: string): Promise<void> => {
    if (!adapters.isNativePlatform()) {
      await adapters.writeBrowser(text);
      return;
    }
    try {
      await adapters.writeNative(text);
    } catch (nativeError) {
      try {
        await adapters.writeBrowser(text);
      } catch {
        throw nativeError;
      }
    }
  };
}

/** 应用默认使用官方 Capacitor 剪贴板插件；浏览器路径作为回退保留。 */
export const copyTextToClipboard: CopyText = createCopyText();
