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
