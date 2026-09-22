// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { MatchClientMessage, MatchSeat, DeckDocument } from '@ptcg/protocol';
import { MatchSession } from '../../service/src/match.ts';
import { PRODUCTION_ABILITY_EFFECTS, PRODUCTION_ATTACK_EFFECTS, PRODUCTION_TOOL_EFFECTS } from '../../service/src/pokemonEffects.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from '../../service/src/trainerEffects.ts';
import { localCatalog } from '../src/local/session.ts';
import { decideSoloAi } from '../src/solo/aiDecision.ts';

const catalog = localCatalog();
const V = 'csve1-062', WORM = 'csv3c-095', ENERGY = 'cbb2c-1102', BALL = 'cbb1c-1702';
// Test-only Fisher-Yates script; never imported by production strategy or runtime.
function planShuffleOutputsForOrder(initial: readonly string[], desired: readonly string[]): number[] {
  const current = [...initial], outputs: number[] = [];
  for (let i = desired.length - 1; i > 0; i--) {
    const j = current.lastIndexOf(desired[i]!, i);
    if (j < 0) throw new Error('Invalid fixture order');
    outputs.push(j); [current[i], current[j]] = [current[j]!, current[i]!];
  }
  return outputs;
}
function make(hiddenVariant: boolean) {
  const own = [V, WORM, ENERGY, ENERGY, ENERGY, BALL, BALL, ...Array.from({ length: 53 }, (_, i) => i % 2 ? ENERGY : BALL)];
  const opponent = [V, WORM, ENERGY, ENERGY, ENERGY, ENERGY, BALL, ...Array.from({ length: 53 }, (_, i) => i % 2 ? ENERGY : BALL)];
  const documents: DeckDocument[] = [own, opponent].map(cards => ({ formatVersion: 1, environmentId: catalog.environment.id,
    cards: [...new Set(cards)].map(cardId => ({ cardId, count: cards.filter(id => id === cardId).length,
      printIdentity: catalog.cards.find(c => c.id === cardId)!.identities.printIdentity,
      effectIdentity: catalog.cards.find(c => c.id === cardId)!.identities.effectIdentity,
    })),
  }));
  const desired = [own.slice(), opponent.slice()];
  if (hiddenVariant) {
    // Different opponent hand, both prize identities and both later deck orders.
    for (const [seat, a, b] of [[1, 2, 7], [0, 7, 8], [1, 9, 10], [0, 20, 21], [1, 20, 21]]) {
      const deck = desired[seat!]!; [deck[a!], deck[b!]] = [deck[b!]!, deck[a!]!];
    }
  }
  const output = [0, ...documents.flatMap((d, i) => planShuffleOutputsForOrder(d!.cards.flatMap(c => Array(c.count).fill(c.cardId) as string[]), desired[i]!))];
  let cursor = 0;
  const session = new MatchSession({ sessionId: 'same-public-session', catalog, decks: [documents[0]!, documents[1]!], nicknames: ['a', 'b'],
    random: { nextInt: upper => { const next = output[cursor++]; return next === undefined ? hiddenVariant ? upper - 1 : 0 : next; } },
    trainerEffects: PRODUCTION_TRAINER_EFFECTS, stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
    attackEffects: PRODUCTION_ATTACK_EFFECTS, abilityEffects: PRODUCTION_ABILITY_EFFECTS, toolEffects: PRODUCTION_TOOL_EFFECTS,
  });
  let seq = 0;
  const submit = (seat: MatchSeat, extra: object) => {
    const v = session.viewFor(session.handleFor(seat));
    const result = session.submit(session.handleFor(seat), { sessionId: v.sessionId, commandId: `opening-${seq++}`, expectedVersion: v.version, choiceId: v.pendingChoice!.choiceId, ...extra } as MatchClientMessage);
    expect(result.ok).toBe(true);
  };
  submit(0, { type: 'choose-turn-order', goFirst: true });
  for (let i = 0; i < 12; i++) {
    const owner = ([0, 1] as const).find(s => session.viewFor(session.handleFor(s)).pendingChoice);
    if (owner === undefined) break;
    const p = session.viewFor(session.handleFor(owner)).pendingChoice!;
    if (p.kind === 'place-setup') submit(owner, { type: 'place-setup', active: 0, bench: [1] });
    else if (p.kind === 'place-bench') submit(owner, { type: 'place-bench', bench: [] });
    else if (p.kind === 'compensation-draw') submit(owner, { type: 'resolve-compensation', draw: 0 });
    else throw new Error(`Unexpected ${p.kind}`);
  }
  return session;
}
describe('information boundary through actual private projections and submitted commands', () => {
  it('different hidden hands/prizes/deck order/future randomness yield identical decisions and commands', () => {
    const games = [make(false), make(true)];
    const views = games.map(s => s.viewFor(s.handleFor(0)));
    expect(views[0]!.phase).toBe('playing');
    expect(games[0]!.viewFor(games[0]!.handleFor(1)).you.hand).not.toEqual(games[1]!.viewFor(games[1]!.handleFor(1)).you.hand);
    expect(views[0]).toEqual(views[1]);
    expect(JSON.stringify(views[0])).not.toMatch(/"(?:seed|cursor|words|instanceId|token)"/u);
    const commands = views.map(v => decideSoloAi(v, 'linyue', catalog).map(d => d.command));
    expect(commands[0]).toEqual(commands[1]);
    for (let i = 0; i < games.length; i++) {
      const result = games[i]!.submit(games[i]!.handleFor(0), commands[i]![0]!);
      expect(result.ok).toBe(true);
    }
    expect(games[0]!.viewFor(games[0]!.handleFor(0))).toEqual(games[1]!.viewFor(games[1]!.handleFor(0)));
  });
});
