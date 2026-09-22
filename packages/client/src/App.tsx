import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { computeCatalogVersion, isValidNickname, normalizeNickname, SOLO_OPPONENTS, SOLO_PRESETS, soloDialogue, type ServiceCatalog, type SoloOpponentId, type SoloPresetId } from '@ptcg/protocol';
import { FriendApp, type AppDependencies as FriendDependencies } from './FriendApp.tsx';
import { createCapacitorBackButtonSource, exitApp } from './app/backButton.ts';
import { lockScreenOrientation } from './app/orientation.ts';
import { localCatalog } from './local/session.ts';
import { createSoloAi, type SoloAi, type SoloAiState } from './solo/aiScheduler.ts';
import { SOLO_AI_VERSION } from './solo/aiDecision.ts';
import { createSoloSessionManager, type SavedSoloMatch, type SoloInspection } from './solo/soloSession.ts';
import { createSoloMatchAdapter } from './solo/matchAdapter.ts';
import { createSoloPreferencesStore, type SoloPreferencesStore } from './solo/preferences.ts';
import { soloLifecycle, type SoloLifecycle } from './solo/lifecycle.ts';
import { INITIAL_MATCH_STATE, type MatchState } from './rooms/matchController.ts';
import { MatchScreen } from './ui/MatchScreen.tsx';
export type { CatalogSourceFactoryInput, DeckValidatorFactoryInput } from './FriendApp.tsx';

export interface AppDependencies extends FriendDependencies {
  readonly soloManager?: ReturnType<typeof createSoloSessionManager>;
  readonly soloPreferences?: SoloPreferencesStore;
  readonly soloLifecycle?: SoloLifecycle;
}
interface Runtime {
  saved: SavedSoloMatch;
  adapter: ReturnType<typeof createSoloMatchAdapter>;
  ai: SoloAi;
  unsubscribe: () => void;
  dispose(): void;
}
const IDLE: SoloAiState = { status: 'idle', paused: true, error: null };

/** Trusted composition root: neither the board nor AI ever receives both seat capabilities. */
export function App({ dependencies }: { dependencies: AppDependencies }): ReactElement {
  const manager = useMemo(() => dependencies.soloManager ?? createSoloSessionManager({ strategyVersion: SOLO_AI_VERSION }), [dependencies.soloManager]);
  const preferences = useMemo(() => dependencies.soloPreferences ?? createSoloPreferencesStore(), [dependencies.soloPreferences]);
  const catalogContent = useMemo(localCatalog, []);
  const [catalog, setCatalog] = useState<ServiceCatalog>();
  const [mode, setMode] = useState<'solo' | 'friends' | 'match'>('solo');
  const [inspection, setInspection] = useState<SoloInspection>();
  const [nickname, setNickname] = useState('玩家');
  const [dialogue, setDialogue] = useState(true);
  const [prefsReady, setPrefsReady] = useState(false);
  const [prefsDirty, setPrefsDirty] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [presetId, setPreset] = useState<SoloPresetId>('solo-a-v1');
  const [opponentId, setOpponent] = useState<SoloOpponentId>('linyue');
  const [match, setMatch] = useState<MatchState>(INITIAL_MATCH_STATE);
  const [aiState, setAiState] = useState(IDLE);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const runtime = useRef<Runtime | undefined>(undefined);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const active = useRef(!document.hidden);
  const aiHeld = useRef(false);
  const lifecycleEpoch = useRef(0);
  const prefsQueue = useRef(Promise.resolve());
  const modeRef = useRef(mode); modeRef.current = mode;
  const homeRef = useRef<() => Promise<void>>(async () => undefined);
  const inspect = async () => { const next = await manager.inspect(); if (mounted.current) setInspection(next); };
  const readPreferences = useCallback(async () => {
    setPrefsReady(false);
    try {
      const value = await preferences.read();
      if (mounted.current) { setNickname(value.nickname); setDialogue(value.dialogue); setPrefsDirty(false); setPrefsError(null); }
    } catch {
      if (mounted.current) setPrefsError('单人偏好无法读取；原数据未覆盖。可重新读取或主动修改昵称、台词。');
    } finally { if (mounted.current) setPrefsReady(true); }
  }, [preferences]);

  useEffect(() => {
    mounted.current = true;
    void inspect();
    void computeCatalogVersion(catalogContent).then(catalogVersion => {
      if (mounted.current) setCatalog({ content: catalogContent, catalogVersion, runtime: { servedAt: '', resources: {}, cardImages: {} } });
    }).catch(() => { if (mounted.current) setError('随包卡牌目录无法验证。'); });
    void readPreferences();
    return () => {
      mounted.current = false; lifecycleEpoch.current++;
      const current = runtime.current; runtime.current = undefined;
      if (current) {
        current.adapter.setEnabled(false);
        void Promise.all([current.ai.pause(), current.adapter.settled()]).finally(() => current.dispose());
      }
    };
  }, [manager, readPreferences, catalogContent]);

  useEffect(() => {
    if (!prefsReady || !prefsDirty) return;
    prefsQueue.current = prefsQueue.current.catch(() => undefined).then(() => preferences.write({ nickname, dialogue }));
    void prefsQueue.current.catch(() => { if (mounted.current) setError('昵称或台词偏好保存失败，请重试。'); });
  }, [nickname, dialogue, prefsReady, prefsDirty, preferences]);
  const editNickname = (value: string) => { setNickname(value); setPrefsDirty(true); setPrefsError(null); };
  const editDialogue = (value: boolean) => { setDialogue(value); setPrefsDirty(true); setPrefsError(null); };

  useEffect(() => (dependencies.soloLifecycle ?? soloLifecycle).subscribe(isActive => {
    active.current = isActive;
    const epoch = ++lifecycleEpoch.current;
    const current = runtime.current;
    if (!current) return;
    current.adapter.setEnabled(false); setPaused(true);
    void Promise.all([current.ai.pause(), current.adapter.settled()]).then(() => {
      if (!mounted.current || epoch !== lifecycleEpoch.current || runtime.current !== current || !active.current || busyRef.current) return;
      if (current.saved.getState().status === 'active' && current.ai.getState().status !== 'error') {
        current.adapter.setEnabled(true); setPaused(false); if (!aiHeld.current) current.ai.resume();
      }
    });
  }), [dependencies.soloLifecycle]);

  const holdAiForConfirmation = useCallback((open: boolean) => {
    aiHeld.current = open;
    const current = runtime.current;
    if (!current) return;
    const epoch = ++lifecycleEpoch.current;
    current.adapter.setEnabled(false); setPaused(true);
    void Promise.all([current.ai.pause(), current.adapter.settled()]).then(() => {
      if (!mounted.current || epoch !== lifecycleEpoch.current || runtime.current !== current || !active.current) return;
      if (current.saved.getState().status !== 'active' || current.ai.getState().status === 'error') return;
      current.adapter.setEnabled(true); setPaused(false);
      if (!aiHeld.current) current.ai.resume();
    });
  }, []);

  useEffect(() => {
    if (mode !== 'match') void lockScreenOrientation('portrait');
    if (mode === 'friends') return;
    return (dependencies.backButton ?? createCapacitorBackButtonSource()).subscribe(() => {
      if (busyRef.current) return;
      if (modeRef.current === 'match') void homeRef.current();
      else if (confirmDiscard) setConfirmDiscard(false);
      else void exitApp();
    });
  }, [mode, dependencies.backButton, confirmDiscard]);

  async function exclusive(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await work(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function stopRuntime() {
    lifecycleEpoch.current++;
    const current = runtime.current;
    if (!current) return;
    current.adapter.setEnabled(false); setPaused(true);
    await Promise.all([current.ai.pause(), current.adapter.settled()]);
    current.dispose();
    if (runtime.current === current) runtime.current = undefined;
  }
  async function home() {
    await exclusive(async () => { await stopRuntime(); setMode('solo'); setFatal(null); setMatch(INITIAL_MATCH_STATE); await inspect(); });
  }
  homeRef.current = home;

  function attach(saved: SavedSoloMatch) {
    if (!mounted.current) { saved.dispose(); return; }
    aiHeld.current = false;
    setFatal(null); setPaused(!active.current); setPreset(saved.summary.presetId); setOpponent(saved.summary.opponentId);
    const adapter = createSoloMatchAdapter(saved.players[saved.summary.humanSeat], state => { if (mounted.current) setMatch(state); });
    const ai = createSoloAi({ port: saved.players[saved.summary.aiSeat], opponentId: saved.summary.opponentId, catalog: catalogContent });
    const fail = (message: string) => { adapter.setEnabled(false); ai.dispose(); if (mounted.current) { setFatal(message); setAiState(ai.getState()); } };
    const unsubscribeSaved = saved.subscribe(() => {
      const state = saved.getState();
      if (state.status !== 'active') fail(state.error ?? '单人对局已停止，请返回首页重新读取存档。');
    });
    const unsubscribeAi = ai.subscribe(() => {
      const state = ai.getState();
      if (mounted.current) setAiState(state);
      if (state.status === 'error') fail(state.error ?? 'AI 操作失败，请返回首页重新读取存档。');
    });
    const unsubscribe = () => { unsubscribeAi(); unsubscribeSaved(); };
    runtime.current = { saved, adapter, ai, unsubscribe, dispose() { unsubscribe(); ai.dispose(); adapter.dispose(); saved.dispose(); } };
    setAiState(ai.getState()); setMode('match');
    adapter.setEnabled(active.current);
    if (active.current) ai.resume();
  }
  const start = () => exclusive(async () => {
    const name = normalizeNickname(nickname);
    if (!isValidNickname(name)) throw new Error('请输入 1–16 个字符的单人昵称。');
    await prefsQueue.current;
    attach(await manager.start({ presetId, opponentId, nickname: name }));
  });
  const resume = () => exclusive(async () => attach(await manager.continue()));
  const discard = () => exclusive(async () => {
    await stopRuntime(); await manager.discard({ confirmed: true }); setConfirmDiscard(false); await inspect();
  });
  const replay = () => exclusive(async () => {
    const current = runtime.current;
    if (!current || current.saved.summary.result === null) return;
    const previous = current.saved.summary;
    const name = match.view?.you.nickname ?? nickname;
    await stopRuntime(); await manager.discard({ confirmed: true });
    setMode('solo'); await inspect();
    attach(await manager.start({ presetId: previous.presetId, opponentId: previous.opponentId, nickname: name }));
  });
  const changeOpponent = () => exclusive(async () => {
    if (runtime.current?.saved.summary.result === null) return;
    await stopRuntime(); await manager.discard({ confirmed: true }); setMode('solo'); setFatal(null); await inspect();
  });
  const opponent = SOLO_OPPONENTS.find(item => item.id === opponentId)!;
  const controller = runtime.current?.adapter.controller;
  const result = match.view?.result;
  const line = soloDialogue(opponentId, result ? (result.winner === 1 ? 'win' : 'loss') : 'start', dialogue && result?.winner !== null);

  if (mode === 'friends') return <FriendApp dependencies={dependencies} onReturnToSolo={() => { setMode('solo'); void inspect(); }} />;

  if (mode === 'match' && controller) return <div className="app solo-match">
    <div className="solo-match__bar">
      <span role="status">{fatal ? '对局已暂停' : paused ? '正在等待当前操作保存…' : aiState.status === 'thinking' ? `${opponent.nameZh}正在思考…` : `单人 · ${opponent.nameZh}`}</span>
      <label><input type="checkbox" checked={dialogue} onChange={event => editDialogue(event.target.checked)} />角色台词</label>
      {line && !fatal ? <span className="solo-dialogue">{opponent.nameZh}：{line}</span> : null}
    </div>
    {fatal || error ? <div className="notice" role="alert">{fatal ?? error}<button className="secondary" disabled={busy} onClick={() => void home()}>返回首页重读存档</button></div> : null}
    <main className="app__body">
      <MatchScreen match={match} connected={!fatal && !paused && !busy} mode="solo" catalog={catalog} onConcedePromptChange={holdAiForConfirmation}
        onChooseTurnOrder={controller.chooseTurnOrder} onPlaceSetup={controller.placeSetup} onResolveCompensation={controller.resolveCompensation} onPlaceBench={controller.placeBench}
        onPlayBasic={controller.playBasic} onAttachEnergy={controller.attachEnergy} onRetreat={controller.retreat} onEvolve={controller.evolve} onUseAbility={controller.useAbility} onAttachTool={controller.attachTool}
        onAttack={controller.attack} onEndTurn={controller.endTurn} onPlayTrainer={controller.playTrainer} onUseStadium={controller.useStadium} onDiscardHand={controller.discardHand}
        onSearchDeck={controller.searchDeck} onChooseMode={controller.chooseMode} onSwitchOpponent={controller.switchOpponent} onChooseOwnBench={controller.chooseOwnBench}
        onAttachHandEnergy={controller.attachHandEnergy} onDiscardEnergy={controller.discardEnergy} onSelectCard={controller.selectCard} onSelectTarget={controller.selectTarget}
        onCopyAttack={controller.copyAttack} onTakePrizes={controller.takePrizes} onChooseReplacement={controller.chooseReplacement} onConcede={controller.concede}
        onReturnToRoom={() => void replay()} onChangeOpponent={() => void changeOpponent()} onBack={() => void home()} onClearError={controller.clearError} />
    </main>
  </div>;

  return <div className="app solo-home">
    <header className="app__header"><h1 className="app__title">PTCG 简中对战</h1><p className="app__subtitle">随时开局，离线也能玩。</p></header>
    <main className="app__body">
      {error ? <p className="notice" role="alert">{error}</p> : null}
      {prefsError ? <div className="notice" role="alert">{prefsError}<button className="secondary" disabled={!prefsReady || busy} onClick={() => void readPreferences()}>重新读取单人偏好</button></div> : null}
      <section className="panel"><h2>单人对战</h2><p>选择固定预设，挑战三位对手。全部开放，无需联网。</p>
        <label className="field">单人昵称<input aria-label="单人昵称" value={nickname} maxLength={16} disabled={!prefsReady || busy} onChange={event => editNickname(event.target.value)} /></label>
        <label><input type="checkbox" checked={dialogue} disabled={!prefsReady} onChange={event => editDialogue(event.target.checked)} />角色台词</label>
      </section>
      {inspection === undefined ? <p role="status">正在读取单人存档…</p> : <>
        {inspection.status !== 'empty' ? <section className="panel" aria-label="单人存档">
          <h2>{inspection.summary?.result ? '上一局结算' : '单人存档'}</h2>
          {inspection.summary ? <p>{SOLO_PRESETS.find(item => item.id === inspection.summary!.presetId)?.nameZh} 对 {SOLO_OPPONENTS.find(item => item.id === inspection.summary!.opponentId)?.nameZh}</p> : null}
          {inspection.message ? <p role="alert">{inspection.message}</p> : null}
          {inspection.status === 'ready' ? <button className="primary" disabled={busy} onClick={() => void resume()}>{inspection.summary?.result ? '查看结算' : '继续存档'}</button> : null}
          <button className="secondary" disabled={busy} onClick={() => setConfirmDiscard(true)}>放弃存档</button>
          <button className="secondary" disabled={busy} onClick={() => void exclusive(inspect)}>重新读取</button>
          {confirmDiscard ? <div role="dialog" aria-label="确认放弃存档"><p>确认放弃此存档？无法继续这局，已有胜负记录会保留；放弃不计为认输。</p><button className="primary" disabled={busy} onClick={() => void discard()}>确认放弃</button><button className="secondary" disabled={busy} onClick={() => setConfirmDiscard(false)}>取消</button></div> : null}
        </section> : null}
        <fieldset className="panel" disabled={busy}><legend>玩家预设</legend><p>单人仅使用以下三套冻结预设。自由组卡请进入朋友联机。</p>
          {SOLO_PRESETS.map(item => <label className="solo-choice" key={item.id}><input type="radio" name="solo-preset" value={item.id} checked={presetId === item.id} onChange={() => setPreset(item.id)} />{item.nameZh}<span>60 张</span></label>)}
        </fieldset>
        <fieldset className="panel" disabled={busy}><legend>选择对手</legend><div className="solo-opponents">
          {SOLO_OPPONENTS.map(item => <label className={`solo-opponent ${opponentId === item.id ? 'is-selected' : ''}`} key={item.id}>
            <input type="radio" name="solo-opponent" value={item.id} checked={opponentId === item.id} onChange={() => setOpponent(item.id)} />
            <img width="72" height="72" src={`data:image/svg+xml,${encodeURIComponent(item.portrait.svg)}`} alt={item.portrait.altZh} />
            <strong>{item.nameZh}</strong><span>{item.introductionZh}</span><span className="field__hint">{item.tactics.planZh}</span>
            <span>{inspection.statsAvailable ? `对战记录：${inspection.stats[item.id].wins} 胜 / ${inspection.stats[item.id].losses} 负 / ${inspection.stats[item.id].draws} 平` : '胜负记录暂不可读取'}</span>
          </label>)}
        </div></fieldset>
        <button className="primary" disabled={busy || !prefsReady || !catalog || inspection.status !== 'empty'} onClick={() => void start()}>{busy ? '正在处理…' : '开始单人对战'}</button>
        {inspection.status !== 'empty' ? <p className="field__hint">先继续或确认放弃已有存档，再开始新局。</p> : null}
      </>}
      <section className="panel"><h2>朋友联机</h2><p>房间码对战，保留四套预设与自由组卡。</p><button className="secondary" disabled={busy} onClick={() => setMode('friends')}>进入朋友联机</button></section>
    </main>
  </div>;
}
