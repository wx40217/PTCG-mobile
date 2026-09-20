import { describe, expect, it } from 'vitest';
import type { CatalogContent, MatchClientMessage, MatchEngineConfig, MatchPendingChoiceView, MatchSeat, MatchView } from '@ptcg/protocol';
import {
  MatchEngine,
  MatchEngineError,
  type AbilityEffect,
  type AttackEffectResolver,
} from '../src/match.ts';
import {
  PRODUCTION_ABILITY_EFFECTS,
  PRODUCTION_ATTACK_EFFECTS,
  PRODUCTION_TOOL_EFFECTS,
} from '../src/pokemonEffects.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from '../src/trainerEffects.ts';import {
  OpeningHandScript,
  SequenceRandomSource,
  deckDocumentFromCardsWith,
  fixtureCatalog,
  releaseCatalogContent,
  type FixtureCardInput,
} from './support/matchTestKit.ts';

/**
 * 预设 A/B 剩余效果的逐卡行为测试（T12 / #13）。
 *
 * 预期来源是 `data/cards/...-card-details.json` 与 effect-matrix 的冻结卡面
 * 文字（含影响判定的版本），只使用真实发行目录与生产注册表；需要
 * 「随心游动」搭档或[钢]能量时使用明确的夹具卡，不修改发行目录。
 */

const SESSION = 'session-ab-decks';
const PSY = 'cbb2c-1102';
const WATER = 'cbb1c-1803';
const FIRE = 'cbb1c-1802';
const GRASS = 'cbb1c-1801';
const MEW = 'csve1-056';
const MOON = 'csve1-057';
const WORM = 'csv3c-095';
const FISH = 'csve1-035';
const SYLVEON_V = 'csve1-062';
const SYLVEON_VMAX = 'csve1-063';
const CHIEN_PAO = 'csv3c-043';
const TREECKO = 'csve1-155';
const KLAARA = 'csv2c-118';
const IRIDA = 'csve1-138';
const POKE_BALL = 'cbb1c-1701';
const ULTRA_BALL = 'cbb1c-1703';
const COURAGE_CHARM = 'csv1c-118';

const FIXTURES: readonly FixtureCardInput[] = [
  // 「海之伴奏」的目标：本冻结环境没有真实「随心游动」宝可梦。
  {
    id: 'fix-swim',
    nameZh: '夹具游动宝可梦',
    cardClass: 'pokemon',
    subtypes: ['基础'],
    type: '水',
    hp: 60,
    retreat: 1,
    attacks: [{ name: '随心游动', cost: ['水'], damage: '10' }],
  },
  // 「营养铁质」的[钢]能量：本冻结环境没有基本钢能量。
  { id: 'fix-steel', nameZh: '夹具钢能量', cardClass: 'energy', subtypes: ['基本能量'], type: '钢' },
  // 「基因侵入」的未接入招式与固定伤害招式对照。
  {
    id: 'fix-weird',
    nameZh: '夹具怪异宝可梦',
    cardClass: 'pokemon',
    subtypes: ['基础'],
    type: '恶',
    hp: 120,
    retreat: 1,
    attacks: [
      { name: '怪异重击', cost: [], damage: null, text: '尚未接入的测试说明文。' },
      { name: '直击', cost: [], damage: '20' },
    ],
  },
  // 私人候选隐私探针：只出现在对手手牌的独特名称。
  {
    id: 'fix-probe',
    nameZh: '夹具邀请目标',
    cardClass: 'pokemon',
    subtypes: ['基础'],
    type: '草',
    hp: 70,
    retreat: 1,
    attacks: [{ name: '轻触', cost: [], damage: '10' }],
  },
];

function repeat(cardId: string, count: number): string[] {
  return Array.from({ length: count }, () => cardId);
}

function groupByFirstOccurrence(cards: readonly string[]): string[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const cardId of cards) {
    if (!counts.has(cardId)) {
      order.push(cardId);
    }
    counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  }
  return order.flatMap((cardId) => Array.from({ length: counts.get(cardId) as number }, () => cardId));
}

/** 与既有测试相同的确定性牌组：奖赏填充、可计划牌序、手牌与补位。 */
function buildDeck(hand: readonly string[], postOpening: readonly string[]): string[] {
  // 前 6 张基本超能量固定作为奖赏填充（与 matchPokemon 相同），保证 rest 留在奖赏下方的牌库；
  // 桌面填充用水能量，避免与奖赏块合并。
  const handPsy = hand.filter((cardId) => cardId === PSY).length;
  const cards = [...repeat(PSY, 6 + handPsy), ...postOpening];
  const handCounts = new Map<string, number>();
  for (const cardId of hand) {
    handCounts.set(cardId, (handCounts.get(cardId) ?? 0) + 1);
  }
  for (const [cardId, needed] of handCounts) {
    const existing = cards.filter((entry) => entry === cardId).length;
    for (let index = existing; index < needed; index += 1) {
      cards.push(cardId);
    }
  }
  const fill = 60 - cards.length;
  if (fill < 0) {
    throw new Error('测试牌组超出 60 张');
  }
  return groupByFirstOccurrence([...cards, ...repeat(WATER, fill)]);
}

interface ScenarioOptions {
  readonly hands: readonly [readonly string[], readonly string[]];
  readonly rest?: readonly [readonly string[], readonly string[]];
  readonly winner?: MatchSeat;
  readonly goFirst?: boolean;
  readonly benchSeats?: readonly MatchSeat[];
  readonly catalog?: CatalogContent;
  readonly attackEffects?: ReadonlyMap<string, AttackEffectResolver>;
  readonly abilityEffects?: ReadonlyMap<string, AbilityEffect>;
}

function plannedRandoms(options: ScenarioOptions, winner: MatchSeat): number[] {
  const rest = options.rest ?? [[], []];
  const decks: [string[], string[]] = [buildDeck(options.hands[0], rest[0]), buildDeck(options.hands[1], rest[1])];
  const script = new OpeningHandScript(decks);
  for (const seat of [0, 1] as const) {
    const pool = [...decks[seat]];
    for (const cardId of options.hands[seat]) {
      const index = pool.indexOf(cardId);
      if (index < 0) {
        throw new Error(`规划手牌失败：牌库中没有 ${cardId}`);
      }
      pool.splice(index, 1);
    }
    script.planHand(seat, options.hands[seat], pool.splice(0, 6));
  }
  return [winner === 0 ? 0 : 1, ...script.outputs, ...Array.from({ length: 800 }, () => 0)];
}

function scenario(options: ScenarioOptions): MatchEngine {
  const winner = options.winner ?? 0;
  const catalog = options.catalog ?? releaseCatalogContent();
  const rest = options.rest ?? [[], []];
  const decks: [string[], string[]] = [buildDeck(options.hands[0], rest[0]), buildDeck(options.hands[1], rest[1])];
  const config: MatchEngineConfig = {
    sessionId: SESSION,
    decks: [deckDocumentFromCardsWith(decks[0], catalog), deckDocumentFromCardsWith(decks[1], catalog)],
    nicknames: ['小智', '小茂'],
    catalog,
    random: new SequenceRandomSource(plannedRandoms(options, winner)),
    trainerEffects: PRODUCTION_TRAINER_EFFECTS,
    stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
    attackEffects: options.attackEffects ?? PRODUCTION_ATTACK_EFFECTS,
    abilityEffects: options.abilityEffects ?? PRODUCTION_ABILITY_EFFECTS,
    toolEffects: PRODUCTION_TOOL_EFFECTS,
  };
  const engine = new MatchEngine(config);
  answerChoice(engine, winner, { type: 'choose-turn-order', goFirst: options.goFirst ?? true });
  finishOpening(engine, options.benchSeats ?? []);
  return engine;
}

function view(engine: MatchEngine, seat: MatchSeat): MatchView {
  return engine.viewFor(seat);
}

function choiceOf(engine: MatchEngine, seat: MatchSeat): MatchPendingChoiceView {
  const pending = engine.viewFor(seat).pendingChoice;
  if (pending === null) {
    throw new Error(`座位 ${seat} 没有待决选择`);
  }
  return pending;
}

function answerChoice(engine: MatchEngine, seat: MatchSeat, extra: Record<string, unknown>): void {
  const current = engine.viewFor(seat);
  if (current.pendingChoice === null) {
    throw new Error('没有可回答的待决选择');
  }
  engine.execute(seat, {
    commandId: `c-choice-${seat}-${engine.version}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: SESSION,
    expectedVersion: current.version,
    choiceId: current.pendingChoice.choiceId,
    ...extra,
  } as MatchClientMessage);
}

function finishOpening(engine: MatchEngine, benchSeats: readonly MatchSeat[]): void {
  for (let step = 0; step < 200; step += 1) {
    const owner = ([0, 1] as const).find((seat) => engine.viewFor(seat).pendingChoice !== null);
    if (owner === undefined) {
      if (engine.phase !== 'playing') {
        throw new Error(`开局流程在 ${engine.phase} 阶段停滞`);
      }
      return;
    }
    const current = engine.viewFor(owner);
    const choice = current.pendingChoice as MatchPendingChoiceView;
    if (choice.kind === 'place-setup') {
      const basics = current.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
      const active = basics[0] as number;
      const bench = benchSeats.includes(owner) ? basics.filter((index) => index !== active) : [];
      answerChoice(engine, owner, { type: 'place-setup', active, bench });
      continue;
    }
    if (choice.kind === 'compensation-draw') {
      answerChoice(engine, owner, { type: 'resolve-compensation', draw: 0 });
      continue;
    }
    if (choice.kind === 'place-bench') {
      answerChoice(engine, owner, { type: 'place-bench', bench: benchSeats.includes(owner) ? choice.candidates : [] });
      continue;
    }
    throw new Error(`未预期的开局待决选择：${choice.kind}`);
  }
  throw new Error('开局流程没有在限定步数内完成');
}

function turnCommand(engine: MatchEngine, seat: MatchSeat, command: Record<string, unknown>): void {
  engine.execute(seat, {
    commandId: `c-turn-${seat}-${engine.version}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: SESSION,
    expectedVersion: engine.version,
    ...command,
  } as MatchClientMessage);
}

function handIndex(
  engine: MatchEngine,
  seat: MatchSeat,
  predicate: (card: MatchView['you']['hand'][number]) => boolean,
): number {
  const index = engine.viewFor(seat).you.hand.findIndex(predicate);
  if (index < 0) {
    throw new Error('手牌中没有满足条件的卡');
  }
  return index;
}

function expectEngineError(fn: () => void, code: string): void {
  let caught: MatchEngineError | undefined;
  try {
    fn();
  } catch (error) {
    if (error instanceof MatchEngineError) {
      caught = error;
    }
  }
  expect(caught?.code).toBe(code);
}

function eventTypes(engine: MatchEngine, seat: MatchSeat): string[] {
  return engine.viewFor(seat).events.map((event) => event.type);
}

function countEvents(engine: MatchEngine, seat: MatchSeat, type: string): number {
  return engine.viewFor(seat).events.filter((event) => event.type === type).length;
}

function endTurn(engine: MatchEngine, seat: MatchSeat): void {
  turnCommand(engine, seat, { type: 'end-turn' });
}

function attach(engine: MatchEngine, seat: MatchSeat, cardId: string, slot: 'active' | 'bench', benchIndex = 0): void {
  turnCommand(engine, seat, {
    type: 'attach-energy',
    handIndex: handIndex(engine, seat, (card) => card.cardId === cardId),
    target: slot === 'active' ? { slot: 'active' } : { slot: 'bench', index: benchIndex },
  });
}

/** 使用手牌中的高级球：支付 2 张手牌代价后，答案选第一张候选宝可梦。 */
function playUltraBall(engine: MatchEngine): void {
  turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === ULTRA_BALL) });
  const discard = choiceOf(engine, 0);
  answerChoice(engine, 0, { type: 'discard-hand', handIndices: [discard.candidates[0] as number, discard.candidates[1] as number] });
  const search = choiceOf(engine, 0);
  answerChoice(engine, 0, { type: 'search-deck', candidateIds: [search.cardCandidates[0]?.candidateId as string] });
}

/** 让座位 `seat` 连续经过 `count` 个自己的回合（对手直接结束回合），每回合可执行 attachId。 */
function passTurnsForEnergy(engine: MatchEngine, seat: MatchSeat, attachIds: readonly string[]): void {
  const other: MatchSeat = seat === 0 ? 1 : 0;
  for (const cardId of attachIds) {
    // 当前必须是 seat 的回合。
    while (engine.viewFor(seat).activeSeat !== seat) {
      endTurn(engine, other);
    }
    attach(engine, seat, cardId, 'active');
    endTurn(engine, seat);
    if (engine.viewFor(seat).result !== null) {
      return;
    }
  }
  while (engine.viewFor(seat).activeSeat !== seat && engine.viewFor(seat).result === null) {
    endTurn(engine, other);
  }
}

const fixture = fixtureCatalog(FIXTURES);

describe('梦幻ex（csve1-056）', () => {
  it('再起动：抽到手牌 3 张；手牌已达 3 张后拒绝且不消耗次数', () => {
    const engine = scenario({
      hands: [
        [MEW, FISH, FISH, FISH, FISH, FISH, FISH],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[PSY, PSY], []],
    });
    // 用基础宝可梦把 7 张手牌压到 2 张（回合开始已经抽过 1 张）。
    for (let index = 0; index < 5; index += 1) {
      turnCommand(engine, 0, { type: 'play-basic', handIndex: handIndex(engine, 0, (card) => card.cardId === FISH) });
    }
    expect(view(engine, 0).you.handCount).toBe(2);
    turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
    expect(view(engine, 0).you.handCount).toBe(3);
    expect(view(engine, 0).you.active?.abilities[0]).toMatchObject({ name: '再起动', usable: false });
    expect(eventTypes(engine, 0)).toContain('ability-used');
    expect(engine.viewFor(0).events.filter((event) => event.type === 'card-drawn' && event.seat === 0).at(-1)).toMatchObject({ count: 1 });
    expect(view(engine, 0).activeSeat).toBe(0);
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 }),
      'action-not-allowed',
    );
  });

  it('基因侵入：复制无说明文招式，支付的是本招式[无无无]费用', () => {
    const engine = scenario({
      hands: [
        [MEW, PSY, PSY, PSY, FISH, FISH, FISH],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      benchSeats: [0],
    });
    passTurnsForEnergy(engine, 0, [PSY, PSY, PSY]);
    expect(view(engine, 0).you.active?.energies).toHaveLength(3);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const modes = choiceOf(engine, 0);
    expect(modes.kind).toBe('choose-mode');
    // 对手（荧光鱼）只有水枪 10：固定伤害招式可复制。
    expect(modes.modes.map((mode) => [mode.modeId, mode.available])).toEqual([['attack-0', true]]);
    answerChoice(engine, 0, { type: 'choose-mode', modeId: 'attack-0' });
    const after = view(engine, 0);
    expect(after.opponent.active?.damageCounters).toBe(1);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '水枪',
      baseDamage: 10,
      damage: 10,
    });
    expect(after.activeSeat).toBe(1);
  });

  it('基因侵入：复制需要后续选择的「珍贵一触」，选择顺序仍按原招式流程', () => {
    const engine = scenario({
      hands: [
        [MEW, PSY, PSY, PSY, PSY, FISH, FISH],
        [SYLVEON_V, SYLVEON_VMAX, PSY, PSY, PSY, PSY, PSY],
      ],
      benchSeats: [0],
    });
    // 对手把自己的最初回合用于过场，第 4 回合（自己的第二个回合）才能进化。
    attach(engine, 0, PSY, 'active');
    endTurn(engine, 0);
    endTurn(engine, 1);
    attach(engine, 0, PSY, 'active');
    endTurn(engine, 0);
    turnCommand(engine, 1, {
      type: 'evolve',
      handIndex: handIndex(engine, 1, (card) => card.cardId === SYLVEON_VMAX),
      target: { slot: 'active' },
    });
    endTurn(engine, 1);
    attach(engine, 0, PSY, 'active');
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const modes = choiceOf(engine, 0);
    expect(modes.modes.find((mode) => mode.modeId === 'attack-0')).toMatchObject({ available: true });
    answerChoice(engine, 0, { type: 'choose-mode', modeId: 'attack-0' });
    const benchChoice = choiceOf(engine, 0);
    expect(benchChoice.kind).toBe('choose-own-bench');
    answerChoice(engine, 0, { type: 'choose-own-bench', benchIndex: benchChoice.candidates[0] as number });
    const energyChoice = choiceOf(engine, 0);
    expect(energyChoice.kind).toBe('attach-hand-energy');
    const psy = energyChoice.cardCandidates.find((candidate) => candidate.card.cardId === PSY);
    expect(psy).toBeDefined();
    answerChoice(engine, 0, { type: 'attach-hand-energy', candidateId: psy?.candidateId as string });
    const after = view(engine, 0);
    expect(after.you.bench[0]?.energies.map((energy) => energy.card.cardId)).toEqual([PSY]);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({ attackName: '珍贵一触' });
    expect(after.activeSeat).toBe(1);
  });

  it('基因侵入：未接入招式列出但不可选；全部未接入时按无效果收招', () => {
    const weird = fixtureCatalog(FIXTURES);
    const engine = scenario({
      catalog: weird,
      hands: [
        [MEW, PSY, PSY, PSY, FISH, FISH, FISH],
        ['fix-weird', PSY, PSY, PSY, PSY, PSY, PSY],
      ],
    });
    passTurnsForEnergy(engine, 0, [PSY, PSY, PSY]);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const modes = choiceOf(engine, 0);
    const unavailable = modes.modes.find((mode) => mode.modeId === 'attack-0');
    expect(unavailable).toMatchObject({ available: false });
    expectEngineError(() => answerChoice(engine, 0, { type: 'choose-mode', modeId: 'attack-0' }), 'illegal-choice');
    const supported = modes.modes.find((mode) => mode.modeId === 'attack-1');
    expect(supported).toMatchObject({ available: true });
    answerChoice(engine, 0, { type: 'choose-mode', modeId: 'attack-1' });
    expect(view(engine, 0).opponent.active?.damageCounters).toBe(2);

    // 只有未接入招式的对手：无可用模式，按无效果收招并结束回合。
    const onlyUnsupported: readonly FixtureCardInput[] = [
      {
        id: 'fix-text-only',
        nameZh: '夹具纯说明文宝可梦',
        cardClass: 'pokemon',
        subtypes: ['基础'],
        type: '恶',
        hp: 100,
        attacks: [{ name: '纯说明文', cost: [], damage: null, text: '未接入。' }],
      },
    ];
    const engine2 = scenario({
      catalog: fixtureCatalog(onlyUnsupported),
      hands: [
        [MEW, PSY, PSY, PSY, FISH, FISH, FISH],
        ['fix-text-only', PSY, PSY, PSY, PSY, PSY, PSY],
      ],
    });
    passTurnsForEnergy(engine2, 0, [PSY, PSY, PSY]);
    turnCommand(engine2, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const after = view(engine2, 0);
    expect(after.pendingChoice).toBeNull();
    expect(after.activeSeat).toBe(1);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({ attackName: '基因侵入', baseDamage: 0 });
  });
});

describe('月石（csve1-057）', () => {
  it('循环抽取：有手牌时必须弃 1 张再抽 3 张', () => {
    const engine = scenario({
      hands: [
        [MOON, FISH, PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[PSY, PSY, PSY], []],
      winner: 1,
      goFirst: true,
    });
    endTurn(engine, 1);
    attach(engine, 0, PSY, 'active');
    const handBefore = view(engine, 0).you.handCount;
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const discardChoice = choiceOf(engine, 0);
    expect(discardChoice.kind).toBe('discard-hand');
    expectEngineError(() => answerChoice(engine, 0, { type: 'discard-hand', handIndices: [] }), 'illegal-choice');
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [discardChoice.candidates[0] as number] });
    const after = view(engine, 0);
    expect(after.you.handCount).toBe(handBefore - 1 + 3);
    expect(after.you.discard.length).toBeGreaterThan(0);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({ attackName: '循环抽取', baseDamage: 0 });
    expect(after.activeSeat).toBe(1);
  });

  it('循环抽取：手牌为空时只抽 3 张，不创建弃牌选择', () => {
    const engine = scenario({
      hands: [
        [MOON, FISH, FISH, FISH, FISH, PSY, ULTRA_BALL],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[ULTRA_BALL, ULTRA_BALL, WORM, WORM, WORM], []],
      winner: 1,
      goFirst: true,
    });
    endTurn(engine, 1);
    // 回合开始抽到高级球；弃 2 找 1 的净消耗把 7 张手牌压到 0。
    attach(engine, 0, PSY, 'active');
    playUltraBall(engine);
    playUltraBall(engine);
    for (let index = 0; index < 5; index += 1) {
      const basics = view(engine, 0).you.hand.findIndex((card) => card.isBasicPokemon);
      if (basics < 0) {
        break;
      }
      turnCommand(engine, 0, { type: 'play-basic', handIndex: basics });
      if (view(engine, 0).you.handCount === 0) {
        break;
      }
    }
    expect(view(engine, 0).you.handCount).toBe(0);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const after = view(engine, 0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.handCount).toBe(3);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({ attackName: '循环抽取', baseDamage: 0 });
  });

  it('月亮强念：30 + 身上[超]能量数量×30', () => {
    const engine = scenario({
      hands: [
        [MOON, PSY, PSY, WATER, PSY, FISH, FISH],
        [CHIEN_PAO, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
    });
    passTurnsForEnergy(engine, 0, [PSY, PSY, WATER]);
    expect(view(engine, 0).you.active?.energies.map((energy) => energy.card.cardId)).toEqual([PSY, PSY, WATER]);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 1, target: { slot: 'active' } });
    const after = view(engine, 0);
    // 30 + 2×30 = 90；月石是超属性，对手古剑豹ex 弱点是钢，不倍增。
    expect(after.opponent.active?.damageCounters).toBe(9);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '月亮强念',
      baseDamage: 90,
      damage: 90,
    });
  });
});

describe('拖拖蚓（csv3c-095）', () => {
  it('营养铁质：持续效果，3 个以上[钢]能量时最大 HP +100', () => {
    const engine = scenario({
      catalog: fixture,
      hands: [
        [WORM, 'fix-steel', 'fix-steel', 'fix-steel', PSY, FISH, FISH],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
    });
    const ability = view(engine, 0).you.active?.abilities[0];
    expect(ability).toMatchObject({ name: '营养铁质', supported: true, usable: false });
    expect(ability?.unusableReasonZh).toContain('持续效果');
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 }),
      'action-not-allowed',
    );
    expect(view(engine, 0).you.active?.maxHp).toBe(130);
    attach(engine, 0, 'fix-steel', 'active');
    endTurn(engine, 0);
    endTurn(engine, 1);
    attach(engine, 0, 'fix-steel', 'active');
    expect(view(engine, 0).you.active?.maxHp).toBe(130);
    endTurn(engine, 0);
    endTurn(engine, 1);
    attach(engine, 0, 'fix-steel', 'active');
    expect(view(engine, 0).you.active?.maxHp).toBe(230);
  });

  it('刺穿：战斗宝可梦 100（含弱点）后对选定备战宝可梦直接 30（不计算弱点/抗性）', () => {
    const engine = scenario({
      catalog: fixture,
      hands: [
        [WORM, 'fix-steel', 'fix-steel', 'fix-steel', PSY, PSY, PSY],
        [CHIEN_PAO, FISH, PSY, PSY, PSY, PSY, PSY],
      ],
      benchSeats: [1],
    });
    passTurnsForEnergy(engine, 0, ['fix-steel', 'fix-steel', 'fix-steel']);
    // 第 4 个能量补满[无无无无]费用。
    attach(engine, 0, PSY, 'active');
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const benchChoice = choiceOf(engine, 0);
    expect(benchChoice.kind).toBe('switch-opponent');
    expect(benchChoice.candidates).toEqual([0]);
    answerChoice(engine, 0, { type: 'switch-opponent', benchIndex: 0 });
    const after = view(engine, 0);
    // 拖拖蚓是钢属性，古剑豹ex 弱点是钢：100×2 = 200（HP220，存活）。
    expect(after.opponent.active?.damageCounters).toBe(20);
    // 备战荧光鱼直接 30 伤害指示物 3 个，不计算弱点/抗性。
    expect(after.opponent.bench[0]?.damageCounters).toBe(3);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '刺穿',
      baseDamage: 100,
      damage: 200,
    });
  });

  it('刺穿：对手没有备战宝可梦时只结算战斗伤害，不创建选择', () => {
    const engine = scenario({
      catalog: fixture,
      hands: [
        [WORM, 'fix-steel', 'fix-steel', 'fix-steel', PSY, PSY, PSY],
        [CHIEN_PAO, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
    });
    passTurnsForEnergy(engine, 0, ['fix-steel', 'fix-steel', 'fix-steel']);
    attach(engine, 0, PSY, 'active');
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const after = view(engine, 0);
    expect(after.pendingChoice).toBeNull();
    expect(after.opponent.active?.damageCounters).toBe(20);
    expect(after.activeSeat).toBe(1);
  });
});

describe('荧光鱼（csve1-035）', () => {
  it('海之伴奏：任意次使用，每次选[水]能量附着于「随心游动」宝可梦', () => {
    const engine = scenario({
      catalog: fixture,
      hands: [
        [FISH, 'fix-swim', WATER, WATER, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      benchSeats: [0],
    });
    const ability = view(engine, 0).you.active?.abilities[0];
    expect(ability).toMatchObject({ name: '海之伴奏', usable: true });
    for (let use = 0; use < 2; use += 1) {
      turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
      const targetChoice = choiceOf(engine, 0);
      expect(targetChoice.kind).toBe('choose-mode');
      expect(targetChoice.modes.map((mode) => mode.modeId)).toContain('bench-0');
      answerChoice(engine, 0, { type: 'choose-mode', modeId: 'bench-0' });
      const energyChoice = choiceOf(engine, 0);
      expect(energyChoice.kind).toBe('attach-hand-energy');
      expect(new Set(energyChoice.cardCandidates.map((candidate) => candidate.card.cardId))).toEqual(new Set([WATER]));
      answerChoice(engine, 0, { type: 'attach-hand-energy', candidateId: energyChoice.cardCandidates[0]?.candidateId as string });
    }
    const after = view(engine, 0);
    expect(after.you.bench[0]?.energies.map((energy) => energy.card.cardId)).toEqual([WATER, WATER]);
    // 「任意次」不写入每回合使用记账：视图仍可用。
    expect(after.you.active?.abilities[0]).toMatchObject({ usable: true });
    expect(after.events.filter((event) => event.type === 'ability-used')).toHaveLength(2);
    expect(after.activeSeat).toBe(0);
  });

  it('海之伴奏：场上没有「随心游动」目标时拒绝且不消耗随机/状态', () => {
    const engine = scenario({
      hands: [
        [FISH, WATER, PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
    });
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
    expect(eventTypes(engine, 0)).not.toContain('ability-used');
  });
});

describe('藤树（csve1-155）与珠贝（csve1-138）', () => {
  it('藤树：只检索「连击」基础宝可梦直接放于备战区', () => {
    const engine = scenario({
      hands: [
        [FISH, TREECKO, SYLVEON_V, WORM, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[WATER, FISH, FISH, SYLVEON_V, SYLVEON_V], []],
      winner: 1,
      goFirst: true,
    });
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === TREECKO) });
    const search = choiceOf(engine, 0);
    expect(search.kind).toBe('search-deck');
    expect(search.min).toBe(0);
    expect(new Set(search.cardCandidates.map((candidate) => candidate.card.cardId))).toEqual(new Set([SYLVEON_V]));
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [search.cardCandidates[0]?.candidateId as string] });
    const after = view(engine, 0);
    expect(after.you.bench.map((pokemon) => pokemon.card.cardId)).toEqual([SYLVEON_V]);
    expect(after.events.filter((event) => event.type === 'cards-searched').at(-1)).toMatchObject({ destination: 'bench' });
    expect(after.you.discard.some((card) => card.cardId === TREECKO)).toBe(true);
  });

  it('藤树：备战区已满时拒绝，不消耗支援者次数', () => {
    const engine = scenario({
      hands: [
        [FISH, FISH, FISH, FISH, FISH, FISH, TREECKO],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      winner: 1,
      goFirst: true,
    });
    endTurn(engine, 1);
    for (let index = 0; index < 5; index += 1) {
      turnCommand(engine, 0, { type: 'play-basic', handIndex: handIndex(engine, 0, (card) => card.cardId === FISH) });
    }
    expect(view(engine, 0).you.bench).toHaveLength(5);
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === TREECKO) }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
    expect(view(engine, 0).you.supporterUsedThisTurn).toBe(false);
  });

  it('珠贝：[水]宝可梦与真正的物品各 1 张，只在最后重洗 1 次', () => {
    const engine = scenario({
      hands: [
        [FISH, IRIDA, PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[WATER, FISH, FISH, POKE_BALL, COURAGE_CHARM], []],
      winner: 1,
      goFirst: true,
    });
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === IRIDA) });
    const waterStep = choiceOf(engine, 0);
    expect(waterStep.kind).toBe('search-deck');
    expect(waterStep.step).toBe(1);
    expect(waterStep.stepCount).toBe(2);
    expect(waterStep.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([FISH]);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [waterStep.cardCandidates[0]?.candidateId as string] });
    const itemStep = choiceOf(engine, 0);
    expect(itemStep.step).toBe(2);
    // 勇气护符是宝可梦道具，不属于「物品」目标。
    expect(itemStep.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([POKE_BALL]);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [itemStep.cardCandidates[0]?.candidateId as string] });
    const after = view(engine, 0);
    expect(after.you.hand.some((card) => card.cardId === FISH)).toBe(true);
    expect(after.you.hand.some((card) => card.cardId === POKE_BALL)).toBe(true);
    expect(countEvents(engine, 0, 'deck-shuffled')).toBe(1);
    expect(after.events.filter((event) => event.type === 'cards-searched')).toHaveLength(2);
  });

  it('珠贝：每一步都可以选择 0 张，仍然只重洗 1 次', () => {
    const engine = scenario({
      hands: [
        [FISH, IRIDA, PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[WATER, FISH, FISH, POKE_BALL, COURAGE_CHARM], []],
      winner: 1,
      goFirst: true,
    });
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === IRIDA) });
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const after = view(engine, 0);
    expect(after.pendingChoice).toBeNull();
    expect(countEvents(engine, 0, 'deck-shuffled')).toBe(1);
    expect(after.events.some((event) => event.type === 'cards-searched')).toBe(false);
  });
});

describe('莉佳的邀请（csv2c-118）', () => {
  it('查看对手手牌并把基础宝可梦放于对手备战区后互换；候选只发给使用者', () => {
    const secret = fixtureCatalog([
      ...FIXTURES,
      {
        id: 'fix-secret',
        nameZh: '夹具机密卡',
        cardClass: 'pokemon',
        subtypes: ['基础'],
        type: '超',
        hp: 70,
        attacks: [{ name: '机密攻击', cost: [], damage: '10' }],
      },
    ]);
    const engine = scenario({
      catalog: secret,
      hands: [
        [FISH, 'fix-secret', KLAARA, PSY, PSY, PSY, PSY],
        [WORM, 'fix-probe', PSY, PSY, PSY, PSY, PSY],
      ],
      winner: 1,
      goFirst: true,
    });
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === KLAARA) });
    const pendingOpponentView = view(engine, 1);
    expect(pendingOpponentView.pendingChoice).toBeNull();
    expect(pendingOpponentView.waitingForOpponentChoice).toBe(true);
    // 使用者（座位 0）的隐藏手牌不会因为查看对手手牌而泄露给对手。
    expect(JSON.stringify(pendingOpponentView)).not.toContain('夹具机密卡');
    const pending = choiceOf(engine, 0);
    expect(pending.kind).toBe('search-deck');
    expect(pending.source).toBe('opponent-hand');
    const probe = pending.cardCandidates.find((candidate) => candidate.card.cardId === 'fix-probe');
    expect(probe).toMatchObject({ selectable: true });
    const energyCandidate = pending.cardCandidates.find((candidate) => candidate.card.cardId === PSY);
    expect(energyCandidate).toMatchObject({ selectable: false });
    expectEngineError(
      () => answerChoice(engine, 0, { type: 'search-deck', candidateIds: [energyCandidate?.candidateId as string] }),
      'illegal-choice',
    );
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [probe?.candidateId as string] });
    const after = view(engine, 0);
    // 选中的基础宝可梦直接成为对手战斗宝可梦，原战斗宝可梦进入备战区。
    expect(after.opponent.active?.card.cardId).toBe('fix-probe');
    expect(after.opponent.bench.map((pokemon) => pokemon.card.cardId)).toEqual([WORM]);
    expect(after.opponent.handCount).toBe(6);
    expect(after.events.filter((event) => event.type === 'bench-switched').at(-1)).toMatchObject({
      seat: 0,
      targetSeat: 1,
    });
    expect(view(engine, 1).you.active?.card.cardId).toBe('fix-probe');
  });

  it('对手备战区已满时仍展示手牌，但不提供放置目标', () => {
    const engine = scenario({
      hands: [
        [FISH, KLAARA, PSY, PSY, PSY, PSY, PSY],
        [WORM, FISH, FISH, FISH, FISH, FISH, PSY],
      ],
      winner: 1,
      goFirst: true,
    });
    for (let index = 0; index < 5; index += 1) {
      turnCommand(engine, 1, { type: 'play-basic', handIndex: handIndex(engine, 1, (card) => card.cardId === FISH) });
    }
    endTurn(engine, 1);
    expect(view(engine, 1).you.bench).toHaveLength(5);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === KLAARA) });
    const pending = choiceOf(engine, 0);
    expect(pending.kind).toBe('search-deck');
    expect(pending.min).toBe(0);
    expect(pending.max).toBe(0);
    expect(pending.cardCandidates.every((candidate) => candidate.selectable === false)).toBe(true);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const after = view(engine, 0);
    expect(after.events.some((event) => event.type === 'bench-switched')).toBe(false);
    expect(after.opponent.bench).toHaveLength(5);
  });
});

describe('基本能量（T12 / #13）', () => {
  it('四种基本能量都可以按每回合 1 张附着，并公开属性', () => {
    const engine = scenario({
      hands: [
        [MOON, PSY, WATER, FIRE, GRASS, FISH, FISH],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
    });
    passTurnsForEnergy(engine, 0, [PSY, WATER, FIRE, GRASS]);
    const active = view(engine, 0).you.active;
    expect(active?.energies.map((energy) => energy.card.cardId)).toEqual([PSY, WATER, FIRE, GRASS]);
    expect(active?.energies.map((energy) => energy.card.type)).toEqual(['超', '水', '火', '草']);
    expect(countEvents(engine, 0, 'energy-attached')).toBe(4);
  });
});
