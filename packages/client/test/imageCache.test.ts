import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@ptcg/protocol';
import {
  createImageCache,
  createMemoryImageCacheStorage,
  type ImageCacheFailureKind,
  type ImageFetchResponse,
} from '../src/catalog/imageCache.ts';

function bytesOf(fill: number, length = 64): Uint8Array {
  return Uint8Array.from({ length }, () => fill);
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await sha256(bytes);
  let out = '';
  for (const byte of digest) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function imageResponse(bytes: Uint8Array): ImageFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.length) },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}

describe('图片缓存：按需、完整性与原子替换', () => {
  it('下载校验后落盘；重新启动的缓存实例命中期望哈希，不再联网', async () => {
    const storage = createMemoryImageCacheStorage();
    const bytes = bytesOf(1);
    const digest = await digestHex(bytes);
    const fetchImage = vi.fn(async () => imageResponse(bytes));
    const cache = createImageCache(storage, { fetchImage });

    const result = await cache.ensure('card:a', digest, 'https://service.test/catalog/card-images/a');
    expect(result.ok).toBe(true);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(fetchImage).toHaveBeenCalledWith(
      'https://service.test/catalog/card-images/a',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(await cache.usage()).toEqual({ count: 1, bytes: bytes.length });
    expect(storage.keys()).toContain(`${digest}.png`);
    expect(storage.keys()).toContain('index.json');

    // 新的缓存实例（等同应用重启）读取同一存储：不产生任何网络请求。
    const fetchAfterRestart = vi.fn(async () => imageResponse(bytes));
    const restarted = createImageCache(storage, { fetchImage: fetchAfterRestart });
    const again = await restarted.ensure('card:a', digest, 'https://service.test/catalog/card-images/a');
    expect(again).toMatchObject({ ok: true });
    expect(fetchAfterRestart).not.toHaveBeenCalled();
    expect(restarted.attemptCount('card:a')).toBe(0);
  });

  it('摘要不一致拒绝写入：不覆盖旧版本，缓存条目仍可读', async () => {
    const storage = createMemoryImageCacheStorage();
    const oldBytes = bytesOf(1);
    const oldDigest = await digestHex(oldBytes);
    const cache = createImageCache(storage, { fetchImage: async () => imageResponse(oldBytes) });
    await cache.ensure('card:a', oldDigest, 'https://service.test/a');
    const usageBefore = await cache.usage();

    const newBytes = bytesOf(2);
    const newDigest = await digestHex(bytesOf(3)); // 声明的是另一个哈希
    const tamperedCache = createImageCache(storage, { fetchImage: async () => imageResponse(newBytes) });
    const result = await tamperedCache.ensure('card:a', newDigest, 'https://service.test/a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('integrity');
      expect(result.cached?.sha256).toBe(oldDigest);
    }
    expect(await cache.usage()).toEqual(usageBefore);
    const stillThere = await cache.get('card:a', oldDigest);
    expect(stillThere?.sha256).toBe(oldDigest);
  });

  it('下载中断（响应体读取失败）保留旧完整版本，不写半成品', async () => {
    const storage = createMemoryImageCacheStorage();
    const oldBytes = bytesOf(4);
    const oldDigest = await digestHex(oldBytes);
    let mode: 'ok' | 'interrupt' = 'ok';
    const fetchImage = vi.fn(async () => {
      if (mode === 'interrupt') {
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            throw new Error('connection reset');
          },
        } satisfies ImageFetchResponse;
      }
      return imageResponse(oldBytes);
    });
    const cache = createImageCache(storage, { fetchImage });
    await cache.ensure('card:a', oldDigest, 'https://service.test/a');

    const newBytes = bytesOf(5);
    const newDigest = await digestHex(newBytes);
    mode = 'interrupt';
    const result = await cache.ensure('card:a', newDigest, 'https://service.test/a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('network');
      expect(result.cached?.sha256).toBe(oldDigest);
    }
    expect(storage.keys()).not.toContain(`${newDigest}.png`);
    expect((await cache.get('card:a', oldDigest))?.sha256).toBe(oldDigest);
  });

  it('磁盘不足（写入抛错）保留旧版本与索引，报告存储失败', async () => {
    const storage = createMemoryImageCacheStorage();
    const oldBytes = bytesOf(6);
    const oldDigest = await digestHex(oldBytes);
    const cache = createImageCache(storage, { fetchImage: async () => imageResponse(oldBytes) });
    await cache.ensure('card:a', oldDigest, 'https://service.test/a');
    const indexBefore = (await storage.read('index.json')) && new TextDecoder().decode((await storage.read('index.json'))!);

    const newBytes = bytesOf(7);
    const newDigest = await digestHex(newBytes);
    storage.failNextWrite(new Error('磁盘空间不足'));
    const failing = createImageCache(storage, { fetchImage: async () => imageResponse(newBytes) });
    const result = await failing.ensure('card:a', newDigest, 'https://service.test/a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('storage');
      expect(result.cached?.sha256).toBe(oldDigest);
    }
    expect((await storage.read('index.json'))?.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode((await storage.read('index.json'))!)).toBe(indexBefore);
    expect((await cache.get('card:a', oldDigest))?.sha256).toBe(oldDigest);
  });

  it('缓存文件被篡改：识别损坏并回退到上一完整版本', async () => {
    const storage = createMemoryImageCacheStorage();
    const v1 = bytesOf(8);
    const v2 = bytesOf(9);
    const d1 = await digestHex(v1);
    const d2 = await digestHex(v2);
    const first = createImageCache(storage, { fetchImage: async () => imageResponse(v1) });
    await first.ensure('card:a', d1, 'https://service.test/a');
    const second = createImageCache(storage, { fetchImage: async () => imageResponse(v2) });
    await second.ensure('card:a', d2, 'https://service.test/a');

    // 模拟文件系统损坏：第二个版本的文件字节被替换。
    await storage.write(`${d2}.png`, bytesOf(0));
    const reader = createImageCache(storage, {
      fetchImage: async () => {
        throw new Error('不应联网');
      },
    });
    const fallback = await reader.get('card:a', d2);
    expect(fallback?.sha256).toBe(d1);
    expect(fallback?.stale).toBe(true);
  });

  it('自动重试有上限；显式重试（force）才继续，且次数可观察', async () => {
    const storage = createMemoryImageCacheStorage();
    const bytes = bytesOf(10);
    const digest = await digestHex(bytes);
    const fetchImage = vi.fn(async () => {
      throw new Error('offline');
    });
    const cache = createImageCache(storage, { fetchImage, maxAutoAttempts: 2 });
    await cache.ensure('card:a', digest, 'https://service.test/a');
    await cache.ensure('card:a', digest, 'https://service.test/a');
    expect(fetchImage).toHaveBeenCalledTimes(2);
    const blocked = await cache.ensure('card:a', digest, 'https://service.test/a');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.failure.message).toMatch(/自动重试上限/u);
    }
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(cache.attemptCount('card:a')).toBe(2);

    await cache.ensure('card:a', digest, 'https://service.test/a', { force: true });
    expect(fetchImage).toHaveBeenCalledTimes(3);
  });

  it('取消下载不计入重试失败，也不写入缓存', async () => {
    const storage = createMemoryImageCacheStorage();
    const bytes = bytesOf(11);
    const digest = await digestHex(bytes);
    const controller = new AbortController();
    const cache = createImageCache(storage, {
      fetchImage: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const pending = cache.ensure('card:a', digest, 'https://service.test/a', { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('aborted');
    }
    expect(cache.attemptCount('card:a')).toBe(0);
    expect(storage.keys()).toEqual([]);
  });

  it('占用按唯一文件统计，clear 清空命名空间并重置重试计数', async () => {
    const storage = createMemoryImageCacheStorage();
    const shared = bytesOf(12);
    const digest = await digestHex(shared);
    const cache = createImageCache(storage, { fetchImage: async () => imageResponse(shared) });
    await cache.ensure('card:a', digest, 'https://service.test/a');
    await cache.ensure('card:b', digest, 'https://service.test/b');
    expect(await cache.usage()).toEqual({ count: 1, bytes: shared.length });

    await cache.clear();
    expect(await cache.usage()).toEqual({ count: 0, bytes: 0 });
    expect(storage.keys()).toEqual([]);
    expect(cache.attemptCount('card:a')).toBe(0);
  });

  it('HTTP 404 不写缓存并给出不可重试的明确原因', async () => {
    const storage = createMemoryImageCacheStorage();
    const bytes = bytesOf(13);
    const digest = await digestHex(bytes);
    const cache = createImageCache(storage, {
      fetchImage: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    const result = await cache.ensure('card:a', digest, 'https://service.test/a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('http');
      expect(result.failure.retryable).toBe(false);
    }
    expect(storage.keys()).toEqual([]);
  });
});

describe('图片缓存失败分类防空档', () => {
  it('失败种类都在联合类型内', () => {
    const kinds: ImageCacheFailureKind[] = ['network', 'http', 'integrity', 'storage', 'too-large', 'aborted'];
    expect(new Set(kinds).size).toBe(6);
  });
});
