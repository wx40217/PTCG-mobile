import { describe, expect, it, vi } from 'vitest';
import { createLocalMatch, localCatalog } from '../src/local/session.ts';
import type { MatchClientMessage } from '@ptcg/protocol';

describe('bundled offline match', () => {
  it('starts with network and storage unavailable, with complete text and all existing recipes', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const catalog = localCatalog();
      expect(catalog.decks.map((deck) => deck.code)).toEqual(['A', 'B', 'C', 'D']);
      expect(catalog.cards.every((card) => card.fullTextZh.length > 0)).toBe(true);
      const match = await createLocalMatch({ presetIds: ['A', 'D'], nicknames: ['玩家', '对手'] });
      expect(Object.keys(match).sort()).toEqual(['dispose', 'players']);
      expect(Object.keys(match.players[0]).sort()).toEqual(['submit', 'subscribe', 'view']);
      expect(match.players[0].view().sessionId).toBe(match.players[1].view().sessionId);
      expect(network).not.toHaveBeenCalled();
      const snapshots = match.players.map((player) => player.view());
      expect(JSON.stringify(snapshots)).not.toMatch(/"(?:seed|words|cursor|token|instanceId)"/);
      match.dispose();
      expect(() => match.players[0].view()).toThrow();
    } finally { network.mockRestore(); }
  });

  it('rejects unknown presets and detaches the catalog from caller changes', async () => {
    const catalog = localCatalog();
    (catalog.cards as unknown[]).length = 0;
    expect(localCatalog().cards.length).toBeGreaterThan(0);
    await expect(createLocalMatch({ presetIds: ['invented', 'A'], nicknames: ['a', 'b'] })).rejects.toThrow('未知预设');
  });

  it('enforces seat, routing, version, parser and idempotency without a room timer', async () => {
    const match = await createLocalMatch({ presetIds: ['A', 'B'], nicknames: ['a', 'b'] });
    const owner = match.players[0].view().pendingChoice ? 0 : 1;
    const player = match.players[owner];
    const view = player.view();
    const command: MatchClientMessage = {
      type: 'choose-turn-order', commandId: 'offline-choice-1', sessionId: view.sessionId,
      expectedVersion: view.version, choiceId: view.pendingChoice!.choiceId, goFirst: true,
    };
    expect(await match.players[1 - owner]!.submit(command)).toMatchObject({ ok: false, code: 'not-your-choice' });
    expect(await player.submit({ ...command, expectedVersion: 999 })).toMatchObject({ ok: false, code: 'stale-version' });
    expect(await player.submit({ ...command, sessionId: 'other' })).toMatchObject({ ok: false, code: 'match-not-found' });
    expect(await player.submit({ ...command, seed: 123 } as MatchClientMessage)).toMatchObject({ ok: false });
    const changes = vi.fn();
    const unsubscribe = player.subscribe(changes);
    const accepted = await player.submit(command);
    expect(accepted.ok).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(await player.submit(command)).toEqual({ ...accepted, duplicate: true });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(await player.submit({ ...command, goFirst: false })).toMatchObject({ ok: false, code: 'command-id-reused' });
    // Mutating an acknowledged view cannot corrupt dedup or the engine.
    if (accepted.ok) (accepted.view.events as unknown[]).length = 0;
    expect((await player.submit(command))).not.toEqual({ ...accepted, duplicate: true });
    unsubscribe();
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(181_000);
      expect(player.view().result).toBeNull();
    } finally { vi.useRealTimers(); match.dispose(); }
  });
});
