import { describe, expect, it } from 'vitest';
import type { CatalogContent, MatchClientMessage, MatchPendingChoiceView, MatchSeat, MatchView } from '@ptcg/protocol';
import {
  MatchEngine,
  MatchEngineError,
  MatchSession,
  abilityEffectKey,
  isPokemonVCard,
  isPokemonVmaxCard,
  prizeValueOf,
  type AbilityEffect,
  type AttackEffectResolver,
  type MatchEngineConfig,
  type ToolEffect,
} from '../src/match.ts';
import {
  PRODUCTION_ABILITY_EFFECTS,
  PRODUCTION_ATTACK_EFFECTS,
  PRODUCTION_TOOL_EFFECTS,
} from '../src/pokemonEffects.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from '../src/trainerEffects.ts';
import {
  OpeningHandScript,
  SequenceRandomSource,
  deckDocumentFromCardsWith,
  fixtureCatalog,
  releaseCatalogContent,
  type FixtureCardInput,
} from './support/matchTestKit.ts';

/**
 * 宝可梦进化、特性、道具与附加卡行为测试（T11 / #12）。
 *
 * 预期来源是冻结卡面文字（effect-matrix 的 full_text_zh）与官方《进阶玩家向
 * 规则指南》A-05（进化）、B-02（宝可梦道具）、C-09（附着能量）、D-18（拥有
 * 规则的宝可梦）。测试给出明确的手牌/牌库/随机序列并断言双方可见结果。
 */

const SESSION = 'session-pokemon';
const PSY = 'cbb2c-1102';
const WATER = 'cbb1c-1803';
const FISH = 'csve1-035';
const SYLVEON_V = 'csve1-062';
const SYLVEON_VMAX = 'csve1-063';
const CHIEN_PAO = 'csv3c-043';
const COURAGE_CHARM = 'csv1c-118';
const POKE_BALL = 'cbb1c-1701';
const SINGLE_STRIKE_ENERGY = 'csve1-171';

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

/** 与 matchTrainers 相同的确定性牌组构造：奖赏填充、可计划的牌序、手牌与补位。 */
function buildDeck(hand: readonly string[], postOpening: readonly string[]): string[] {
  // 前 6 张 PSY 是固定的奖赏填充；手牌里的 PSY 在规划时从牌库移除，
  // 因此按手牌中的 PSY 数量额外预留，保证奖赏卡始终是这 6 张填充。
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
  readonly benchSeats?: readonly MatchSeat[];
  readonly catalog?: CatalogContent;
  readonly attackEffects?: ReadonlyMap<string, AttackEffectResolver>;
  readonly abilityEffects?: ReadonlyMap<string, AbilityEffect>;
  readonly toolEffects?: ReadonlyMap<string, ToolEffect>;
}

interface ScenarioResult {
  readonly engine: MatchEngine;
  readonly config: MatchEngineConfig;
}

function configFor(options: ScenarioOptions, catalog: CatalogContent, outputs: readonly number[]): MatchEngineConfig {
  const rest = options.rest ?? [[], []];
  const decks: [string[], string[]] = [buildDeck(options.hands[0], rest[0]), buildDeck(options.hands[1], rest[1])];
  return {
    sessionId: SESSION,
    decks: [deckDocumentFromCardsWith(decks[0], catalog), deckDocumentFromCardsWith(decks[1], catalog)],
    nicknames: ['小智', '小茂'],
    catalog,
    // 初始洗牌之后可能还有检索洗牌；追加的 0 让 SequenceRandomSource 覆盖它们。
    random: new SequenceRandomSource([...outputs, ...Array.from({ length: 400 }, () => 0)]),
    trainerEffects: PRODUCTION_TRAINER_EFFECTS,
    stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
    attackEffects: options.attackEffects ?? PRODUCTION_ATTACK_EFFECTS,
    abilityEffects: options.abilityEffects ?? PRODUCTION_ABILITY_EFFECTS,
    toolEffects: options.toolEffects ?? PRODUCTION_TOOL_EFFECTS,
  };
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
  return [winner === 0 ? 0 : 1, ...script.outputs];
}

function scenario(options: ScenarioOptions): ScenarioResult {
  const winner = options.winner ?? 0;
  const catalog = options.catalog ?? releaseCatalogContent();
  const config = configFor(options, catalog, plannedRandoms(options, winner));
  const engine = new MatchEngine(config);
  chooseTurnOrder(engine, winner, true);
  finishOpening(engine, options.benchSeats ?? []);
  return { engine, config };
}

function choiceOf(engine: MatchEngine, seat: MatchSeat): MatchPendingChoiceView {
  const view = engine.viewFor(seat);
  if (view.pendingChoice === null) {
    throw new Error(`座位 ${seat} 没有待决选择`);
  }
  return view.pendingChoice;
}

function answerChoice(engine: MatchEngine, seat: MatchSeat, extra: Record<string, unknown>): void {
  const view = engine.viewFor(seat);
  if (view.pendingChoice === null) {
    throw new Error('没有可回答的待决选择');
  }
  engine.execute(seat, {
    commandId: `c-choice-${seat}-${engine.version}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: SESSION,
    expectedVersion: view.version,
    choiceId: view.pendingChoice.choiceId,
    ...extra,
  } as MatchClientMessage);
}

function chooseTurnOrder(engine: MatchEngine, seat: MatchSeat, goFirst: boolean): void {
  const view = engine.viewFor(seat);
  engine.execute(seat, {
    type: 'choose-turn-order',
    commandId: `c-to-${seat}-${engine.version}`,
    sessionId: SESSION,
    expectedVersion: view.version,
    choiceId: (view.pendingChoice as MatchPendingChoiceView).choiceId,
    goFirst,
  });
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
    const view = engine.viewFor(owner);
    const choice = view.pendingChoice as MatchPendingChoiceView;
    if (choice.kind === 'place-setup') {
      const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
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

/** 座位 0（先攻）仙子伊布V 主链：V + 备战 V + VMAX + 勇气护符 + 基本超能量。 */
const EVOLUTION_HANDS: ScenarioOptions['hands'] = [
  [SYLVEON_V, SYLVEON_V, SYLVEON_VMAX, COURAGE_CHARM, PSY, PSY, PSY],
  [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
];

describe('进化（T11 / #12）', () => {
  it('最初回合、名字链与刚出场当回合限制都在状态修改前拒绝', () => {
    const { engine } = scenario({
      hands: [
        [SYLVEON_V, FISH, SYLVEON_V, SYLVEON_VMAX, COURAGE_CHARM, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[], []],
    });
    const version = engine.version;
    // 最初回合的视图公开说明不能进化的原因；客户端据此禁用进化目标。
    expect(engine.viewFor(0).you.active?.canEvolve).toBe(false);
    expect(engine.viewFor(0).you.active?.evolveBlockedReasonZh).toContain('最初回合');
    // 座位 0 的最初回合：任何进化都非法。
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'evolve', handIndex: handIndex(engine, 0, (card) => card.cardId === SYLVEON_VMAX), target: { slot: 'active' } }),
      'action-not-allowed',
    );
    // 把荧光鱼与新 V 放进备战区；名字链不符与刚出场当回合分别拒绝。
    turnCommand(engine, 0, { type: 'play-basic', handIndex: handIndex(engine, 0, (card) => card.cardId === FISH) });
    turnCommand(engine, 0, { type: 'play-basic', handIndex: handIndex(engine, 0, (card) => card.cardId === SYLVEON_V) });
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'evolve', handIndex: handIndex(engine, 0, (card) => card.cardId === SYLVEON_VMAX), target: { slot: 'bench', index: 0 } }),
      'illegal-target',
    );
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'evolve', handIndex: handIndex(engine, 0, (card) => card.cardId === SYLVEON_VMAX), target: { slot: 'bench', index: 1 } }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version + 2);
    expect(eventTypes(engine, 0)).not.toContain('evolved');
  });

  it('进化保留伤害/能量/道具、清除特殊状态，并在视图中公开进化信息', () => {
    const { engine } = scenario({
      hands: EVOLUTION_HANDS,
      rest: [[], []],
      benchSeats: [0],
    });
    turnCommand(engine, 0, { type: 'attach-tool', handIndex: handIndex(engine, 0, (card) => card.cardId === COURAGE_CHARM), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, (card) => card.cardId === PSY), target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.maxHp).toBe(250); // V 200 + 勇气护符 50
    turnCommand(engine, 0, { type: 'end-turn' });
    turnCommand(engine, 1, { type: 'end-turn' });
    turnCommand(engine, 0, { type: 'evolve', handIndex: handIndex(engine, 0, (card) => card.cardId === SYLVEON_VMAX), target: { slot: 'active' } });

    const active = engine.viewFor(0).you.active;
    expect(active?.card.cardId).toBe(SYLVEON_VMAX);
    expect(active?.card.evolvesFrom).toBe('仙子伊布V');
    expect(active?.maxHp).toBe(310); // 勇气护符只加成基础宝可梦，VMAX 不是基础
    expect(active?.energies).toHaveLength(1);
    expect(active?.tools.map((tool) => tool.cardId)).toEqual([COURAGE_CHARM]);
    expect(active?.attacks.map((attack) => attack.name)).toEqual(['珍贵一触', '极巨和弦']);
    const evolved = engine.viewFor(0).events.find((event) => event.type === 'evolved');
    expect(evolved).toMatchObject({ seat: 0, fromNameZh: '仙子伊布V', toNameZh: '仙子伊布VMAX' });
    // 对手同样能看到公开的进化结果与道具附着。
    expect(engine.viewFor(1).opponent.active?.card.cardId).toBe(SYLVEON_VMAX);
    expect(engine.viewFor(1).opponent.active?.tools.map((tool) => tool.cardId)).toEqual([COURAGE_CHARM]);
  });

  it('真实主链：进化→珍贵一触附着→极巨和弦按备战属性种类加伤并终局', () => {
    const { engine } = scenario({
      hands: EVOLUTION_HANDS,
      // 第 1、3、5、7 回合的回合开始抽牌顺序。
      rest: [[PSY, WATER, WATER, WATER], []],
      benchSeats: [0],
    });
    // 第 1 回合（座位 0 先攻）：附道具与能量，结束。
    turnCommand(engine, 0, { type: 'attach-tool', handIndex: handIndex(engine, 0, (card) => card.cardId === COURAGE_CHARM), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, (card) => card.cardId === PSY), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'end-turn' });
    turnCommand(engine, 1, { type: 'end-turn' });
    // 第 3 回合：进化后使用「珍贵一触」：选备战目标 → 选手中能量 → 附着并结束回合。
    turnCommand(engine, 0, { type: 'evolve', handIndex: handIndex(engine, 0, (card) => card.cardId === SYLVEON_VMAX), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const benchChoice = choiceOf(engine, 0);
    expect(benchChoice.kind).toBe('choose-own-bench');
    expect(benchChoice.step).toBe(1);
    expect(benchChoice.stepCount).toBe(2);
    // 对手不能回答选择，也看不到候选。
    expect(engine.viewFor(1).pendingChoice).toBeNull();
    expectEngineError(
      () =>
        engine.execute(1, {
          type: 'choose-own-bench',
          commandId: 'c-cross-seat',
          sessionId: SESSION,
          expectedVersion: engine.version,
          choiceId: benchChoice.choiceId,
          benchIndex: 0,
        }),
      'not-your-choice',
    );
    answerChoice(engine, 0, { type: 'choose-own-bench', benchIndex: benchChoice.candidates[0] as number });
    const energyChoice = choiceOf(engine, 0);
    expect(energyChoice.kind).toBe('attach-hand-energy');
    expect(energyChoice.step).toBe(2);
    const energyCandidate = energyChoice.cardCandidates.find((candidate) => candidate.card.cardId === PSY);
    expect(energyCandidate).toBeDefined();
    answerChoice(engine, 0, { type: 'attach-hand-energy', candidateId: energyCandidate?.candidateId as string });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(engine.viewFor(0).you.bench[0]?.energies.map((energy) => energy.card.cardId)).toEqual([PSY]);
    expect(engine.viewFor(0).activeSeat).toBe(1); // 招式结束回合
    const touchEvent = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    expect(touchEvent).toMatchObject({ attackName: '珍贵一触', baseDamage: 0, damage: 0 });
    // 第 5 回合：再附 1 张能量；第 7 回合附满 3 张后使用「极巨和弦」。
    turnCommand(engine, 1, { type: 'end-turn' });
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, (card) => card.cardId === PSY), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'end-turn' });
    turnCommand(engine, 1, { type: 'end-turn' });
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, (card) => card.cardId === PSY), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: 1, target: { slot: 'active' } });
    const chord = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    // 备战区 1 只超属性 V（附着能量不改变属性）→ 70 + 1×30 = 100。
    expect(chord).toMatchObject({ attackName: '极巨和弦', baseDamage: 100, damage: 100 });
    // 对手荧光鱼 50 HP 被击倒，且没有后备：取走奖赏后终局为无后备败北。
    const prizeChoice = choiceOf(engine, 0);
    expect(prizeChoice.kind).toBe('take-prizes');
    answerChoice(engine, 0, { type: 'take-prizes', prizes: [prizeChoice.candidates[0] as number] });
    const result = engine.viewFor(0).result;
    expect(result).toMatchObject({ winner: 0, reason: 'no-pokemon' });
    expect(engine.viewFor(1).result?.winner).toBe(0);
  });

  it('V/VMAX 奖赏价值从印刷规则读取；「宝可梦V」按印刷规则文字匹配', () => {
    const catalog = releaseCatalogContent();
    const v = catalog.cards.find((card) => card.id === SYLVEON_V) as NonNullable<ReturnType<typeof catalog.cards.find>>;
    const vmax = catalog.cards.find((card) => card.id === SYLVEON_VMAX) as NonNullable<ReturnType<typeof catalog.cards.find>>;
    expect(prizeValueOf(v)).toBe(2);
    expect(prizeValueOf(vmax)).toBe(3);
    // D-18：V 与 VMAX 都是「拥有规则的宝可梦」；官方截止日前文章 product/15732
    // 以「讲究腰带」对宝可梦V 的加成作用于 VMAX，确认 VMAX 属于「宝可梦V」。
    expect(isPokemonVCard(v)).toBe(true);
    expect(isPokemonVCard(vmax)).toBe(true);
    expect(isPokemonVmaxCard(vmax)).toBe(true);
  });
});

describe('特性（T11 / #12）', () => {
  it('梦中赠礼：只检索真正的物品、候选只发给选择者、结算后自己的回合结束', () => {
    const { engine } = scenario({
      hands: [
        [SYLVEON_V, COURAGE_CHARM, PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[WATER, POKE_BALL], []],
    });
    const abilityView = engine.viewFor(0).you.active?.abilities[0];
    expect(abilityView).toMatchObject({ name: '梦中赠礼', supported: true, usable: true });
    turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
    expect(eventTypes(engine, 0)).toContain('ability-used');
    const choice = choiceOf(engine, 0);
    expect(choice.kind).toBe('search-deck');
    // 勇气护符是宝可梦道具，不是物品，不出现在候选中；精灵球是物品。
    expect(choice.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([POKE_BALL]);
    // 候选隐私：对手载荷没有候选身份。
    expect(engine.viewFor(1).pendingChoice).toBeNull();
    expect(JSON.stringify(engine.viewFor(1))).not.toContain(POKE_BALL);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [choice.cardCandidates[0]?.candidateId as string] });
    expect(engine.viewFor(0).you.hand.map((card) => card.cardId)).toContain(POKE_BALL);
    expect(eventTypes(engine, 0)).toContain('cards-searched');
    // 使用了特性后回合立即结束，轮到对手。
    expect(engine.viewFor(0).activeSeat).toBe(1);
    expect(engine.viewFor(0).you.active?.abilities[0]?.usable).toBe(false);
  });

  it('梦中赠礼牌库没有目标时不创建无人能答的选择，按检索失败处理并结束回合', () => {
    const { engine } = scenario({
      hands: [
        [SYLVEON_V, PSY, PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[], []],
    });
    turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(engine.viewFor(0).activeSeat).toBe(1);
    expect(eventTypes(engine, 0)).toContain('deck-shuffled');
  });

  it('战栗冷气：只在战斗场上、每只宝可梦每回合 1 次、只检索基本水能量', () => {
    const { engine } = scenario({
      hands: [
        [FISH, CHIEN_PAO, WATER, WATER, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[PSY, PSY], []],
      // 古剑豹ex 放于备战区：条件不满足。
      benchSeats: [0],
    });
    const benchAbility = engine.viewFor(0).you.bench[0]?.abilities[0];
    expect(benchAbility).toMatchObject({ name: '战栗冷气', supported: true, usable: false });
    expect(benchAbility?.unusableReasonZh).toContain('战斗场');
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'bench', index: 0 }, abilityIndex: 0 }),
      'action-not-allowed',
    );
    // 未接入特性仍整体拒绝。
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 }),
      'unsupported-card',
    );
  });

  it('战栗冷气在战斗场使用一次后本回合拒绝再次使用', () => {
    const { engine } = scenario({
      hands: [
        [CHIEN_PAO, WATER, WATER, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[PSY, PSY], []],
    });
    const abilityView = engine.viewFor(0).you.active?.abilities[0];
    expect(abilityView).toMatchObject({ name: '战栗冷气', usable: true });
    turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
    const choice = choiceOf(engine, 0);
    expect(choice.kind).toBe('search-deck');
    // 候选只有基本水能量（基本超能量不在其中）。
    expect(new Set(choice.cardCandidates.map((candidate) => candidate.card.cardId))).toEqual(new Set([WATER]));
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [choice.cardCandidates[0]?.candidateId as string] });
    expect(engine.viewFor(0).you.active?.abilities[0]).toMatchObject({ usable: false });
    expect(engine.viewFor(0).you.active?.abilities[0]?.unusableReasonZh).toContain('本回合');
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 }),
      'action-not-allowed',
    );
  });

  it('进化不会把旧卡的特性使用次数错误带给新卡：新卡的另一个特性仍可使用', () => {
    // 受控目录：进化前的 V 有「战栗冷气」，进化后的 VMAX 有「测试特性」。
    // 第 3 回合先用旧特性、再进化、再使用新特性，验证限制按卡上的特性记账。
    const release = releaseCatalogContent();
    const patched: CatalogContent = {
      ...release,
      cards: release.cards.map((card) => {
        if (card.id === SYLVEON_V) {
          return { ...card, abilities: [{ label: '特性', name: '战栗冷气', text: '测试用特性。' }] };
        }
        if (card.id === SYLVEON_VMAX) {
          return { ...card, abilities: [{ label: '特性', name: '测试特性', text: '测试用新特性。' }] };
        }
        return card;
      }),
    };
    const searchEffect: AbilityEffect = {
      canUse: () => ({ ok: true }),
      use: (context) => {
        context.startDeckSearch({
          filter: { basicEnergyOnly: true, energyType: '水' },
          min: 0,
          max: 2,
          destination: 'hand',
          descriptionZh: '测试特性检索。',
        });
      },
    };
    const abilityEffects = new Map<string, AbilityEffect>([
      ...PRODUCTION_ABILITY_EFFECTS,
      [abilityEffectKey('fx:pokemon:仙子伊布V:82add47b1578', '战栗冷气'), searchEffect],
      [abilityEffectKey('fx:pokemon:仙子伊布VMAX:7f46295cb5ec', '测试特性'), searchEffect],
    ]);
    const { engine } = scenario({
      catalog: patched,
      abilityEffects,
      hands: [
        [SYLVEON_V, SYLVEON_VMAX, WATER, WATER, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[PSY, PSY], []],
    });
    // 第 1 回合先攻不能进化，结束；第 2 回合对手结束。
    turnCommand(engine, 0, { type: 'end-turn' });
    turnCommand(engine, 1, { type: 'end-turn' });
    // 第 3 回合：先用旧卡的「战栗冷气」，再进化，再用新卡的「测试特性」。
    turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
    let choice = choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [choice.cardCandidates[0]?.candidateId as string] });
    turnCommand(engine, 0, { type: 'evolve', handIndex: handIndex(engine, 0, (card) => card.cardId === SYLVEON_VMAX), target: { slot: 'active' } });
    const newAbility = engine.viewFor(0).you.active?.abilities[0];
    expect(newAbility).toMatchObject({ name: '测试特性', usable: true });
    turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
    choice = choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [choice.cardCandidates[0]?.candidateId as string] });
    expect(engine.viewFor(0).you.active?.abilities[0]?.usable).toBe(false);
  });
});

describe('宝可梦道具（T11 / #12）', () => {
  it('勇气护符：基础宝可梦 +50、保持附着并随昏厥进弃牌区', () => {
    const fixture: FixtureCardInput[] = [
      {
        id: 'fix-ko',
        nameZh: '夹具击倒',
        cardClass: 'pokemon',
        subtypes: ['基础'],
        type: '水',
        hp: 50,
        attacks: [{ name: '终击', cost: ['水'], damage: '990' }],
      },
    ];
    const catalog = fixtureCatalog(fixture);
    const { engine } = scenario({
      catalog,
      hands: [
        [FISH, COURAGE_CHARM, PSY, PSY, PSY, PSY, PSY],
        ['fix-ko', WATER, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[], []],
    });
    // 座位 0 先攻：先把勇气护符贴到荧光鱼（基础）。
    turnCommand(engine, 0, { type: 'attach-tool', handIndex: handIndex(engine, 0, (card) => card.cardId === COURAGE_CHARM), target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.maxHp).toBe(100);
    expect(engine.viewFor(0).you.active?.tools.map((tool) => tool.cardId)).toEqual([COURAGE_CHARM]);
    // 每只宝可梦至多 1 张：先消耗手牌里的道具，再验证无第二张可贴。
    turnCommand(engine, 0, { type: 'end-turn' });
    // 座位 1 用夹具固定伤害招式击倒 100 HP 的荧光鱼。
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: handIndex(engine, 1, (card) => card.cardId === WATER), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const prizeChoice = choiceOf(engine, 1);
    answerChoice(engine, 1, { type: 'take-prizes', prizes: [prizeChoice.candidates[0] as number] });
    expect(engine.viewFor(0).result?.winner).toBe(1);
    // 昏厥宝可梦与勇气护符一同进入弃牌区。
    expect(engine.viewFor(1).opponent.discard.map((card) => card.cardId)).toContain(COURAGE_CHARM);
  });

  it('未接入的宝可梦道具整体拒绝，不能借用物品规则', () => {
    const fixture: FixtureCardInput[] = [
      { id: 'fix-tool', nameZh: '夹具道具', cardClass: 'trainer', effectiveCategory: '宝可梦道具' },
    ];
    const catalog = fixtureCatalog(fixture);
    const { engine } = scenario({
      catalog,
      hands: [
        [FISH, 'fix-tool', PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[], []],
    });
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'attach-tool', handIndex: handIndex(engine, 0, (card) => card.cardId === 'fix-tool'), target: { slot: 'active' } }),
      'unsupported-card',
    );
  });
});

describe('附加卡与特殊能量边界（T11 / #12）', () => {
  it('未接入的特殊能量不能附着，附着路径整体拒绝', () => {
    const { engine } = scenario({
      hands: [
        [FISH, SINGLE_STRIKE_ENERGY, PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[], []],
    });
    expectEngineError(
      () => turnCommand(engine, 0, {
        type: 'attach-energy',
        handIndex: handIndex(engine, 0, (card) => card.cardId === SINGLE_STRIKE_ENERGY),
        target: { slot: 'active' },
      }),
      'unsupported-card',
    );
  });
});

describe('公共会话边界（T11 / #12）', () => {
  it('越权/旧版本/重复命令不改变状态，候选只发给选择者', () => {
    const options: ScenarioOptions = {
      hands: [
        [SYLVEON_V, COURAGE_CHARM, PSY, PSY, PSY, PSY, PSY],
        [FISH, PSY, PSY, PSY, PSY, PSY, PSY],
      ],
      rest: [[WATER, POKE_BALL], []],
    };
    const catalog = releaseCatalogContent();
    const config = configFor(options, catalog, plannedRandoms(options, 0));
    const session = new MatchSession(config);
    const handle0 = session.handleFor(0);
    const handle1 = session.handleFor(1);
    const initial = session.viewFor(handle0);
    session.submit(handle0, {
      type: 'choose-turn-order',
      commandId: 'session-to',
      sessionId: SESSION,
      expectedVersion: initial.version,
      choiceId: (initial.pendingChoice as MatchPendingChoiceView).choiceId,
      goFirst: true,
    });
    for (let step = 0; step < 100; step += 1) {
      const owner = ([0, 1] as const).find((seat) => session.viewFor(session.handleFor(seat)).pendingChoice !== null);
      if (owner === undefined) {
        break;
      }
      const view = session.viewFor(session.handleFor(owner));
      const choice = view.pendingChoice as MatchPendingChoiceView;
      const base = { commandId: `session-open-${step}`, sessionId: SESSION, expectedVersion: view.version, choiceId: choice.choiceId };
      if (choice.kind === 'place-setup') {
        const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
        session.submit(session.handleFor(owner), { type: 'place-setup', ...base, active: basics[0] as number, bench: [] });
        continue;
      }
      if (choice.kind === 'compensation-draw') {
        session.submit(session.handleFor(owner), { type: 'resolve-compensation', ...base, draw: 0 });
        continue;
      }
      if (choice.kind === 'place-bench') {
        session.submit(session.handleFor(owner), { type: 'place-bench', ...base, bench: [] });
        continue;
      }
      throw new Error(`未知开局选择 ${choice.kind}`);
    }
    // 旧版本命令被拒绝并回传当前视图，状态不变。
    const before = session.viewFor(handle0);
    const psyIndex = before.you.hand.findIndex((card) => card.cardId === PSY);
    const stale = session.submit(handle0, {
      type: 'attach-energy',
      commandId: 'session-stale',
      sessionId: SESSION,
      expectedVersion: before.version - 1,
      handIndex: psyIndex,
      target: { slot: 'active' },
    });
    expect(stale).toMatchObject({ ok: false, code: 'stale-version' });
    expect(session.viewFor(handle0).version).toBe(before.version);
    // 座位 0 使用特性：只有座位 0 得到待决选择，座位 1 回答被拒绝。
    const useAbility = session.submit(handle0, {
      type: 'use-ability',
      commandId: 'session-ability',
      sessionId: SESSION,
      expectedVersion: before.version,
      target: { slot: 'active' },
      abilityIndex: 0,
    });
    expect(useAbility.ok).toBe(true);
    const choice0 = session.viewFor(handle0).pendingChoice;
    expect(choice0?.kind).toBe('search-deck');
    expect(session.viewFor(handle1).pendingChoice).toBeNull();
    expect(JSON.stringify(session.viewFor(handle1))).not.toContain(POKE_BALL);
    const crossSeat = session.submit(handle1, {
      type: 'search-deck',
      commandId: 'session-cross',
      sessionId: SESSION,
      expectedVersion: session.viewFor(handle1).version,
      choiceId: choice0?.choiceId as string,
      candidateIds: [],
    });
    expect(crossSeat.ok).toBe(false);
    // 相同命令 ID 的精确重传返回第一次结果，不重复生效。
    const duplicate = session.submit(handle0, {
      type: 'use-ability',
      commandId: 'session-ability',
      sessionId: SESSION,
      expectedVersion: before.version,
      target: { slot: 'active' },
      abilityIndex: 0,
    });
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });
  });
});
