import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CARD,
  PROBE_DECKS,
  SeededRandomSource,
  captureStep,
  createMatch,
  replayMatch,
} from '../dist/src/index.js';
import { commandFor, findHandIndex, ok, submit, view } from '../testlib/helpers.mjs';

/** Returns max-1 for every call: identity shuffle, deterministic coin flips. */
class IdentityMaxRandom {
  nextInt(max) {
    return max - 1;
  }
}

function runScriptedMatch(random) {
  const session = createMatch({ deckEntries: PROBE_DECKS, names: ['P1', 'P2'], random });
  const history = [];
  const capture = () => history.push(JSON.stringify(captureStep(session)));
  capture();

  const hallIndex = findHandIndex(view(session, 0), CARD.hallOfDestiny);
  assert.ok(hallIndex >= 0, 'the scripted deal must put 古剑豹ex into the opening hand');
  ok(session, 0, commandFor(session, 'place-setup-pokemon', { active: hallIndex, bench: [] }));
  capture();

  const finneonIndex = findHandIndex(view(session, 1), CARD.finneon);
  assert.ok(finneonIndex >= 0, 'the scripted deal must put 荧光鱼 into the opening hand');
  ok(session, 1, commandFor(session, 'place-setup-pokemon', { active: finneonIndex, bench: [] }));
  capture();

  const chooser = view(session, 0).pendingChoice ? 0 : 1;
  ok(session, chooser, commandFor(session, 'choose-turn-order', { goFirst: chooser === 1 }));
  capture();

  let attachedThisTurn = false;
  let attacked = false;
  for (let guard = 0; guard < 60 && !session.isFinished(); guard += 1) {
    const pending0 = view(session, 0).pendingChoice;
    const pending1 = view(session, 1).pendingChoice;
    if (pending0 !== null || pending1 !== null) {
      const seat = pending0 !== null ? 0 : 1;
      const pending = pending0 ?? pending1;
      let picks = [];
      if (pending.kind === 'search-deck') {
        if (pending.purpose === 'search-basic-water-energy') {
          picks = pending.candidates.slice(0, 2).map(candidate => candidate.ref);
        } else if (pending.purpose === 'search-water-pokemon-and-item') {
          const water = pending.candidates.find(candidate => candidate.roles.includes('water-pokemon'));
          const item = pending.candidates.find(candidate => candidate.roles.includes('item'));
          picks = [water, item].filter(Boolean).map(candidate => candidate.ref);
        } else {
          picks = [pending.candidates[0].ref];
        }
      } else if (pending.kind === 'discard-energy') {
        picks = pending.energies.slice(0, 2).map(energy => energy.ref);
      } else if (pending.kind === 'promote-active') {
        picks = [pending.candidates[0].ref];
      }
      ok(session, seat, commandFor(session, 'resolve-choice', { choiceId: pending.choiceId, picks }));
      capture();
      continue;
    }

    const activeSeat = view(session, 0).activeSeat;
    if (activeSeat === 1) {
      ok(session, 1, commandFor(session, 'end-turn'));
      attachedThisTurn = false;
      capture();
      continue;
    }

    const p1 = view(session, 0);
    if (p1.self.active.energies.length >= 2 && !attacked) {
      ok(session, 0, commandFor(session, 'attack', { name: '冰雹利刃' }));
      attacked = true;
      capture();
      continue;
    }
    if (!attachedThisTurn) {
      const energyIndex = findHandIndex(p1, CARD.waterEnergy);
      if (energyIndex >= 0) {
        ok(
          session,
          0,
          commandFor(session, 'attach-energy', { handIndex: energyIndex, target: { slot: 'active' } }),
        );
        attachedThisTurn = true;
        capture();
        continue;
      }
      const ability = submit(session, 0, commandFor(session, 'use-ability', { name: '战栗冷气' }));
      capture();
      if (!ability.ok) {
        ok(session, 0, commandFor(session, 'end-turn'));
        attachedThisTurn = false;
        capture();
      }
      continue;
    }
    ok(session, 0, commandFor(session, 'end-turn'));
    attachedThisTurn = false;
    attacked = false;
    capture();
  }

  assert.ok(session.isFinished(), 'the scripted match must reach a terminal result');
  assert.deepEqual(session.result(), { winner: 0, reason: 'no-pokemon' });
  return { session, history };
}

test('recorded random input replays the exact command sequence and views', () => {
  const original = runScriptedMatch(new IdentityMaxRandom());
  const record = original.session.record();
  assert.ok(record.randomOutputs.length > 0, 'random outputs must be captured for replay');
  assert.ok(record.commands.length > 5);

  const replayed = replayMatch(record);
  assert.equal(replayed.steps.length, original.history.length);
  for (let index = 0; index < original.history.length; index += 1) {
    assert.equal(
      JSON.stringify(replayed.steps[index]),
      original.history[index],
      `step ${index} diverged during replay`,
    );
  }
  assert.deepEqual(replayed.session.result(), { winner: 0, reason: 'no-pokemon' });
  assert.equal(replayed.session.seats[0].token === original.session.seats[0].token, false);
});

test('client-facing views never contain a seed, random outputs or deck order', () => {
  const { session } = runScriptedMatch(new IdentityMaxRandom());
  const record = session.record();
  const views = JSON.stringify([session.viewFor(session.seats[0]), session.viewFor(session.seats[1])]);
  assert.ok(!views.includes('randomOutputs'));
  assert.ok(!views.includes('"seed"'));
  assert.ok(!record.randomOutputs.some(value => views.includes(`"${value}"`)));
  const keys = new Set();
  const collect = value => {
    if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value !== null && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => {
        keys.add(key);
        collect(item);
      });
    }
  };
  collect(JSON.parse(views));
  assert.ok(!keys.has('instanceId'));
  assert.ok(!keys.has('deckOrder'));
  assert.ok(!keys.has('randomOutputs'));
});

test('the same seeded random source produces identical view histories', () => {
  const first = createMatch({ deckEntries: PROBE_DECKS, random: new SeededRandomSource(20260920) });
  const second = createMatch({ deckEntries: PROBE_DECKS, random: new SeededRandomSource(20260920) });
  assert.equal(
    JSON.stringify(captureStep(first)),
    JSON.stringify(captureStep(second)),
    'same seed and same decks must produce the same opening state',
  );
  assert.equal(
    JSON.stringify(first.engine.internalSnapshotForTest()),
    JSON.stringify(second.engine.internalSnapshotForTest()),
  );
});
