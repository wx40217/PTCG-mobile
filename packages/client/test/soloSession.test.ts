import { describe, expect, it, vi } from 'vitest';
import { createSoloSessionManager } from '../src/solo/soloSession.ts';
import type { SoloStorage, SoloRawRecord } from '../src/solo/soloStorage.ts';

function storage() {
  let record: SoloRawRecord = { current: null, previous: null, ledger: null };
  let failure = false;
  let readFailure = false;
  const store: SoloStorage = {
    async read() { if (readFailure) throw new Error('read failure'); return structuredClone(record); },
    async commit({ expected, next, ledger, preservePrevious }) {
      if (failure) throw new Error('interrupted transaction');
      if (expected !== record.current) throw new Error('conflict');
      record = { current: next, previous: preservePrevious ? record.previous : record.current, ledger };
    },
  };
  return { store, get record() { return record; }, set record(value) { record = value; }, fail: () => { failure = true; }, readFail: () => { readFailure = true; } };
}
const input = { presetId: 'solo-a-v1', opponentId: 'canglan', nickname: '玩家' } as const;
function manager(store: SoloStorage, version = 'ai-test-v1') { return createSoloSessionManager({ storage: store, strategyVersion: version }); }
async function reseal(value: unknown) {
  const json = JSON.stringify(value);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return { json, sha256: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}

describe('durable solo lifecycle', () => {
  it('saves before first exposure and restores opening state/RNG without a second new game', async () => {
    const disk = storage();
    const first = await manager(disk.store).start(input);
    const view = first.players[0].view();
    const saved = disk.record.current;
    first.dispose();
    const next = manager(disk.store);
    expect(await next.inspect()).toMatchObject({ status: 'ready', summary: { sessionId: view.sessionId } });
    const resumed = await next.continue();
    expect(resumed.players[0].view()).toEqual(view);
    expect(disk.record.current).toBe(saved);
    await expect(next.start(input)).rejects.toThrow('已有单人存档');
    expect(Object.keys(resumed.players[0])).toEqual(['view', 'submit', 'subscribe']);
  });
  it('records normal concede once in the same commit, including lost acknowledgement and repeated result reopening', async () => {
    const disk = storage();
    const game = await manager(disk.store).start(input);
    const view = game.players[0].view();
    const command = { type: 'concede', sessionId: view.sessionId, expectedVersion: view.version, commandId: 'once' } as const;
    const accepted = await game.players[0].submit(command);
    game.dispose();
    const next = manager(disk.store);
    for (let i = 0; i < 3; i++) {
      const resumed = await next.continue();
      expect(await resumed.players[0].submit(command)).toEqual({ ...accepted, duplicate: true });
      expect(await next.inspect()).toMatchObject({ status: 'ready', stats: { canglan: { wins: 0, losses: 1, draws: 0 } } });
      resumed.dispose();
    }
    await next.discard({ confirmed: true });
    expect(await next.inspect()).toMatchObject({ status: 'empty', stats: { canglan: { losses: 1 } } });
  });
  it('failed first write exposes no game; failed advancement stops both seats and preserves the last checkpoint/count', async () => {
    const initial = storage(); initial.fail();
    await expect(manager(initial.store).start(input)).rejects.toThrow('写入失败');
    expect(initial.record.current).toBeNull();
    const disk = storage();
    const game = await manager(disk.store).start(input);
    const prior = disk.record.current;
    const view = game.players[0].view();
    const notify = vi.fn(); game.players[0].subscribe(notify);
    const lifecycle = vi.fn(); game.subscribe(lifecycle);
    disk.fail();
    await expect(game.players[0].submit({ type: 'concede', sessionId: view.sessionId, expectedVersion: view.version, commandId: 'failed' })).rejects.toThrow('写入失败');
    expect(notify).not.toHaveBeenCalled();
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(game.getState()).toMatchObject({ status: 'error', error: expect.stringContaining('写入失败') });
    expect(() => game.players[1].view()).toThrow('已停止');
    expect(disk.record.current).toBe(prior);
    expect(await manager(disk.store).inspect()).toMatchObject({ status: 'ready', stats: { canglan: { losses: 0 } } });
  });
  it('rejects old strategy/rules, distinguishes corrupt and I/O from absent, and does not overwrite', async () => {
    const disk = storage(); await manager(disk.store).start(input);
    const saved = disk.record.current;
    expect(await manager(disk.store, 'ai-v2').inspect()).toMatchObject({ status: 'incompatible' });
    await expect(manager(disk.store, 'ai-v2').continue()).rejects.toThrow('不兼容');
    expect(disk.record.current).toBe(saved);
    disk.record = { ...disk.record, current: '{broken' };
    expect(await manager(disk.store).inspect()).toMatchObject({ status: 'corrupt' });
    await expect(manager(disk.store).start(input)).rejects.toThrow();
    disk.readFail();
    expect(await manager(disk.store).inspect()).toMatchObject({ status: 'io-error' });
  });
  it('confirmed discard preserves independently checked ledger even when active match is damaged', async () => {
    const disk = storage(); const session = manager(disk.store);
    const first = await session.start(input);
    const view = first.players[0].view();
    await first.players[0].submit({ type: 'concede', sessionId: view.sessionId, expectedVersion: view.version, commandId: 'lost' });
    const raw = JSON.parse(disk.record.current!);
    raw.active.json = 'damaged';
    disk.record = { ...disk.record, current: JSON.stringify(raw) };
    expect(await session.inspect()).toMatchObject({ status: 'corrupt', stats: { canglan: { losses: 1 } } });
    await expect(session.discard({ confirmed: false } as never)).rejects.toThrow('明确确认');
    await session.discard({ confirmed: true });
    expect(await session.inspect()).toMatchObject({ status: 'empty', stats: { canglan: { losses: 1 } } });
  });
  it('rejects structurally corrupt state even with a recalculated checksum', async () => {
    const disk = storage(); await manager(disk.store).start(input);
    const raw = JSON.parse(disk.record.current!);
    const active = JSON.parse(raw.active.json);
    active.checkpoint.random.cursor = 999;
    raw.active = await reseal(active);
    disk.record = { ...disk.record, current: JSON.stringify(raw) };
    expect(await manager(disk.store).inspect()).toMatchObject({ status: 'corrupt' });
  });
  it('can explicitly discard a wholly unreadable match container while preserving the separate atomic ledger', async () => {
    const disk = storage(); const session = manager(disk.store);
    const game = await session.start(input); const view = game.players[0].view();
    await game.players[0].submit({ type: 'concede', sessionId: view.sessionId, expectedVersion: view.version, commandId: 'count' });
    disk.record = { ...disk.record, current: '{broken' };
    expect(await session.inspect()).toMatchObject({ status: 'corrupt', stats: { canglan: { losses: 1 } } });
    await session.discard({ confirmed: true });
    expect(await session.inspect()).toMatchObject({ status: 'empty', stats: { canglan: { losses: 1 } } });
  });
  it('concurrent resumed hosts cannot overwrite each other; abandoned games do not count as losses', async () => {
    const disk = storage(); const one = manager(disk.store); const two = manager(disk.store);
    const first = await one.start(input); const second = await two.continue();
    const view = first.players[0].view();
    await one.discard({ confirmed: true });
    await expect(second.players[0].submit({ type: 'concede', sessionId: view.sessionId, expectedVersion: view.version, commandId: 'late' })).rejects.toThrow('写入失败');
    expect(await one.inspect()).toMatchObject({ status: 'empty', stats: { canglan: { losses: 0 } } });
  });
});
