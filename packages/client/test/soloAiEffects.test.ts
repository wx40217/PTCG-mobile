// @vitest-environment node
import { expect, it } from 'vitest';
import type { DeckDocument, MatchClientMessage, MatchSeat } from '@ptcg/protocol';
import { MatchSession } from '../../service/src/match.ts';
import { PRODUCTION_ABILITY_EFFECTS, PRODUCTION_ATTACK_EFFECTS, PRODUCTION_TOOL_EFFECTS } from '../../service/src/pokemonEffects.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from '../../service/src/trainerEffects.ts';
import { localCatalog } from '../src/local/session.ts';
import { decideSoloAi } from '../src/solo/aiDecision.ts';

const catalog = localCatalog();
const MEW = 'csve1-056', WO = 'csv3c-015', ENERGY = 'cbb2c-1102';
function scriptedCopyGame() {
  const orders = [MEW, WO].map(id => [id, ...Array<string>(59).fill(ENERGY)]);
  const decks: DeckDocument[] = orders.map(ids => ({ formatVersion: 1, environmentId: catalog.environment.id, cards: [...new Set(ids)].map(cardId => ({
    cardId, count: ids.filter(id => id === cardId).length,
    printIdentity: catalog.cards.find(c => c.id === cardId)!.identities.printIdentity,
    effectIdentity: catalog.cards.find(c => c.id === cardId)!.identities.effectIdentity,
  })) }));
  // Identity Fisher-Yates order keeps the chosen lead in the opening hand.
  const randoms = [0, ...Array.from({ length: 59 }, (_, i) => 59 - i), ...Array.from({ length: 59 }, (_, i) => 59 - i)];
  let randomIndex = 0;
  return new MatchSession({ sessionId: 'ai-copy-effects', catalog, decks: [decks[0]!, decks[1]!], nicknames: ['ai', 'opponent'],
    random: { nextInt: () => randoms[randomIndex++] ?? 0 },
    trainerEffects: PRODUCTION_TRAINER_EFFECTS, stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
    attackEffects: PRODUCTION_ATTACK_EFFECTS, abilityEffects: PRODUCTION_ABILITY_EFFECTS, toolEffects: PRODUCTION_TOOL_EFFECTS,
  });
}
it('the AI pays three energy, declares Genome Hacking and resolves its actual copied attack through the session', () => {
  const session = scriptedCopyGame();
  const submit = (seat: MatchSeat, intent: object) => {
    const v = session.viewFor(session.handleFor(seat));
    const result = session.submit(session.handleFor(seat), { commandId: `fixture-${v.version}`, sessionId: v.sessionId, expectedVersion: v.version, ...intent } as MatchClientMessage);
    expect(result.ok).toBe(true);
  };
  // The opponent fixture passes; AI itself makes every opening and effect choice.
  const trace: MatchClientMessage[] = [];
  for (let step = 0; step < 40; step++) {
    const aiView = session.viewFor(session.handleFor(0));
    const other = session.viewFor(session.handleFor(1));
    if (aiView.events.some(e => e.type === 'attack-used' && e.damage > 0)) break;
    if (other.pendingChoice) {
      const p = other.pendingChoice;
      if (p.kind === 'place-setup') submit(1, { type: 'place-setup', choiceId: p.choiceId, active: 0, bench: [] });
      else if (p.kind === 'place-bench') submit(1, { type: 'place-bench', choiceId: p.choiceId, bench: [] });
      else throw new Error(`Unexpected opponent choice ${p.kind}`);
    } else if (other.activeSeat === 1 && !other.waitingForOpponentChoice) submit(1, { type: 'end-turn' });
    else {
      const candidates = decideSoloAi(aiView, 'linyue', catalog);
      let accepted = false;
      for (const { command } of candidates) {
        if (session.submit(session.handleFor(0), command).ok) { trace.push(command); accepted = true; break; }
      }
      expect(accepted).toBe(true);
    }
  }
  expect(trace.filter(c => c.type === 'attach-energy')).toHaveLength(3);
  expect(trace.find(c => c.type === 'attack')).toMatchObject({ attackIndex: 0 });
  expect(trace.find(c => c.type === 'choose-mode')).toMatchObject({ modeId: 'attack-1' });
  expect(session.viewFor(session.handleFor(0)).events).toContainEqual(expect.objectContaining({ type: 'attack-used', attackName: '基因侵入', damage: 220 }));
  expect(session.viewFor(session.handleFor(0)).opponent.active?.damageCounters).toBe(22);
});
