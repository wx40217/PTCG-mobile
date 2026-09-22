// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchClientMessage } from '@ptcg/protocol';
import { localCatalog, type LocalPlayerPort } from '../src/local/session.ts';
import { SOLO_AI_VERSION, decideSoloAi } from '../src/solo/aiDecision.ts';
import { createSoloAi, type SoloAi } from '../src/solo/aiScheduler.ts';
import { createSoloSessionManager, type SavedSoloMatch } from '../src/solo/soloSession.ts';
import type { SoloRawRecord, SoloStorage } from '../src/solo/soloStorage.ts';

const catalog = localCatalog();
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function disk(initial: SoloRawRecord = { current: null, previous: null, ledger: null }) {
  let record: SoloRawRecord = JSON.parse(JSON.stringify(initial));
  let gate: { entered: ReturnType<typeof deferred>; finish: ReturnType<typeof deferred>; fail: boolean } | undefined;
  let commits = 0;
  const storage: SoloStorage = {
    read: async () => JSON.parse(JSON.stringify(record)) as SoloRawRecord,
    commit: async ({ expected, next, ledger, preservePrevious }) => {
      if (gate) {
        const currentGate = gate; gate = undefined;
        currentGate.entered.resolve();
        await currentGate.finish.promise;
        if (currentGate.fail) throw new Error('simulated transaction interruption');
      }
      if (expected !== record.current) throw new Error('CAS conflict');
      record = { current: next, previous: preservePrevious ? record.previous : record.current, ledger };
      commits++;
    },
  };
  return { storage, get record() { return JSON.parse(JSON.stringify(record)) as SoloRawRecord; }, get commits() { return commits; },
    blockNext: (fail: boolean) => { gate = { entered: deferred(), finish: deferred(), fail }; return gate; },
  };
}
function manager(storage: SoloStorage) { return createSoloSessionManager({ storage, strategyVersion: SOLO_AI_VERSION }); }

/** Trusted entry assembly watches the durable lifecycle separately from private seat snapshots. */
function assemble(saved: SavedSoloMatch, includePlayerDriver = false, observe?: (command: MatchClientMessage) => void) {
  const ais: SoloAi[] = [];
  let displayedError: string | null = null;
  const unsubscribe = saved.subscribe(() => {
    const state = saved.getState();
    if (state.status !== 'active') {
      displayedError = state.error;
      ais.forEach(ai => ai.dispose());
    }
  });
  for (const seat of includePlayerDriver ? [0, 1] as const : [1] as const) {
    const own = saved.players[seat];
    const port: LocalPlayerPort = { view: own.view, subscribe: own.subscribe, submit: command => { observe?.(command); return own.submit(command); } };
    ais.push(createSoloAi({ port, opponentId: seat === 0 ? 'linyue' : saved.summary.opponentId, catalog }));
  }
  return { ais, get displayedError() { return displayedError; }, dispose: () => { unsubscribe(); ais.forEach(ai => ai.dispose()); } };
}

afterEach(() => { vi.restoreAllMocks(); });
describe('real durable manager and AI assembly', () => {
  it('another seat save failure is displayed and disposes the AI that was waiting for publication', async () => {
    const store = disk(); const owner = manager(store.storage);
    const saved = await owner.start({ presetId: 'solo-a-v1', opponentId: 'yansen', nickname: '玩家' });
    const assembly = assemble(saved);
    try {
      const prior = store.record;
      const view = saved.players[0].view();
      const gate = store.blockNext(true);
      // Human concession is legal in any phase, independent of the randomly chosen opening owner.
      const submitting = saved.players[0].submit({ type: 'concede', commandId: 'human-failed-save', sessionId: view.sessionId, expectedVersion: view.version }).catch(error => error as Error);
      await gate.entered.promise;
      assembly.ais[0]!.resume();
      for (let i = 0; i < 3; i++) await tick();
      expect(assembly.ais[0]!.getState()).toMatchObject({ status: 'idle', paused: false, error: null });
      gate.finish.resolve();
      expect(await submitting).toBeInstanceOf(Error);
      expect(saved.getState()).toMatchObject({ status: 'error' });
      expect(assembly.displayedError).toContain('写入失败');
      expect(assembly.ais[0]!.getState()).toMatchObject({ paused: true });
      expect(() => saved.players[1].view()).toThrow('已停止');
      expect(store.record).toEqual(prior);
      assembly.ais[0]!.resume(); await tick();
      expect(assembly.ais[0]!.getState().paused).toBe(true);
      expect((await manager(store.storage).inspect()).stats.yansen).toEqual({ wins: 0, losses: 0, draws: 0 });
    } finally { assembly.dispose(); owner.dispose(); }
  });

  it('pause waits for a real in-flight save; a JSON restore replays the acknowledged command without a second commit', async () => {
    const store = disk(); const owner = manager(store.storage);
    const saved = await owner.start({ presetId: 'solo-a-v1', opponentId: 'yansen', nickname: '玩家' });
    const seat = saved.players[0].view().pendingChoice ? 0 : 1;
    const opponentId = seat === 0 ? 'linyue' : 'yansen';
    let lastCommand: MatchClientMessage | undefined;
    const port = saved.players[seat];
    const ai = createSoloAi({ port: { ...port, submit: command => { lastCommand = command; return port.submit(command); } }, opponentId, catalog });
    try {
      const gate = store.blockNext(false);
      ai.resume(); await gate.entered.promise;
      let paused = false;
      const pausing = ai.pause().then(() => { paused = true; });
      await tick(); expect(paused).toBe(false);
      gate.finish.resolve(); await pausing;
      const persistedView = port.view();
      const count = store.commits;
      await tick(); expect(store.commits).toBe(count);
      ai.dispose(); owner.dispose();
      const restoredDisk = disk(store.record);
      const restoredManager = manager(restoredDisk.storage);
      const restored = await restoredManager.continue();
      try {
        expect(restored.players[seat].view()).toEqual(persistedView);
        const duplicated = await restored.players[seat].submit(lastCommand!);
        expect(duplicated).toMatchObject({ ok: true, duplicate: true, version: persistedView.version });
        expect(restoredDisk.commits).toBe(0);
        expect(restored.players[seat].view()).toEqual(persistedView);
        expect(decideSoloAi(restored.players[seat].view(), opponentId, catalog)).toEqual(decideSoloAi(persistedView, opponentId, catalog));
      } finally { restoredManager.dispose(); }
    } finally { ai.dispose(); owner.dispose(); }
  });

  it('finishes a fully saved AI game across three fresh-manager JSON restores, without repeated actions or result counting', async () => {
    // Test-only reproducible entropy at the platform seam; neither strategy nor manager receives a seed.
    let entropy = 191;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (!(array instanceof Uint32Array) && !(array instanceof Uint8Array)) throw new Error('Unexpected entropy request');
      for (let i = 0; i < array.length; i++) { entropy = (Math.imul(entropy, 1664525) + 1013904223) >>> 0; array[i] = entropy; }
      return array;
    });
    let store = disk(), owner = manager(store.storage);
    let saved = await owner.start({ presetId: 'solo-a-v1', opponentId: 'yansen', nickname: '玩家' });
    const sessionId = saved.summary.sessionId;
    const ids = new Map<string, string>();
    const observe = (command: MatchClientMessage) => {
      expect(ids.has(command.commandId), `unexpected repeated submission ${command.commandId}`).toBe(false);
      ids.set(command.commandId, JSON.stringify(command));
    };
    let assembly = assemble(saved, true, observe);
    let restored = 0;
    try {
      assembly.ais.forEach(ai => ai.resume());
      for (let step = 0; step < 2400 && !saved.summary.result; step++) {
        await tick();
        expect(saved.getState().error).toBeNull();
        for (const ai of assembly.ais) expect(ai.getState().error).toBeNull();
        // summary is committed state; never inspect a port while its peer is publishing.
        if (restored < 3 && ids.size >= [15, 40, 70][restored]!) {
          await Promise.all(assembly.ais.map(ai => ai.pause()));
          const views = saved.players.map(port => port.view());
          const before = store.commits;
          await tick(); expect(store.commits).toBe(before);
          assembly.dispose(); owner.dispose();
          store = disk(store.record); owner = manager(store.storage);
          saved = await owner.continue();
          expect(saved.summary.sessionId).toBe(sessionId);
          expect(saved.players.map(port => port.view())).toEqual(views);
          expect(store.commits).toBe(0);
          assembly = assemble(saved, true, observe); restored++;
          assembly.ais.forEach(ai => ai.resume());
        }
      }
      await Promise.all(assembly.ais.map(ai => ai.pause()));
      expect(restored).toBe(3);
      expect(saved.summary.result).not.toBeNull();
      expect(saved.summary.result!.reason).not.toBe('concede');
      const finalView = saved.players[0].view();
      expect(finalView.events.some(e => e.type === 'attack-used' && e.damage > 0)).toBe(true);
      expect(saved.players[1].view().result).toEqual(finalView.result);
      const inspection = await owner.inspect();
      const results = inspection.stats.yansen;
      expect(results.wins + results.losses + results.draws).toBe(1);
      assembly.dispose(); owner.dispose();
      store = disk(store.record); owner = manager(store.storage);
      const finished = await owner.continue();
      expect(finished.players[0].view()).toEqual(finalView);
      expect((await owner.inspect()).stats).toEqual(inspection.stats);
      expect(store.commits).toBe(0);
    } finally { assembly.dispose(); owner.dispose(); }
  }, 45_000);
});
