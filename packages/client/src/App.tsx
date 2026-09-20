import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  DECK_FORMAT_VERSION,
  createDeviceIdentity,
  presetDeckDocument,
  type CatalogCard,
  type ConnectedSession,
  type ConnectResult,
  type ConnectionFailure,
  type DeckDocument,
  type DeviceIdentity,
  type LiveConnection,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';
import { resolveBackAction, validateProfileInput, type AppView, type OfflineCatalogEntryState, type ProfileIssue } from './app/controller.ts';
import type { CopyText } from './app/clipboard.ts';
import { createCapacitorBackButtonSource, exitApp, type BackButtonSource } from './app/backButton.ts';
import { createDraft, createPreferencesDeckDraftStore, type DeckDraft, type DeckDraftStore } from './decks/draftStore.ts';
import { createHttpDeckValidator, type DeckValidatorSource } from './decks/validatorSource.ts';
import { createRoomController, INITIAL_ROOM_STATE, type RoomController, type RoomState } from './rooms/roomController.ts';
import { createMatchController, INITIAL_MATCH_STATE, type MatchController, type MatchState } from './rooms/matchController.ts';
import { createCatalogCache, createPreferencesCatalogCache, type CatalogCache } from './catalog/cache.ts';
import { createHttpCatalogSource, type CatalogSource } from './catalog/source.ts';
import { createImageCache, type ImageCache, type ImageCacheUsage } from './catalog/imageCache.ts';
import { createFilesystemImageCacheStorage } from './catalog/imageCacheFilesystem.ts';
import { useCatalog } from './catalog/useCatalog.ts';
import { buildConfig } from './config.ts';
import type { ConnectFn } from './connection/connection.ts';
import { loadOrCreateIdentity, type ProfileStore, type StoredProfile } from './storage/profileStore.ts';
import { CatalogScreen, type CatalogImageRequest } from './ui/CatalogScreen.tsx';
import { CardDetailScreen } from './ui/CardDetailScreen.tsx';
import { ConnectingScreen } from './ui/ConnectingScreen.tsx';
import { DeckEditorScreen } from './ui/DeckEditorScreen.tsx';
import { DecksScreen } from './ui/DecksScreen.tsx';
import { FailureScreen } from './ui/FailureScreen.tsx';
import { HomeScreen } from './ui/HomeScreen.tsx';
import { ImageViewer } from './ui/ImageViewer.tsx';
import { MatchScreen } from './ui/MatchScreen.tsx';
import { PresetDeckScreen } from './ui/PresetDeckScreen.tsx';
import { RoomScreen, roomHomeSummary } from './ui/RoomScreen.tsx';
import { SettingsScreen } from './ui/SettingsScreen.tsx';

export interface CatalogSourceFactoryInput {
  readonly serviceAddress: string;
  readonly policy: ServiceAddressPolicy;
}

export interface DeckValidatorFactoryInput {
  readonly serviceAddress: string;
  readonly policy: ServiceAddressPolicy;
}

export interface AppDependencies {
  readonly store: ProfileStore;
  readonly connect: ConnectFn;
  readonly policy: ServiceAddressPolicy;
  readonly defaultServiceAddress: string;
  readonly backButton?: BackButtonSource;
  /** 覆盖身份生成（自动化测试注入失败路径）；默认使用 WebCrypto。 */
  readonly createIdentity?: () => Promise<DeviceIdentity>;
  /** 覆盖目录数据源（测试注入假服务）；默认使用 HTTP 目录接口。 */
  readonly createCatalogSource?: (input: CatalogSourceFactoryInput) => CatalogSource;
  /** 覆盖目录缓存（测试注入内存存储）；默认使用 Capacitor Preferences。 */
  readonly catalogCache?: CatalogCache;
  /** 覆盖图片缓存（测试注入内存存储）；默认使用 Capacitor Filesystem 的应用私有目录。 */
  readonly imageCache?: ImageCache;
  /** 覆盖卡组草稿存储（测试注入内存存储）；默认使用 Capacitor Preferences。 */
  readonly deckStore?: DeckDraftStore;
  /** 覆盖服务端卡组校验数据源（测试注入假服务）；默认使用 HTTP POST。 */
  readonly createDeckValidator?: (input: DeckValidatorFactoryInput) => DeckValidatorSource;
  /** 覆盖剪贴板复制（测试注入假实现）；默认走原生插件，浏览器回退 Web Clipboard。 */
  readonly copyText?: CopyText | undefined;
}

const ADDRESS_HINT_INSECURE = '开发配置：允许局域网明文（http/ws）。';
const ADDRESS_HINT_SECURE = '正式配置：只允许 https/wss。';

export function App({ dependencies }: { dependencies: AppDependencies }): ReactElement {
  const [view, setView] = useState<AppView>('loading');
  const [nickname, setNickname] = useState('');
  const [serviceAddress, setServiceAddress] = useState(dependencies.defaultServiceAddress);
  const [identity, setIdentity] = useState<DeviceIdentity | undefined>();
  const [issue, setIssue] = useState<ProfileIssue | undefined>();
  const [identityError, setIdentityError] = useState<string | undefined>();
  const [failure, setFailure] = useState<ConnectionFailure | undefined>();
  const [session, setSession] = useState<ConnectedSession | undefined>();
  const [connectionLost, setConnectionLost] = useState(false);
  const [offlineCatalog, setOfflineCatalog] = useState<OfflineCatalogEntryState>('checking');
  const [selectedCardId, setSelectedCardId] = useState<string | undefined>();
  const [viewer, setViewer] = useState<CatalogImageRequest | undefined>();
  const [catalogReloadToken, setCatalogReloadToken] = useState(0);
  const [imageCacheUsage, setImageCacheUsage] = useState<ImageCacheUsage | undefined>();
  const [imageCacheBusy, setImageCacheBusy] = useState(false);
  const [imageCacheError, setImageCacheError] = useState<string | undefined>();
  const [imageCacheNote, setImageCacheNote] = useState<string | undefined>();
  const [drafts, setDrafts] = useState<DeckDraft[] | undefined>(undefined);
  const [draftsLoadError, setDraftsLoadError] = useState<string | undefined>();
  const [draftsReloadToken, setDraftsReloadToken] = useState(0);
  const [deckSaveError, setDeckSaveError] = useState<string | undefined>();
  const [selectedPresetCode, setSelectedPresetCode] = useState<string | undefined>();
  const [selectedDraftId, setSelectedDraftId] = useState<string | undefined>();
  const [roomState, setRoomState] = useState<RoomState>(INITIAL_ROOM_STATE);
  const [matchState, setMatchState] = useState<MatchState>(INITIAL_MATCH_STATE);
  const attempt = useRef(0);
  const connectionRef = useRef<LiveConnection | undefined>(undefined);
  const roomControllerRef = useRef<RoomController | undefined>(undefined);
  const matchControllerRef = useRef<MatchController | undefined>(undefined);
  // 断线回调需要知道“当时”所在页面：在目录/详情页断线不应把用户踢出缓存。
  const viewRef = useRef<AppView>('loading');
  viewRef.current = view;

  /** 主动释放当前连接；close() 不会触发 onClosed，因此不会误报断线。 */
  const releaseConnection = useCallback(() => {
    matchControllerRef.current?.dispose();
    matchControllerRef.current = undefined;
    roomControllerRef.current?.dispose();
    roomControllerRef.current = undefined;
    setRoomState(INITIAL_ROOM_STATE);
    setMatchState(INITIAL_MATCH_STATE);
    const connection = connectionRef.current;
    connectionRef.current = undefined;
    connection?.close();
  }, []);

  // 组件卸载（例如热重载、路由替换）时释放套接字，避免遗留连接。
  useEffect(() => {
    return () => {
      attempt.current += 1;
      releaseConnection();
    };
  }, [releaseConnection]);

  const { store, connect, policy, backButton } = dependencies;
  const createIdentity = dependencies.createIdentity ?? createDeviceIdentity;
  const deckStore = useMemo(
    () => dependencies.deckStore ?? createPreferencesDeckDraftStore(),
    [dependencies.deckStore],
  );
  const createDeckValidator = dependencies.createDeckValidator ?? createHttpDeckValidator;
  const catalogFactoryRef = useRef(dependencies.createCatalogSource ?? createHttpCatalogSource);
  const createCatalogSource = catalogFactoryRef.current;
  const catalogCache = useMemo(
    () => dependencies.catalogCache ?? createPreferencesCatalogCache(),
    [dependencies.catalogCache],
  );
  const imageCache = useMemo(
    () => dependencies.imageCache ?? createImageCache(createFilesystemImageCacheStorage()),
    [dependencies.imageCache],
  );

  // 设置页显示图片缓存占用；进入设置时重新统计，确保清除/新增后显示真实值。
  useEffect(() => {
    if (view !== 'settings') {
      return;
    }
    let cancelled = false;
    setImageCacheError(undefined);
    void (async () => {
      try {
        const usage = await imageCache.usage();
        if (!cancelled) {
          setImageCacheUsage(usage);
        }
      } catch {
        if (!cancelled) {
          setImageCacheUsage({ count: 0, bytes: 0 });
          setImageCacheError('无法读取图片缓存占用；图片缓存可能不可用。');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageCache, view]);
  const catalogSource = useMemo(
    // 数据源只依赖已保存的地址；离线入口在没有任何联机会话时也要能创建它。
    () => createCatalogSource({ serviceAddress, policy }),
    [createCatalogSource, policy, serviceAddress],
  );
  const catalogEnabled = view === 'catalog' || view === 'card' || view === 'decks' || view === 'preset' || view === 'deck';
  const catalogFlow = useCatalog({
    enabled: catalogEnabled,
    source: catalogSource,
    cache: catalogCache,
    reloadToken: catalogReloadToken,
  });
  const catalog = catalogFlow.state.catalog;

  // 草稿独立于服务连接持久化：离线编辑、重启恢复；写入串行化避免旧列表覆盖新列表。
  // 读取成功前禁止任何写入：读取失败时若把空列表当作现状，会覆盖设备上已有的草稿。
  const draftsRef = useRef<readonly DeckDraft[]>([]);
  const draftsLoadedRef = useRef(false);
  const deckWriteChain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    setDrafts(undefined);
    setDraftsLoadError(undefined);
    draftsLoadedRef.current = false;
    void (async () => {
      try {
        const loaded = await deckStore.read();
        if (cancelled) {
          return;
        }
        draftsLoadedRef.current = true;
        draftsRef.current = loaded;
        setDrafts(loaded);
      } catch {
        if (cancelled) {
          return;
        }
        setDrafts(undefined);
        setDraftsLoadError('无法读取本机卡组草稿；为避免覆盖已有草稿，写入已暂停。请重试读取。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deckStore, draftsReloadToken]);
  const persistDrafts = useCallback(
    (next: readonly DeckDraft[]): boolean => {
      if (!draftsLoadedRef.current) {
        setDeckSaveError('本机草稿尚未读取成功，暂不能写入；请先重试读取。');
        return false;
      }
      draftsRef.current = next;
      setDrafts([...next]);
      setDeckSaveError(undefined);
      const operation = deckWriteChain.current.then(() => deckStore.write(next));
      deckWriteChain.current = operation.catch(() => undefined);
      void operation.catch(() => setDeckSaveError('无法保存卡组草稿，请检查系统存储。'));
      return true;
    },
    [deckStore],
  );
  const handleRetryDrafts = useCallback(() => {
    setDraftsReloadToken((token) => token + 1);
  }, []);
  const selectedDraft = useMemo(
    () => drafts?.find((draft) => draft.id === selectedDraftId),
    [drafts, selectedDraftId],
  );
  const selectedPreset = useMemo(
    () => catalog?.content.decks.find((deck) => deck.code === selectedPresetCode),
    [catalog, selectedPresetCode],
  );
  const deckValidator = useMemo(
    () => (serviceAddress.trim().length === 0 ? undefined : createDeckValidator({ serviceAddress, policy })),
    [createDeckValidator, policy, serviceAddress],
  );
  const selectedCard: CatalogCard | undefined = useMemo(
    () =>
      selectedCardId === undefined || catalog === undefined
        ? undefined
        : catalog.content.cards.find((card) => card.id === selectedCardId),
    [catalog, selectedCardId],
  );
  const resolveAssetUrl = useCallback(
    (path: string) => catalogSource?.resolveAssetUrl(path) ?? '',
    [catalogSource],
  );
  // 串行写入：重置身份与随后的自动保存按请求顺序落盘，避免旧身份覆盖新身份。
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const persistProfile = useCallback(
    (profile: StoredProfile): Promise<void> => {
      const next = writeChain.current.then(() => store.write(profile));
      // 单次失败不阻塞后续写入；调用方仍能看到本次失败。
      writeChain.current = next.catch(() => undefined);
      return next;
    },
    [store],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profile = await store.read();
        const loaded = profile.identity ?? (await loadOrCreateIdentity(store));
        if (cancelled) {
          return;
        }
        setNickname(profile.nickname);
        if (profile.serviceAddress.length > 0) {
          setServiceAddress(profile.serviceAddress);
        }
        setIdentity(loaded);
        setIdentityError(undefined);
        setView('settings');
      } catch {
        // 本机资料不可读时仍进入设置页并给出可操作的说明，不能停在空白页。
        if (cancelled) {
          return;
        }
        setIdentityError('无法读取本机身份资料。请重试，或在系统设置中清除应用数据后重启。');
        setView('settings');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  // 昵称与地址在输入时就落盘：即使未点击「保存并连接」就重启，也要保留住。
  useEffect(() => {
    if (view === 'loading' || identity === undefined) {
      return;
    }
    void persistProfile({ nickname, serviceAddress, identity }).catch(() => {
      // 后台自动保存失败不弹提示；重置身份与连接前保存会显式等待并报告失败。
    });
  }, [identity, nickname, persistProfile, serviceAddress, view]);

  // 设置页与失败页的离线目录入口：没有联机会话时，只要本机有一份通过版本
  // 校验的完整缓存，也能进入目录阅读。每次进入这两个页面重新检查，确保刚
  // 在线写入的缓存立刻可用，同时把“检查中”作为明确状态交给界面。
  useEffect(() => {
    if (view !== 'settings' && view !== 'failure') {
      return;
    }
    let cancelled = false;
    setOfflineCatalog('checking');
    void (async () => {
      let cached: Awaited<ReturnType<CatalogCache['load']>>;
      try {
        cached = await catalogCache.load();
      } catch {
        cached = undefined;
      }
      if (!cancelled) {
        setOfflineCatalog(cached === undefined ? 'none' : 'available');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogCache, view]);

  const runConnect = useCallback(
    async (targetNickname: string, targetAddress: string, currentIdentity: DeviceIdentity) => {
      const token = (attempt.current += 1);
      // 替换/重试前先释放旧连接：close() 不发出 onClosed，旧连接不会串扰新会话。
      releaseConnection();
      setView('connecting');
      setIssue(undefined);
      setFailure(undefined);

      try {
        await persistProfile({ nickname: targetNickname, serviceAddress: targetAddress, identity: currentIdentity });
      } catch {
        // 存储写入失败时不能停在连接检查页：此时还没有发出任何网络请求，
        // 回到设置页说明原因，并保留现有身份，等待用户重试。
        if (attempt.current !== token) {
          return;
        }
        setIdentityError('无法保存本机资料，未发起连接。请检查系统存储后重试。');
        setView('settings');
        return;
      }
      // 用户在写入期间返回设置或卸载时，不再发起这一轮连接。
      if (attempt.current !== token) {
        return;
      }
      // 保存成功说明存储可用，之前显示的保存类错误不再成立。
      setIdentityError(undefined);

      let result: ConnectResult;
      try {
        result = await connect({ serviceAddress: targetAddress, nickname: targetNickname, identity: currentIdentity }, policy);
      } catch {
        // 连接器自身抛错不是一种协议失败，但同样不能把用户困在连接页。
        if (attempt.current !== token) {
          return;
        }
        setFailure({ kind: 'unreachable', message: '连接过程意外中断，请确认服务后再试。' });
        setView('failure');
        return;
      }
      // 返回键可能已经让用户离开连接页，此时忽略过期结果，避免界面跳回失败页。
      if (attempt.current !== token) {
        if (result.ok) {
          result.connection.close();
        }
        return;
      }
      if (result.ok) {
        const connection = result.connection;
        connectionRef.current = connection;
        // 房间控制器随连接建立：离开房间页面后状态仍保留，回首页再进入不会丢座位。
        roomControllerRef.current = createRoomController(connection, (next) => {
          if (attempt.current !== token || connectionRef.current !== connection) {
            return;
          }
          setRoomState(next);
        });
        matchControllerRef.current = createMatchController(connection, (next) => {
          if (attempt.current !== token || connectionRef.current !== connection) {
            return;
          }
          setMatchState(next);
        });
        setRoomState(INITIAL_ROOM_STATE);
        setMatchState(INITIAL_MATCH_STATE);
        connection.onClosed(() => {
          // 过期连接的断开事件不得影响新会话。
          if (attempt.current !== token || connectionRef.current !== connection) {
            return;
          }
          roomControllerRef.current?.dispose();
          roomControllerRef.current = undefined;
          matchControllerRef.current?.dispose();
          matchControllerRef.current = undefined;
          connectionRef.current = undefined;
          // 目录/详情/卡组页断线：保留当前页面与本机缓存，只标记离线，用户可以继续阅读与编辑。
          if (
            viewRef.current === 'catalog' ||
            viewRef.current === 'card' ||
            viewRef.current === 'decks' ||
            viewRef.current === 'preset' ||
            viewRef.current === 'deck'
          ) {
            setConnectionLost(true);
            return;
          }
          setSession(undefined);
          setFailure({ kind: 'disconnected', message: '与服务端的连接已断开。' });
          setView('failure');
        });
        setSession(connection.session);
        setConnectionLost(false);
        setView('home');
        return;
      }
      setFailure(result.failure);
      setView('failure');
    },
    [connect, persistProfile, policy, releaseConnection],
  );

  const handleConnect = useCallback(() => {
    if (identity === undefined) {
      return;
    }
    const validated = validateProfileInput({ nickname, serviceAddress }, policy);
    if (!validated.ok) {
      setIssue(validated.issue);
      return;
    }
    void runConnect(validated.nickname, validated.serviceAddress, identity);
  }, [identity, nickname, serviceAddress, policy, runConnect]);

  /** 离开已连接页就断开：界面上不再显示「已连接」时，套接字也不应该还在。 */
  const handleBackToSettings = useCallback(() => {
    attempt.current += 1;
    releaseConnection();
    setSession(undefined);
    setConnectionLost(false);
    setSelectedCardId(undefined);
    setSelectedPresetCode(undefined);
    setSelectedDraftId(undefined);
    setViewer(undefined);
    setView('settings');
  }, [releaseConnection]);

  const handleResetIdentity = useCallback(() => {
    void (async () => {
      let created: DeviceIdentity;
      try {
        created = await createIdentity();
      } catch {
        setIdentityError('无法生成本机身份。请检查系统存储与安全设置后重试。');
        return;
      }
      try {
        await persistProfile({ nickname, serviceAddress, identity: created });
      } catch {
        setIdentityError('无法保存新的本机身份。请检查系统存储后重试。');
        return;
      }
      // 只有写入成功后才发布新身份，否则界面会显示一个重启后不存在的身份。
      setIdentity(created);
      setIdentityError(undefined);
    })();
  }, [createIdentity, nickname, persistProfile, serviceAddress]);

  const handleOpenCatalog = useCallback(() => {
    setSelectedCardId(undefined);
    setView('catalog');
  }, []);

  const handleOpenHome = useCallback(() => {
    setSelectedCardId(undefined);
    // 离线入口进入目录时没有联机会话；此时“返回”目标是设置页。
    setView(session === undefined ? 'settings' : 'home');
  }, [session]);

  const handleOpenDecks = useCallback(() => {
    setSelectedPresetCode(undefined);
    setSelectedDraftId(undefined);
    setView('decks');
  }, []);

  const handleOpenRoom = useCallback(() => {
    setView('room');
  }, []);

  // 双方准备完成后自动进入开局准备界面（房间页仍保留给等待状态使用）。
  useEffect(() => {
    if (view === 'room' && roomState.room?.status === 'started') {
      setView('match');
    }
  }, [roomState.room?.status, view]);

  const handleDecksBack = useCallback(() => {
    setSelectedPresetCode(undefined);
    setSelectedDraftId(undefined);
    setView(session === undefined ? 'settings' : 'home');
  }, [session]);

  const handleOpenPreset = useCallback((code: string) => {
    setSelectedPresetCode(code);
    setView('preset');
  }, []);

  const handleOpenDraft = useCallback((id: string) => {
    setSelectedDraftId(id);
    setView('deck');
  }, []);

  const handleCopyPreset = useCallback(
    (code: string) => {
      if (!draftsLoadedRef.current) {
        setDeckSaveError('本机草稿尚未读取成功，暂不能复制预设；请先重试读取。');
        return;
      }
      const currentCatalog = catalogFlow.state.catalog;
      if (currentCatalog === undefined) {
        setDeckSaveError('卡牌目录未加载，无法复制预设卡组。');
        return;
      }
      const preset = currentCatalog.content.decks.find((deck) => deck.code === code);
      if (preset === undefined) {
        return;
      }
      const document = presetDeckDocument(preset, currentCatalog.content);
      if (document === null) {
        setDeckSaveError('预设引用了目录中不存在的卡牌，拒绝复制。');
        return;
      }
      const draft = createDraft({ name: preset.nameZh, document });
      if (!persistDrafts([...draftsRef.current, draft])) {
        return;
      }
      setSelectedDraftId(draft.id);
      setView('deck');
    },
    [catalogFlow.state.catalog, persistDrafts],
  );

  const handleCreateBlankDraft = useCallback(() => {
    if (!draftsLoadedRef.current) {
      setDeckSaveError('本机草稿尚未读取成功，暂不能新建草稿；请先重试读取。');
      return;
    }
    const currentCatalog = catalogFlow.state.catalog;
    if (currentCatalog === undefined) {
      setDeckSaveError('卡牌目录未加载，无法新建卡组。');
      return;
    }
    const draft = createDraft({
      name: '新卡组',
      document: {
        formatVersion: DECK_FORMAT_VERSION,
        environmentId: currentCatalog.content.environment.id,
        cards: [],
      },
    });
    if (!persistDrafts([...draftsRef.current, draft])) {
      return;
    }
    setSelectedDraftId(draft.id);
    setView('deck');
  }, [catalogFlow.state.catalog, persistDrafts]);

  const handlePersistDraft = useCallback(
    (id: string, document: DeckDocument, name: string) => {
      if (!draftsLoadedRef.current) {
        setDeckSaveError('本机草稿尚未读取成功，暂不能保存；请先重试读取。');
        return;
      }
      const current = draftsRef.current;
      const index = current.findIndex((draft) => draft.id === id);
      if (index < 0) {
        return;
      }
      const previous = current[index] as DeckDraft;
      const updated: DeckDraft = { ...previous, name, document, updatedAt: new Date().toISOString() };
      const next = [...current];
      next[index] = updated;
      persistDrafts(next);
    },
    [persistDrafts],
  );

  const handleSelectCard = useCallback((card: CatalogCard) => {
    setSelectedCardId(card.id);
    setView('card');
  }, []);

  const handleCatalogBack = useCallback(() => {
    setSelectedCardId(undefined);
    setView('catalog');
  }, []);

  const handleRetryCatalog = useCallback(() => {
    setCatalogReloadToken((token) => token + 1);
  }, []);

  const handleRefreshImageCacheUsage = useCallback(() => {
    setImageCacheNote(undefined);
    setImageCacheError(undefined);
    void (async () => {
      try {
        setImageCacheUsage(await imageCache.usage());
      } catch {
        setImageCacheError('无法读取图片缓存占用。');
      }
    })();
  }, [imageCache]);

  const handleClearImageCache = useCallback(() => {
    void (async () => {
      setImageCacheBusy(true);
      setImageCacheError(undefined);
      setImageCacheNote(undefined);
      try {
        await imageCache.clear();
        setImageCacheUsage(await imageCache.usage());
        setImageCacheNote('已清除图片缓存；设备身份、昵称、地址与卡组不受影响。');
      } catch {
        setImageCacheError('清除图片缓存失败，请检查系统存储后重试。');
      } finally {
        setImageCacheBusy(false);
      }
    })();
  }, [imageCache]);

  const handleBack = useCallback(() => {
    // 图片查看器打开时，返回键先关闭查看器，不丢当前页面。
    if (viewer !== undefined) {
      setViewer(undefined);
      return;
    }
    const action = resolveBackAction(view);
    if (action === 'exit') {
      void exitApp();
      return;
    }
    if (action === 'to-settings') {
      handleBackToSettings();
      return;
    }
    if (action === 'to-home') {
      setSelectedCardId(undefined);
      setSelectedPresetCode(undefined);
      setSelectedDraftId(undefined);
      // 离线入口进入的目录/卡组没有联机会话，返回键应回到设置而不是不存在的首页。
      setView(session === undefined ? 'settings' : 'home');
      return;
    }
    if (action === 'to-decks') {
      setSelectedPresetCode(undefined);
      setSelectedDraftId(undefined);
      setView('decks');
      return;
    }
    setSelectedCardId(undefined);
    setView('catalog');
  }, [view, viewer, handleBackToSettings, session]);

  useEffect(() => {
    const source = backButton ?? createCapacitorBackButtonSource();
    return source.subscribe(handleBack);
  }, [backButton, handleBack]);

  const addressHint = useMemo(
    () => (policy.allowInsecure ? ADDRESS_HINT_INSECURE : ADDRESS_HINT_SECURE),
    [policy.allowInsecure],
  );

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">PTCG 简中对战</h1>
        <p className="app__subtitle">v{buildConfig.appVersion} · 首版朋友联机</p>
      </header>
      <main className="app__body">
        {view === 'settings' ? (
          <SettingsScreen
            nickname={nickname}
            serviceAddress={serviceAddress}
            addressHint={addressHint}
            identity={identity}
            identityError={identityError}
            fieldError={issue}
            offlineCatalog={offlineCatalog}
            imageCacheUsage={imageCacheUsage}
            imageCacheBusy={imageCacheBusy}
            imageCacheError={imageCacheError}
            imageCacheNote={imageCacheNote}
            onNicknameChange={setNickname}
            onAddressChange={setServiceAddress}
            onConnect={handleConnect}
            onOpenOfflineCatalog={handleOpenCatalog}
            onOpenDecks={handleOpenDecks}
            onResetIdentity={handleResetIdentity}
            onRefreshImageCacheUsage={handleRefreshImageCacheUsage}
            onClearImageCache={handleClearImageCache}
          />
        ) : null}
        {view === 'connecting' ? <ConnectingScreen /> : null}
        {view === 'failure' && failure !== undefined ? (
          <FailureScreen
            failure={failure}
            offlineCatalog={offlineCatalog}
            onRetry={handleConnect}
            onBackToSettings={handleBackToSettings}
            onOpenOfflineCatalog={handleOpenCatalog}
          />
        ) : null}
        {view === 'home' && session !== undefined ? (
          <HomeScreen
            session={session}
            connected={!connectionLost}
            roomSummary={roomHomeSummary(roomState)}
            onBackToSettings={handleBackToSettings}
            onOpenCatalog={handleOpenCatalog}
            onOpenDecks={handleOpenDecks}
            onOpenRoom={handleOpenRoom}
          />
        ) : null}
        {view === 'room' && session !== undefined ? (
          <RoomScreen
            serviceAddress={serviceAddress}
            connected={!connectionLost && roomState.phase !== 'disconnected'}
            room={roomState}
            drafts={drafts}
            catalog={catalog}
            onBack={handleOpenHome}
            onCreate={() => roomControllerRef.current?.createRoom()}
            onJoin={(code) => roomControllerRef.current?.joinRoom(code)}
            onSelectDeck={(deck) => roomControllerRef.current?.selectDeck(deck)}
            onSetReady={(ready) => roomControllerRef.current?.setReady(ready)}
            onLeave={() => roomControllerRef.current?.leaveRoom()}
            onClearError={() => roomControllerRef.current?.clearError()}
            copyText={dependencies.copyText}
          />
        ) : null}
        {view === 'match' && session !== undefined ? (
          <MatchScreen
            connected={!connectionLost && matchState.error?.code !== 'disconnected'}
            match={matchState}
            onChooseTurnOrder={(goFirst) => matchControllerRef.current?.chooseTurnOrder(goFirst)}
            onPlaceSetup={(active, bench) => matchControllerRef.current?.placeSetup(active, bench)}
            onResolveCompensation={(draw) => matchControllerRef.current?.resolveCompensation(draw)}
            onPlaceBench={(bench) => matchControllerRef.current?.placeBench(bench)}
            onPlayBasic={(handIndex) => matchControllerRef.current?.playBasic(handIndex)}
            onAttachEnergy={(handIndex, target) => matchControllerRef.current?.attachEnergy(handIndex, target)}
            onRetreat={(energyIndices, benchIndex) => matchControllerRef.current?.retreat(energyIndices, benchIndex)}
            onAttack={(attackIndex, target) => matchControllerRef.current?.attack(attackIndex, target)}
            onEndTurn={() => matchControllerRef.current?.endTurn()}
            onTakePrizes={(prizes) => matchControllerRef.current?.takePrizes(prizes)}
            onChooseReplacement={(benchIndex) => matchControllerRef.current?.chooseReplacement(benchIndex)}
            onConcede={() => matchControllerRef.current?.concede()}
            onReturnToRoom={() => setView('room')}
            onBack={handleOpenHome}
            onClearError={() => matchControllerRef.current?.clearError()}
          />
        ) : null}
        {view === 'catalog' || (view === 'card' && (selectedCard === undefined || catalog === undefined)) ? (
          <CatalogScreen
            state={catalogFlow.state}
            imageCache={imageCache}
            connectionLost={connectionLost}
            offlineMode={session === undefined}
            onRetry={handleRetryCatalog}
            onBackToHome={handleOpenHome}
            onSelectCard={handleSelectCard}
            resolveAssetUrl={resolveAssetUrl}
            onOpenImage={setViewer}
          />
        ) : null}
        {view === 'card' && selectedCard !== undefined && catalog !== undefined ? (
          <CardDetailScreen
            card={selectedCard}
            catalog={catalog}
            imageCache={imageCache}
            onBack={handleCatalogBack}
            resolveAssetUrl={resolveAssetUrl}
            onOpenImage={setViewer}
          />
        ) : null}
        {view === 'decks' ? (
          <DecksScreen
            drafts={drafts}
            draftsError={draftsLoadError}
            catalog={catalog}
            offlineMode={session === undefined}
            connectionLost={connectionLost}
            onBack={handleDecksBack}
            onCreateBlank={handleCreateBlankDraft}
            onOpenPreset={handleOpenPreset}
            onCopyPreset={handleCopyPreset}
            onOpenDraft={handleOpenDraft}
            onRetryDrafts={handleRetryDrafts}
          />
        ) : null}
        {view === 'preset' && selectedPreset !== undefined && catalog !== undefined ? (
          <PresetDeckScreen
            preset={selectedPreset}
            catalog={catalog}
            copyDisabled={drafts === undefined}
            onCopy={() => handleCopyPreset(selectedPreset.code)}
            onBack={() => setView('decks')}
          />
        ) : null}
        {view === 'preset' && (selectedPreset === undefined || catalog === undefined) ? (
          <section className="card">
            <p className="notice" role="alert">
              预设卡组当前不可用（目录未加载或预设已变化）。
            </p>
            <button className="secondary" type="button" onClick={() => setView('decks')}>
              返回卡组列表
            </button>
          </section>
        ) : null}
        {view === 'deck' && selectedDraft !== undefined ? (
          <DeckEditorScreen
            key={selectedDraft.id}
            draft={selectedDraft}
            catalog={catalog}
            validator={deckValidator}
            saveError={deckSaveError}
            onPersist={(document, name) => handlePersistDraft(selectedDraft.id, document, name)}
            onBack={() => setView('decks')}
          />
        ) : null}
        {view === 'deck' && selectedDraft === undefined ? (
          <section className="card">
            <p className="notice" role="alert">
              草稿不存在或尚未读取完成。
            </p>
            <button className="secondary" type="button" onClick={() => setView('decks')}>
              返回卡组列表
            </button>
          </section>
        ) : null}
      </main>
      {viewer === undefined ? null : (
        <ImageViewer
          src={viewer.src}
          labelZh={viewer.labelZh}
          provenanceZh={viewer.provenanceZh}
          onClose={() => setViewer(undefined)}
        />
      )}
    </div>
  );
}
