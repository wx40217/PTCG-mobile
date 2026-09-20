import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCatalogVersion, parseServiceCatalog } from '@ptcg/protocol';
import {
  CATALOG_CACHE_BACKUP_KEY,
  CATALOG_CACHE_KEY,
  createCatalogCache,
  createMemoryCatalogStorage,
} from '../src/catalog/cache.ts';

function realDocument(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), '../../data/catalog/zh-cn-standard-2025-06-05-catalog.json'), 'utf8'),
  ) as Record<string, unknown>;
}

/** 构造一份“内容已变、版本也随之更新”的合法文档（模拟服务端新版本）。 */
async function renamedDocument(name: string): Promise<Record<string, unknown>> {
  const document = realDocument();
  const cards = document['cards'] as Array<Record<string, unknown>>;
  (cards[0] as Record<string, unknown>)['nameZh'] = name;
  const parsed = parseServiceCatalog(document);
  if (parsed === null) {
    throw new Error('test document invalid');
  }
  document['catalogVersion'] = await computeCatalogVersion(parsed.content);
  return document;
}

describe('目录缓存原子性与失败保护', () => {
  it('写入成功后可以读取完整文档', async () => {
    const cache = createCatalogCache(createMemoryCatalogStorage());
    const document = realDocument();
    await cache.save(document);
    const loaded = await cache.load();
    expect(loaded).toBeDefined();
    expect(loaded?.catalog.content.cards).toHaveLength(47);
    expect(parseServiceCatalog(loaded?.raw)).not.toBeNull();
  });

  it('拒绝写入无法完整解析的目录，且不破坏已有缓存', async () => {
    const storage = createMemoryCatalogStorage();
    const cache = createCatalogCache(storage);
    await cache.save(realDocument());
    await expect(cache.save({ schema: 'bad' })).rejects.toThrow(/拒绝写入/u);
    const loaded = await cache.load();
    expect(loaded?.catalog.content.cards).toHaveLength(47);
  });

  it('新版本写入失败时保留上一份完整缓存', async () => {
    const storage = createMemoryCatalogStorage();
    const cache = createCatalogCache(storage);
    await cache.save(realDocument());
    storage.failNextSet(CATALOG_CACHE_KEY);
    await expect(cache.save(await renamedDocument('新版本'))).rejects.toThrow(/写入失败|校验失败/u);
    const loaded = await cache.load();
    expect(loaded).toBeDefined();
    const first = loaded?.catalog.content.cards[0];
    expect(first?.nameZh).not.toBe('新版本');
  });

  it('当前槽损坏时回退备份槽，并尽力恢复当前槽', async () => {
    const oldDocument = realDocument();
    const storage = createMemoryCatalogStorage({
      [CATALOG_CACHE_BACKUP_KEY]: JSON.stringify(oldDocument),
      [CATALOG_CACHE_KEY]: '{ 这不是 JSON',
    });
    const cache = createCatalogCache(storage);
    const loaded = await cache.load();
    expect(loaded).toBeDefined();
    expect(loaded?.catalog.content.cards).toHaveLength(47);
    // 恢复后当前槽再次可读。
    const again = await cache.load();
    expect(again).toBeDefined();
  });

  it('两份都损坏时视为无缓存，而不是返回半份数据', async () => {
    const storage = createMemoryCatalogStorage({
      [CATALOG_CACHE_BACKUP_KEY]: '{"schema":"ptcg.catalog/v1"}',
      [CATALOG_CACHE_KEY]: 'null',
    });
    const cache = createCatalogCache(storage);
    expect(await cache.load()).toBeUndefined();
  });

  it('版本与内容不一致的缓存视为损坏，不得冒充完整缓存', async () => {
    const document = realDocument();
    document['catalogVersion'] = 'f'.repeat(64);
    const storage = createMemoryCatalogStorage({
      [CATALOG_CACHE_KEY]: JSON.stringify(document),
      [CATALOG_CACHE_BACKUP_KEY]: JSON.stringify(realDocument()),
    });
    const cache = createCatalogCache(storage);
    const loaded = await cache.load();
    expect(loaded).toBeDefined();
    // 回退到备份槽（真实的 catalogVersion）。
    expect(loaded?.catalog.catalogVersion).not.toBe('f'.repeat(64));
  });

  it('结构合法但版本与内容不一致的写入在触碰槽位前被拒绝', async () => {
    const storage = createMemoryCatalogStorage();
    const cache = createCatalogCache(storage);
    await cache.save(realDocument());
    await cache.save(await renamedDocument('第二版'));
    const currentBefore = await storage.get(CATALOG_CACHE_KEY);
    const backupBefore = await storage.get(CATALOG_CACHE_BACKUP_KEY);

    // 内容为新版本、但 catalogVersion 仍是上一版的哈希：结构可解析，内容不可信。
    const tampered = await renamedDocument('被篡改');
    const staleVersion = (JSON.parse(currentBefore ?? '{}') as Record<string, unknown>)['catalogVersion'];
    tampered['catalogVersion'] = staleVersion;
    await expect(cache.save(tampered)).rejects.toThrow(/版本与内容不一致/u);

    // 当前槽与备份槽都没有被这次失败写入影响。
    expect(await storage.get(CATALOG_CACHE_KEY)).toBe(currentBefore);
    expect(await storage.get(CATALOG_CACHE_BACKUP_KEY)).toBe(backupBefore);
    const loaded = await cache.load();
    expect(loaded?.catalog.content.cards[0]?.nameZh).toBe('第二版');
  });

  it('成功写入新版本后备份槽保留上一版本，当前槽为新版本', async () => {
    const storage = createMemoryCatalogStorage();
    const cache = createCatalogCache(storage);
    await cache.save(realDocument());
    await cache.save(await renamedDocument('第二版'));
    const loaded = await cache.load();
    expect(loaded?.catalog.content.cards[0]?.nameZh).toBe('第二版');
    const backup = JSON.parse((await storage.get(CATALOG_CACHE_BACKUP_KEY)) ?? 'null') as Record<string, unknown>;
    const backupCards = backup['cards'] as Array<Record<string, unknown>>;
    expect((backupCards[0] as Record<string, unknown>)['nameZh']).not.toBe('第二版');
    expect(storage.keys()).toEqual(expect.arrayContaining([CATALOG_CACHE_KEY, CATALOG_CACHE_BACKUP_KEY]));
  });
});
