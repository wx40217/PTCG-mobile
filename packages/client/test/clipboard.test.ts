import { describe, expect, it, vi } from 'vitest';
import { createCopyText, type ClipboardAdapters } from '../src/app/clipboard.ts';

interface AdapterOverrides {
  readonly isNativePlatform?: () => boolean;
  readonly writeNative?: (text: string) => Promise<void>;
  readonly writeBrowser?: (text: string) => Promise<void>;
}

function adapters(overrides: AdapterOverrides = {}): ClipboardAdapters {
  return {
    isNativePlatform: overrides.isNativePlatform ?? (() => false),
    writeNative: overrides.writeNative ?? (async () => undefined),
    writeBrowser: overrides.writeBrowser ?? (async () => undefined),
  };
}

describe('剪贴板复制抽象', () => {
  it('原生平台使用官方插件的原生写入，不碰 Web Clipboard', async () => {
    const writeNative = vi.fn(async () => undefined);
    const writeBrowser = vi.fn(async () => undefined);
    const copy = createCopyText(adapters({ isNativePlatform: () => true, writeNative, writeBrowser }));

    await copy('042000');

    expect(writeNative).toHaveBeenCalledExactlyOnceWith('042000');
    expect(writeBrowser).not.toHaveBeenCalled();
  });

  it('浏览器环境保留 Web Clipboard 路径', async () => {
    const writeNative = vi.fn(async () => undefined);
    const writeBrowser = vi.fn(async () => undefined);
    const copy = createCopyText(adapters({ writeNative, writeBrowser }));

    await copy('042000');

    expect(writeBrowser).toHaveBeenCalledExactlyOnceWith('042000');
    expect(writeNative).not.toHaveBeenCalled();
  });

  it('原生写入失败时仍退回 Web Clipboard 一次', async () => {
    const writeNative = vi.fn(async () => {
      throw new Error('native denied');
    });
    const writeBrowser = vi.fn(async () => undefined);
    const copy = createCopyText(adapters({ isNativePlatform: () => true, writeNative, writeBrowser }));

    await copy('042000');

    expect(writeNative).toHaveBeenCalledExactlyOnceWith('042000');
    expect(writeBrowser).toHaveBeenCalledExactlyOnceWith('042000');
  });

  it('原生与 Web 都失败时抛错，交给界面提示手动抄写', async () => {
    const writeNative = vi.fn(async () => {
      throw new Error('native denied');
    });
    const writeBrowser = vi.fn(async () => {
      throw new Error('browser denied');
    });
    const copy = createCopyText(adapters({ isNativePlatform: () => true, writeNative, writeBrowser }));

    await expect(copy('042000')).rejects.toThrow('native denied');
  });
});
