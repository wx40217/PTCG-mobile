import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD, createFixtureMatch, fixtureConfig } from '../dist/src/index.js';
import { ScriptedRandom, commandFor, findHandIndex, ok, standardFixture, view } from '../testlib/helpers.mjs';

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

test('two serialized seats never see each other\'s hand, deck or prizes', () => {
  const session = createFixtureMatch(
    fixtureConfig(new ScriptedRandom(), {
      p1: {
        hand: [CARD.irida, CARD.orthworm],
        deck: [CARD.ultraBall, CARD.braveryCharm, CARD.waterEnergy],
        prizes: [CARD.fireEnergy, CARD.grassEnergy],
        active: { cardKey: CARD.hallOfDestiny },
      },
      p2: {
        hand: [CARD.psychicEnergy],
        deck: [CARD.psychicEnergy, CARD.psychicEnergy],
        prizes: [CARD.psychicEnergy],
        active: { cardKey: CARD.finneon },
      },
    }),
  );

  const p1 = view(session, 0);
  const p2 = view(session, 1);
  assert.equal(p2.opponent.hand.count, 2);
  assert.equal(p2.opponent.deck.count, 3);
  assert.equal(p2.opponent.prizes.count, 2);
  assert.equal(p1.opponent.hand.count, 1);
  assert.equal(p1.opponent.deck.count, 2);
  assert.equal(p1.opponent.prizes.count, 1);

  const p2Json = JSON.stringify(p2.opponent);
  for (const hiddenKey of [CARD.irida, CARD.orthworm, CARD.ultraBall, CARD.braveryCharm, CARD.fireEnergy, CARD.grassEnergy]) {
    assert.ok(!p2Json.includes(hiddenKey), `${hiddenKey} leaked into the opponent projection`);
  }
  const p1Json = JSON.stringify(p1);
  assert.ok(!p1Json.includes(CARD.psychicEnergy), 'opponent hidden identities leaked into seat 0 view');
  assert.ok(!p1Json.includes(CARD.fireEnergy), 'own face-down prizes leaked into seat 0 view');
  assert.ok(!p1Json.includes(CARD.grassEnergy), 'own face-down prizes leaked into seat 0 view');

  const keys = collectKeys(p1);
  assert.ok(!keys.has('instanceId'));
  assert.ok(!keys.has('deckOrder'));
  assert.ok(!keys.has('seed'));
});

test('deck search candidates are private to the choosing seat', () => {
  const session = standardFixture({
    p1: {
      hand: [CARD.ultraBall, CARD.finneon, CARD.orthworm],
      deck: [CARD.hallOfDestiny, CARD.irida],
      active: { cardKey: CARD.finneon },
    },
    p2: { hand: [], deck: [CARD.waterEnergy], active: { cardKey: CARD.finneon } },
  });
  const ballIndex = findHandIndex(view(session, 0), CARD.ultraBall);
  ok(session, 0, commandFor(session, 'play-trainer', { handIndex: ballIndex, discardHandIndices: [1, 2] }));

  const p1 = view(session, 0);
  const p2 = view(session, 1);
  assert.equal(p1.pendingChoice.kind, 'search-deck');
  assert.ok(p1.pendingChoice.candidates.some(candidate => candidate.cardKey === CARD.hallOfDestiny));

  const p2Json = JSON.stringify(p2);
  assert.ok(!p2Json.includes(CARD.hallOfDestiny), 'private candidate identity leaked to the opponent');
  assert.ok(!p2Json.includes(p1.pendingChoice.choiceId), 'choice id leaked to the opponent');
  for (const candidate of p1.pendingChoice.candidates) {
    assert.ok(!p2Json.includes(`"${candidate.ref}"`), 'ephemeral candidate ref leaked to the opponent');
  }
});

test('hidden zones serialize as counts only, so a shuffle exposes no before/after mapping', () => {
  // Scripted 0 makes the search-triggered Fisher-Yates shuffle actually change order.
  const session = createFixtureMatch(
    fixtureConfig(new ScriptedRandom([0]), {
      p1: {
        hand: [CARD.ultraBall, CARD.finneon, CARD.orthworm],
        deck: [CARD.hallOfDestiny, CARD.irida],
        active: { cardKey: CARD.finneon },
      },
      p2: { hand: [], deck: [CARD.waterEnergy], active: { cardKey: CARD.finneon } },
    }),
  );

  const deckBefore = session.engine
    .internalSnapshotForTest()
    .players[0].deck.map(card => `${card.instanceId}:${card.cardKey}`);
  const p2Before = view(session, 1);

  const ballIndex = findHandIndex(view(session, 0), CARD.ultraBall);
  ok(session, 0, commandFor(session, 'play-trainer', { handIndex: ballIndex, discardHandIndices: [1, 2] }));
  const pending = view(session, 0).pendingChoice;
  const candidate = pending.candidates.find(entry => entry.cardKey === CARD.hallOfDestiny);
  ok(session, 0, commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks: [candidate.ref] }));

  const deckAfter = session.engine
    .internalSnapshotForTest()
    .players[0].deck.map(card => `${card.instanceId}:${card.cardKey}`);
  const p2After = view(session, 1);

  assert.notDeepEqual(deckAfter, deckBefore, 'the hidden deck order must have changed for the assertion to be meaningful');
  assert.deepEqual(Object.keys(p2After.opponent.deck), ['count']);
  assert.deepEqual(Object.keys(p2After.opponent.hand), ['count']);
  assert.deepEqual(Object.keys(p2After.opponent.prizes), ['count']);
  assert.equal(p2After.opponent.deck.count, deckAfter.length);
  assert.deepEqual(p2After.opponent.prizes, p2Before.opponent.prizes);
  assert.equal(p2After.opponent.hand.count, 1);
  assert.equal(session.engine.internalSnapshotForTest().players[0].hand[0].cardKey, CARD.hallOfDestiny);

  const p2Json = JSON.stringify(p2After);
  assert.ok(!p2Json.includes(CARD.irida), `${CARD.irida} leaked from the hidden deck`);
  // 古剑豹ex is the searched card and is public through the reveal event by rule.
  assert.ok(
    p2After.events.some(
      event => event.type === 'cards-revealed' && event.cards.some(card => card.cardKey === CARD.hallOfDestiny),
    ),
  );
  const keys = collectKeys(p2After);
  assert.ok(!keys.has('instanceId'));
  assert.ok(!keys.has('seed'));
});

test('identical visible state with different hidden orders serializes identically', () => {
  const build = hiddenOrder => {
    const session = createFixtureMatch(
      fixtureConfig(new ScriptedRandom(), {
        p1: {
          hand: [CARD.irida],
          deck: hiddenOrder,
          prizes: [CARD.grassEnergy],
          active: { cardKey: CARD.finneon },
        },
        p2: { hand: [], deck: [CARD.waterEnergy], active: { cardKey: CARD.finneon } },
      }),
    );
    return JSON.stringify([view(session, 0), view(session, 1)]);
  };
  const first = build([CARD.hallOfDestiny, CARD.ultraBall, CARD.orthworm]);
  const second = build([CARD.orthworm, CARD.hallOfDestiny, CARD.ultraBall]);
  assert.equal(first, second);
});
