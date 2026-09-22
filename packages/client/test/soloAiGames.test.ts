// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SOLO_OPPONENTS, soloDeckDocument, type MatchSeat, type MatchClientMessage } from '@ptcg/protocol';
import { MatchSession } from '../../service/src/match.ts';
import { PRODUCTION_ABILITY_EFFECTS, PRODUCTION_ATTACK_EFFECTS, PRODUCTION_TOOL_EFFECTS } from '../../service/src/pokemonEffects.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from '../../service/src/trainerEffects.ts';
import { localCatalog } from '../src/local/session.ts';
import { decideSoloAi } from '../src/solo/aiDecision.ts';
import { createSoloAi } from '../src/solo/aiScheduler.ts';
import { bindLocalMatchHost } from '../../service/src/localMatch.ts';
import { BufferedCryptoRandomSource } from '../../service/src/localRandom.ts';

const catalog = localCatalog();
function game(a: number, b: number, seed: number) {
  let state = seed >>> 0;
  return new MatchSession({ sessionId: `ai-${a}-${b}-${seed}`, catalog,
    decks: [soloDeckDocument(SOLO_OPPONENTS[a]!.presetId)!, soloDeckDocument(SOLO_OPPONENTS[b]!.presetId)!],
    nicknames: ['player', 'ai'], random: { nextInt: upper => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % upper; } },
    trainerEffects: PRODUCTION_TRAINER_EFFECTS, stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
    attackEffects: PRODUCTION_ATTACK_EFFECTS, abilityEffects: PRODUCTION_ABILITY_EFFECTS, toolEffects: PRODUCTION_TOOL_EFFECTS,
  });
}
describe('production strategies through ordinary authenticated commands', () => {
  const coverage = new Set<string>();
  const attacks = new Map<string, number>();
  const endings = new Map<string, number>();
  let completed = 0;
  const combinations = SOLO_OPPONENTS.flatMap((_, a) => SOLO_OPPONENTS.flatMap((_, b) => ([0, 1] as const).flatMap(first => [7, 191, 9021].map(seed => [a, b, first, seed] as const))));
  it.each(combinations)('player %i vs AI %i first %i seed %i', (a, b, first, seed) => {
    const session = game(a, b, seed);
    const handles = [session.handleFor(0), session.handleFor(1)] as const;
    const accepted: { seat: MatchSeat; command: MatchClientMessage }[] = [];
    const rejections: string[] = [];
    for (let step = 0; step < 2200 && !session.result; step++) {
      const views = handles.map(h => session.viewFor(h));
      const seat = (views.findIndex(v => v.pendingChoice) >= 0 ? views.findIndex(v => v.pendingChoice) : views[0]!.activeSeat) as MatchSeat;
      const view = views[seat]!;
      const candidates = decideSoloAi(view, SOLO_OPPONENTS[seat === 0 ? a : b]!.id, catalog);
      let success = false;
      for (const { command: original } of candidates) {
        const command = original.type === 'choose-turn-order' ? { ...original, goFirst: seat === first } : original;
        const result = session.submit(handles[seat], command);
        if (result.ok) { accepted.push({ seat, command }); success = true; break; }
        rejections.push(`${command.type}: ${result.code} ${result.message}`);
      }
      expect(success, `turn ${view.turn} choice ${view.pendingChoice?.kind}; rejected: ${rejections.slice(-10).join(';')}`).toBe(true);
    }
    expect(session.result, `commands ${accepted.length}`).not.toBeNull();
    expect(session.viewFor(handles[0]).result).toEqual(session.viewFor(handles[1]).result);
    expect(session.result?.reason).not.toBe('concede');
    const events = session.viewFor(handles[0]).events;
    expect(events.some(e => e.type === 'attack-used' && e.damage > 0), JSON.stringify({ result: session.result, attacks: events.filter(e => e.type === 'attack-used'), sides: [session.viewFor(handles[0]).you, session.viewFor(handles[1]).you], rejections: rejections.slice(-10) })).toBe(true);
    expect(accepted.some(e => e.command.type === 'attach-energy')).toBe(true);
    expect(accepted.some(e => e.command.type === 'play-basic')).toBe(true);
    // A game that simply passes until deck-out is not strategy acceptance.
    expect(accepted.filter(e => e.command.type === 'attack').length).toBeGreaterThan(1);
    for (const { command } of accepted) coverage.add(command.type);
    for (const event of events) if (event.type === 'attack-used') attacks.set(event.attackName, (attacks.get(event.attackName) ?? 0) + 1);
    endings.set(session.result!.reason, (endings.get(session.result!.reason) ?? 0) + 1);
    completed++;
  });
  afterAll(() => {
    if (completed !== combinations.length) return;
    for (const type of ['evolve', 'use-ability', 'play-trainer', 'discard-hand', 'search-deck', 'choose-mode', 'discard-energy', 'choose-replacement', 'take-prizes', 'retreat']) expect(coverage.has(type), type).toBe(true);
    for (const name of ['极巨和弦', '冰雹利刃', '贪欲藤蔓', '森林燃烧']) expect(attacks.get(name), name).toBeGreaterThan(0);
    console.info('AI matrix:', JSON.stringify({ completed, endings: Object.fromEntries(endings), attacks: Object.fromEntries(attacks), commands: [...coverage] }));
  });
});

describe('real local ports with production schedulers', () => {
  it.each([[0, 1], [1, 2], [2, 0]])('AI %i vs AI %i yields, persists and finishes without a human choice', async (a, b) => {
    vi.useFakeTimers();
    const session = game(a!, b!, 191);
    let saves = 0;
    const host = bindLocalMatchHost(session, new BufferedCryptoRandomSource(), async () => { await Promise.resolve(); saves++; });
    const ais = host.players.map((port, i) => createSoloAi({ port, opponentId: SOLO_OPPONENTS[i === 0 ? a! : b!]!.id, catalog }));
    try {
      ais.forEach(ai => ai.resume());
      for (let ticks = 0; ticks < 2200 && !session.result; ticks++) {
        await vi.advanceTimersByTimeAsync(10);
        for (const ai of ais) expect(ai.getState().error).toBeNull();
        if (ticks === 12) {
          await Promise.all(ais.map(ai => ai.pause()));
          const version = session.version;
          await vi.advanceTimersByTimeAsync(1000);
          expect(session.version).toBe(version);
          ais.forEach(ai => ai.resume());
        }
      }
      expect(session.result).not.toBeNull();
      expect(saves).toBeGreaterThan(20);
      await vi.advanceTimersByTimeAsync(50);
      expect(ais.every(ai => ai.getState().status === 'idle')).toBe(true);
    } finally { ais.forEach(ai => ai.dispose()); host.dispose(); vi.useRealTimers(); }
  });
});
