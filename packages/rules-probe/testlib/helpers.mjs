import assert from 'node:assert/strict';
import { CARD, createFixtureMatch, fixtureConfig } from '../dist/src/index.js';

let commandSeq = 0;

/** Deterministic source: identity shuffle (nextInt(max) === max-1). */
export function identityRandom() {
  return { nextInt: max => max - 1 };
}

/** Deterministic source returning a fixed value clamped into range. */
export function fixedRandom(value) {
  return { nextInt: max => Math.min(value, max - 1) };
}

/** Deterministic source consuming a scripted list of raw outputs. */
export class ScriptedRandom {
  constructor(values = []) {
    this.values = [...values];
  }

  nextInt(max) {
    const value = this.values.length > 0 ? this.values.shift() : 0;
    return value % max;
  }
}

export function commandFor(session, type, fields = {}) {
  commandSeq += 1;
  return {
    commandId: `cmd-${commandSeq}`,
    expectedVersion: session.version,
    type,
    ...fields,
  };
}

export function view(session, seat) {
  return session.viewFor(session.seats[seat]);
}

export function submit(session, seat, command) {
  return session.submit(session.seats[seat], command);
}

export function ok(session, seat, command) {
  const result = submit(session, seat, command);
  assert.equal(result.ok, true, `${command.type} failed: ${result.ok ? '' : `${result.code} ${result.message}`}`);
  return result;
}

export function fails(session, seat, command, code) {
  const result = submit(session, seat, command);
  assert.equal(result.ok, false, `${command.type} unexpectedly succeeded`);
  assert.equal(result.code, code, `expected ${code}, got ${result.code}: ${result.message}`);
  return result;
}

export function findHandIndex(playerView, cardKey) {
  const entry = playerView.self.hand.find(item => item.card.cardKey === cardKey);
  return entry === undefined ? -1 : entry.handIndex;
}

export function standardFixture(options = {}) {
  const { p1 = {}, p2 = {}, ...rest } = options;
  return createFixtureMatch(
    fixtureConfig(identityRandom(), {
      ...rest,
      p1: {
        hand: [],
        deck: [CARD.waterEnergy, CARD.waterEnergy],
        prizes: [],
        active: { cardKey: CARD.hallOfDestiny },
        ...p1,
      },
      p2: {
        hand: [],
        deck: [CARD.waterEnergy],
        prizes: [],
        active: { cardKey: CARD.finneon },
        ...p2,
      },
    }),
  );
}

export function playUltraBall(session, seat, handIndex, discardHandIndices) {
  return ok(
    session,
    seat,
    commandFor(session, 'play-trainer', { handIndex, discardHandIndices }),
  );
}
