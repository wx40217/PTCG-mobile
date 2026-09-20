import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  exportDeckText,
  validateDeck,
  type ConnectResult,
  type ConnectionClosedEvent,
  type DeckDocument,
  type DeckValidationResponse,
  type LiveConnection,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';
import { App } from '../src/App.tsx';
import type { ConnectFn } from '../src/connection/connection.ts';
import { CATALOG_CACHE_KEY, createCatalogCache, createMemoryCatalogStorage, type MemoryCatalogStorage } from '../src/catalog/cache.ts';
import type { CatalogSource } from '../src/catalog/source.ts';
import { createDraft, createMemoryDeckDraftStore, type DeckDraft, type DeckDraftStore } from '../src/decks/draftStore.ts';
import type { DeckValidatorSource } from '../src/decks/validatorSource.ts';
import { catalogDocumentWithRuntime, createFakeCatalogSource, type FakeCatalogSource } from './catalogHelpers.ts';
import { deckDocumentOf, realCatalog } from './deckHelpers.ts';

const DEV_POLICY: ServiceAddressPolicy = { allowInsecure: true };
const catalog = realCatalog();

function fakeConnection(nickname: string, deviceId: string): {
  readonly connection: LiveConnection;
  readonly emitClosed: (event?: ConnectionClosedEvent) => void;
} {
  const listeners = new Set<(event: ConnectionClosedEvent) => void>();
  let closed = false;
  const connection: LiveConnection = {
    session: {
      protocolVersion: 1,
      serverVersion: '0.1.0',
      sessionId: 'session-1',
      deviceId,
      nickname,
      registered: true,
    },
    get closed() {
      return closed;
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
    emitClosed(event = { kind: 'disconnected' }) {
      closed = true;
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

interface RenderOptions {
  readonly source?: FakeCatalogSource | CatalogSource;
  readonly storage?: MemoryCatalogStorage;
  readonly deckStore?: DeckDraftStore;
  readonly validator?: DeckValidatorSource;
  readonly connect?: ConnectFn;
  readonly defaultServiceAddress?: string;
}

async function renderApp(options: RenderOptions = {}) {
  let latest: ReturnType<typeof fakeConnection> | undefined;
  const connect: ConnectFn =
    options.connect ??
    (async (input): Promise<ConnectResult> => {
      latest = fakeConnection('小智', input.identity.deviceId);
      return { ok: true, connection: latest.connection };
    });
  const storage = options.storage ?? createMemoryCatalogStorage();
  const source = options.source ?? createFakeCatalogSource(() => catalogDocumentWithRuntime());
  const deckStore = options.deckStore ?? createMemoryDeckDraftStore();
  const view = render(
    <App
      dependencies={{
        store: {
          read: async () => ({ nickname: '', serviceAddress: '' }),
          write: async () => undefined,
        },
        connect,
        policy: DEV_POLICY,
        defaultServiceAddress: options.defaultServiceAddress ?? 'http://127.0.0.1:8787',
        createCatalogSource: () => source,
        catalogCache: createCatalogCache(storage),
        deckStore,
        ...(options.validator === undefined
          ? {}
          : { createDeckValidator: () => options.validator as DeckValidatorSource }),
      }}
    />,
  );
  await screen.findByLabelText('昵称（仅用于显示）');
  return { storage, source, deckStore, emitClosed: () => latest?.emitClosed(), unmount: () => view.unmount() };
}

async function connect(user: ReturnType<typeof userEvent.setup>, nickname = '小智') {
  await user.type(screen.getByLabelText('昵称（仅用于显示）'), nickname);
  await user.click(screen.getByRole('button', { name: '保存并连接' }));
  await screen.findByTestId('open-decks');
}

async function openDecks(user: ReturnType<typeof userEvent.setup>) {
  await connect(user);
  await user.click(screen.getByTestId('open-decks'));
  await screen.findByTestId('preset-card-A');
  await screen.findByTestId('decks-drafts-ready');
}

async function copyPresetA(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('preset-copy-A'));
  await screen.findByTestId('deck-name');
}

describe('预设卡组：预览、复制与未就绪状态', () => {
  it('列出四套预设，效果未接入时明确未就绪；预览逐张显示，复制后仍是同一校验结果', async () => {
    const user = userEvent.setup();
    await renderApp();
    await openDecks(user);

    expect(screen.getAllByTestId(/^preset-card-/u)).toHaveLength(4);
    for (const code of ['A', 'B', 'C', 'D']) {
      expect(screen.getByTestId(`preset-readiness-${code}`)).toHaveTextContent('效果未接入');
      expect(screen.getByTestId(`preset-readiness-${code}`)).not.toHaveTextContent('可以正式对战');
    }

    await user.click(screen.getByTestId('preset-preview-A'));
    expect(await screen.findByTestId('preset-title')).toHaveTextContent('仙子伊布VMAX');
    expect(screen.getByTestId('preset-count-csve1-062')).toHaveTextContent('×4');
    expect(screen.getByTestId('preset-entry-csve1-056')).toHaveTextContent('梦幻ex');
    expect(screen.getByTestId('preset-summary')).toHaveTextContent('效果未接入');
    expect(screen.getByTestId('preset-total')).toHaveTextContent('共 60 张');

    await user.click(screen.getByTestId('preset-copy'));
    expect(await screen.findByTestId('deck-name')).toHaveValue('仙子伊布VMAX 和弦进化');
    expect(screen.getByTestId('deck-total')).toHaveTextContent('共 60 张');
    expect(screen.getByTestId('deck-offline-summary')).toHaveTextContent('效果未接入');
  });
});

describe('草稿编辑与持久化', () => {
  it('延迟读取草稿期间禁止新建/复制且不产生写入，读取完成后已有草稿不被覆盖', async () => {
    const user = userEvent.setup();
    const existing = createDraft({ name: '已有草稿', document: deckDocumentOf('A', catalog), id: 'existing-draft' });
    let releaseRead: (() => void) | undefined;
    const writes: DeckDraft[][] = [];
    const deckStore: DeckDraftStore = {
      read: () =>
        new Promise<DeckDraft[]>((resolve) => {
          releaseRead = () => resolve([existing]);
        }),
      write: async (drafts) => {
        writes.push(drafts.map((draft) => ({ ...draft })));
      },
    };
    await renderApp({ deckStore });
    await connect(user);
    await user.click(screen.getByTestId('open-decks'));
    await screen.findByTestId('preset-card-A');

    expect(screen.getByTestId('decks-loading')).toBeInTheDocument();
    expect(screen.getByTestId('create-blank-draft')).toBeDisabled();
    expect(screen.getByTestId('preset-copy-A')).toBeDisabled();
    await user.click(screen.getByTestId('create-blank-draft'));
    await user.click(screen.getByTestId('preset-copy-A'));
    expect(writes).toHaveLength(0);
    expect(screen.queryByTestId('deck-name')).not.toBeInTheDocument();

    releaseRead?.();
    await screen.findByTestId('decks-drafts-ready');
    expect(await screen.findByTestId('draft-item-existing-draft')).toBeInTheDocument();
    expect(writes).toHaveLength(0);

    await user.click(screen.getByTestId('create-blank-draft'));
    await screen.findByTestId('deck-name');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.map((draft) => draft.id)).toContain('existing-draft');
    expect(writes[0]!).toHaveLength(2);
  });

  it('读取失败显示可恢复错误并暂停写入；重试成功后基于已读草稿编辑，不覆盖已有数据', async () => {
    const user = userEvent.setup();
    const existing = createDraft({ name: '已有草稿', document: deckDocumentOf('A', catalog), id: 'existing-draft' });
    let attempts = 0;
    const writes: DeckDraft[][] = [];
    const deckStore: DeckDraftStore = {
      async read() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('storage unavailable');
        }
        return [existing];
      },
      async write(drafts) {
        writes.push(drafts.map((draft) => ({ ...draft })));
      },
    };
    await renderApp({ deckStore });
    await connect(user);
    await user.click(screen.getByTestId('open-decks'));
    await screen.findByTestId('preset-card-A');

    expect(await screen.findByTestId('decks-read-error')).toHaveTextContent('无法读取本机卡组草稿');
    expect(screen.queryByTestId('decks-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('create-blank-draft')).toBeDisabled();
    await user.click(screen.getByTestId('preset-copy-A'));
    expect(writes).toHaveLength(0);

    await user.click(screen.getByTestId('decks-retry'));
    await screen.findByTestId('decks-drafts-ready');
    expect(await screen.findByTestId('draft-item-existing-draft')).toBeInTheDocument();
    expect(writes).toHaveLength(0);

    await user.click(screen.getByTestId('draft-open-existing-draft'));
    await screen.findByTestId('deck-name');
    await user.type(screen.getByTestId('deck-card-search'), '古剑豹');
    await user.click(await screen.findByTestId('deck-add-csv3c-043'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!).toHaveLength(1);
    expect(writes[0]![0]!.id).toBe('existing-draft');
    expect(writes[0]![0]!.document.cards.some((entry) => entry.cardId === 'csv3c-043')).toBe(true);
  });

  it('重命名、增减数量与从缓存卡池加卡立即落盘，应用重启后恢复', async () => {
    const user = userEvent.setup();
    const deckStore = createMemoryDeckDraftStore();
    const first = await renderApp({ deckStore });
    await openDecks(user);

    await user.click(screen.getByTestId('create-blank-draft'));
    const nameInput = await screen.findByTestId('deck-name');
    await user.clear(nameInput);
    await user.type(nameInput, '离线测试卡组');
    expect(screen.getByTestId('deck-empty')).toBeInTheDocument();

    await user.type(screen.getByTestId('deck-card-search'), '古剑豹');
    await user.click(await screen.findByTestId('deck-add-csv3c-043'));
    await user.click(screen.getByTestId('deck-entry-inc-csv3c-043'));
    expect(screen.getByTestId('deck-entry-count-csv3c-043')).toHaveTextContent('2');
    expect(screen.getByTestId('deck-total')).toHaveTextContent('共 2 张');

    const saved = await waitFor(async () => {
      const list = await deckStore.read();
      expect(list).toHaveLength(1);
      return list;
    });
    expect(saved[0]!.name).toBe('离线测试卡组');
    expect(saved[0]!.document.cards).toEqual([
      {
        cardId: 'csv3c-043',
        printIdentity: 'print:CSV3C:043/130',
        effectIdentity: 'fx:pokemon:古剑豹ex:47bdd73235a0',
        count: 2,
      },
    ]);

    first.unmount();
    const second = await renderApp({ deckStore });
    const secondUser = userEvent.setup();
    await openDecks(secondUser);
    expect(await screen.findByText('离线测试卡组')).toBeInTheDocument();
    await secondUser.click(screen.getByTestId(`draft-open-${saved[0]!.id}`));
    expect(await screen.findByTestId('deck-name')).toHaveValue('离线测试卡组');
    expect(screen.getByTestId('deck-entry-count-csv3c-043')).toHaveTextContent('2');
    second.unmount();
  });
});

describe('离线缓存校验与服务端当前校验', () => {
  it('无连接时使用本机缓存校验并注明目录版本；服务端入口在未配置地址时不可用', async () => {
    const user = userEvent.setup();
    const { document, catalog: cachedCatalog } = catalogDocumentWithRuntime();
    const storage = createMemoryCatalogStorage({ [CATALOG_CACHE_KEY]: JSON.stringify(document) });
    const source = createFakeCatalogSource(() => ({ document, catalog: cachedCatalog }));
    source.failNext('服务未启动');
    await renderApp({ storage, source, defaultServiceAddress: '' });

    await user.click(await screen.findByTestId('open-offline-decks'));
    await screen.findByTestId('preset-card-A');
    expect(screen.getByTestId('decks-revision')).toHaveTextContent('目录版本');
    await user.click(screen.getByTestId('preset-copy-A'));
    await screen.findByTestId('deck-name');

    expect(screen.getByTestId('deck-offline-summary')).toHaveTextContent('效果未接入');
    expect(screen.getByTestId('deck-offline-revision')).toHaveTextContent('依据本机缓存');
    expect(screen.getByTestId('deck-offline-revision')).toHaveTextContent(new RegExp(`目录版本 [0-9a-f]{12}`, 'u'));
    expect(screen.getByTestId('deck-server-unavailable')).toBeInTheDocument();
  });

  it('服务端校验显示服务端版本与就绪状态；修改卡组后旧结果失效，重新校验提交最新内容', async () => {
    const user = userEvent.setup();
    const offline = validateDeck(deckDocumentOf('A', catalog), {
      content: catalog.content,
      catalogVersion: catalog.catalogVersion,
    });
    const serverResponse: DeckValidationResponse = {
      ...offline,
      catalogVersion: 'f'.repeat(64),
      dataRevision: 'e'.repeat(64),
      legal: true,
      ready: true,
      problems: [],
    };
    let lastDeck: DeckDocument | undefined;
    const validator: DeckValidatorSource = {
      available: true,
      async validate(deck) {
        lastDeck = deck;
        return { ok: true, response: serverResponse };
      },
    };
    await renderApp({ validator });
    await openDecks(user);
    await copyPresetA(user);

    await user.click(screen.getByTestId('deck-server-validate'));
    expect(await screen.findByTestId('deck-server-summary')).toHaveTextContent('可以正式对战');
    expect(screen.getByTestId('deck-server-revision')).toHaveTextContent('服务端：环境');
    expect(screen.getByTestId('deck-server-revision')).toHaveTextContent('ffffffffffff');
    expect(screen.getByTestId('deck-server-stale')).toBeInTheDocument();

    await user.click(screen.getByTestId('deck-entry-inc-csve1-062'));
    expect(screen.queryByTestId('deck-server-summary')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('deck-server-validate'));
    await screen.findByTestId('deck-server-summary');
    await waitFor(() => {
      expect(lastDeck?.cards.find((entry) => entry.cardId === 'csve1-062')?.count).toBe(5);
    });
  });
});

describe('文本导入导出', () => {
  it('旧环境草稿导入当前文档时整体替换为导入文档的环境与卡牌，不留下混合语义', async () => {
    const user = userEvent.setup();
    const oldDocument: DeckDocument = { ...deckDocumentOf('A', catalog), environmentId: 'zh-cn-standard-2020-01-01' };
    const oldDraft = createDraft({ name: '旧环境草稿', document: oldDocument, id: 'old-env-draft' });
    const deckStore = createMemoryDeckDraftStore([oldDraft]);
    await renderApp({ deckStore });
    await openDecks(user);

    await user.click(screen.getByTestId('draft-open-old-env-draft'));
    expect(await screen.findByTestId('deck-total')).toHaveTextContent('zh-cn-standard-2020-01-01');

    const currentText = exportDeckText(deckDocumentOf('B', catalog), catalog);
    fireEvent.change(screen.getByTestId('deck-import-text'), { target: { value: currentText } });
    await user.click(screen.getByTestId('deck-import'));
    expect(await screen.findByTestId('deck-notice')).toHaveTextContent('已导入');
    expect(screen.getByTestId('deck-total')).toHaveTextContent(catalog.content.environment.id);
    expect(screen.getByTestId('deck-entry-csv3c-043')).toBeInTheDocument();

    await waitFor(async () => {
      const saved = await deckStore.read();
      expect(saved).toHaveLength(1);
      expect(saved[0]!.document.environmentId).toBe(catalog.content.environment.id);
      expect(saved[0]!.document.cards.some((entry) => entry.cardId === 'csv3c-043')).toBe(true);
    });
  });

  it('导入失败保留原卡组；成功后整体替换，导出文本带版本、环境与精确身份', async () => {
    const user = userEvent.setup();
    await renderApp();
    await openDecks(user);
    await copyPresetA(user);

    const importArea = screen.getByTestId('deck-import-text') as HTMLTextAreaElement;
    fireEvent.change(importArea, { target: { value: 'PTCG-DECK/1\nENV wrong-environment\n4 不存在卡牌' } });
    await user.click(screen.getByTestId('deck-import'));
    expect(await screen.findByTestId('deck-import-errors')).toBeInTheDocument();
    expect(screen.getByTestId('deck-total')).toHaveTextContent('共 60 张');
    expect(screen.getByTestId('deck-entry-count-csve1-062')).toHaveTextContent('4');

    const energy = catalog.content.cards.find((card) => card.effectiveCategory === '基本能量')!;
    const energyLine = `60 ${energy.id} ${energy.identities.printIdentity} ${energy.identities.effectIdentity}`;
    fireEvent.change(importArea, {
      target: { value: `PTCG-DECK/1\nENV ${catalog.content.environment.id}\n${energyLine}\n${energyLine}` },
    });
    await user.click(screen.getByTestId('deck-import'));
    expect(await screen.findByTestId('deck-import-errors')).toHaveTextContent('超过单条目上限');
    expect(screen.getByTestId('deck-total')).toHaveTextContent('共 60 张');
    expect(screen.getByTestId('deck-entry-count-csve1-062')).toHaveTextContent('4');

    await user.click(screen.getByTestId('deck-export'));
    const exportArea = (await screen.findByTestId('deck-export-text')) as HTMLTextAreaElement;
    expect(exportArea.value).toContain('PTCG-DECK/1');
    expect(exportArea.value).toContain(`ENV ${catalog.content.environment.id}`);
    expect(exportArea.value).toContain('print:CSVE1C:062');
    expect(exportArea.value).toContain('fx:pokemon:仙子伊布V:82add47b1578');

    const deckB = exportDeckText(deckDocumentOf('B', catalog), catalog);
    fireEvent.change(importArea, { target: { value: deckB } });
    await user.click(screen.getByTestId('deck-import'));
    expect(await screen.findByTestId('deck-notice')).toHaveTextContent('已导入');
    expect(screen.getByTestId('deck-entry-csv3c-043')).toBeInTheDocument();
    expect(screen.queryByTestId('deck-entry-csve1-062')).not.toBeInTheDocument();
    expect(screen.getByTestId('deck-total')).toHaveTextContent('共 60 张');
  });
});
