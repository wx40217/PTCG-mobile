import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  createDeviceIdentity,
  type ConnectedSession,
  type ConnectionFailure,
  type DeviceIdentity,
  type LiveConnection,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';
import { resolveBackAction, validateProfileInput, type AppView, type ProfileIssue } from './app/controller.ts';
import { createCapacitorBackButtonSource, exitApp, type BackButtonSource } from './app/backButton.ts';
import { buildConfig } from './config.ts';
import type { ConnectFn } from './connection/connection.ts';
import { loadOrCreateIdentity, type ProfileStore } from './storage/profileStore.ts';
import { ConnectingScreen } from './ui/ConnectingScreen.tsx';
import { FailureScreen } from './ui/FailureScreen.tsx';
import { HomeScreen } from './ui/HomeScreen.tsx';
import { SettingsScreen } from './ui/SettingsScreen.tsx';

export interface AppDependencies {
  readonly store: ProfileStore;
  readonly connect: ConnectFn;
  readonly policy: ServiceAddressPolicy;
  readonly defaultServiceAddress: string;
  readonly backButton?: BackButtonSource;
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
  const attempt = useRef(0);
  const connectionRef = useRef<LiveConnection | undefined>(undefined);

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
    void store.write({ nickname, serviceAddress, identity });
  }, [identity, nickname, serviceAddress, store, view]);

  const runConnect = useCallback(
    async (targetNickname: string, targetAddress: string, currentIdentity: DeviceIdentity) => {
      const token = (attempt.current += 1);
      // 替换/重试前先释放旧连接：close() 不发出 onClosed，旧连接不会串扰新会话。
      releaseConnection();
      setView('connecting');
      setIssue(undefined);
      setFailure(undefined);

      await store.write({ nickname: targetNickname, serviceAddress: targetAddress, identity: currentIdentity });

      const result = await connect({ serviceAddress: targetAddress, nickname: targetNickname, identity: currentIdentity }, policy);
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
          setSession(undefined);
          setFailure({ kind: 'disconnected', message: '与服务端的连接已断开。' });
          setView('failure');
        });
        setSession(connection.session);
        setView('home');
        return;
      }
      setFailure(result.failure);
      setView('failure');
    },
    [connect, policy, releaseConnection, store],
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
    setView('settings');
  }, [releaseConnection]);

  const handleResetIdentity = useCallback(() => {
    void (async () => {
      try {
        const created = await createDeviceIdentity();
        setIdentity(created);
        setIdentityError(undefined);
        await store.write({ nickname, serviceAddress, identity: created });
      } catch {
        setIdentityError('无法生成本机身份。请检查系统存储与安全设置后重试。');
      }
    })();
  }, [nickname, serviceAddress, store]);

  const handleBack = useCallback(() => {
    if (resolveBackAction(view) === 'exit') {
      void exitApp();
      return;
    }
    handleBackToSettings();
  }, [view, handleBackToSettings]);

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
          <HomeScreen session={session} onBackToSettings={handleBackToSettings} />
        ) : null}
      </main>
    </div>
  );
}
