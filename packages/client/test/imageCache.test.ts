import { describe, expect, it, vi } from 'vitest';
import { sha256, utf8 } from '@ptcg/protocol';
import {
  createImageCache,
  createMemoryImageCacheStorage,
  type ImageCacheFailureKind,
  type ImageCacheStorage,
  type ImageFetchResponse,
} from '../src/catalog/imageCache.ts';

function bytesOf(fill: number, length = 64): Uint8Array {
  return Uint8Array.from({ length }, () => fill);
}

/** 给索引写入注入延迟，拉大并发写入时的读改写窗口。 */
function delayedIndexStorage(base: ReturnType<typeof createMemoryImageCacheStorage>, delayMs = 30): ImageCacheStorage {
  return {
    read: (name) => base.read(name),
    async write(name, bytes) {
      if (name === 'index.json') {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      await base.write(name, bytes);
    },
    remove: (name) => base.remove(name),
    list: () => base.list(),
    clear: () => base.clear(),
  };
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

  it('索引提交失败：共享内容哈希仍被其它 key 引用时保留文件，无人引用才回收', async () => {
    const storage = createMemoryImageCacheStorage();
    const shared = bytesOf(42);
    const sharedDigest = await digestHex(shared);
    const cache = createImageCache(storage, { fetchImage: async () => imageResponse(shared) });
    // key A 已完整缓存该内容哈希：文件被 A 的索引条目引用。
    await cache.ensure('card:a', sharedDigest, 'https://service.test/a');
    const indexBefore = new TextDecoder().decode((await storage.read('index.json'))!);

    // key B 命中同一内容哈希，文件写完但索引提交失败：不能把 A 仍在引用的文件删掉。
    const failingStorage: ImageCacheStorage = {
      read: (name) => storage.read(name),
      write: async (name, data) => {
        if (name === 'index.json') {
          throw new Error('存储索引写入失败');
        }
        await storage.write(name, data);
      },
      remove: (name) => storage.remove(name),
      list: () => storage.list(),
      clear: () => storage.clear(),
    };
    const failing = createImageCache(failingStorage, { fetchImage: async () => imageResponse(shared) });
    const sharedResult = await failing.ensure('card:b', sharedDigest, 'https://service.test/b');
    expect(sharedResult.ok).toBe(false);
    if (!sharedResult.ok) {
      expect(sharedResult.failure.kind).toBe('storage');
      expect(sharedResult.cached).toBeUndefined();
    }
    expect(new TextDecoder().decode((await storage.read('index.json'))!)).toBe(indexBefore);
    expect(storage.keys()).toContain(`${sharedDigest}.png`);
    expect(await cache.get('card:a', sharedDigest)).toMatchObject({ sha256: sharedDigest, stale: false });

    // 无人引用的新文件在索引失败后仍会被回收，不留下无法映射的孤儿文件。
    const orphan = bytesOf(43);
    const orphanDigest = await digestHex(orphan);
    const orphanCache = createImageCache(failingStorage, { fetchImage: async () => imageResponse(orphan) });
    const orphanResult = await orphanCache.ensure('card:c', orphanDigest, 'https://service.test/c');
    expect(orphanResult.ok).toBe(false);
    if (!orphanResult.ok) {
      expect(orphanResult.failure.kind).toBe('storage');
    }
    expect(storage.keys()).not.toContain(`${orphanDigest}.png`);
    expect(new TextDecoder().decode((await storage.read('index.json'))!)).toBe(indexBefore);
    expect(await cache.get('card:a', sharedDigest)).toMatchObject({ sha256: sharedDigest, stale: false });
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

describe('图片缓存并发提交、清空协调与字节核对', () => {
  it('并发写入不同 key：索引串行合并，两个完整文件都不会被 prune 删除', async () => {
    const storage = delayedIndexStorage(createMemoryImageCacheStorage());
    const bytesA = bytesOf(20);
    const bytesB = bytesOf(21);
    const digestA = await digestHex(bytesA);
    const digestB = await digestHex(bytesB);
    const fetchImage = vi.fn(async (url: string) => imageResponse(url.endsWith('/a') ? bytesA : bytesB));
    const cache = createImageCache(storage, { fetchImage });

    const [resultA, resultB] = await Promise.all([
      cache.ensure('card:a', digestA, 'https://service.test/a'),
      cache.ensure('card:b', digestB, 'https://service.test/b'),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(await cache.get('card:a', digestA)).toMatchObject({ sha256: digestA, stale: false });
    expect(await cache.get('card:b', digestB)).toMatchObject({ sha256: digestB, stale: false });
    expect(await cache.usage()).toEqual({ count: 2, bytes: bytesA.length + bytesB.length });
  });

  it('并发写入共享同一图片字节的不同 key：文件只留一份，两个条目都可用', async () => {
    const base = createMemoryImageCacheStorage();
    const storage = delayedIndexStorage(base);
    const shared = bytesOf(22);
    const digest = await digestHex(shared);
    const cache = createImageCache(storage, { fetchImage: async () => imageResponse(shared) });

    const results = await Promise.all([
      cache.ensure('card:a', digest, 'https://service.test/a'),
      cache.ensure('card:b', digest, 'https://service.test/b'),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(await cache.get('card:a', digest)).toMatchObject({ sha256: digest, stale: false });
    expect(await cache.get('card:b', digest)).toMatchObject({ sha256: digest, stale: false });
    expect(await cache.usage()).toEqual({ count: 1, bytes: shared.length });
    expect(base.keys()).toContain(`${digest}.png`);
  });

  it('下载进行中清空缓存：完成下载也不写回索引或文件', async () => {
    const storage = createMemoryImageCacheStorage();
    const bytes = bytesOf(23);
    const digest = await digestHex(bytes);
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = createImageCache(storage, {
      fetchImage: async () => {
        markStarted?.();
        await gate;
        return imageResponse(bytes);
      },
    });

    const pending = cache.ensure('card:a', digest, 'https://service.test/a');
    await started;
    await cache.clear();
    release?.();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(await cache.usage()).toEqual({ count: 0, bytes: 0 });
    expect(storage.keys()).toEqual([]);
    expect(await cache.get('card:a', digest)).toBeUndefined();
  });

  it('清理失败：不重置索引与占用，剩余图片仍可读取，重试成功后清空', async () => {
    const storage = createMemoryImageCacheStorage();
    const bytes = bytesOf(24);
    const digest = await digestHex(bytes);
    const cache = createImageCache(storage, { fetchImage: async () => imageResponse(bytes) });
    await cache.ensure('card:a', digest, 'https://service.test/a');
    storage.failNextClear(new Error('测试注入的清理失败'));

    await expect(cache.clear()).rejects.toThrow('测试注入的清理失败');
    expect(await cache.get('card:a', digest)).toMatchObject({ sha256: digest });
    expect(await cache.usage()).toEqual({ count: 1, bytes: bytes.length });

    await cache.clear();
    expect(await cache.usage()).toEqual({ count: 0, bytes: 0 });
  });

  it('同一实例内同长度篡改被识别并回退到上一完整版本', async () => {
    const storage = createMemoryImageCacheStorage();
    const v1 = bytesOf(30);
    const v2 = bytesOf(31);
    const d1 = await digestHex(v1);
    const d2 = await digestHex(v2);
    let serving = v1;
    const cache = createImageCache(storage, { fetchImage: async () => imageResponse(serving) });

    await cache.ensure('card:a', d1, 'https://service.test/a');
    serving = v2;
    await cache.ensure('card:a', d2, 'https://service.test/a');

    // 文件是本实例写入的；同长度损坏仍必须以实际字节为准被发现。
    await storage.write(`${d2}.png`, bytesOf(32));
    const fallback = await cache.get('card:a', d2);
    expect(fallback).toMatchObject({ sha256: d1, stale: true });
    expect(storage.keys()).not.toContain(`${d2}.png`);
  });

  it('同一实例内唯一版本同长度损坏：删除损坏文件，下一次 ensure 重新下载', async () => {
    const storage = createMemoryImageCacheStorage();
    const good = bytesOf(33);
    const digest = await digestHex(good);
    const fetchImage = vi.fn(async () => imageResponse(good));
    const cache = createImageCache(storage, { fetchImage });

    await cache.ensure('card:a', digest, 'https://service.test/a');
    await storage.write(`${digest}.png`, bytesOf(34));

    expect(await cache.get('card:a', digest)).toBeUndefined();
    expect(storage.keys()).not.toContain(`${digest}.png`);

    const again = await cache.ensure('card:a', digest, 'https://service.test/a');
    expect(again.ok).toBe(true);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('expectedSha256 为 null 时返回最新完整缓存且不计为更新失败', async () => {
    const storage = createMemoryImageCacheStorage();
    const bytes = bytesOf(35);
    const digest = await digestHex(bytes);
    const cache = createImageCache(storage, { fetchImage: async () => imageResponse(bytes) });
    await cache.ensure('card:a', digest, 'https://service.test/a');

    expect(await cache.get('card:a', null)).toMatchObject({ sha256: digest, stale: false });
  });
});

describe('图片缓存索引的命名空间边界', () => {
  // 索引条目只允许引用内容哈希文件；其他名字（穿越、绝对路径、子目录、任意名）
  // 都必须让整份索引作废，绝不按索引里的路径去读取或删除存储中的文件。
  const outOfNamespaceFiles = [
    '../outside.png',
    '/absolute/outside.png',
    `nested/${'a'.repeat(64)}.png`,
    `${'a'.repeat(64)}.png`,
    'other.png',
  ];

  it.each(outOfNamespaceFiles)(
    '索引条目 file=%s 不是 <sha256>.png 时整份索引作废且不读取该文件',
    async (file) => {
      const bytes = bytesOf(40);
      const digest = await digestHex(bytes);
      const base = createMemoryImageCacheStorage({
        'index.json': utf8(
          JSON.stringify({
            schema: 'ptcg.image-cache/v1',
            entries: {
              'card:a': [{ sha256: digest, bytes: bytes.length, storedAt: '2026-01-01T00:00:00.000Z', file }],
            },
          }),
        ),
        [file]: bytes,
      });
      const reads: string[] = [];
      const removes: string[] = [];
      const storage: ImageCacheStorage = {
        read: (name) => {
          reads.push(name);
          return base.read(name);
        },
        write: (name, data) => base.write(name, data),
        remove: (name) => {
          removes.push(name);
          return base.remove(name);
        },
        list: () => base.list(),
        clear: () => base.clear(),
      };
      const cache = createImageCache(storage, {
        fetchImage: async () => {
          throw new Error('损坏索引不得触发下载');
        },
      });

      expect(await cache.get('card:a', digest)).toBeUndefined();
      expect(await cache.usage()).toEqual({ count: 0, bytes: 0 });
      expect(reads).not.toContain(file);
      expect(removes).not.toContain(file);
    },
  );

  it('损坏索引清空命名空间后，ensure 以规范文件名重新缓存', async () => {
    const bytes = bytesOf(41);
    const digest = await digestHex(bytes);
    const base = createMemoryImageCacheStorage({
      'index.json': utf8(
        JSON.stringify({
          schema: 'ptcg.image-cache/v1',
          entries: {
            'card:a': [
              { sha256: digest, bytes: bytes.length, storedAt: '2026-01-01T00:00:00.000Z', file: '../outside.png' },
            ],
          },
        }),
      ),
      '../outside.png': bytes,
    });
    const cache = createImageCache(base, { fetchImage: async () => imageResponse(bytes) });
    expect(await cache.get('card:a', digest)).toBeUndefined();

    const result = await cache.ensure('card:a', digest, 'https://service.test/a');
    expect(result.ok).toBe(true);
    expect(base.keys()).toContain(`${digest}.png`);
    expect(base.keys()).not.toContain('../outside.png');
  });
});

describe('图片缓存失败分类防空档', () => {
  it('失败种类都在联合类型内', () => {
    const kinds: ImageCacheFailureKind[] = ['network', 'http', 'integrity', 'storage', 'too-large', 'aborted'];
    expect(new Set(kinds).size).toBe(6);
  });
});
