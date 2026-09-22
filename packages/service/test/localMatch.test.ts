import { describe, expect, it, vi } from 'vitest';
import { presetDeckDocument, type MatchClientMessage, type MatchSeat } from '@ptcg/protocol';
import { bindLocalMatchHost, createLocalMatchHost } from '../src/localMatch.ts';
import { BufferedCryptoRandomSource } from '../src/localRandom.ts';
import { MatchSession } from '../src/match.ts';
import { PRODUCTION_TRAINER_EFFECTS } from '../src/trainerEffects.ts';
import { OpeningHandScript, SequenceRandomSource, deckDocumentFromCardsWith, releaseCatalogContent } from './support/matchTestKit.ts';

const catalog = releaseCatalogContent();
function options() {
  const deck = presetDeckDocument(catalog.decks[0]!, catalog)!;
  return { catalog, catalogVersion: 'test-version', decks: [deck, deck] as const, nicknames: ['a', 'b'] as const };
}
function concede(host: ReturnType<typeof createLocalMatchHost>): MatchClientMessage {
  return { type: 'concede', sessionId: host.session.sessionId, expectedVersion: host.session.version, commandId: 'concede-once' };
}

describe('local trusted host', () => {
  it('validates real decks and does not accept an unsupported or incomplete deck', () => {
    const config = options();
    expect(() => createLocalMatchHost({ ...config, decks: [{ ...config.decks[0], cards: [] }, config.decks[1]] })).toThrow();
  });

  it('waits for the atomic checkpoint barrier before returning results or notifying either seat', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const saved = new Promise<void>((resolve) => { release = resolve; });
    const host = createLocalMatchHost({ ...options(), beforePublish: async () => { entered(); await saved; } });
    const notify = vi.fn();
    host.players[0].subscribe(notify);
    host.players[1].subscribe(notify);
    const command = concede(host);
    const first = host.players[0].submit(command);
    const retry = host.players[0].submit(command);
    await started;
    expect(notify).not.toHaveBeenCalled();
    expect(() => host.players[0].view()).toThrow('正在提交');
    release();
    expect(await first).toMatchObject({ ok: true, duplicate: false });
    expect(await retry).toMatchObject({ ok: true, duplicate: true });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(host.players[0].view().result).toEqual(host.players[1].view().result);
  });

  it('fails closed on a save error without publishing the advanced state or executing queued work', async () => {
    const host = createLocalMatchHost({ ...options(), beforePublish: async () => { throw new Error('disk full'); } });
    const notify = vi.fn();
    host.players[0].subscribe(notify);
    const command = concede(host);
    const first = host.players[0].submit(command);
    const next = host.players[0].submit(command);
    await expect(first).rejects.toThrow('disk full');
    await expect(next).rejects.toThrow('已停止');
    expect(notify).not.toHaveBeenCalled();
    expect(() => host.players[0].view()).toThrow('已停止');
  });

  it('matches service session semantics through paid search choices and a complete deck-out game', async () => {
    const fish = 'csve1-035', ball = 'cbb1c-1703', moon = 'csve1-057', water = 'cbb1c-1803';
    const cards = [fish, fish, fish, fish, ball, ball, ball, ball, moon, moon, moon, moon, ...Array<string>(48).fill(water)];
    const script = new OpeningHandScript([cards, cards]);
    for (const seat of [0, 1] as const) script.planHand(seat, [fish, ball, ...Array<string>(5).fill(water)], Array<string>(6).fill(water));
    const make = () => new MatchSession({ sessionId: 'local-parity', catalog,
      decks: [deckDocumentFromCardsWith(cards, catalog), deckDocumentFromCardsWith(cards, catalog)],
      nicknames: ['a', 'b'], trainerEffects: PRODUCTION_TRAINER_EFFECTS,
      random: new SequenceRandomSource([0, ...script.outputs, ...Array<number>(200).fill(0)]),
    });
    const remote = make();
    const host = bindLocalMatchHost(make(), new BufferedCryptoRandomSource());
    let id = 0;
    const send = async (seat: MatchSeat, body: Record<string, unknown>) => {
      const view = host.players[seat].view();
      const command = { sessionId: view.sessionId, expectedVersion: view.version, commandId: `parity-${++id}`, ...body } as MatchClientMessage;
      const expected = remote.submit(remote.handleFor(seat), command);
      const actual = await host.players[seat].submit(command);
      expect(actual).toEqual(expected);
      expect(actual.ok).toBe(true);
      for (const side of [0, 1] as const) expect(host.players[side].view()).toEqual(remote.viewFor(remote.handleFor(side)));
    };
    for (let i = 0; i < 20 && host.players[0].view().phase !== 'playing'; i++) {
      const seat = ([0, 1] as const).find((s) => host.players[s].view().pendingChoice)!;
      const view = host.players[seat].view();
      const choice = view.pendingChoice!;
      const body = choice.kind === 'turn-order' ? { type: 'choose-turn-order', goFirst: true }
        : choice.kind === 'place-setup' ? { type: 'place-setup', active: 0, bench: [] }
        : choice.kind === 'compensation-draw' ? { type: 'resolve-compensation', draw: 0 }
        : { type: 'place-bench', bench: [] };
      await send(seat, { ...body, choiceId: choice.choiceId });
    }
    expect(host.players[0].view().phase).toBe('playing');
    await send(0, { type: 'play-trainer', handIndex: host.players[0].view().you.hand.findIndex((c) => c.cardId === ball) });
    let choice = host.players[0].view().pendingChoice!;
    expect(choice.kind).toBe('discard-hand');
    await send(0, { type: 'discard-hand', choiceId: choice.choiceId, handIndices: choice.candidates.slice(0, 2) });
    choice = host.players[0].view().pendingChoice!;
    expect(choice.kind).toBe('search-deck');
    expect(host.players[1].view().pendingChoice).toBeNull();
    expect(host.players[0].view().you.discard).toHaveLength(3);
    await send(0, { type: 'search-deck', choiceId: choice.choiceId, candidateIds: [] });
    for (let turn = 0; turn < 110 && host.players[0].view().result === null; turn++) {
      await send(host.players[0].view().activeSeat!, { type: 'end-turn' });
    }
    expect(host.players[0].view().result).not.toBeNull();
  });
});

describe('checkpointable local entropy', () => {
  it('preserves buffered draws and rejects malformed checkpoints', () => {
    const random = new BufferedCryptoRandomSource();
    random.nextInt(60);
    const checkpoint = random.snapshot();
    const restored = BufferedCryptoRandomSource.restore(checkpoint);
    expect(Array.from({ length: 100 }, () => restored.nextInt(59))).toEqual(Array.from({ length: 100 }, () => random.nextInt(59)));
    for (const broken of [{ ...checkpoint, cursor: -1 }, { ...checkpoint, words: [1] }, { ...checkpoint, algorithm: 'unknown' }]) {
      expect(() => BufferedCryptoRandomSource.restore(broken as typeof checkpoint)).toThrow();
    }
  });
  it('rejects biased tail values and refills exactly at the saved boundary', () => {
    const words = Array<number>(256).fill(0);
    words[254] = 0xffff_ffff; words[255] = 8;
    const random = BufferedCryptoRandomSource.restore({ algorithm: 'webcrypto-pool-v1', words, cursor: 254 });
    expect(random.nextInt(3)).toBe(2); // 2^32-1 rejected, then 8 % 3.
    const restored = BufferedCryptoRandomSource.restore(random.snapshot());
    expect(restored.snapshot().cursor).toBe(256);
    expect(restored.nextInt(1)).toBe(0);
    expect(restored.snapshot().cursor).toBe(1);
    expect(restored.snapshot().words).toHaveLength(256);
  });
});
