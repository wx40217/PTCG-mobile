import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD } from '../dist/src/index.js';
import {
  commandFor,
  fails,
  findHandIndex,
  ok,
  standardFixture,
  submit,
  view,
} from '../testlib/helpers.mjs';

test('command ids are idempotent and never execute twice', () => {
  const session = standardFixture({
    p1: { hand: [CARD.waterEnergy], deck: [CARD.waterEnergy], active: { cardKey: CARD.hallOfDestiny } },
    p2: { hand: [], deck: [CARD.waterEnergy] },
  });
  const command = commandFor(session, 'attach-energy', { handIndex: 0, target: { slot: 'active' } });
  const first = ok(session, 0, command);
  const snapshotAfterFirst = session.engine.internalSnapshotForTest();

  const retransmitted = { ...command };
  const second = submit(session, 0, retransmitted);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.version, first.version);
  assert.deepEqual(session.engine.internalSnapshotForTest(), snapshotAfterFirst);
  assert.equal(session.engine.internalSnapshotForTest().players[0].hand.length, 0);
  assert.equal(session.engine.internalSnapshotForTest().players[0].active.energies.length, 1);

  fails(session, 0, { ...command, target: { slot: 'bench', index: 0 } }, 'COMMAND_ID_REUSED');
});

test('command id idempotency is scoped to the authenticated seat', () => {
  const session = standardFixture({
    p1: { hand: [CARD.waterEnergy, CARD.ultraBall], deck: [], prizes: [], active: { cardKey: CARD.hallOfDestiny } },
    p2: { hand: [CARD.waterEnergy], deck: [CARD.waterEnergy], prizes: [], active: { cardKey: CARD.finneon } },
  });
  const sharedId = 'shared-command-id';
  const seat0Command = {
    commandId: sharedId,
    expectedVersion: session.version,
    type: 'attach-energy',
    handIndex: 0,
    target: { slot: 'active' },
  };
  const first = ok(session, 0, seat0Command);

  // The other seat retransmitting the exact same command must not receive seat 0's cached view.
  const crossExact = submit(session, 1, { ...seat0Command });
  assert.equal(crossExact.ok, false);
  assert.equal(crossExact.code, 'STALE_VERSION');
  assert.equal('view' in crossExact, false);
  assert.ok(!JSON.stringify(crossExact).includes(CARD.ultraBall));
  assert.equal(session.version, first.version);

  // Same id, re-evaluated by the other seat with the current version: fresh action, not a duplicate of seat 0.
  const crossSame = submit(session, 1, { ...seat0Command, expectedVersion: session.version });
  assert.equal(crossSame.ok, false);
  assert.equal(crossSame.code, 'NOT_YOUR_TURN');
  assert.equal('view' in crossSame, false);
  assert.ok(!JSON.stringify(crossSame).includes(CARD.ultraBall));

  // Same id with another payload from the other seat: also fresh, not COMMAND_ID_REUSED against seat 0's entry.
  const crossDifferent = submit(session, 1, {
    ...seat0Command,
    expectedVersion: session.version,
    target: { slot: 'bench', index: 0 },
  });
  assert.equal(crossDifferent.ok, false);
  assert.equal(crossDifferent.code, 'NOT_YOUR_TURN');
  assert.equal('view' in crossDifferent, false);

  // Seat 1 gets its own turn and its own idempotency scope, including seat 0's command id.
  ok(session, 0, commandFor(session, 'end-turn'));
  const seat1Command = {
    commandId: sharedId,
    expectedVersion: session.version,
    type: 'attach-energy',
    handIndex: 0,
    target: { slot: 'active' },
  };
  const seat1First = ok(session, 1, seat1Command);
  assert.equal(seat1First.view.seat, 1);
  const seat1Duplicate = submit(session, 1, { ...seat1Command });
  assert.equal(seat1Duplicate.ok, true);
  assert.equal(seat1Duplicate.duplicate, true);
  assert.equal(seat1Duplicate.version, seat1First.version);
  assert.deepEqual(seat1Duplicate.view, seat1First.view);
  assert.equal(seat1Duplicate.view.seat, 1);
  assert.deepEqual(seat1Duplicate.view.self.hand.map(entry => entry.card.cardKey), [CARD.waterEnergy]);
  assert.ok(!JSON.stringify(seat1Duplicate).includes(CARD.ultraBall));

  // Payload reuse inside one seat still reports COMMAND_ID_REUSED.
  fails(session, 1, { ...seat1Command, target: { slot: 'bench', index: 0 } }, 'COMMAND_ID_REUSED');

  // Seat 0's original entry still returns seat 0's own cached result, not seat 1's.
  const seat0Duplicate = submit(session, 0, { ...seat0Command });
  assert.equal(seat0Duplicate.ok, true);
  assert.equal(seat0Duplicate.duplicate, true);
  assert.equal(seat0Duplicate.version, first.version);
  assert.equal(seat0Duplicate.view.seat, 0);
  assert.deepEqual(seat0Duplicate.view.self.hand.map(entry => entry.card.cardKey), [CARD.ultraBall]);
});

test('stale expectedVersion is rejected without mutating state', () => {
  const session = standardFixture({ p1: { hand: [CARD.waterEnergy] } });
  const before = session.engine.internalSnapshotForTest();
  fails(
    session,
    0,
    {
      commandId: 'stale-1',
      expectedVersion: session.version - 1,
      type: 'attach-energy',
      handIndex: 0,
      target: { slot: 'active' },
    },
    'STALE_VERSION',
  );
  assert.deepEqual(session.engine.internalSnapshotForTest(), before);
});

test('seat handles are authenticated', () => {
  const session = standardFixture({});
  const forged = { seat: 0, token: 'not-a-real-token' };
  const result = session.submit(forged, commandFor(session, 'end-turn'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_AUTHENTICATED_SEAT');
  assert.throws(() => session.viewFor(forged), /not valid/);

  const crossSeat = { seat: 1, token: session.seats[0].token };
  const crossResult = session.submit(crossSeat, commandFor(session, 'end-turn'));
  assert.equal(crossResult.ok, false);
  assert.equal(crossResult.code, 'NOT_AUTHENTICATED_SEAT');
});

test('a pending choice blocks every other command', () => {
  const session = standardFixture({
    p1: {
      hand: [CARD.ultraBall, CARD.finneon, CARD.orthworm, CARD.waterEnergy],
      deck: [CARD.hallOfDestiny, CARD.finneon],
    },
  });
  const ultraBallIndex = findHandIndex(view(session, 0), CARD.ultraBall);
  ok(
    session,
    0,
    commandFor(session, 'play-trainer', {
      handIndex: ultraBallIndex,
      discardHandIndices: [1, 2],
    }),
  );
  assert.equal(view(session, 0).pendingChoice?.kind, 'search-deck');
  assert.equal(view(session, 1).pendingChoice, null);
  assert.equal(view(session, 1).waitingForOpponentChoice, true);

  fails(
    session,
    0,
    commandFor(session, 'attach-energy', { handIndex: 0, target: { slot: 'active' } }),
    'CHOICE_PENDING',
  );
  fails(session, 1, commandFor(session, 'end-turn'), 'CHOICE_PENDING');
  fails(
    session,
    1,
    commandFor(session, 'resolve-choice', {
      choiceId: view(session, 0).pendingChoice.choiceId,
      picks: [],
    }),
    'NOT_YOUR_CHOICE',
  );
  fails(
    session,
    0,
    commandFor(session, 'resolve-choice', { choiceId: 'wrong', picks: [] }),
    'ILLEGAL_TARGET',
  );
});

test('invalid turn actions are rejected with stable codes', () => {
  const session = standardFixture({
    p1: {
      hand: [CARD.waterEnergy, CARD.waterEnergy, CARD.irida, CARD.irida, CARD.braveryCharm],
      deck: [CARD.hallOfDestiny, CARD.ultraBall, CARD.orthworm],
      active: { cardKey: CARD.hallOfDestiny },
    },
  });

  ok(session, 0, commandFor(session, 'attach-energy', { handIndex: 0, target: { slot: 'active' } }));
  fails(
    session,
    0,
    commandFor(session, 'attach-energy', { handIndex: 0, target: { slot: 'active' } }),
    'ACTION_NOT_ALLOWED',
  );

  const iridaIndex = findHandIndex(view(session, 0), CARD.irida);
  ok(session, 0, commandFor(session, 'play-trainer', { handIndex: iridaIndex }));
  const pending = view(session, 0).pendingChoice;
  const water = pending.candidates.find(candidate => candidate.roles.includes('water-pokemon'));
  const item = pending.candidates.find(candidate => candidate.roles.includes('item'));
  ok(session, 0, commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks: [water.ref, item.ref] }));

  const secondIrida = findHandIndex(view(session, 0), CARD.irida);
  fails(session, 0, commandFor(session, 'play-trainer', { handIndex: secondIrida }), 'ACTION_NOT_ALLOWED');

  const charmIndex = findHandIndex(view(session, 0), CARD.braveryCharm);
  fails(session, 0, commandFor(session, 'play-trainer', { handIndex: charmIndex }), 'UNSUPPORTED_CARD');

  fails(session, 0, commandFor(session, 'attack', { name: '冰雹利刃' }), 'INSUFFICIENT_ENERGY');
});

test('turn ownership, unsupported attacks and terminal state are enforced', () => {
  const session = standardFixture({
    p1: {
      hand: [],
      active: { cardKey: CARD.orthworm },
      deck: [CARD.waterEnergy],
    },
    p2: { active: { cardKey: CARD.finneon }, deck: [CARD.waterEnergy] },
  });
  fails(session, 1, commandFor(session, 'end-turn'), 'NOT_YOUR_TURN');
  fails(session, 0, commandFor(session, 'attack', { name: '刺穿' }), 'UNSUPPORTED_CARD');
  fails(session, 0, commandFor(session, 'attack', { name: '不存在' }), 'ILLEGAL_TARGET');

  ok(session, 0, commandFor(session, 'concede'));
  assert.deepEqual(session.result(), { winner: 1, reason: 'concede' });
  const after = session.engine.internalSnapshotForTest();
  fails(session, 0, commandFor(session, 'end-turn'), 'GAME_FINISHED');
  assert.deepEqual(session.engine.internalSnapshotForTest(), after);
});

test('view version advances with accepted commands and stays put on errors', () => {
  const session = standardFixture({ p1: { hand: [CARD.waterEnergy] } });
  const v0 = view(session, 0).version;
  const result = ok(session, 0, commandFor(session, 'attach-energy', { handIndex: 0, target: { slot: 'active' } }));
  assert.equal(result.version, v0 + 1);
  assert.equal(view(session, 0).version, v0 + 1);
  fails(
    session,
    0,
    commandFor(session, 'attach-energy', { handIndex: 0, target: { slot: 'active' } }),
    'ACTION_NOT_ALLOWED',
  );
  assert.equal(view(session, 0).version, v0 + 1);
});
