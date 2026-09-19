import type { CardKind } from './contract.js';

export interface AbilityDef {
  readonly name: string;
  readonly requiresActive: boolean;
  readonly oncePerTurn: boolean;
  readonly effect: 'search-basic-water-energy-up-to-2';
  readonly implemented: boolean;
}

export interface AttackDef {
  readonly name: string;
  readonly cost: readonly string[];
  readonly baseDamage: number;
  readonly kind: 'hail-blade' | 'fixed' | 'pierce';
  readonly benchDamage?: number;
  readonly implemented: boolean;
}

export interface CardDef {
  /** Frozen effect identity from data/decks/zh-cn-standard-2025-06-05-effect-matrix.json. */
  readonly cardKey: string;
  readonly nameZh: string;
  readonly kind: CardKind;
  readonly category: string | null;
  readonly subtypes: readonly string[];
  /** False means the card is known to the frozen pool but the probe engine rejects playing it. */
  readonly implemented: boolean;

  // Pokémon
  readonly basic?: boolean;
  readonly hp?: number;
  readonly type?: string;
  readonly weakness?: { readonly type: string; readonly factor: number };
  readonly resistance?: { readonly type: string; readonly value: number };
  readonly retreat?: number;
  readonly prizeValue?: number;
  readonly abilities?: readonly AbilityDef[];
  readonly attacks?: readonly AttackDef[];

  // Basic energy
  readonly provides?: string;

  // Trainer
  readonly trainerEffect?: 'discard2-search-pokemon' | 'search-water-pokemon-and-item' | 'coin-flip-search-pokemon';
}

/**
 * Bounded card catalog transcribed from the frozen T01 data.
 *
 * Sources (byte-for-byte cross-checked by test/frozen-consistency.test.mjs):
 * - data/cards/zh-cn-standard-2025-06-05/csve1-card-details.json
 * - data/cards/zh-cn-standard-2025-06-05/standard-2025-06-05-extra-card-details.json
 * - data/decks/zh-cn-standard-2025-06-05-effect-matrix.json
 *
 * `implemented: false` entries are kept only so the probe can classify them
 * (for example 珠贝 must exclude 宝可梦道具 from its item search) and so the
 * supported/known split is explicit.
 */
export const CATALOG: Readonly<Record<string, CardDef>> = {
  'fx:energy:基本草能量:878bad62aabd': {
    cardKey: 'fx:energy:基本草能量:878bad62aabd',
    nameZh: '基本草能量',
    kind: 'energy',
    category: '基本能量',
    subtypes: ['基本能量'],
    implemented: true,
    provides: '草',
  },
  'fx:energy:基本火能量:5b395f9b8619': {
    cardKey: 'fx:energy:基本火能量:5b395f9b8619',
    nameZh: '基本火能量',
    kind: 'energy',
    category: '基本能量',
    subtypes: ['基本能量'],
    implemented: true,
    provides: '火',
  },
  'fx:energy:基本水能量:ea6e444ea341': {
    cardKey: 'fx:energy:基本水能量:ea6e444ea341',
    nameZh: '基本水能量',
    kind: 'energy',
    category: '基本能量',
    subtypes: ['基本能量'],
    implemented: true,
    provides: '水',
  },
  'fx:energy:基本超能量:5f901a4470b2': {
    cardKey: 'fx:energy:基本超能量:5f901a4470b2',
    nameZh: '基本超能量',
    kind: 'energy',
    category: '基本能量',
    subtypes: ['基本能量'],
    implemented: true,
    provides: '超',
  },
  'fx:pokemon:古剑豹ex:47bdd73235a0': {
    cardKey: 'fx:pokemon:古剑豹ex:47bdd73235a0',
    nameZh: '古剑豹ex',
    kind: 'pokemon',
    category: null,
    subtypes: ['基础', 'ex'],
    implemented: true,
    basic: true,
    hp: 220,
    type: '水',
    weakness: { type: '钢', factor: 2 },
    retreat: 2,
    prizeValue: 2,
    abilities: [
      {
        name: '战栗冷气',
        requiresActive: true,
        oncePerTurn: true,
        effect: 'search-basic-water-energy-up-to-2',
        implemented: true,
      },
    ],
    attacks: [
      {
        name: '冰雹利刃',
        cost: ['水', '水'],
        baseDamage: 0,
        kind: 'hail-blade',
        implemented: true,
      },
    ],
  },
  'fx:pokemon:荧光鱼:4e3297b73f44': {
    cardKey: 'fx:pokemon:荧光鱼:4e3297b73f44',
    nameZh: '荧光鱼',
    kind: 'pokemon',
    category: null,
    subtypes: ['基础'],
    implemented: true,
    basic: true,
    hp: 50,
    type: '水',
    weakness: { type: '雷', factor: 2 },
    retreat: 1,
    prizeValue: 1,
    abilities: [
      {
        name: '海之伴奏',
        requiresActive: false,
        oncePerTurn: false,
        effect: 'search-basic-water-energy-up-to-2',
        implemented: false,
      },
    ],
    attacks: [
      {
        name: '水枪',
        cost: ['水'],
        baseDamage: 10,
        kind: 'fixed',
        implemented: true,
      },
    ],
  },
  'fx:pokemon:拖拖蚓:428e5ea49c3c': {
    cardKey: 'fx:pokemon:拖拖蚓:428e5ea49c3c',
    nameZh: '拖拖蚓',
    kind: 'pokemon',
    category: null,
    subtypes: ['基础'],
    implemented: true,
    basic: true,
    hp: 130,
    type: '钢',
    weakness: { type: '火', factor: 2 },
    resistance: { type: '草', value: -30 },
    retreat: 2,
    prizeValue: 1,
    abilities: [
      {
        name: '营养铁质',
        requiresActive: false,
        oncePerTurn: false,
        effect: 'search-basic-water-energy-up-to-2',
        implemented: false,
      },
    ],
    attacks: [
      {
        name: '刺穿',
        cost: ['无', '无', '无', '无'],
        baseDamage: 100,
        kind: 'pierce',
        benchDamage: 30,
        implemented: false,
      },
    ],
  },
  'fx:trainer:高级球:d8722e9e5903': {
    cardKey: 'fx:trainer:高级球:d8722e9e5903',
    nameZh: '高级球',
    kind: 'trainer',
    category: '物品',
    subtypes: ['物品'],
    implemented: true,
    trainerEffect: 'discard2-search-pokemon',
  },
  'fx:trainer:珠贝:d6960eb0d722': {
    cardKey: 'fx:trainer:珠贝:d6960eb0d722',
    nameZh: '珠贝',
    kind: 'trainer',
    category: '支援者',
    subtypes: ['支援者'],
    implemented: true,
    trainerEffect: 'search-water-pokemon-and-item',
  },
  'fx:trainer:精灵球:992d7d8946ca': {
    cardKey: 'fx:trainer:精灵球:992d7d8946ca',
    nameZh: '精灵球',
    kind: 'trainer',
    category: '物品',
    subtypes: ['物品'],
    implemented: true,
    trainerEffect: 'coin-flip-search-pokemon',
  },
  'fx:trainer:勇气护符:8eb34c62d928': {
    cardKey: 'fx:trainer:勇气护符:8eb34c62d928',
    nameZh: '勇气护符',
    kind: 'trainer',
    category: '宝可梦道具',
    subtypes: ['宝可梦道具'],
    implemented: false,
  },
};

export function getCard(cardKey: string): CardDef {
  const card = CATALOG[cardKey];
  if (card === undefined) {
    throw new Error(`unknown card key: ${cardKey}`);
  }
  return card;
}
