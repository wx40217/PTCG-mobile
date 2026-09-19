import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD, createFixtureMatch, fixtureConfig } from '../dist/src/index.js';
import {
  ScriptedRandom,
  commandFor,
  fails,
  findHandIndex,
  ok,
  standardFixture,
  submit,
  view,
} from '../testlib/helpers.mjs';

test('高级球: discard-2 cost and private deck search pause/resume', () => {
  const session = standardFixture({
    p1: {
      hand: [CARD.ultraBall, CARD.finneon, CARD.orthworm, CARD.waterEnergy, CARD.irida],
      deck: [CARD.hallOfDestiny, CARD.braveryCharm, CARD.waterEnergy, CARD.ultraBall],
      active: { cardKey: CARD.hallOfDestiny },
    },
    p2: { hand: [], deck: [CARD.waterEnergy, CARD.finneon] },
  });
  const ultraBallIndex = findHandIndex(view(session, 0), CARD.ultraBall);

  fails(
    session,
    0,
    commandFor(session, 'play-trainer', { handIndex: ultraBallIndex, discardHandIndices: [1] }),
    'ILLEGAL_COST',
  );
  fails(
    session,
    0,
    commandFor(session, 'play-trainer', { handIndex: ultraBallIndex, discardHandIndices: [1, 1] }),
    'ILLEGAL_COST',
  );
  ok(
    session,
    0,
    commandFor(session, 'play-trainer', { handIndex: ultraBallIndex, discardHandIndices: [1, 2] }),
  );

  const selfPending = view(session, 0).pendingChoice;
  const opponentPending = view(session, 1);
  assert.equal(selfPending.kind, 'search-deck');
  assert.equal(selfPending.purpose, 'search-pokemon');
  assert.ok(selfPending.candidates.some(candidate => candidate.cardKey === CARD.hallOfDestiny));
  assert.equal(opponentPending.pendingChoice, null);
  assert.equal(opponentPending.waitingForOpponentChoice, true);
  assert.ok(!JSON.stringify(opponentPending).includes(selfPending.choiceId));
  assert.equal(opponentPending.self.deck.count, 2);
  assert.deepEqual(
    view(session, 0).self.discard.map(card => card.cardKey).sort(),
    [CARD.ultraBall, CARD.finneon, CARD.orthworm].sort(),
  );

  // Pause: a rejected resolution must not consume the choice or mutate state.
  const paused = session.engine.internalSnapshotForTest();
  const target = selfPending.candidates.find(candidate => candidate.cardKey === CARD.hallOfDestiny);
  fails(
    session,
    0,
    commandFor(session, 'resolve-choice', { choiceId: selfPending.choiceId, picks: [] }),
    'ILLEGAL_TARGET',
  );
  fails(
    session,
    0,
    commandFor(session, 'resolve-choice', { choiceId: selfPending.choiceId, picks: ['nope'] }),
    'ILLEGAL_TARGET',
  );
  fails(
    session,
    0,
    commandFor(session, 'resolve-choice', { choiceId: selfPending.choiceId, picks: [target.ref, target.ref] }),
    'ILLEGAL_TARGET',
  );
  assert.deepEqual(session.engine.internalSnapshotForTest(), paused);

  // Resume.
  ok(session, 0, commandFor(session, 'resolve-choice', { choiceId: selfPending.choiceId, picks: [target.ref] }));
  const resolved = view(session, 0);
  assert.equal(resolved.pendingChoice, null);
  assert.ok(resolved.self.hand.some(entry => entry.card.cardKey === CARD.hallOfDestiny));
  assert.equal(resolved.self.deck.count, 3);
  const revealed = resolved.events.find(event => event.type === 'cards-revealed');
  assert.deepEqual(revealed.cards, [{ cardKey: CARD.hallOfDestiny, nameZh: '古剑豹ex' }]);
  assert.ok(resolved.events.some(event => event.type === 'deck-shuffled' && event.seat === 0));
});

test('珠贝: search one water Pokémon and one item, and never a 宝可梦道具', () => {
  const session = standardFixture({
    p1: {
      hand: [CARD.irida, CARD.irida],
      deck: [CARD.braveryCharm, CARD.hallOfDestiny, CARD.ultraBall, CARD.orthworm, CARD.waterEnergy],
      active: { cardKey: CARD.hallOfDestiny },
    },
    p2: { hand: [], deck: [CARD.waterEnergy] },
  });
  const iridaIndex = findHandIndex(view(session, 0), CARD.irida);
  ok(session, 0, commandFor(session, 'play-trainer', { handIndex: iridaIndex }));

  const pending = view(session, 0).pendingChoice;
  assert.equal(pending.kind, 'search-deck');
  assert.equal(pending.purpose, 'search-water-pokemon-and-item');
  const candidateKeys = pending.candidates.map(candidate => candidate.cardKey);
  assert.ok(candidateKeys.includes(CARD.hallOfDestiny), 'water Pokémon must be selectable');
  assert.ok(candidateKeys.includes(CARD.ultraBall), 'item must be selectable');
  assert.ok(!candidateKeys.includes(CARD.braveryCharm), '宝可梦道具 must not be treated as an item (2025-01-17)');
  assert.ok(!candidateKeys.includes(CARD.orthworm), 'non-water Pokémon must not be selectable');

  const water = pending.candidates.find(candidate => candidate.cardKey === CARD.hallOfDestiny);
  const item = pending.candidates.find(candidate => candidate.cardKey === CARD.ultraBall);
  fails(
    session,
    0,
    commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks: [item.ref] }),
    'ILLEGAL_TARGET',
  );
  fails(
    session,
    0,
    commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks: [water.ref, water.ref] }),
    'ILLEGAL_TARGET',
  );
  ok(session, 0, commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks: [water.ref, item.ref] }));

  const p1 = view(session, 0);
  assert.ok(p1.self.hand.some(entry => entry.card.cardKey === CARD.hallOfDestiny));
  assert.ok(p1.self.hand.some(entry => entry.card.cardKey === CARD.ultraBall));
  assert.ok(session.engine.internalSnapshotForTest().players[0].deck.some(card => card.cardKey === CARD.braveryCharm));
  assert.ok(!p1.self.hand.some(entry => entry.card.cardKey === CARD.braveryCharm));

  const secondIrida = findHandIndex(p1, CARD.irida);
  fails(session, 0, commandFor(session, 'play-trainer', { handIndex: secondIrida }), 'ACTION_NOT_ALLOWED');
});

test('古剑豹ex ability: search up to two basic water energy, once per turn, active only', () => {
  const session = standardFixture({
    p1: {
      hand: [],
      deck: [CARD.waterEnergy, CARD.fireEnergy, CARD.waterEnergy, CARD.waterEnergy],
      active: { cardKey: CARD.hallOfDestiny },
    },
    p2: { hand: [], deck: [CARD.waterEnergy] },
  });
  fails(session, 0, commandFor(session, 'use-ability', { name: '不存在' }), 'ILLEGAL_TARGET');
  ok(session, 0, commandFor(session, 'use-ability', { name: '战栗冷气' }));

  const pending = view(session, 0).pendingChoice;
  assert.equal(pending.kind, 'search-deck');
  assert.equal(pending.purpose, 'search-basic-water-energy');
  assert.equal(pending.min, 0);
  assert.equal(pending.max, 2);
  assert.deepEqual(
    pending.candidates.map(candidate => candidate.cardKey),
    [CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy],
  );
  fails(
    session,
    0,
    commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks: pending.candidates.map(c => c.ref) }),
    'ILLEGAL_TARGET',
  );
  const picked = pending.candidates.slice(0, 2).map(candidate => candidate.ref);
  ok(session, 0, commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks: picked }));
  assert.equal(view(session, 0).self.hand.filter(entry => entry.card.cardKey === CARD.waterEnergy).length, 2);
  fails(session, 0, commandFor(session, 'use-ability', { name: '战栗冷气' }), 'ACTION_NOT_ALLOWED');

  const benched = standardFixture({
    p1: {
      hand: [],
      deck: [CARD.waterEnergy],
      active: { cardKey: CARD.finneon },
      bench: [{ cardKey: CARD.hallOfDestiny }],
    },
    p2: { hand: [], deck: [CARD.waterEnergy] },
  });
  fails(benched, 0, commandFor(benched, 'use-ability', { name: '战栗冷气' }), 'ILLEGAL_TARGET');
});

test('KO chain: cost, damage from discarded water, KO, prize and no-Pokémon terminal', () => {
  const session = standardFixture({
    p1: {
      hand: [CARD.waterEnergy, CARD.waterEnergy],
      deck: [CARD.ultraBall, CARD.finneon, CARD.orthworm],
      prizes: [CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy],
      active: { cardKey: CARD.hallOfDestiny },
    },
    p2: {
      hand: [],
      deck: [CARD.waterEnergy, CARD.finneon],
      prizes: [CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy],
      active: { cardKey: CARD.finneon },
      bench: [],
    },
  });

  fails(session, 0, commandFor(session, 'attack', { name: '冰雹利刃' }), 'INSUFFICIENT_ENERGY');

  const firstEnergy = findHandIndex(view(session, 0), CARD.waterEnergy);
  ok(session, 0, commandFor(session, 'attach-energy', { handIndex: firstEnergy, target: { slot: 'active' } }));
  fails(session, 0, commandFor(session, 'attack', { name: '冰雹利刃' }), 'INSUFFICIENT_ENERGY');

  // Pass to the opponent and back so the once-per-turn energy attachment resets.
  ok(session, 0, commandFor(session, 'end-turn'));
  ok(session, 1, commandFor(session, 'end-turn'));

  const secondEnergy = findHandIndex(view(session, 0), CARD.waterEnergy);
  ok(session, 0, commandFor(session, 'attach-energy', { handIndex: secondEnergy, target: { slot: 'active' } }));
  assert.equal(view(session, 0).self.active.energies.length, 2);
  ok(session, 0, commandFor(session, 'attack', { name: '冰雹利刃' }));

  const pending = view(session, 0).pendingChoice;
  assert.equal(pending.kind, 'discard-energy');
  assert.equal(pending.max, 2);
  assert.equal(view(session, 1).pendingChoice, null);
  assert.equal(view(session, 1).waitingForOpponentChoice, true);

  const paused = session.engine.internalSnapshotForTest();
  fails(
    session,
    0,
    commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks: [pending.energies[0].ref, 'bogus'] }),
    'ILLEGAL_TARGET',
  );
  assert.deepEqual(session.engine.internalSnapshotForTest(), paused);

  const picks = pending.energies.map(energy => energy.ref);
  ok(session, 0, commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks }));

  const p1 = view(session, 0);
  const p2 = view(session, 1);
  assert.deepEqual(p1.result, { winner: 0, reason: 'no-pokemon' });
  assert.deepEqual(p2.result, { winner: 0, reason: 'no-pokemon' });
  assert.equal(p1.self.prizes.count, 5);
  assert.equal(p1.self.hand.length, 2);
  const attackEvent = p1.events.find(event => event.type === 'attack-used');
  assert.equal(attackEvent.damage, 120);
  assert.equal(attackEvent.targetCardKey, CARD.finneon);
  assert.ok(p1.events.some(event => event.type === 'pokemon-knocked-out' && event.cardKey === CARD.finneon));
  assert.ok(p1.events.some(event => event.type === 'prizes-taken' && event.count === 1 && event.remaining === 5));
  assert.ok(p1.events.some(event => event.type === 'match-finished' && event.reason === 'no-pokemon'));

  const afterTerminal = session.engine.internalSnapshotForTest();
  fails(session, 1, commandFor(session, 'end-turn'), 'GAME_FINISHED');
  assert.deepEqual(session.engine.internalSnapshotForTest(), afterTerminal);
});

test('ex knockout takes two prizes and asks the owner to promote from the bench', () => {
  const session = standardFixture({
    p1: {
      hand: [],
      deck: [CARD.waterEnergy, CARD.orthworm],
      prizes: [CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy],
      active: { cardKey: CARD.finneon, energies: [CARD.waterEnergy] },
    },
    p2: {
      hand: [],
      deck: [CARD.waterEnergy],
      prizes: [CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy, CARD.waterEnergy],
      active: { cardKey: CARD.hallOfDestiny, damage: 215 },
      bench: [{ cardKey: CARD.orthworm }],
    },
  });
  ok(session, 0, commandFor(session, 'attack', { name: '水枪' }));
  const p1 = view(session, 0);
  assert.equal(p1.result, null);
  assert.equal(p1.self.prizes.count, 4, 'ex knockout takes two prizes');
  const prizeEvent = p1.events.find(event => event.type === 'prizes-taken');
  assert.equal(prizeEvent.count, 2);
  assert.equal(session.engine.internalSnapshotForTest().players[1].active, null);

  const promote = view(session, 1).pendingChoice;
  assert.equal(promote.kind, 'promote-active');
  assert.equal(promote.candidates.length, 1);
  assert.equal(view(session, 0).waitingForOpponentChoice, true);
  fails(session, 0, commandFor(session, 'resolve-choice', { choiceId: promote.choiceId, picks: [promote.candidates[0].ref] }), 'NOT_YOUR_CHOICE');
  ok(session, 1, commandFor(session, 'resolve-choice', { choiceId: promote.choiceId, picks: [promote.candidates[0].ref] }));
  const p2 = view(session, 1);
  assert.equal(p2.pendingChoice, null);
  assert.equal(p2.self.active.cardKey, CARD.orthworm);
});

test('精灵球: coin flip is server-side and only heads opens the search', () => {
  const heads = createFixtureMatch(
    fixtureConfig(new ScriptedRandom([0]), {
      p1: {
        hand: [CARD.pokeBall],
        deck: [CARD.hallOfDestiny, CARD.finneon],
        active: { cardKey: CARD.hallOfDestiny },
      },
      p2: { hand: [], deck: [CARD.waterEnergy], active: { cardKey: CARD.finneon } },
    }),
  );
  const headsBall = findHandIndex(view(heads, 0), CARD.pokeBall);
  ok(heads, 0, commandFor(heads, 'play-trainer', { handIndex: headsBall }));
  const headsView = view(heads, 0);
  assert.ok(headsView.events.some(event => event.type === 'coin-flip' && event.result === 'heads'));
  assert.equal(headsView.pendingChoice.kind, 'search-deck');
  assert.equal(headsView.pendingChoice.purpose, 'search-pokemon');
  const target = headsView.pendingChoice.candidates.find(candidate => candidate.cardKey === CARD.hallOfDestiny);
  ok(heads, 0, commandFor(heads, 'resolve-choice', { choiceId: headsView.pendingChoice.choiceId, picks: [target.ref] }));
  assert.ok(view(heads, 0).events.some(event => event.type === 'cards-revealed'));

  const tails = createFixtureMatch(
    fixtureConfig(new ScriptedRandom([1]), {
      p1: {
        hand: [CARD.pokeBall],
        deck: [CARD.hallOfDestiny, CARD.finneon],
        active: { cardKey: CARD.hallOfDestiny },
      },
      p2: { hand: [], deck: [CARD.waterEnergy], active: { cardKey: CARD.finneon } },
    }),
  );
  const tailsBall = findHandIndex(view(tails, 0), CARD.pokeBall);
  ok(tails, 0, commandFor(tails, 'play-trainer', { handIndex: tailsBall }));
  const tailsView = view(tails, 0);
  assert.ok(tailsView.events.some(event => event.type === 'coin-flip' && event.result === 'tails'));
  assert.equal(tailsView.pendingChoice, null);
  assert.ok(!tailsView.events.some(event => event.type === 'deck-shuffled'));
  assert.equal(tailsView.self.deck.count, 2);
});

test('invalid hand and target references stay rejected after a pause', () => {
  const session = standardFixture({
    p1: { hand: [CARD.waterEnergy], deck: [CARD.waterEnergy] },
  });
  fails(
    session,
    0,
    commandFor(session, 'attach-energy', { handIndex: 5, target: { slot: 'active' } }),
    'ILLEGAL_TARGET',
  );
  fails(
    session,
    0,
    commandFor(session, 'attach-energy', { handIndex: 0, target: { slot: 'bench', index: 0 } }),
    'ILLEGAL_TARGET',
  );
  const result = submit(session, 0, {
    commandId: '',
    expectedVersion: session.version,
    type: 'end-turn',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_NOT_ALLOWED');
});
