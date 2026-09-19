import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  createDeviceIdentity,
  type ConnectedSession,
  type ConnectionFailure,
  type DeviceIdentity,
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
  const [failure, setFailure] = useState<ConnectionFailure | undefined>();
  const [session, setSession] = useState<ConnectedSession | undefined>();
  const attempt = useRef(0);

  const { store, connect, policy, backButton } = dependencies;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
      setView('settings');
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  const runConnect = useCallback(
    async (targetNickname: string, targetAddress: string, currentIdentity: DeviceIdentity) => {
      const token = (attempt.current += 1);
      setView('connecting');
      setIssue(undefined);
      setFailure(undefined);

      await store.write({ nickname: targetNickname, serviceAddress: targetAddress, identity: currentIdentity });

      const result = await connect({ serviceAddress: targetAddress, nickname: targetNickname, identity: currentIdentity }, policy);
      // 返回键可能已经让用户离开连接页，此时忽略过期结果，避免界面跳回失败页。
      if (attempt.current !== token) {
        if (result.ok) {
          result.close();
        }
        return;
      }
      if (result.ok) {
        setSession(result.session);
        setView('home');
        return;
      }
      setFailure(result.failure);
      setView('failure');
    },
    [connect, policy, store],
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

  const handleBackToSettings = useCallback(() => {
    attempt.current += 1;
    setView('settings');
  }, []);

  const handleResetIdentity = useCallback(() => {
    void (async () => {
      const created = await createDeviceIdentity();
      setIdentity(created);
      await store.write({ nickname, serviceAddress, identity: created });
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
            fieldError={issue}
            busy={false}
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
          <HomeScreen session={session} onBackToSettings={handleBackToSettings} onDisconnect={handleBackToSettings} />
        ) : null}
      </main>
    </div>
  );
}
