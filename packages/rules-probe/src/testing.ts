import type { DeckEntry } from './contract.js';
import type { FixtureEngineConfig, FixturePlayerSpec } from './engine.js';

/** Frozen effect identities used by the probe (from the T01 effect matrix). */
export const CARD = {
  hallOfDestiny: 'fx:pokemon:古剑豹ex:47bdd73235a0',
  finneon: 'fx:pokemon:荧光鱼:4e3297b73f44',
  orthworm: 'fx:pokemon:拖拖蚓:428e5ea49c3c',
  ultraBall: 'fx:trainer:高级球:d8722e9e5903',
  irida: 'fx:trainer:珠贝:d6960eb0d722',
  pokeBall: 'fx:trainer:精灵球:992d7d8946ca',
  braveryCharm: 'fx:trainer:勇气护符:8eb34c62d928',
  waterEnergy: 'fx:energy:基本水能量:ea6e444ea341',
  fireEnergy: 'fx:energy:基本火能量:5b395f9b8619',
  grassEnergy: 'fx:energy:基本草能量:878bad62aabd',
  psychicEnergy: 'fx:energy:基本超能量:5f901a4470b2',
} as const;

/**
 * Probe decks. Every card is taken from the frozen T01 pool and every card is
 * either implemented by the probe or intentionally kept as a known-but-
 * unsupported card (勇气护符) to exercise the 2025-01-17 item/tool split.
 *
 * The exact order matters for deterministic tests that control the shuffle.
 */
export const PROBE_DECKS: readonly [readonly DeckEntry[], readonly DeckEntry[]] = [
  [
    { cardKey: CARD.hallOfDestiny, count: 1 },
    { cardKey: CARD.waterEnergy, count: 2 },
    { cardKey: CARD.ultraBall, count: 1 },
    { cardKey: CARD.irida, count: 1 },
    { cardKey: CARD.finneon, count: 1 },
    { cardKey: CARD.orthworm, count: 1 },
    { cardKey: CARD.hallOfDestiny, count: 1 },
    { cardKey: CARD.waterEnergy, count: 2 },
    { cardKey: CARD.ultraBall, count: 1 },
    { cardKey: CARD.irida, count: 1 },
    { cardKey: CARD.finneon, count: 1 },
    { cardKey: CARD.orthworm, count: 1 },
    { cardKey: CARD.braveryCharm, count: 2 },
    { cardKey: CARD.fireEnergy, count: 2 },
  ],
  [
    { cardKey: CARD.finneon, count: 1 },
    { cardKey: CARD.orthworm, count: 1 },
    { cardKey: CARD.waterEnergy, count: 2 },
    { cardKey: CARD.ultraBall, count: 1 },
    { cardKey: CARD.braveryCharm, count: 1 },
    { cardKey: CARD.irida, count: 1 },
    { cardKey: CARD.finneon, count: 1 },
    { cardKey: CARD.waterEnergy, count: 2 },
    { cardKey: CARD.ultraBall, count: 1 },
    { cardKey: CARD.finneon, count: 1 },
    { cardKey: CARD.orthworm, count: 1 },
    { cardKey: CARD.finneon, count: 1 },
    { cardKey: CARD.waterEnergy, count: 1 },
  ],
];

export interface FixtureOptions {
  readonly p1?: FixturePlayerSpec;
  readonly p2?: FixturePlayerSpec;
  readonly activeSeat?: 0 | 1 | null;
  readonly turn?: number;
  readonly phase?: 'setup' | 'turn-order' | 'playing';
}

/**
 * Test-only fixture builder. It bypasses the opening procedure so a test can
 * place exact cards; commands still go through the public session interface.
 */
export function fixtureConfig(random: FixtureEngineConfig['random'], options: FixtureOptions = {}): FixtureEngineConfig {
  return {
    players: [
      options.p1 ?? { hand: [], deck: [], prizes: [] },
      options.p2 ?? { hand: [], deck: [], prizes: [] },
    ],
    names: ['P1', 'P2'],
    activeSeat: options.activeSeat === undefined ? 0 : options.activeSeat,
    turn: options.turn ?? 1,
    phase: options.phase ?? 'playing',
    random,
  };
}
