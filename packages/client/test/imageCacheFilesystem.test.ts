import { describe, expect, it } from 'vitest';
import { Directory } from '@capacitor/filesystem';
import {
  IMAGE_CACHE_NAMESPACE,
  createFilesystemImageCacheStorage,
  type FilesystemLike,
} from '../src/catalog/imageCacheFilesystem.ts';

/** 模拟原生 Filesystem：rename 不允许覆盖已存在目标，用于验证备份/恢复路径。 */
class FakeFilesystem implements FilesystemLike {
  readonly files = new Map<string, string>();
  renameCalls: Array<{ from: string; to: string }> = [];
  failTempCommits = 0;
  readonly failDeletes = new Set<string>();
  failRmdir = false;

  async readFile(options: { path: string }): Promise<{ data: string }> {
    const value = this.files.get(options.path);
    if (value === undefined) {
      throw new Error(`not found: ${options.path}`);
    }
    return { data: value };
  }

  async writeFile(options: { path: string; data: string }): Promise<unknown> {
    this.files.set(options.path, options.data);
    return {};
  }

  async deleteFile(options: { path: string }): Promise<void> {
    if (this.failDeletes.has(options.path)) {
      throw new Error(`delete failed: ${options.path}`);
    }
    this.files.delete(options.path);
  }

  async mkdir(): Promise<unknown> {
    return {};
  }

  async stat(options: { path: string }): Promise<unknown> {
    if (![...this.files.keys()].some((key) => key === options.path || key.startsWith(`${options.path}/`))) {
      throw new Error(`not found: ${options.path}`);
    }
    return {};
  }

  async readdir(options: { path: string }): Promise<{ files: Array<{ name?: string }> }> {
    const prefix = `${options.path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) {
          names.add(rest);
        }
      }
    }
    return { files: [...names].map((name) => ({ name })) };
  }

  async rename(options: { from: string; to: string }): Promise<void> {
    this.renameCalls.push({ from: options.from, to: options.to });
    if (this.failTempCommits > 0 && options.from.includes('.tmp-') && options.to.endsWith('index.json')) {
      this.failTempCommits -= 1;
      throw new Error('rename failed');
    }
    if (this.files.has(options.to)) {
      throw new Error('target exists');
    }
    const value = this.files.get(options.from);
    if (value === undefined) {
      throw new Error(`missing source: ${options.from}`);
    }
    this.files.set(options.to, value);
    this.files.delete(options.from);
  }

  async rmdir(options: { path: string }): Promise<void> {
    if (this.failRmdir) {
      throw new Error(`rmdir failed: ${options.path}`);
    }
    const prefix = `${options.path}/`;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) {
        this.files.delete(key);
      }
    }
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('Filesystem 图片缓存存储的原子替换', () => {
  it('目标不存在时直接 rename；已存在时经备份替换且不残留 .bak/临时文件', async () => {
    const fs = new FakeFilesystem();
    const storage = createFilesystemImageCacheStorage(IMAGE_CACHE_NAMESPACE, fs);
    await storage.write('index.json', bytes('v1'));
    expect(Array.from((await storage.read('index.json')) ?? [])).toEqual(Array.from(bytes('v1')));

    await storage.write('index.json', bytes('v2'));
    expect(Array.from((await storage.read('index.json')) ?? [])).toEqual(Array.from(bytes('v2')));
    const names = [...fs.files.keys()];
    expect(names.some((name) => name.includes('.bak-'))).toBe(false);
    expect(names.some((name) => name.includes('.tmp-'))).toBe(false);
    // 旧目标先被挪到备份，再放入新目标。
    expect(fs.renameCalls.some((call) => call.to.endsWith('index.json') && call.from.includes('.bak-') === false)).toBe(true);
  });

  it('替换过程中新文件改名失败时恢复旧文件，不丢上一完整版本', async () => {
    const fs = new FakeFilesystem();
    const storage = createFilesystemImageCacheStorage(IMAGE_CACHE_NAMESPACE, fs);
    await storage.write('index.json', bytes('good'));
    fs.failTempCommits = 2;
    await expect(storage.write('index.json', bytes('broken'))).rejects.toThrow();
    expect(Array.from((await storage.read('index.json')) ?? [])).toEqual(Array.from(bytes('good')));
    expect([...fs.files.keys()].some((name) => name.includes('.bak-'))).toBe(false);
    expect([...fs.files.keys()].some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('clear 只删除本命名空间并保留命名空间外的文件', async () => {
    const fs = new FakeFilesystem();
    const storage = createFilesystemImageCacheStorage(IMAGE_CACHE_NAMESPACE, fs);
    await storage.write('a.png', bytes('a'));
    fs.files.set('other-namespace/keep.txt', 'keep');
    await storage.clear();
    expect(await storage.read('a.png')).toBeUndefined();
    expect(fs.files.get('other-namespace/keep.txt')).toBe('keep');
    expect(await storage.list()).toEqual([]);
  });

  it('删除失败且目录无法递归移除时如实报错，剩余文件与索引仍可恢复', async () => {
    const fs = new FakeFilesystem();
    const storage = createFilesystemImageCacheStorage(IMAGE_CACHE_NAMESPACE, fs);
    await storage.write('a.png', bytes('a'));
    await storage.write('index.json', bytes('index'));
    fs.failDeletes.add(`${IMAGE_CACHE_NAMESPACE}/a.png`);
    fs.failDeletes.add(`${IMAGE_CACHE_NAMESPACE}/index.json`);
    fs.failRmdir = true;

    await expect(storage.clear()).rejects.toThrow(/仍有 2 个文件未能删除/u);
    expect(fs.files.has(`${IMAGE_CACHE_NAMESPACE}/a.png`)).toBe(true);
    expect(fs.files.has(`${IMAGE_CACHE_NAMESPACE}/index.json`)).toBe(true);
    // 剩余文件仍可读，重试清理有依据。
    expect(Array.from((await storage.read('a.png')) ?? [])).toEqual(Array.from(bytes('a')));

    fs.failDeletes.clear();
    fs.failRmdir = false;
    await storage.clear();
    expect(await storage.read('a.png')).toBeUndefined();
    expect(await storage.list()).toEqual([]);
  });

  it('单个文件删除失败但递归移除目录成功时，clear 成功且不报假失败', async () => {
    const fs = new FakeFilesystem();
    const storage = createFilesystemImageCacheStorage(IMAGE_CACHE_NAMESPACE, fs);
    await storage.write('a.png', bytes('a'));
    fs.failDeletes.add(`${IMAGE_CACHE_NAMESPACE}/a.png`);

    await storage.clear();
    expect(fs.files.has(`${IMAGE_CACHE_NAMESPACE}/a.png`)).toBe(false);
    expect(await storage.list()).toEqual([]);
  });
});
