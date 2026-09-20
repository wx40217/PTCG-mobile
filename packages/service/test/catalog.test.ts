import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeCatalogVersion,
  parseCatalogContent,
  parseServiceCatalog,
  type CatalogContent,
  type ServiceCatalog,
} from '@ptcg/protocol';
import { createLogger } from '../src/logger.ts';
import { defaultCatalogPath, loadCatalogStore } from '../src/catalog.ts';
import { createService, type ServiceHandle } from '../src/server.ts';

const REAL_CATALOG = JSON.parse(readFileSync(defaultCatalogPath(), 'utf8')) as Record<string, unknown>;

const temporary: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ptcg-catalog-'));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function writeCatalog(mutate: (raw: Record<string, unknown>) => void): Promise<{ readonly catalogPath: string }> {
  const raw = JSON.parse(JSON.stringify(REAL_CATALOG)) as Record<string, unknown>;
  mutate(raw);
  delete raw['catalogVersion'];
  const content = parseCatalogContent(raw);
  if (content === null) {
    throw new Error('test catalog construction failed');
  }
  const catalogVersion = await computeCatalogVersion(content);
  const dir = tempDir();
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ ...content, catalogVersion }, null, 2));
  return { catalogPath };
}

function silentLogger() {
  return createLogger(() => undefined, () => 1_700_000_000_000);
}

describe('目录装载', () => {
  it('真实产物装载成功，未配置图片目录时全部标记不可用', async () => {
    const store = await loadCatalogStore({}, silentLogger(), () => 1_700_000_000_000);
    expect(store.version).not.toBeNull();
    expect(store.problem).toBeNull();
    expect(store.cardCount).toBe(47);
    expect(store.availableResourceIds).toEqual([]);
    expect(store.availableCardImageIds).toEqual([]);
    const served = parseServiceCatalog(JSON.parse(store.servedJson() ?? 'null')) as ServiceCatalog;
    expect(served.runtime.servedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(served.runtime.resources['asar-sample-sv1-en-170']?.available).toBe(false);
    expect(served.content.cards).toHaveLength(47);
  });

  it('产物版本与内容不符时拒绝加载', async () => {
    const { catalogPath } = await writeCatalog((raw) => {
      raw['catalogVersion'] = 'f'.repeat(64);
      const cards = raw['cards'] as Array<Record<string, unknown>>;
      (cards[0] as Record<string, unknown>)['nameZh'] = '被篡改';
    });
    // writeCatalog recomputes a matching version, so overwrite it with a wrong one.
    const broken = JSON.parse(readFileSync(catalogPath, 'utf8')) as Record<string, unknown>;
    broken['catalogVersion'] = '0'.repeat(64);
    writeFileSync(catalogPath, JSON.stringify(broken));
    const store = await loadCatalogStore({ catalogPath }, silentLogger());
    expect(store.version).toBeNull();
    expect(store.problem).toMatch(/版本/u);
    expect(store.servedJson()).toBeNull();
  });

  it('产物缺失时给出可读问题而不是抛异常', async () => {
    const store = await loadCatalogStore({ catalogPath: join(tempDir(), 'missing.json') }, silentLogger());
    expect(store.version).toBeNull();
    expect(store.problem).toMatch(/无法读取/u);
  });

  it('资源样本目录配置且哈希一致时可用，读取字节与 etag 来自哈希', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const { catalogPath } = await writeCatalog((raw) => {
      const resources = raw['resources'] as Array<Record<string, unknown>>;
      resources[0] = { ...(resources[0] as Record<string, unknown>), sha256, file: 'sample.png' };
    });
    const resourceDir = tempDir();
    writeFileSync(join(resourceDir, 'sample.png'), bytes);
    const store = await loadCatalogStore({ catalogPath, resourceDir }, silentLogger());
    expect(store.availableResourceIds).toEqual(['asar-sample-sv1-en-170']);
    expect(store.readResource('asar-sample-sv1-en-170')).toEqual(bytes);
    expect(store.resourceSha256('asar-sample-sv1-en-170')).toBe(sha256);
  });

  it('哈希不一致或文件缺失时资源保持不可用，目录仍然完整', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const { catalogPath } = await writeCatalog((raw) => {
      const resources = raw['resources'] as Array<Record<string, unknown>>;
      resources[0] = { ...(resources[0] as Record<string, unknown>), sha256: 'a'.repeat(64), file: 'sample.png' };
    });
    const resourceDir = tempDir();
    writeFileSync(join(resourceDir, 'sample.png'), bytes);
    const store = await loadCatalogStore({ catalogPath, resourceDir }, silentLogger());
    expect(store.version).not.toBeNull();
    expect(store.availableResourceIds).toEqual([]);
    expect(store.readResource('asar-sample-sv1-en-170')).toBeNull();
    const served = parseServiceCatalog(JSON.parse(store.servedJson() ?? 'null')) as ServiceCatalog;
    expect(served.runtime.resources['asar-sample-sv1-en-170']?.available).toBe(false);
    expect(served.content.cards).toHaveLength(47);
  });

  it('卡图目录只提供声明了官方图来源的卡，并且校验哈希', async () => {
    const bytes = Buffer.from([9, 8, 7, 6, 5]);
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const { catalogPath } = await writeCatalog((raw) => {
      const cards = raw['cards'] as Array<Record<string, unknown>>;
      const target = cards.find((card) => card['id'] === 'csve1-035') as Record<string, unknown>;
      target['imageSource'] = { ...(target['imageSource'] as Record<string, unknown>), sha256 };
    });
    const cardImageDir = tempDir();
    writeFileSync(join(cardImageDir, 'csve1-035.png'), bytes);
    const store = await loadCatalogStore({ catalogPath, cardImageDir }, silentLogger());
    expect(store.availableCardImageIds).toEqual(['csve1-035']);
    expect(store.readCardImage('csve1-035')).toEqual(bytes);
    // 未配置文件的其他卡保持不可用。
    expect(store.readCardImage('csve1-036')).toBeNull();
    const served = parseServiceCatalog(JSON.parse(store.servedJson() ?? 'null')) as ServiceCatalog;
    expect(served.runtime.cardImages['csve1-035']?.path).toBe('catalog/card-images/csve1-035');
  });
});

describe('目录 HTTP 接口', () => {
  let service: ServiceHandle | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it('GET /catalog 返回带运行期的目录与 ETag，并支持条件请求', async () => {
    service = await createService({ host: '127.0.0.1', port: 0, logger: silentLogger() });
    const response = await fetch(new URL('catalog', service.httpUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const etag = response.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/u);
    const body = parseServiceCatalog(await response.json()) as ServiceCatalog;
    expect(body.content.cards).toHaveLength(47);
    expect(body.runtime.resources['asar-sample-sv1-en-170']?.available).toBe(false);

    const conditional = await fetch(new URL('catalog', service.httpUrl), { headers: { 'if-none-match': etag as string } });
    expect(conditional.status).toBe(304);
  });

  it('目录不可用时返回 503 且不影响健康检查', async () => {
    service = await createService({
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger(),
      catalog: { catalogPath: join(tempDir(), 'missing.json') },
    });
    const catalogResponse = await fetch(new URL('catalog', service.httpUrl));
    expect(catalogResponse.status).toBe(503);
    const health = await fetch(new URL('health', service.httpUrl));
    expect(health.status).toBe(200);
  });

  it('已配置的真实资源样本经 HTTP 返回图片字节', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const { catalogPath } = await writeCatalog((raw) => {
      const resources = raw['resources'] as Array<Record<string, unknown>>;
      resources[0] = { ...(resources[0] as Record<string, unknown>), sha256, file: 'sample.png' };
    });
    const resourceDir = tempDir();
    writeFileSync(join(resourceDir, 'sample.png'), bytes);
    service = await createService({ host: '127.0.0.1', port: 0, logger: silentLogger(), catalog: { catalogPath, resourceDir } });

    const response = await fetch(new URL('catalog/resources/asar-sample-sv1-en-170', service.httpUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    const missing = await fetch(new URL('catalog/resources/not-there', service.httpUrl));
    expect(missing.status).toBe(404);
  });

  it('卡图路径禁止穿越到目录之外', async () => {
    service = await createService({ host: '127.0.0.1', port: 0, logger: silentLogger() });
    const response = await fetch(new URL('catalog/card-images/..%2F..%2Fsecret', service.httpUrl));
    expect(response.status).toBe(404);
  });

  it('ETag 覆盖整份响应：同内容版本下运行期图片可用性变化不得被 304 掩盖', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const { catalogPath } = await writeCatalog((raw) => {
      const resources = raw['resources'] as Array<Record<string, unknown>>;
      resources[0] = { ...(resources[0] as Record<string, unknown>), sha256, file: 'sample.png' };
    });
    const resourceDir = tempDir();
    writeFileSync(join(resourceDir, 'sample.png'), bytes);

    // 同一份目录产物先以「未配置图片目录」运行，再以「配置了图片目录」运行，
    // catalogVersion（内容哈希）完全一致，只有运行期覆盖不同。
    const withoutImages = await createService({ host: '127.0.0.1', port: 0, logger: silentLogger(), catalog: { catalogPath } });
    try {
      const first = await fetch(new URL('catalog', withoutImages.httpUrl));
      const firstEtag = first.headers.get('etag') as string;
      const firstBody = (await first.json()) as ServiceCatalog;
      expect(firstBody.runtime.resources['asar-sample-sv1-en-170']?.available).toBe(false);

      const withImages = await createService({
        host: '127.0.0.1',
        port: 0,
        logger: silentLogger(),
        catalog: { catalogPath, resourceDir },
      });
      try {
        // 用旧 ETag 条件请求：绝不能 304，必须拿到带新运行期的响应。
        const conditional = await fetch(new URL('catalog', withImages.httpUrl), {
          headers: { 'if-none-match': firstEtag },
        });
        expect(conditional.status).toBe(200);
        const conditionalBody = (await conditional.json()) as ServiceCatalog;
        expect(conditionalBody.catalogVersion).toBe(firstBody.catalogVersion);
        expect(conditionalBody.runtime.resources['asar-sample-sv1-en-170']?.available).toBe(true);
        const secondEtag = conditional.headers.get('etag') as string;
        expect(secondEtag).not.toBe(firstEtag);

        // 当前 ETag 才能得到 304。
        const revalidated = await fetch(new URL('catalog', withImages.httpUrl), {
          headers: { 'if-none-match': secondEtag },
        });
        expect(revalidated.status).toBe(304);

        // 反向：已有图片的 ETag 面对未配置图片的服务同样不得 304。
        const converse = await fetch(new URL('catalog', withoutImages.httpUrl), {
          headers: { 'if-none-match': secondEtag },
        });
        expect(converse.status).toBe(200);
        const converseBody = (await converse.json()) as ServiceCatalog;
        expect(converseBody.runtime.resources['asar-sample-sv1-en-170']?.available).toBe(false);
      } finally {
        await withImages.close();
      }
    } finally {
      await withoutImages.close();
    }
  });
});

describe('目录内容契约', () => {
  it('内容可以在不解析运行期的情况下单独校验（工具产物路径）', async () => {
    const content = parseCatalogContent(REAL_CATALOG) as CatalogContent;
    expect(content.cards).toHaveLength(47);
    expect(await computeCatalogVersion(content)).toBe(REAL_CATALOG['catalogVersion']);
  });
});
