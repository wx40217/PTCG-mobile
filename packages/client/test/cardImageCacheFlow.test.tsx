import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  sha256,
  type ConnectResult,
  type ConnectionClosedEvent,
  type LiveConnection,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';
import { App } from '../src/App.tsx';
import type { ConnectFn } from '../src/connection/connection.ts';
import { CATALOG_CACHE_KEY, createCatalogCache, createMemoryCatalogStorage, type CatalogCache } from '../src/catalog/cache.ts';
import {
  createImageCache,
  createMemoryImageCacheStorage,
  type ImageCache,
  type ImageFetchResponse,
} from '../src/catalog/imageCache.ts';
import { IMAGE_CACHE_NAMESPACE } from '../src/catalog/imageCacheFilesystem.ts';
import { createMemoryProfileStore, type ProfileStore } from '../src/storage/profileStore.ts';
import { catalogDocumentWithRuntime, createFakeCatalogSource, type FakeCatalogSource } from './catalogHelpers.ts';

/**
 * 按需卡图缓存的界面行为：
 *   - 打开详情才下载；目录列表不预取；
 *   - 断网/失败时显示已缓存旧图并保留完整文字；
 *   - 设置页展示占用并可清除，清除不影响身份；
 *   - 缓存按目录声明的哈希更新，失败保留旧版本。
 */

const DEV_POLICY: ServiceAddressPolicy = { allowInsecure: true };

function fakeConnection(nickname: string, deviceId: string): LiveConnection {
  const listeners = new Set<(event: ConnectionClosedEvent) => void>();
  return {
    session: { protocolVersion: 1, serverVersion: '0.1.0', sessionId: 'session-1', deviceId, nickname, registered: true },
    closed: false,
    onClosed(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      /* 测试连接无需释放资源 */
    },
  };
}

const IMAGE_BYTES_A = Uint8Array.from({ length: 256 }, (_, index) => index % 251);
const IMAGE_BYTES_B = Uint8Array.from({ length: 300 }, (_, index) => (index + 7) % 241);

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

function fixtureWithCardImage(sha256: string) {
  return catalogDocumentWithRuntime((raw) => {
    const runtime = raw['runtime'] as Record<string, Record<string, unknown>>;
    runtime['cardImages'] = {
      'csve1-035': {
        available: true,
        path: 'catalog/card-images/csve1-035',
        sha256,
        labelZh: '官方商品文章图（测试）',
        provenanceZh: 'T01 哈希核实的测试卡图。',
      },
    };
    runtime['resources'] = {
      'asar-sample-sv1-en-170': {
        available: true,
        path: 'catalog/resources/asar-sample-sv1-en-170',
        sha256,
        labelZh: 'T01 测试资源样本',
        provenanceZh: '从本机资源包有界导出的测试样本。',
      },
    };
  });
}

interface RenderOptions {
  readonly source: FakeCatalogSource;
  readonly imageCache: ImageCache;
  readonly store?: ProfileStore;
  readonly catalogCache?: CatalogCache;
}

async function renderApp(options: RenderOptions) {
  const store = options.store ?? createMemoryProfileStore();
  const connect: ConnectFn = async (input): Promise<ConnectResult> => ({
    ok: true,
    connection: fakeConnection('小智', input.identity.deviceId),
  });
  const view = render(
    <App
      dependencies={{
        store,
        connect,
        policy: DEV_POLICY,
        defaultServiceAddress: 'http://127.0.0.1:8787',
        createCatalogSource: () => options.source,
        imageCache: options.imageCache,
        ...(options.catalogCache === undefined ? {} : { catalogCache: options.catalogCache }),
      }}
    />,
  );
  await screen.findByLabelText('昵称（仅用于显示）');
  return { store, unmount: () => view.unmount() };
}

async function connectAndOpenCatalog(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('昵称（仅用于显示）'), '小智');
  await user.click(screen.getByRole('button', { name: '保存并连接' }));
  await screen.findByTestId('open-catalog');
  await user.click(screen.getByTestId('open-catalog'));
  await screen.findByTestId('catalog-environment');
}

async function openCardDetail(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('搜索简中名称、商品/卡牌编号或类别'), '荧光鱼');
  await user.click(await screen.findByTestId('catalog-card-csve1-035'));
  await screen.findByTestId('card-detail-name');
}

describe('卡图按需缓存界面', () => {
  it('目录列表不下载；打开详情才按需下载并显示', async () => {
    const digest = await digestHex(IMAGE_BYTES_A);
    const fixture = fixtureWithCardImage(digest);
    const fetchImage = vi.fn(async () => imageResponse(IMAGE_BYTES_A));
    const storage = createMemoryImageCacheStorage();
    const imageCache = createImageCache(storage, { fetchImage });
    const source = createFakeCatalogSource(() => fixture);
    const user = userEvent.setup();
    await renderApp({ source, imageCache });

    await connectAndOpenCatalog(user);
    expect(fetchImage).not.toHaveBeenCalled();
    await openCardDetail(user);
    // 详情挂载后才发起下载；断言最终完成，避免与微任务竞态。
    await screen.findByTestId('card-image');
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('card-image').getAttribute('src')).toMatch(/^(blob:|data:image\/png)/u);
    expect(screen.getByTestId('card-detail-fulltext').textContent).toBe(
      fixture.catalog.content.cards.find((card) => card.id === 'csve1-035')!.fullTextZh,
    );
  });

  it('应用重启后离线：已缓存卡图直接显示，文字与旧图不依赖网络', async () => {
    const digest = await digestHex(IMAGE_BYTES_A);
    const fixture = fixtureWithCardImage(digest);
    const storage = createMemoryImageCacheStorage();
    const firstFetch = vi.fn(async () => imageResponse(IMAGE_BYTES_A));
    const firstCache = createImageCache(storage, { fetchImage: firstFetch });
    const first = await renderApp({ source: createFakeCatalogSource(() => fixture), imageCache: firstCache });
    await connectAndOpenCatalog(userEvent.setup());
    await openCardDetail(userEvent.setup());
    await screen.findByTestId('card-image');
    expect(firstFetch).toHaveBeenCalledTimes(1);
    first.unmount();

    // 模拟进程重启 + 断网：同一存储的新缓存实例不得发起请求。
    const offlineFetch = vi.fn(async () => {
      throw new Error('offline');
    });
    const offlineCache = createImageCache(storage, { fetchImage: offlineFetch });
    await renderApp({ source: createFakeCatalogSource(() => fixture), imageCache: offlineCache });
    await connectAndOpenCatalog(userEvent.setup());
    await openCardDetail(userEvent.setup());
    await screen.findByTestId('card-image');
    expect(offlineFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('card-detail-fulltext')).toBeInTheDocument();
  });

  it('目录哈希更新但下载失败：显示已缓存旧图、明确提示并保留重试', async () => {
    const digestA = await digestHex(IMAGE_BYTES_A);
    const digestB = await digestHex(IMAGE_BYTES_B);
    let fixture = fixtureWithCardImage(digestA);
    const storage = createMemoryImageCacheStorage();
    const fetchA = vi.fn(async () => imageResponse(IMAGE_BYTES_A));
    const first = await renderApp({
      source: createFakeCatalogSource(() => fixture),
      imageCache: createImageCache(storage, { fetchImage: fetchA }),
    });
    await connectAndOpenCatalog(userEvent.setup());
    await openCardDetail(userEvent.setup());
    await screen.findByTestId('card-image');
    first.unmount();

    // 服务端目录切换到新哈希，但图片下载返回与目录不符的字节。
    fixture = fixtureWithCardImage(digestB);
    const failingCache = createImageCache(storage, { fetchImage: async () => imageResponse(IMAGE_BYTES_A) });
    await renderApp({ source: createFakeCatalogSource(() => fixture), imageCache: failingCache });
    await connectAndOpenCatalog(userEvent.setup());
    await openCardDetail(userEvent.setup());
    await screen.findByTestId('card-image-stale');
    expect(screen.getByTestId('card-image-stale').textContent).toMatch(/更新失败/u);
    expect(screen.getByTestId('card-image')).toBeInTheDocument();
    expect(screen.getByTestId('card-detail-fulltext')).toBeInTheDocument();
    expect(screen.getByTestId('card-image-retry')).toBeInTheDocument();
  });

  it('设置页显示占用并可清除：图片缓存清空，身份/昵称与卡组命名空间不受影响', async () => {
    const digest = await digestHex(IMAGE_BYTES_A);
    const fixture = fixtureWithCardImage(digest);
    const storage = createMemoryImageCacheStorage();
    const imageCache = createImageCache(storage, { fetchImage: async () => imageResponse(IMAGE_BYTES_A) });
    const profileStore = createMemoryProfileStore();
    const user = userEvent.setup();
    await renderApp({ source: createFakeCatalogSource(() => fixture), imageCache, store: profileStore });

    await connectAndOpenCatalog(user);
    await openCardDetail(user);
    await screen.findByTestId('card-image');

    // 返回设置页（卡组编辑 #6 未接入；图片缓存使用独立命名空间，清除不得触碰其它存储）。
    await user.click(screen.getByTestId('card-detail-back'));
    await user.click(await screen.findByRole('button', { name: '返回首页' }));
    await user.click(await screen.findByRole('button', { name: '返回设置' }));
    await screen.findByTestId('image-cache-usage');
    expect(screen.getByTestId('image-cache-usage').textContent).toMatch(/已缓存 1 张图片/u);
    const deviceId = screen.getByTestId('device-id').textContent;

    await user.click(screen.getByTestId('image-cache-clear'));
    await waitFor(() => {
      expect(screen.getByTestId('image-cache-usage').textContent).toMatch(/已缓存 0 张图片/u);
    });
    expect(screen.getByTestId('image-cache-note').textContent).toMatch(/身份、昵称、地址与卡组不受影响/u);
    expect(storage.keys()).toEqual([]);
    expect((await profileStore.read()).nickname).toBe('小智');
    expect(screen.getByLabelText('昵称（仅用于显示）')).toHaveValue('小智');
    expect(screen.getByTestId('device-id').textContent).toBe(deviceId);
  });

  it('资源样本同样按需缓存：列表阶段不下载，点击后缓存并打开查看器', async () => {
    const digest = await digestHex(IMAGE_BYTES_A);
    const fixture = fixtureWithCardImage(digest);
    const storage = createMemoryImageCacheStorage();
    const fetchImage = vi.fn(async () => imageResponse(IMAGE_BYTES_A));
    const imageCache = createImageCache(storage, { fetchImage });
    const user = userEvent.setup();
    await renderApp({ source: createFakeCatalogSource(() => fixture), imageCache });

    await connectAndOpenCatalog(user);
    expect(fetchImage).not.toHaveBeenCalled();

    await user.click(await screen.findByTestId('resource-load-asar-sample-sv1-en-170'));
    await screen.findByRole('button', { name: '查看资源样本（可放大）' });
    expect(fetchImage).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '查看资源样本（可放大）' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/有界导出/u);
  });
});

describe('服务端图片配置移除后仍显示本机完整缓存', () => {
  it('离线刷新后目录不再声明卡图：详情显示本机缓存且不发起下载', async () => {
    const digest = await digestHex(IMAGE_BYTES_A);
    const storage = createMemoryImageCacheStorage();
    const first = await renderApp({
      source: createFakeCatalogSource(() => fixtureWithCardImage(digest)),
      imageCache: createImageCache(storage, { fetchImage: async () => imageResponse(IMAGE_BYTES_A) }),
    });
    await connectAndOpenCatalog(userEvent.setup());
    await openCardDetail(userEvent.setup());
    await screen.findByTestId('card-image');
    first.unmount();

    // 服务端运行期覆盖不再声明任何卡图，且这次刷新离线；本机完整缓存仍要展示。
    const withoutImages = catalogDocumentWithRuntime();
    expect(withoutImages.catalog.runtime.cardImages).toEqual({});
    const source = createFakeCatalogSource(() => withoutImages);
    source.failNext('测试离线');
    const offlineFetch = vi.fn(async () => {
      throw new Error('目录未声明卡图时不应发起下载');
    });
    await renderApp({
      source,
      imageCache: createImageCache(storage, { fetchImage: offlineFetch }),
      catalogCache: createCatalogCache(
        createMemoryCatalogStorage({ [CATALOG_CACHE_KEY]: JSON.stringify(withoutImages.document) }),
      ),
    });
    await connectAndOpenCatalog(userEvent.setup());
    await openCardDetail(userEvent.setup());

    await screen.findByTestId('card-image');
    expect(offlineFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('card-detail-fulltext')).toBeInTheDocument();
    expect(screen.queryByTestId('card-detail-no-image')).not.toBeInTheDocument();
    expect(screen.getByText('本机缓存')).toBeInTheDocument();
  });

  it('运行期声明仍在但解析不出 URL（noURL）：详情显示本机缓存且不下载', async () => {
    const digest = await digestHex(IMAGE_BYTES_A);
    const storage = createMemoryImageCacheStorage();
    const fixture = fixtureWithCardImage(digest);
    const first = await renderApp({
      source: createFakeCatalogSource(() => fixture),
      imageCache: createImageCache(storage, { fetchImage: async () => imageResponse(IMAGE_BYTES_A) }),
    });
    await connectAndOpenCatalog(userEvent.setup());
    await openCardDetail(userEvent.setup());
    await screen.findByTestId('card-image');
    first.unmount();

    const base = createFakeCatalogSource(() => fixture);
    const noUrlSource: FakeCatalogSource = { ...base, resolveAssetUrl: () => '' };
    const offlineFetch = vi.fn(async () => {
      throw new Error('URL 不可解析时不应发起下载');
    });
    await renderApp({ source: noUrlSource, imageCache: createImageCache(storage, { fetchImage: offlineFetch }) });
    await connectAndOpenCatalog(userEvent.setup());
    await openCardDetail(userEvent.setup());

    await screen.findByTestId('card-image');
    expect(offlineFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('card-detail-fulltext')).toBeInTheDocument();
  });
});

describe('图片缓存命名空间与其它存储分离', () => {
  it('缓存命名空间只位于应用私有 Data 目录，且不共享其他存储对象', async () => {
    // 图片缓存命名空间固定在应用私有数据目录；身份与后续卡组不会使用该前缀。
    expect(IMAGE_CACHE_NAMESPACE).toMatch(/^ptcg-image-cache\//u);
    const imageStorage = createMemoryImageCacheStorage();
    const otherStorage = createMemoryImageCacheStorage();
    const imageCache = createImageCache(imageStorage, { fetchImage: async () => imageResponse(IMAGE_BYTES_A) });
    await imageCache.clear();
    expect(imageStorage.keys()).toEqual([]);
    // clear 只作用于注入的图片存储实例，另一个存储对象不受影响。
    await otherStorage.write('ptcg.decks.v1', new TextEncoder().encode('decks'));
    expect(otherStorage.keys()).toEqual(['ptcg.decks.v1']);
  });
});
