import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  createDeviceIdentity,
  type CatalogCard,
  type ConnectedSession,
  type ConnectResult,
  type ConnectionFailure,
  type DeviceIdentity,
  type LiveConnection,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';
import { resolveBackAction, validateProfileInput, type AppView, type ProfileIssue } from './app/controller.ts';
import { createCapacitorBackButtonSource, exitApp, type BackButtonSource } from './app/backButton.ts';
import { createCatalogCache, createPreferencesCatalogCache, type CatalogCache } from './catalog/cache.ts';
import { createHttpCatalogSource, type CatalogSource } from './catalog/source.ts';
import { useCatalog } from './catalog/useCatalog.ts';
import { buildConfig } from './config.ts';
import type { ConnectFn } from './connection/connection.ts';
import { loadOrCreateIdentity, type ProfileStore, type StoredProfile } from './storage/profileStore.ts';
import { CatalogScreen, type CatalogImageRequest } from './ui/CatalogScreen.tsx';
import { CardDetailScreen } from './ui/CardDetailScreen.tsx';
import { ConnectingScreen } from './ui/ConnectingScreen.tsx';
import { FailureScreen } from './ui/FailureScreen.tsx';
import { HomeScreen } from './ui/HomeScreen.tsx';
import { ImageViewer } from './ui/ImageViewer.tsx';
import { SettingsScreen } from './ui/SettingsScreen.tsx';

export interface CatalogSourceFactoryInput {
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
  const [selectedCardId, setSelectedCardId] = useState<string | undefined>();
  const [viewer, setViewer] = useState<CatalogImageRequest | undefined>();
  const [catalogReloadToken, setCatalogReloadToken] = useState(0);
  const attempt = useRef(0);
  const connectionRef = useRef<LiveConnection | undefined>(undefined);
  // 断线回调需要知道“当时”所在页面：在目录/详情页断线不应把用户踢出缓存。
  const viewRef = useRef<AppView>('loading');
  viewRef.current = view;

  /** 主动释放当前连接；close() 不会触发 onClosed，因此不会误报断线。 */
  const releaseConnection = useCallback(() => {
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
  const catalogFactoryRef = useRef(dependencies.createCatalogSource ?? createHttpCatalogSource);
  const createCatalogSource = catalogFactoryRef.current;
  const catalogCache = useMemo(
    () => dependencies.catalogCache ?? createPreferencesCatalogCache(),
    [dependencies.catalogCache],
  );
  const catalogSource = useMemo(
    () => (session === undefined ? undefined : createCatalogSource({ serviceAddress, policy })),
    [createCatalogSource, session, serviceAddress, policy],
  );
  const catalogEnabled = session !== undefined && (view === 'catalog' || view === 'card');
  const catalogFlow = useCatalog({
    enabled: catalogEnabled,
    source: catalogSource,
    cache: catalogCache,
    reloadToken: catalogReloadToken,
  });
  const catalog = catalogFlow.state.catalog;
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
        connection.onClosed(() => {
          // 过期连接的断开事件不得影响新会话。
          if (attempt.current !== token || connectionRef.current !== connection) {
            return;
          }
          connectionRef.current = undefined;
          // 目录/详情页断线：保留当前页面与本机缓存，只标记离线，用户可以继续阅读。
          if (viewRef.current === 'catalog' || viewRef.current === 'card') {
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
    setView('home');
  }, []);

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
      setView('home');
      return;
    }
    setSelectedCardId(undefined);
    setView('catalog');
  }, [view, viewer, handleBackToSettings]);

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
            onNicknameChange={setNickname}
            onAddressChange={setServiceAddress}
            onConnect={handleConnect}
            onResetIdentity={handleResetIdentity}
          />
        ) : null}
        {view === 'connecting' ? <ConnectingScreen /> : null}
        {view === 'failure' && failure !== undefined ? (
          <FailureScreen
            failure={failure}
            onRetry={handleConnect}
            onBackToSettings={handleBackToSettings}
          />
        ) : null}
        {view === 'home' && session !== undefined ? (
          <HomeScreen
            session={session}
            connected={!connectionLost}
            onBackToSettings={handleBackToSettings}
            onOpenCatalog={handleOpenCatalog}
          />
        ) : null}
        {view === 'catalog' || (view === 'card' && (selectedCard === undefined || catalog === undefined)) ? (
          <CatalogScreen
            state={catalogFlow.state}
            connectionLost={connectionLost}
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
            onBack={handleCatalogBack}
            resolveAssetUrl={resolveAssetUrl}
            onOpenImage={setViewer}
          />
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
