import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeCatalogVersion, parseServiceCatalog, sha256, type ConnectResult, type ConnectionClosedEvent, type LiveConnection, type ServiceAddressPolicy } from '@ptcg/protocol';
import { App } from '../src/App.tsx';
import type { ConnectFn } from '../src/connection/connection.ts';
import {
  CATALOG_CACHE_BACKUP_KEY,
  CATALOG_CACHE_KEY,
  createCatalogCache,
  createMemoryCatalogStorage,
  type MemoryCatalogStorage,
} from '../src/catalog/cache.ts';
import { createHttpCatalogSource, type CatalogSource } from '../src/catalog/source.ts';
import { createImageCache, createMemoryImageCacheStorage, type ImageCache, type ImageFetchResponse } from '../src/catalog/imageCache.ts';
import { createMemoryProfileStore } from '../src/storage/profileStore.ts';
import type { BackButtonSource } from '../src/app/backButton.ts';
import type { CatalogSourceFactoryInput } from '../src/App.tsx';
import { catalogDocumentWithRuntime, createFakeCatalogSource, type FakeCatalogSource } from './catalogHelpers.ts';

const DEV_POLICY: ServiceAddressPolicy = { allowInsecure: true };

function fakeConnection(nickname: string, deviceId: string): {
  readonly connection: LiveConnection;
  readonly emitClosed: () => void;
} {
  const listeners = new Set<(event: ConnectionClosedEvent) => void>();
  let closed = false;
  const connection: LiveConnection = {
    session: {
      protocolVersion: 1,
      serverVersion: '0.1.0',
      serviceInstanceId: 'service-test',
      sessionId: 'session-1',
      deviceId,
      nickname,
      registered: true,
    },
    get closed() {
      return closed;
    },
    send() {
      /* 该测试不发送房间命令 */
    },
    onMessage() {
      return () => undefined;
    },
    onClosed(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
    },
  };
  return {
    connection,
    emitClosed() {
      closed = true;
      for (const listener of [...listeners]) {
        listener({ kind: 'disconnected' });
      }
    },
  };
}

interface RenderOptions {
  readonly source?: FakeCatalogSource;
  readonly storage?: MemoryCatalogStorage;
  readonly backButton?: BackButtonSource;
  readonly connect?: ConnectFn;
  /** 覆盖目录数据源工厂（例如接入真实 HTTP 来源 + 假 fetch）。 */
  readonly createSource?: (input: CatalogSourceFactoryInput) => CatalogSource;
  readonly imageCache?: ImageCache;
}

async function renderApp(options: RenderOptions) {
  const store = createMemoryProfileStore();
  let latest: ReturnType<typeof fakeConnection> | undefined;
  const defaultConnect: ConnectFn = async (input): Promise<ConnectResult> => {
    latest = fakeConnection('小智', input.identity.deviceId);
    return { ok: true, connection: latest.connection };
  };
  const connect = options.connect ?? defaultConnect;
  const storage = options.storage ?? createMemoryCatalogStorage();
  const source = options.source ?? createFakeCatalogSource(() => catalogDocumentWithRuntime());
  const view = render(
    <App
      dependencies={{
        store,
        connect,
        policy: DEV_POLICY,
        defaultServiceAddress: 'http://127.0.0.1:8787',
        createCatalogSource: options.createSource ?? (() => source),
        catalogCache: createCatalogCache(storage),
        imageCache: options.imageCache ?? createImageCache(createMemoryImageCacheStorage()),
        ...(options.backButton === undefined ? {} : { backButton: options.backButton }),
      }}
    />,
  );
  await screen.findByLabelText('昵称（仅用于显示）');
  return { storage, source, emitClosed: () => latest?.emitClosed(), unmount: () => view.unmount() };
}

/** 连接并进入目录（等待目录加载完成）。 */
async function openCatalog(user: ReturnType<typeof userEvent.setup>) {
  await enterCatalog(user);
  await screen.findByTestId('catalog-environment');
}

/** 只连接到首页并点击目录入口（用于验证失败/加载状态）。 */
async function enterCatalog(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('昵称（仅用于显示）'), '小智');
  await user.click(screen.getByRole('button', { name: '保存并连接' }));
  await screen.findByTestId('open-catalog');
  await user.click(screen.getByTestId('open-catalog'));
}

describe('目录首页：冻结范围与支持子集', () => {
  it('显示环境、冻结范围和已核实子集，默认列出全部 47 条且不宣传可对战', async () => {
    const user = userEvent.setup();
    await renderApp({ source: createFakeCatalogSource(() => catalogDocumentWithRuntime()) });
    await openCatalog(user);

    expect(screen.getByTestId('catalog-environment')).toHaveTextContent('简中标准赛制冻结快照 2025-06-05');
    expect(screen.getByTestId('catalog-scope')).toHaveTextContent(/不是完整标准卡池/u);
    expect(screen.getByTestId('catalog-scope')).toHaveTextContent(/47 张/u);
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');
    expect(screen.getByTestId('catalog-version')).toHaveTextContent(/来自服务/u);
    // T10 已把 7 张逐张验证的训练家卡标为已支持；其余 40 条仍必须显示“效果未接入”。
    expect(screen.getAllByText('效果已支持')).toHaveLength(7);
    expect(screen.getAllByText('效果未接入')).toHaveLength(40);
  });

  it('资源未配置时展示文字兜底说明，不声称有图', async () => {
    const user = userEvent.setup();
    await renderApp({ source: createFakeCatalogSource(() => catalogDocumentWithRuntime()) });
    await openCatalog(user);
    expect(screen.getByTestId('resource-unavailable-asar-sample-sv1-en-170')).toHaveTextContent(/未配置本机资源样本/u);
    expect(screen.getAllByText('文字卡面')).toHaveLength(47);
  });
});

describe('搜索、筛选与详情', () => {
  it('按简中名称搜索并进入详情，显示完整文字、数值与三项独立状态', async () => {
    const user = userEvent.setup();
    const { document, catalog } = catalogDocumentWithRuntime();
    await renderApp({ source: createFakeCatalogSource(() => ({ document, catalog })) });
    await openCatalog(user);

    await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), '古剑豹');
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 1 条');
    await user.click(screen.getByTestId('catalog-card-csv3c-043'));

    expect(await screen.findByTestId('card-detail-name')).toHaveTextContent('古剑豹ex');
    const source = catalog.content.cards.find((card) => card.id === 'csv3c-043');
    expect(source).toBeDefined();
    expect(screen.getByTestId('card-detail-fulltext').textContent).toBe(source!.fullTextZh);
    expect(screen.getByText('HP')).toBeInTheDocument();
    expect(screen.getByText('220')).toBeInTheDocument();
    expect(screen.getAllByText('环境合法').length).toBeGreaterThan(0);
    expect(screen.getAllByText('效果未接入').length).toBeGreaterThan(0);
    expect(screen.getByTestId('card-detail-no-image')).toHaveTextContent(/不依赖图片/u);
    expect(screen.getByText('print:CSV3C:043/130')).toBeInTheDocument();
    expect(screen.getByText('fx:pokemon:古剑豹ex:47bdd73235a0')).toBeInTheDocument();
  });

  it('按编号与类别筛选；空结果有提示且可清除筛选', async () => {
    const user = userEvent.setup();
    const { document, catalog } = catalogDocumentWithRuntime();
    await renderApp({ source: createFakeCatalogSource(() => ({ document, catalog })) });
    await openCatalog(user);

    await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), '143/177');
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 1 条');
    await user.clear(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'));

    await user.click(screen.getByRole('button', { name: '支援者' }));
    expect(screen.getByTestId('catalog-count')).not.toHaveTextContent('共 47 条');
    expect(screen.getByTestId('catalog-card-csve1-138')).toBeInTheDocument();

    await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), 'zzz不存在');
    expect(screen.getByTestId('catalog-empty')).toHaveTextContent(/没有找到匹配的卡牌/u);

    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');
  });

  it('同名不同效果的两个印刷版本都保留并可区分', async () => {
    const user = userEvent.setup();
    const fixture = catalogDocumentWithRuntime((raw) => {
      const cards = raw['cards'] as Array<Record<string, unknown>>;
      const base = cards.find((card) => card['id'] === 'csve1-035') as Record<string, unknown>;
      cards.push({
        ...base,
        id: 'csve1-035b',
        print: { ...(base['print'] as Record<string, unknown>), number: '035B' },
        identities: {
          effectIdentity: 'fx:pokemon:荧光鱼:different0000',
          printIdentity: 'print:CSVE1C:035B',
          nameGroupKey: 'name:荧光鱼',
        },
      });
    });
    expect(fixture.catalog.content.cards.some((card) => card.id === 'csve1-035b')).toBe(true);
    await renderApp({ source: createFakeCatalogSource(() => fixture) });
    await openCatalog(user);

    await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), '荧光鱼');
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 2 条');
    expect(screen.getByTestId('identity-relation-csve1-035')).toHaveTextContent(/同名不同效果/u);
    expect(screen.getByTestId('identity-relation-csve1-035b')).toHaveTextContent(/同名不同效果/u);
  });
});

describe('离线缓存与失败保护', () => {
  it('首次在线成功后写入缓存；在线失败仍可读缓存并标注版本来源', async () => {
    const user = userEvent.setup();
    const source = createFakeCatalogSource(() => catalogDocumentWithRuntime());
    const { storage } = await renderApp({ source });
    await openCatalog(user);
    await waitFor(() => {
      expect(storage.keys()).toContain('ptcg.catalog.cache.v1');
    });

    source.failNext('测试离线');
    await user.click(screen.getByRole('button', { name: '刷新目录' }));

    await screen.findByTestId('catalog-stale');
    expect(screen.getByTestId('catalog-stale')).toHaveTextContent('测试离线');
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');
    expect(screen.getByTestId('catalog-version')).toHaveTextContent(/来自本机缓存/u);
  });

  it('无缓存且读取失败时给出错误与重试，重试成功后进入目录', async () => {
    const user = userEvent.setup();
    const source = createFakeCatalogSource(() => catalogDocumentWithRuntime());
    source.failNext('服务未启动');
    await renderApp({ source });
    await enterCatalog(user);

    expect(await screen.findByTestId('catalog-error')).toHaveTextContent('服务未启动');
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('catalog-environment')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');
  });

  it('目录浏览期间连接断开：不把用户踢出缓存，首页显示断线并可返回设置', async () => {
    const user = userEvent.setup();
    const source = createFakeCatalogSource(() => catalogDocumentWithRuntime());
    const { emitClosed } = await renderApp({ source });
    await openCatalog(user);

    emitClosed();
    await waitFor(() => {
      expect(screen.getByText(/离线 · 连接已断开/u)).toBeInTheDocument();
    });
    // 仍可继续阅读缓存目录。
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');

    await user.click(screen.getByRole('button', { name: '返回首页' }));
    expect(await screen.findByTestId('home-disconnected')).toHaveTextContent(/缓存仍可离线阅读/u);
    expect(screen.getByText('连接已断开')).toBeInTheDocument();
  });
});

describe('卡图与放大', () => {
  it('配置卡图与资源样本后，列表、详情与查看器都能显示并可放大', async () => {
    const user = userEvent.setup();
    const imageBytes = Uint8Array.from({ length: 128 }, (_, index) => (index * 3) % 251);
    const digestBytes = await sha256(imageBytes);
    const digest = [...digestBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const fetchImage = vi.fn(
      async (): Promise<ImageFetchResponse> => ({
        ok: true,
        status: 200,
        headers: { get: () => String(imageBytes.length) },
        async arrayBuffer() {
          return imageBytes.buffer.slice(0) as ArrayBuffer;
        },
      }),
    );
    const fixture = catalogDocumentWithRuntime((raw) => {
      const runtime = raw['runtime'] as Record<string, Record<string, unknown>>;
      runtime['cardImages'] = {
        'csve1-035': {
          available: true,
          path: 'catalog/card-images/csve1-035',
          sha256: digest,
          labelZh: '官方商品文章图（T01 已核实）',
          provenanceZh: 'T01 哈希核实的官方商品图。',
        },
      };
      runtime['resources'] = {
        'asar-sample-sv1-en-170': {
          available: true,
          path: 'catalog/resources/asar-sample-sv1-en-170',
          sha256: digest,
          labelZh: 'T01 真实资源样本',
          provenanceZh: '从本机卡图资源包有界导出。',
        },
      };
    });
    await renderApp({
      source: createFakeCatalogSource(() => fixture),
      imageCache: createImageCache(createMemoryImageCacheStorage(), { fetchImage }),
    });
    await openCatalog(user);

    await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), '荧光鱼');
    expect(screen.getByText('卡图可用')).toBeInTheDocument();
    await user.click(screen.getByTestId('catalog-card-csve1-035'));
    await screen.findByTestId('card-detail-name');

    await user.click(await screen.findByRole('button', { name: '放大查看卡图' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('T01 哈希核实的官方商品图。');
    expect(screen.getByTestId('viewer-zoom')).toHaveTextContent('100%');
    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByTestId('viewer-zoom')).toHaveTextContent('150%');
    await user.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // 返回目录后点击加载资源样本，再打开查看器。
    await user.click(screen.getByTestId('card-detail-back'));
    await user.click(await screen.findByTestId('resource-load-asar-sample-sv1-en-170'));
    await user.click(await screen.findByRole('button', { name: '查看资源样本（可放大）' }));
    const sampleDialog = await screen.findByRole('dialog');
    expect(sampleDialog).toHaveTextContent(/有界导出/u);
  });
});

describe('返回键与长文本', () => {
  it('返回键逐级从详情到目录再到首页', async () => {
    const user = userEvent.setup();
    let handler: (() => void) | undefined;
    const backButton: BackButtonSource = {
      subscribe(next) {
        handler = next;
        return () => {
          handler = undefined;
        };
      },
    };
    const { document, catalog } = catalogDocumentWithRuntime();
    await renderApp({ source: createFakeCatalogSource(() => ({ document, catalog })), backButton });
    await openCatalog(user);
    await user.click(screen.getByTestId('catalog-card-csv3c-043'));
    await screen.findByTestId('card-detail-name');

    handler?.();
    await waitFor(() => expect(screen.getByTestId('catalog-environment')).toBeInTheDocument());
    handler?.();
    await waitFor(() => expect(screen.getByTestId('open-catalog')).toBeInTheDocument());
  });

  it('超长效果文字完整渲染，宽字符与换行都不截断', async () => {
    const user = userEvent.setup();
    const longTail = '这是一段用于验证长文本完整显示的追加文字。'.repeat(40);
    const fixture = catalogDocumentWithRuntime((raw) => {
      const cards = raw['cards'] as Array<Record<string, unknown>>;
      const target = cards.find((card) => card['id'] === 'csve1-063') as Record<string, unknown>;
      target['fullTextZh'] = `${String(target['fullTextZh'])}\n${longTail}`;
    });
    await renderApp({ source: createFakeCatalogSource(() => fixture) });
    await openCatalog(user);
    await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), '仙子伊布VMAX');
    await user.click(screen.getByTestId('catalog-card-csve1-063'));
    await screen.findByTestId('card-detail-name');
    expect(screen.getByTestId('card-detail-fulltext')).toHaveTextContent(longTail);
  });
});

/** 生成一份「内容已变、版本也随之更新」的合法夹具（模拟服务端新版本）。 */
async function renamedFixture(name: string) {
  const base = catalogDocumentWithRuntime();
  const cards = base.document['cards'] as Array<Record<string, unknown>>;
  (cards[0] as Record<string, unknown>)['nameZh'] = name;
  const parsed = parseServiceCatalog(base.document);
  if (parsed === null) {
    throw new Error('测试夹具无法解析');
  }
  base.document['catalogVersion'] = await computeCatalogVersion(parsed.content);
  const catalog = parseServiceCatalog(base.document);
  if (catalog === null) {
    throw new Error('测试夹具版本更新后无法解析');
  }
  return { document: base.document, catalog };
}

describe('离线冷启动入口（无联机会话）', () => {
  it('设置页在缓存校验完成后可直接进入目录，搜索与详情不依赖连接', async () => {
    const user = userEvent.setup();
    const good = catalogDocumentWithRuntime();
    const storage = createMemoryCatalogStorage({ [CATALOG_CACHE_KEY]: JSON.stringify(good.document) });
    const source = createFakeCatalogSource(() => good);
    source.failNext('服务未启动');
    const connect: ConnectFn = async () => ({ ok: false, failure: { kind: 'unreachable', message: '服务未启动' } });
    await renderApp({ source, storage, connect });

    // 缓存检查完成后才出现入口；点击不需要任何握手。
    await user.click(await screen.findByTestId('open-offline-catalog'));
    await screen.findByTestId('catalog-environment');
    expect(screen.getByText(/离线 · 未连接服务/u)).toBeInTheDocument();
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');
    expect(screen.getByTestId('catalog-version')).toHaveTextContent(/来自本机缓存/u);
    expect(await screen.findByTestId('catalog-stale')).toHaveTextContent('服务未启动');

    await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), '古剑豹');
    await user.click(screen.getByTestId('catalog-card-csv3c-043'));
    expect(await screen.findByTestId('card-detail-name')).toHaveTextContent('古剑豹ex');

    // 详情 → 目录 → 设置；离线入口不能返回不存在的首页。
    await user.click(screen.getByTestId('card-detail-back'));
    await user.click(await screen.findByRole('button', { name: '返回设置' }));
    expect(await screen.findByRole('button', { name: '保存并连接' })).toBeInTheDocument();
  });

  it('连接失败页同样提供离线入口，系统返回键回到设置而不是空白首页', async () => {
    const user = userEvent.setup();
    const good = catalogDocumentWithRuntime();
    const storage = createMemoryCatalogStorage({ [CATALOG_CACHE_KEY]: JSON.stringify(good.document) });
    const source = createFakeCatalogSource(() => good);
    source.failNext('服务未启动');
    let backHandler: (() => void) | undefined;
    const backButton: BackButtonSource = {
      subscribe(next) {
        backHandler = next;
        return () => {
          backHandler = undefined;
        };
      },
    };
    const connect: ConnectFn = async () => ({ ok: false, failure: { kind: 'unreachable', message: '服务未启动' } });
    await renderApp({ source, storage, connect, backButton });

    await user.type(screen.getByLabelText('昵称（仅用于显示）'), '小智');
    await user.click(screen.getByRole('button', { name: '保存并连接' }));
    await screen.findByTestId('failure-detail');
    await user.click(await screen.findByTestId('open-offline-catalog'));
    await screen.findByTestId('catalog-environment');
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');

    backHandler?.();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument();
    });
  });

  it('没有通过校验的完整缓存时只提示先在线加载，不提供离线入口', async () => {
    const source = createFakeCatalogSource(() => catalogDocumentWithRuntime());
    const connect: ConnectFn = async () => ({ ok: false, failure: { kind: 'unreachable', message: '服务未启动' } });
    await renderApp({ source, connect });
    expect(await screen.findByTestId('offline-catalog-none')).toBeInTheDocument();
    expect(screen.queryByTestId('open-offline-catalog')).not.toBeInTheDocument();
  });

  it('离线浏览后重新连接：在线版本替换缓存并切回「来自服务」', async () => {
    const user = userEvent.setup();
    const cached = catalogDocumentWithRuntime();
    const updated = await renamedFixture('新版本卡');
    const storage = createMemoryCatalogStorage({ [CATALOG_CACHE_KEY]: JSON.stringify(cached.document) });
    let online = false;
    const source = createFakeCatalogSource(() => (online ? updated : cached));
    source.failNext('服务未启动');
    const connect: ConnectFn = async (input) => {
      if (!online) {
        return { ok: false, failure: { kind: 'unreachable', message: '服务未启动' } };
      }
      return { ok: true, connection: fakeConnection('小智', input.identity.deviceId).connection };
    };
    await renderApp({ source, storage, connect });

    await user.click(await screen.findByTestId('open-offline-catalog'));
    await screen.findByTestId('catalog-environment');
    expect(screen.getByTestId('catalog-version')).toHaveTextContent(/来自本机缓存/u);
    await user.click(await screen.findByRole('button', { name: '返回设置' }));

    online = true;
    await user.type(screen.getByLabelText('昵称（仅用于显示）'), '小智');
    await user.click(screen.getByRole('button', { name: '保存并连接' }));
    await screen.findByTestId('open-catalog');
    await user.click(screen.getByTestId('open-catalog'));
    await screen.findByTestId('catalog-environment');
    await screen.findByText(/来自服务/u);

    await waitFor(async () => {
      const saved = JSON.parse((await storage.get(CATALOG_CACHE_KEY)) ?? 'null') as Record<string, unknown>;
      expect(saved['catalogVersion']).toBe(updated.catalog.catalogVersion);
    });
  });
});

describe('运行期图片可用性在同一内容版本下也要持久化', () => {
  function runtimeFixture(available: boolean) {
    return catalogDocumentWithRuntime((raw) => {
      const runtime = raw['runtime'] as Record<string, Record<string, unknown>>;
      runtime['cardImages'] = {
        'csve1-035': {
          available,
          path: available ? 'catalog/card-images/csve1-035' : null,
          sha256: 'a'.repeat(64),
          labelZh: '官方商品图',
          provenanceZh: '测试',
        },
      };
    });
  }

  it('图片不可用→可用会被写入缓存且不改内容版本；可用→不可用同样被替换', async () => {
    const user = userEvent.setup();
    const unavailable = runtimeFixture(false);
    const available = runtimeFixture(true);
    expect(available.catalog.catalogVersion).toBe(unavailable.catalog.catalogVersion);
    expect(available.catalog.runtime.cardImages['csve1-035']?.available).toBe(true);
    expect(unavailable.catalog.runtime.cardImages['csve1-035']?.available).toBe(false);

    let current = available;
    const source = createFakeCatalogSource(() => current);
    const storage = createMemoryCatalogStorage({ [CATALOG_CACHE_KEY]: JSON.stringify(unavailable.document) });
    await renderApp({ source, storage });
    await enterCatalog(user);
    await screen.findByTestId('catalog-environment');
    await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), '荧光鱼');
    expect(await screen.findByText('卡图可用')).toBeInTheDocument();
    await waitFor(async () => {
      const saved = JSON.parse((await storage.get(CATALOG_CACHE_KEY)) ?? 'null') as Record<string, unknown>;
      const runtime = saved['runtime'] as Record<string, Record<string, { available?: boolean }>> | undefined;
      expect(runtime?.cardImages?.['csve1-035']?.available).toBe(true);
      expect(saved['catalogVersion']).toBe(unavailable.catalog.catalogVersion);
    });

    // 反向：服务端图片被移除时，缓存与界面不得继续声称卡图可用。
    current = unavailable;
    await user.clear(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'));
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await waitFor(async () => {
      const saved = JSON.parse((await storage.get(CATALOG_CACHE_KEY)) ?? 'null') as Record<string, unknown>;
      const runtime = saved['runtime'] as Record<string, Record<string, { available?: boolean }>> | undefined;
      expect(runtime?.cardImages?.['csve1-035']?.available).toBe(false);
    });
    await waitFor(() => {
      expect(screen.getAllByText('文字卡面').length).toBeGreaterThan(0);
    });
  });
});

describe('在线信任边界（真实来源 + 假 fetch）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('结构合法但哈希陈旧的服务响应不替换当前/备份缓存与界面，冷启动仍读最后一份完整缓存', async () => {
    const user = userEvent.setup();
    const good = catalogDocumentWithRuntime();
    const storage = createMemoryCatalogStorage();
    const cache = createCatalogCache(storage);
    await cache.save(good.document);
    await cache.save(good.document);
    const currentBefore = await storage.get(CATALOG_CACHE_KEY);
    const backupBefore = await storage.get(CATALOG_CACHE_BACKUP_KEY);
    expect(backupBefore).not.toBeNull();

    const tampered = JSON.parse(JSON.stringify(good.document)) as Record<string, unknown>;
    tampered['catalogVersion'] = 'f'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => tampered })),
    );

    const app = await renderApp({
      storage,
      createSource: (input) => createHttpCatalogSource({ ...input, timeoutMs: 3000 }),
    });
    await enterCatalog(user);
    expect(await screen.findByTestId('catalog-stale')).toHaveTextContent(/版本与内容不一致/u);
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');
    expect(screen.getByTestId('catalog-version')).toHaveTextContent(/来自本机缓存/u);
    expect(await storage.get(CATALOG_CACHE_KEY)).toBe(currentBefore);
    expect(await storage.get(CATALOG_CACHE_BACKUP_KEY)).toBe(backupBefore);
    app.unmount();

    // 冷启动且服务不可达：仍显示同一份最后完整缓存。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const connect: ConnectFn = async () => ({ ok: false, failure: { kind: 'unreachable', message: '服务未启动' } });
    await renderApp({ storage, connect, createSource: (input) => createHttpCatalogSource({ ...input, timeoutMs: 3000 }) });
    await user.click(await screen.findByTestId('open-offline-catalog'));
    await screen.findByTestId('catalog-environment');
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('共 47 条');
    expect(screen.getByTestId('catalog-version')).toHaveTextContent(/来自本机缓存/u);
  });
});
