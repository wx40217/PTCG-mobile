import { beforeEach, afterEach, expect, vi } from 'vitest';
import { MatchSession, type MatchSessionConfig } from '../src/match.ts';
import { deckDocumentFromCardsWith } from './support/matchTestKit.ts';
// Run the existing rule expectations with a JSON checkpoint boundary before/after every command.
// This exercises real pending follow-ups, card object identity, Sets, dedup, settlement and costs.
import './matchEngine.test.ts';
import './matchTurns.test.ts';
import './matchSettlement.test.ts';
import './matchTrainers.test.ts';
import './matchPokemon.test.ts';
import './matchABDecks.test.ts';
import './matchDecksCd.test.ts';

beforeEach(() => {
  const submit = MatchSession.prototype.submit;
  const configs = new WeakMap<MatchSession, MatchSessionConfig>();
  function boundary(session: MatchSession): void {
    // Test-only introspection obtains the originally configured effects and script RNG.
    const internal = session as unknown as { engine: { state: any; cardsById: Map<string, any>; random: any }; dedup: unknown };
    let config = configs.get(session);
    if (!config) {
      const state = internal.engine.state;
      const catalog = { cards: [...internal.engine.cardsById.values()] } as MatchSessionConfig['catalog'];
      const ids = (player: any, seat: number): string[] => {
        const field = [player.active, ...player.bench].filter(Boolean);
        return [...player.deck, ...player.hand, ...player.prizes, ...player.discard,
          ...field.flatMap(p => [p.card, ...p.evolutionStack, ...p.energies, ...p.tools]),
          ...(state.stadium?.seat === seat ? [state.stadium.card] : [])].map(card => card.cardId);
      };
      config = { sessionId: session.sessionId, catalog, random: internal.engine.random,
        decks: [deckDocumentFromCardsWith(ids(state.players[0], 0), catalog), deckDocumentFromCardsWith(ids(state.players[1], 1), catalog)],
        nicknames: [state.players[0].nickname, state.players[1].nickname],
        attackEffects: state.attackEffects, trainerEffects: state.trainerEffects, stadiumEffects: state.stadiumEffects,
        abilityEffects: state.abilityEffects, toolEffects: state.toolEffects };
      configs.set(session, config);
    }
    const before = [session.viewFor(session.handleFor(0)), session.viewFor(session.handleFor(1))];
    const restored = MatchSession.restoreCheckpoint(JSON.parse(JSON.stringify(session.exportCheckpoint())), config);
    expect([restored.viewFor(restored.handleFor(0)), restored.viewFor(restored.handleFor(1))]).toEqual(before);
    const restoredInternal = restored as unknown as typeof internal;
    internal.engine = restoredInternal.engine;
    internal.dedup = restoredInternal.dedup;
  }
  vi.spyOn(MatchSession.prototype, 'submit').mockImplementation(function (this: MatchSession, handle, command) {
    boundary(this);
    const result = submit.call(this, handle, command);
    boundary(this);
    return result;
  });
});
afterEach(() => vi.restoreAllMocks());
