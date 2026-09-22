import type { CatalogContent, SoloOpponentId } from '@ptcg/protocol';
import type { LocalPlayerPort } from '../local/session.ts';
import { decideSoloAi } from './aiDecision.ts';

export interface SoloAiState {
  readonly status: 'idle' | 'thinking' | 'error';
  readonly paused: boolean;
  readonly error: string | null;
}
export interface SoloAi {
  /** Stops new submissions immediately; resolves after any in-flight save settles. */
  pause(): Promise<void>;
  resume(): void;
  dispose(): void;
  getState(): SoloAiState;
  subscribe(listener: () => void): () => void;
}

/** One seat capability only. No access to the host, checkpoints, RNG or opponent view. */
export function createSoloAi(options: {
  readonly port: LocalPlayerPort;
  readonly opponentId: SoloOpponentId;
  readonly catalog: CatalogContent;
}): SoloAi {
  const catalog = structuredClone(options.catalog);
  let state: SoloAiState = { status: 'idle', paused: true, error: null };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let versionKey = '';
  let rejected = new Set<string>();
  let staleCount = 0;
  let actionTurn = '';
  let actions = 0;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SoloAiState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) { try { listener(); } catch { /* observers are isolated */ } }
  };
  const fail = (error: unknown) => set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
  const schedule = () => {
    if (disposed || state.paused || state.status !== 'thinking' || timer !== undefined || flight) return;
    // Macrotask boundary between every command/rejection yields to input and rendering.
    timer = setTimeout(() => {
      timer = undefined;
      // Install the in-flight promise before notifying observers from step().
      flight = Promise.resolve().then(step).catch(fail).finally(() => { flight = undefined; schedule(); });
    }, 8);
  };
  const step = async () => {
    if (disposed || state.paused) return;
    let view;
    try { view = options.port.view(); }
    catch (error) {
      // The local port deliberately hides an uncommitted snapshot. Do not poll it:
      // successful persistence will notify this seat; a failed save stops the host.
      if (error instanceof Error && error.message === '本地会话正在提交，请等待状态通知。') {
        set({ status: 'idle' }); return;
      }
      throw error;
    }
    const key = `${view.sessionId}:${view.version}`;
    if (key !== versionKey) { versionKey = key; rejected = new Set(); staleCount = 0; }
    const turn = `${view.sessionId}:${view.turn}`;
    if (turn !== actionTurn) { actionTurn = turn; actions = 0; }
    const candidates = decideSoloAi(view, options.opponentId, catalog);
    if (!candidates.length) {
      if (view.pendingChoice && !view.result) throw new Error('AI 无法处理当前待决选择。');
      set({ status: 'idle' });
      // Stay asleep until a seat notification; do not poll the other player's turn.
      return;
    }
    if (++actions > 512) throw new Error('AI 本回合操作超过安全上限，请重新载入对局。');
    const next = candidates.find(c => !rejected.has(c.command.commandId));
    if (!next) throw new Error('AI 当前选择均被拒绝，已停止自动操作。');
    set({ status: 'thinking' });
    if (disposed || state.paused) return;
    const result = await options.port.submit(next.command);
    if (disposed) return;
    if (!result.ok) {
      if (result.code === 'stale-version') {
        if (++staleCount > 2) throw new Error('AI 状态持续过期，已停止自动操作。');
      } else if (['action-not-allowed', 'illegal-target', 'illegal-choice', 'insufficient-energy', 'unsupported-card'].includes(result.code)) {
        rejected.add(next.command.commandId);
      } else throw new Error(`AI 命令失败：${result.message}`);
    }
    set({ status: state.paused ? 'idle' : 'thinking' });
  };
  const wake = () => {
    if (disposed || state.paused || state.status === 'error') return;
    set({ status: 'thinking' }); schedule();
  };
  const unsubscribe = options.port.subscribe(wake);
  const handle: SoloAi = {
    pause: async () => {
      set({ paused: true });
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      await flight;
      if (!disposed && state.status !== 'error') set({ status: 'idle' });
    },
    resume: () => {
      if (disposed || state.status === 'error') return;
      set({ paused: false, status: 'thinking' }); schedule();
    },
    dispose: () => {
      disposed = true; unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined; listeners.clear();
      state = Object.freeze({ ...state, paused: true, status: state.status === 'error' ? 'error' : 'idle' });
    },
    getState: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return handle;
}
