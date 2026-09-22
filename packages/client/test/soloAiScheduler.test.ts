import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchClientMessage, MatchView } from '@ptcg/protocol';
import { localCatalog, type LocalPlayerPort, type MatchSubmitResult } from '../src/local/session.ts';
import { createSoloAi } from '../src/solo/aiScheduler.ts';
import { decideSoloAi } from '../src/solo/aiDecision.ts';
import { matchView, matchSide } from './matchHelpers.ts';

const catalog = localCatalog();
function opening(): MatchView {
  return matchView({ phase: 'turn-order', pendingChoice: { choiceId: 'c1', seat: 0, kind: 'turn-order', min: 0, max: 1, benchMin: 0, benchMax: 0, candidates: [], cardCandidates: [], modes: [], source: 'none', step: 1, stepCount: 1, descriptionZh: '' } });
}
function fake(initial: MatchView, submit?: (command: MatchClientMessage) => Promise<MatchSubmitResult>) {
  let current = initial;
  const listeners = new Set<() => void>();
  const port: LocalPlayerPort = { view: vi.fn(() => structuredClone(current)),
    submit: vi.fn(submit ?? (async (): Promise<MatchSubmitResult> => {
      current = { ...current, version: current.version + 1, pendingChoice: null, waitingForOpponentChoice: true };
      for (const listener of listeners) listener();
      return { ok: true, version: current.version, duplicate: false, view: current };
    })),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { port, update: (v: MatchView) => { current = v; for (const listener of listeners) listener(); }, listeners };
}
afterEach(() => { vi.useRealTimers(); });
describe('bounded subscribe-driven AI lifecycle', () => {
  it('a pause/dispose from a thinking observer happens before any submission', async () => {
    vi.useFakeTimers();
    for (const mode of ['pause', 'dispose'] as const) {
      const { port } = fake(opening());
      const ai = createSoloAi({ port, opponentId: 'linyue', catalog });
      ai.resume();
      ai.subscribe(() => { if (!ai.getState().paused && ai.getState().status === 'thinking') void ai[mode](); });
      await vi.advanceTimersByTimeAsync(100);
      expect(port.submit).not.toHaveBeenCalled(); ai.dispose();
    }
  });
  it('waits for a saved-state notification when another command is publishing', async () => {
    vi.useFakeTimers();
    const { port, update } = fake(opening());
    vi.mocked(port.view).mockImplementationOnce(() => { throw new Error('本地会话正在提交，请等待状态通知。'); });
    const ai = createSoloAi({ port, opponentId: 'linyue', catalog }); ai.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.view).toHaveBeenCalledTimes(1); expect(port.submit).not.toHaveBeenCalled();
    expect(ai.getState()).toMatchObject({ status: 'idle', error: null });
    update(opening()); await vi.advanceTimersByTimeAsync(100);
    expect(port.submit).toHaveBeenCalledTimes(1); ai.dispose();
  });
  it('starts paused, yields before acting, sleeps on opponent turn and wakes on notification', async () => {
    vi.useFakeTimers();
    const { port, update } = fake(opening());
    const ai = createSoloAi({ port, opponentId: 'linyue', catalog });
    await vi.advanceTimersByTimeAsync(500);
    expect(port.submit).not.toHaveBeenCalled();
    ai.resume(); expect(ai.getState().status).toBe('thinking');
    expect(port.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(port.submit).toHaveBeenCalledTimes(1);
    expect(ai.getState().status).toBe('idle');
    const reads = vi.mocked(port.view).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(port.view).mock.calls.length).toBe(reads);
    update({ ...opening(), version: 10 });
    await vi.advanceTimersByTimeAsync(50);
    expect(port.submit).toHaveBeenCalledTimes(2);
    ai.dispose();
  });
  it('pause waits for in-flight persistence; resume/dispose never submit an extra action', async () => {
    vi.useFakeTimers();
    let acknowledge!: (result: MatchSubmitResult) => void;
    const { port, update, listeners } = fake(opening(), () => new Promise(resolve => { acknowledge = resolve; }));
    const ai = createSoloAi({ port, opponentId: 'linyue', catalog });
    ai.resume(); await vi.advanceTimersByTimeAsync(8);
    let paused = false;
    const wait = ai.pause().then(() => { paused = true; });
    await Promise.resolve(); expect(paused).toBe(false);
    const saved = { ...opening(), pendingChoice: null, waitingForOpponentChoice: true, version: 4 };
    update(saved);
    acknowledge({ ok: true, duplicate: false, view: saved, version: 4 });
    await wait; expect(paused).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); expect(port.submit).toHaveBeenCalledTimes(1);
    ai.resume(); ai.dispose(); update(opening());
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.submit).toHaveBeenCalledTimes(1); expect(listeners.size).toBe(0);
  });
  it('disposal during submission permits its acknowledgement but cannot restart scheduling', async () => {
    vi.useFakeTimers();
    let acknowledge!: (result: MatchSubmitResult) => void;
    const { port } = fake(opening(), () => new Promise(resolve => { acknowledge = resolve; }));
    const ai = createSoloAi({ port, opponentId: 'linyue', catalog });
    ai.resume(); await vi.advanceTimersByTimeAsync(8); ai.dispose();
    acknowledge({ ok: true, duplicate: false, view: opening(), version: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.submit).toHaveBeenCalledTimes(1);
    expect(ai.getState()).toMatchObject({ status: 'idle', paused: true });
  });
  it('same-state recreation emits the same ID and payload; ordinary duplicate acknowledgement is safe', async () => {
    vi.useFakeTimers();
    const command = decideSoloAi(opening(), 'linyue', catalog)[0]!.command;
    for (let restore = 0; restore < 2; restore++) {
      const { port, update } = fake(opening(), async input => {
        expect(input).toEqual(command);
        const saved = { ...opening(), version: 4, pendingChoice: null, waitingForOpponentChoice: true };
        update(saved);
        return { ok: true, duplicate: restore === 1, version: 4, view: saved };
      });
      const ai = createSoloAi({ port, opponentId: 'linyue', catalog });
      ai.resume(); await vi.advanceTimersByTimeAsync(100);
      expect(port.submit).toHaveBeenCalledTimes(1); expect(ai.getState().status).toBe('idle'); ai.dispose();
    }
  });
  it('a rejected mandatory choice is not repeated; persistent stale state and save failure stop explicitly', async () => {
    vi.useFakeTimers();
    for (const code of ['illegal-choice', 'stale-version', 'save-error'] as const) {
      const { port } = fake(opening(), async () => {
        if (code === 'save-error') throw new Error('磁盘写入失败');
        return { ok: false, code, message: code, version: 3, view: opening() };
      });
      const ai = createSoloAi({ port, opponentId: 'linyue', catalog });
      ai.resume(); await vi.advanceTimersByTimeAsync(1000);
      expect(ai.getState().status).toBe('error');
      const calls = vi.mocked(port.submit).mock.calls.length;
      expect(calls).toBe(code === 'stale-version' ? 3 : 1);
      ai.resume(); await vi.advanceTimersByTimeAsync(10_000);
      expect(port.submit).toHaveBeenCalledTimes(calls); ai.dispose();
    }
  });
  it('resynchronizes after a stale command and enumerates rejected candidates once per version', async () => {
    vi.useFakeTimers();
    const v = matchView({ phase: 'playing', turn: 3, activeSeat: 0, you: matchSide(0), stadium: { cardId: 'csv2c-127', nameZh: '深钵镇', kind: 'trainer', classLabelZh: '训练家', isBasicPokemon: false, evolvesFrom: null, type: null, hp: null, printDisplayNumber: '' } });
    const { port, update } = fake(v, async command => {
      if (command.expectedVersion === 3) { const fresh = { ...v, version: 4 }; update(fresh); return { ok: false, code: 'stale-version', message: 'stale', version: 4, view: fresh }; }
      if (command.type === 'use-stadium') return { ok: false, code: 'action-not-allowed', message: 'no eligible cards', version: 4 };
      update({ ...v, version: 5, activeSeat: 1 });
      return { ok: true, duplicate: false, version: 5, view: port.view() };
    });
    const ai = createSoloAi({ port, opponentId: 'linyue', catalog }); ai.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(port.submit).mock.calls.map(c => [c[0].expectedVersion, c[0].type])).toEqual([[3, 'use-stadium'], [4, 'use-stadium'], [4, 'end-turn']]);
    expect(ai.getState().status).toBe('idle'); ai.dispose();
  });
});
