import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceAddressPolicy } from '@ptcg/protocol';
import { createHttpCatalogSource } from '../src/catalog/source.ts';
import { catalogDocumentWithRuntime } from './catalogHelpers.ts';

const DEV_POLICY: ServiceAddressPolicy = { allowInsecure: true };

/** 最小 fetch 替身：只实现来源真正读取的字段，避免依赖 jsdom 的全局 Response。 */
function stubFetchJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    })),
  );
}

describe('在线目录来源的信任边界', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('结构合法但 catalogVersion 与内容不符的响应被拒绝，并给出明确原因', async () => {
    const { document } = catalogDocumentWithRuntime();
    document['catalogVersion'] = 'f'.repeat(64);
    stubFetchJson(document);

    const source = createHttpCatalogSource({ serviceAddress: 'http://127.0.0.1:8787', policy: DEV_POLICY });
    const result = await source.fetchCatalog();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('invalid-payload');
      expect(result.message).toMatch(/版本与内容不一致/u);
    }
  });

  it('版本与内容一致的响应正常交给上层发布', async () => {
    const { document, catalog } = catalogDocumentWithRuntime();
    stubFetchJson(document);

    const source = createHttpCatalogSource({ serviceAddress: 'http://127.0.0.1:8787', policy: DEV_POLICY });
    const result = await source.fetchCatalog();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalog.catalogVersion).toBe(catalog.catalogVersion);
      expect(result.catalog.content.cards).toHaveLength(47);
    }
  });

  it('旧哈希与更新后的运行期覆盖混在一起也不得通过', async () => {
    // 攻击/故障形态：内容已更新且哈希正确，但服务错误地沿用旧的内容哈希；
    // 哈希校验必须以内容为准，而不是被运行期字段掩盖。
    const { document } = catalogDocumentWithRuntime((raw) => {
      raw['runtime'] = {
        servedAt: '2026-09-20T00:00:00.000Z',
        resources: {},
        cardImages: {},
      };
    });
    const cards = document['cards'] as Array<Record<string, unknown>>;
    (cards[0] as Record<string, unknown>)['nameZh'] = '内容已更新';
    document['catalogVersion'] = '0'.repeat(64);
    stubFetchJson(document);

    const source = createHttpCatalogSource({ serviceAddress: 'http://127.0.0.1:8787', policy: DEV_POLICY });
    const result = await source.fetchCatalog();
    expect(result.ok).toBe(false);
  });
});
