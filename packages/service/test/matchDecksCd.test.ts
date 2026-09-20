import { describe, expect, it } from 'vitest';
import { presetDeckDocument, type CatalogContent, type MatchClientMessage, type MatchPendingChoiceView, type MatchSeat } from '@ptcg/protocol';
import { MatchEngine, MatchEngineError, type MatchEngineConfig } from '../src/match.ts';
import {
  PRODUCTION_ABILITY_EFFECTS,
  PRODUCTION_ATTACK_EFFECTS,
  PRODUCTION_PASSIVE_ABILITY_EFFECTS,
  PRODUCTION_TOOL_EFFECTS,
} from '../src/pokemonEffects.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from '../src/trainerEffects.ts';
import {
  OpeningHandScript,
  SequenceRandomSource,
  deckDocumentFromCardsWith,
  fixtureCatalog,
  loadReleaseCatalog,
  releaseCatalogContent,
} from './support/matchTestKit.ts';

/**
 * T13 / #14：C/D 预设卡组剩余卡牌效果行为。
 *
 * 期望值来自冻结卡面文字与冻结规则（B-01/B-04、D、F、H），覆盖正常路径、
 * 失败/可选分支、目标与次数限制，以及与进化/道具/昏厥/奖赏等既有机制的交互。
 * 夹具卡只用于构造属性、HP 与招式条件；发行目录与 APK 不包含这些卡。
 *
 * 牌库构造约定：`rest[seat]` 是从开局奖赏卡之后开始的完整牌库顺序；每个座位
 * 在自己的回合开始抽走 1 张，因此断言前必须按自己的回合数预留抽牌。牌库总张
 * 数固定为 13 + rest.length（7 手牌 + 6 奖赏 + 全部 rest），因此不存在填充
 * 干扰：rest 的最后一张之后牌库为空。
 */

const SESSION = 'session-decks-cd';
const DRAGON = 'csv3c-095'; // 拖拖蚓（基础填充；C/D 兼用）
const FIRE_FISH = 'csv3c-031'; // 古玉鱼ex
const SNAIL = 'csv3c-015'; // 古简蜗ex
const MEW = 'csve1-056'; // 梦幻ex
const REGI = 'csve1-098'; // 雷吉奇卡斯
const CAMPFIRE = 'csve1-143'; // 营火专家
const LILLIE = 'csv2c-118'; // 莉佳的邀请
const THORNTON = 'csve1-157'; // 捩木
const MAGMA = 'csve1-169'; // 熔岩瀑布之渊
const COURAGE = 'csv1c-118'; // 勇气护符
const ULTRA_BALL = 'cbb1c-1703'; // 高级球
const CHIEN_PAO = 'csv3c-043'; // 古剑豹ex
const FIRE = 'cbb1c-1802';
const GRASS = 'cbb1c-1801';
const WATER = 'cbb1c-1803';
const PSY = 'cbb2c-1102';

const FIXTURE_NEUTRAL = 'fixture-neutral';
const FIXTURE_FIRE_20 = 'fixture-fire-20';
const FIXTURE_STEEL_ENERGY = 'fixture-steel-energy';
const FIXTURE_ATTACKER = 'fixture-attacker';
const FIXTURE_VICTIM = 'fixture-victim';
const FIXTURE_WATER_WEAK = 'fixture-water-weak';
const FIXTURE_BENCH_60 = 'fixture-bench-60';
const FIXTURE_VMAX = 'fixture-vmax';
const FIXTURE_UNSUPPORTED = 'fixture-unsupported';
const REGIROCK = 'fixture-regirock';

function repeat(cardId: string, count: number): string[] {
  return Array.from({ length: count }, () => cardId);
}

function cdFixtures(): CatalogContent {
  return fixtureCatalog([
    { id: FIXTURE_NEUTRAL, nameZh: '测试无弱点', cardClass: 'pokemon', subtypes: ['基础'], type: '无', hp: 200, retreat: 1 },
    { id: FIXTURE_FIRE_20, nameZh: '测试火宝可梦20', cardClass: 'pokemon', subtypes: ['基础'], type: '火', hp: 20, retreat: 1 },
    { id: FIXTURE_STEEL_ENERGY, nameZh: '基本钢能量', cardClass: 'energy', subtypes: ['基本能量'], type: '钢' },
    {
      id: FIXTURE_ATTACKER,
      nameZh: '测试攻击手',
      cardClass: 'pokemon',
      subtypes: ['基础'],
      type: '火',
      hp: 90,
      retreat: 1,
      attacks: [{ name: '测试击倒', cost: [], damage: '70' }],
    },
    { id: FIXTURE_VICTIM, nameZh: '测试牺牲品', cardClass: 'pokemon', subtypes: ['基础'], type: '无', hp: 30, retreat: 1 },
    { id: FIXTURE_WATER_WEAK, nameZh: '测试水弱点', cardClass: 'pokemon', subtypes: ['基础'], type: '水', hp: 200, weakness: '草×2', retreat: 1 },
    { id: FIXTURE_BENCH_60, nameZh: '测试备战60', cardClass: 'pokemon', subtypes: ['基础'], type: '无', hp: 60, retreat: 1 },
    {
      id: FIXTURE_VMAX,
      nameZh: '测试VMAX',
      cardClass: 'pokemon',
      subtypes: ['基础'],
      type: '无',
      hp: 400,
      retreat: 1,
      specialRuleTextZh: 'VMAX规则：当宝可梦VMAX昏厥时，对手将拿取3张奖赏卡。',
    },
    {
      id: FIXTURE_UNSUPPORTED,
      nameZh: '测试未接入',
      cardClass: 'pokemon',
      subtypes: ['基础'],
      type: '无',
      hp: 120,
      retreat: 1,
      attacks: [{ name: '未接入招式', cost: [], damage: null, text: '造成尚未接入的特殊效果。' }],
    },
    { id: REGIROCK, nameZh: '雷吉洛克', cardClass: 'pokemon', subtypes: ['基础'], type: '斗', hp: 120, retreat: 3 },
  ]);
}

/**
 * 构造与牌库物化顺序一致的确定性牌库：
 *   [奖赏填充（6 + 手牌中的填充数）] + rest + [手牌中不在填充/rest 的额外卡]
 * 所有同名卡必须连续；rest 可以以填充卡开头（与奖赏填充连成一段），但不能
 * 在中间再次出现填充卡。
 */
function buildDeck(hand: readonly string[], rest: readonly string[], fill = DRAGON): string[] {
  const handCounts = new Map<string, number>();
  for (const cardId of hand) {
    handCounts.set(cardId, (handCounts.get(cardId) ?? 0) + 1);
  }
  const firstNonFill = rest.findIndex((cardId) => cardId !== fill);
  if (firstNonFill !== -1 && rest.slice(firstNonFill).includes(fill)) {
    throw new Error(`测试牌库构造错误：填充卡 ${fill} 在 rest 中不连续`);
  }
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const cardId of rest) {
    if (cardId !== previous) {
      if (seen.has(cardId)) {
        throw new Error(`测试牌库构造错误：${cardId} 在 rest 中不连续`);
      }
      seen.add(cardId);
      previous = cardId;
    }
  }
  const handFill = handCounts.get(fill) ?? 0;
  const extras: string[] = [];
  for (const [cardId, count] of handCounts) {
    if (cardId === fill) {
      continue;
    }
    if (rest.includes(cardId)) {
      throw new Error(`测试牌库构造错误：手牌与牌库顶顺序同时包含 ${cardId}`);
    }
    for (let index = 0; index < count; index += 1) {
      extras.push(cardId);
    }
  }
  return [...repeat(fill, 6 + handFill), ...rest, ...extras];
}

interface ScenarioOptions {
  readonly hands: readonly [readonly string[], readonly string[]];
  readonly rest?: readonly [readonly string[], readonly string[]];
  readonly winner?: MatchSeat;
  readonly goFirst?: boolean;
  readonly benchSeats?: readonly MatchSeat[];
  readonly catalog?: CatalogContent;
  readonly fill?: string;
}

interface ScenarioResult {
  readonly engine: MatchEngine;
  readonly catalog: CatalogContent;
}

function decksFor(options: ScenarioOptions): [string[], string[]] {
  const rest = options.rest ?? [[], []];
  return [buildDeck(options.hands[0], rest[0], options.fill), buildDeck(options.hands[1], rest[1], options.fill)];
}

function plannedRandoms(options: ScenarioOptions, winner: MatchSeat): number[] {
  const decks = decksFor(options);
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

function configFor(options: ScenarioOptions, catalog: CatalogContent, outputs: readonly number[]): MatchEngineConfig {
  const decks = decksFor(options);
  return {
    sessionId: SESSION,
    decks: [deckDocumentFromCardsWith(decks[0], catalog), deckDocumentFromCardsWith(decks[1], catalog)],
    nicknames: ['小智', '小茂'],
    catalog,
    random: new SequenceRandomSource([...outputs, ...Array.from({ length: 800 }, () => 0)]),
    trainerEffects: PRODUCTION_TRAINER_EFFECTS,
    stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
    attackEffects: PRODUCTION_ATTACK_EFFECTS,
    abilityEffects: PRODUCTION_ABILITY_EFFECTS,
    toolEffects: PRODUCTION_TOOL_EFFECTS,
    passiveAbilityEffects: PRODUCTION_PASSIVE_ABILITY_EFFECTS,
  };
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

function finishOpening(engine: MatchEngine, benchSeats: readonly MatchSeat[]): void {
  for (let step = 0; step < 300; step += 1) {
    const owner = ([0, 1] as const).find((seat) => engine.viewFor(seat).pendingChoice !== null);
    if (owner === undefined) {
      if (engine.phase !== 'playing') {
        throw new Error(`开局流程在 ${engine.phase} 阶段停住`);
      }
      return;
    }
    const view = engine.viewFor(owner);
    const choice = view.pendingChoice as MatchPendingChoiceView;
    if (choice.kind === 'place-setup') {
      const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
      const active = basics[0] as number;
      const bench = benchSeats.includes(owner) ? basics.filter((index) => index !== active).slice(0, 5) : [];
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

function scenario(options: ScenarioOptions): ScenarioResult {
  const winner = options.winner ?? 0;
  const goFirst = options.goFirst ?? true;
  const catalog = options.catalog ?? cdFixtures();
  const config = configFor(options, catalog, plannedRandoms(options, winner));
  const engine = new MatchEngine(config);
  const view = engine.viewFor(winner);
  engine.execute(winner, {
    type: 'choose-turn-order',
    commandId: `c-to-${winner}`,
    sessionId: SESSION,
    expectedVersion: view.version,
    choiceId: (view.pendingChoice as MatchPendingChoiceView).choiceId,
    goFirst,
  });
  finishOpening(engine, options.benchSeats ?? []);
  return { engine, catalog };
}

function turnCommand(engine: MatchEngine, seat: MatchSeat, command: Record<string, unknown>): void {
  engine.execute(seat, {
    commandId: `c-turn-${seat}-${engine.version}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: SESSION,
    expectedVersion: engine.version,
    ...command,
  } as MatchClientMessage);
}

function endTurn(engine: MatchEngine): void {
  const seat = engine.viewFor(0).activeSeat;
  if (seat === null) {
    throw new Error('没有回合玩家');
  }
  turnCommand(engine, seat, { type: 'end-turn' });
}

function handIndex(engine: MatchEngine, seat: MatchSeat, cardId: string): number {
  const index = engine.viewFor(seat).you.hand.findIndex((card) => card.cardId === cardId);
  if (index < 0) {
    throw new Error(`手牌中没有 ${cardId}`);
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

/** 自己的每个回合开始后附着 1 张指定能量，共 `count` 次；不结束最后一个回合。 */
function attachOnOwnTurns(engine: MatchEngine, seat: MatchSeat, cardId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      endTurn(engine);
      endTurn(engine);
    }
    turnCommand(engine, seat, { type: 'attach-energy', handIndex: handIndex(engine, seat, cardId), target: { slot: 'active' } });
  }
}

describe('营火专家（csve1-143，#14）', () => {
  it('没有[火]能量时整体拒绝且不消耗手牌、支援者次数与随机', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, CAMPFIRE, PSY, WATER, WATER, WATER, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60]],
    });
    endTurn(engine); // 座位 1 先攻；现在是座位 0 最初回合
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, CAMPFIRE) }), 'action-not-allowed');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(false);
    expect(eventTypes(engine, 0)).not.toContain('trainer-played');
  });

  it('牌库公开张数为 0 时整体拒绝（冻结 B-04）', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, CAMPFIRE, FIRE, WATER, WATER, WATER, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL], [FIXTURE_NEUTRAL]],
    });
    endTurn(engine);
    expect(engine.viewFor(0).you.deckCount).toBe(0);
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, CAMPFIRE) }), 'action-not-allowed');
    expect(engine.version).toBe(version);
  });

  it('弃 1 张[火]能量代价 → 查看牌库顶 7 张选至多 2 张 → 重洗；可选 0 张与非法张数受限', () => {
    const look = [
      FIXTURE_NEUTRAL,
      COURAGE,
      FIXTURE_WATER_WEAK,
      FIXTURE_VMAX,
      REGIROCK,
      FIXTURE_ATTACKER,
      FIXTURE_VICTIM,
    ];
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, CAMPFIRE, FIRE, PSY, WATER, WATER, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      // 座位 0 回合 2 开始抽 FIXTURE_BENCH_60；之后牌库顶是 look 的 7 张。
      rest: [[FIXTURE_BENCH_60, ...look], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60]],
    });
    endTurn(engine);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, CAMPFIRE) });

    const discardChoice = choiceOf(engine, 0);
    expect(discardChoice.kind).toBe('discard-hand');
    expect(discardChoice.min).toBe(1);
    expect(discardChoice.max).toBe(1);
    expect(discardChoice.step).toBe(1);
    expect(discardChoice.stepCount).toBe(2);
    const fireIndex = handIndex(engine, 0, FIRE);
    const psyIndex = handIndex(engine, 0, PSY);
    expect(discardChoice.candidates).toEqual([fireIndex]);
    expectEngineError(() => answerChoice(engine, 0, { type: 'discard-hand', handIndices: [psyIndex] }), 'illegal-choice');
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [fireIndex] });
    expect(engine.viewFor(0).you.discard.map((card) => card.cardId)).toContain(FIRE);

    const lookChoice = choiceOf(engine, 0);
    expect(lookChoice.kind).toBe('search-deck');
    expect(lookChoice.source).toBe('top-deck');
    expect(lookChoice.min).toBe(0);
    expect(lookChoice.max).toBe(2);
    expect(lookChoice.step).toBe(2);
    expect(lookChoice.stepCount).toBe(2);
    expect(lookChoice.cardCandidates).toHaveLength(7);
    expect(lookChoice.cardCandidates.every((candidate) => candidate.selectable !== false)).toBe(true);
    expect(engine.viewFor(1).pendingChoice).toBeNull();
    expect(engine.viewFor(1).waitingForOpponentChoice).toBe(true);
    expectEngineError(
      () => answerChoice(engine, 0, { type: 'search-deck', candidateIds: lookChoice.cardCandidates.slice(0, 3).map((candidate) => candidate.candidateId) }),
      'illegal-choice',
    );
    const neutralCandidate = lookChoice.cardCandidates.find((candidate) => candidate.card.cardId === FIXTURE_NEUTRAL);
    const courageCandidate = lookChoice.cardCandidates.find((candidate) => candidate.card.cardId === COURAGE);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [neutralCandidate?.candidateId as string, courageCandidate?.candidateId as string] });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(engine.viewFor(0).you.hand.map((card) => card.cardId)).toEqual(expect.arrayContaining([FIXTURE_NEUTRAL, COURAGE]));
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(true);
    expect(eventTypes(engine, 0)).toContain('deck-shuffled');
  });

  it('查看牌库顶后可以选择 0 张：代价已支付、不退还，仍重洗牌库', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, CAMPFIRE, FIRE, WATER, WATER, WATER, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_BENCH_60, FIXTURE_NEUTRAL, COURAGE, FIXTURE_WATER_WEAK],
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60],
      ],
    });
    endTurn(engine);
    const handBefore = engine.viewFor(0).you.hand.map((card) => card.cardId);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, CAMPFIRE) });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [handIndex(engine, 0, FIRE)] });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    expect(engine.viewFor(0).you.discard.map((card) => card.cardId)).toContain(FIRE);
    const expectedHand = handBefore.filter((cardId) => cardId !== FIRE && cardId !== CAMPFIRE);
    expect([...engine.viewFor(0).you.hand.map((card) => card.cardId)].sort()).toEqual([...expectedHand].sort());
    expect(eventTypes(engine, 0)).toContain('deck-shuffled');
  });
});

describe('莉佳的邀请（csv2c-118，#14）', () => {
  it('查看对手手牌并把基础宝可梦放于其备战区后互换；候选只发给选择者', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, LILLIE, PSY, WATER, WATER, WATER, WATER],
        [DRAGON, MEW, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL], [COURAGE, FIXTURE_BENCH_60]],
    });
    endTurn(engine); // 座位 1 最初回合结束（回合开始抽 1 张）
    expect(engine.viewFor(0).opponent.active?.card.cardId).toBe(DRAGON);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, LILLIE) });

    const select = choiceOf(engine, 0);
    expect(select.kind).toBe('select-card');
    expect(select.source).toBe('opponent-hand');
    expect(select.min).toBe(0);
    expect(select.max).toBe(1);
    expect(select.step).toBe(1);
    expect(select.stepCount).toBe(2);
    // 座位 1 手牌 6 张 + 回合开始抽牌 = 7 张全部展示。
    expect(select.cardCandidates).toHaveLength(7);
    const mewCandidate = select.cardCandidates.find((candidate) => candidate.card.cardId === MEW);
    const fireCandidate = select.cardCandidates.find((candidate) => candidate.card.cardId === FIRE);
    expect(mewCandidate?.selectable).not.toBe(false);
    expect(fireCandidate?.selectable).toBe(false);
    expect(engine.viewFor(1).pendingChoice).toBeNull();
    expectEngineError(
      () => answerChoice(engine, 0, { type: 'select-card', candidateIds: [fireCandidate?.candidateId as string] }),
      'illegal-choice',
    );
    answerChoice(engine, 0, { type: 'select-card', candidateIds: [mewCandidate?.candidateId as string] });

    expect(engine.viewFor(0).opponent.active?.card.cardId).toBe(MEW);
    expect(engine.viewFor(0).opponent.bench.map((pokemon) => pokemon.card.cardId)).toContain(DRAGON);
    expect(engine.viewFor(0).opponent.handCount).toBe(6);
    expect(eventTypes(engine, 0)).toContain('bench-switched');
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(true);
  });

  it('对手手牌没有基础宝可梦时仍展示手牌并允许选择 0 张；对手备战区已满时整体拒绝', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, LILLIE, PSY, WATER, WATER, WATER, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL], [COURAGE, FIXTURE_BENCH_60]],
    });
    endTurn(engine);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, LILLIE) });
    const select = choiceOf(engine, 0);
    expect(select.max).toBe(0);
    expect(select.cardCandidates).toHaveLength(7);
    expect(select.cardCandidates.every((candidate) => candidate.selectable === false)).toBe(true);
    const opponentHandBefore = engine.viewFor(0).opponent.handCount;
    answerChoice(engine, 0, { type: 'select-card', candidateIds: [] });
    expect(engine.viewFor(0).opponent.handCount).toBe(opponentHandBefore);
    expect(engine.viewFor(0).opponent.active?.card.cardId).toBe(DRAGON);
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(true);

    const full = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, LILLIE, PSY, WATER, WATER, WATER, WATER],
        [DRAGON, DRAGON, DRAGON, DRAGON, DRAGON, DRAGON, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL], [COURAGE, FIXTURE_BENCH_60]],
      benchSeats: [1],
    });
    endTurn(full.engine);
    expect(full.engine.viewFor(0).opponent.bench).toHaveLength(5);
    const version = full.engine.version;
    expectEngineError(() => turnCommand(full.engine, 0, { type: 'play-trainer', handIndex: handIndex(full.engine, 0, LILLIE) }), 'action-not-allowed');
    expect(full.engine.version).toBe(version);
  });
});

describe('捩木（csve1-157，#14）', () => {
  it('弃牌区基础宝可梦与场上基础宝可梦互换并继承附着卡、伤害与效果；旧卡进弃牌区', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [DRAGON, ULTRA_BALL, MEW, THORNTON, FIRE, COURAGE, PSY],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK],
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK],
      ],
    });
    // 回合 1：高级球弃 2 张（含梦幻ex）代价 → 检索 0 张。
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, ULTRA_BALL) });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [handIndex(engine, 0, MEW), handIndex(engine, 0, PSY)] });
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    expect(engine.viewFor(0).you.discard.map((card) => card.cardId)).toContain(MEW);
    turnCommand(engine, 0, { type: 'attach-tool', handIndex: handIndex(engine, 0, COURAGE), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, FIRE), target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.maxHp).toBe(180); // 拖拖蚓 130 + 勇气护符 50

    endTurn(engine); // 回合 2（座位 1）
    endTurn(engine); // 回合 3（座位 0）
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, THORNTON) });
    const discardSelect = choiceOf(engine, 0);
    expect(discardSelect.kind).toBe('select-card');
    expect(discardSelect.source).toBe('discard');
    expect(discardSelect.min).toBe(1);
    expect(discardSelect.max).toBe(1);
    const discardMew = discardSelect.cardCandidates.find((candidate) => candidate.card.cardId === MEW);
    expect(discardMew?.selectable).not.toBe(false);
    const nonBasic = discardSelect.cardCandidates.find((candidate) => candidate.card.cardId === ULTRA_BALL);
    expect(nonBasic?.selectable).toBe(false);
    expectEngineError(() => answerChoice(engine, 0, { type: 'select-card', candidateIds: [nonBasic?.candidateId as string] }), 'illegal-choice');
    answerChoice(engine, 0, { type: 'select-card', candidateIds: [discardMew?.candidateId as string] });

    const targetSelect = choiceOf(engine, 0);
    expect(targetSelect.kind).toBe('select-target');
    expect(targetSelect.source).toBe('own-field');
    expect(targetSelect.step).toBe(2);
    expect(targetSelect.stepCount).toBe(2);
    answerChoice(engine, 0, { type: 'select-target', candidateIds: ['active'] });

    const active = engine.viewFor(0).you.active;
    expect(active?.card.cardId).toBe(MEW);
    expect(active?.energies.map((energy) => energy.card.cardId)).toEqual([FIRE]);
    expect(active?.tools.map((tool) => tool.cardId)).toEqual([COURAGE]);
    expect(active?.maxHp).toBe(230); // 梦幻ex 180 + 勇气护符 50（基础宝可梦）
    expect(engine.viewFor(0).you.discard.map((card) => card.cardId)).toContain(DRAGON);
    expect(eventTypes(engine, 0)).toContain('pokemon-swapped');
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(true);
  });

  it('弃牌区没有基础宝可梦时整体拒绝且不消耗支援者次数', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, THORNTON, FIRE, PSY, WATER, WATER, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL], [FIXTURE_NEUTRAL]],
    });
    endTurn(engine);
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, THORNTON) }), 'action-not-allowed');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(false);
  });

  it('继承的“出场回合”不因互换而重置：交换来的宝可梦当回合不能进化', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [DRAGON, DRAGON, ULTRA_BALL, 'csve1-062', THORNTON, FIRE, PSY],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK]],
    });
    endTurn(engine); // 回合 2 开始
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, ULTRA_BALL) });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [handIndex(engine, 0, 'csve1-062'), handIndex(engine, 0, PSY)] });
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    // 换到座位 0 的第二个自己的回合再互换，避免“最初回合不能进化”的原因先命中。
    endTurn(engine); // 回合 3（座位 1）
    endTurn(engine); // 回合 4（座位 0）
    turnCommand(engine, 0, { type: 'play-basic', handIndex: handIndex(engine, 0, DRAGON) });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, THORNTON) });
    const discardSelect = choiceOf(engine, 0);
    const discardV = discardSelect.cardCandidates.find((candidate) => candidate.card.cardId === 'csve1-062');
    answerChoice(engine, 0, { type: 'select-card', candidateIds: [discardV?.candidateId as string] });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'select-target', candidateIds: ['bench-0'] });
    expect(engine.viewFor(0).you.bench[0]?.card.cardId).toBe('csve1-062');
    expect(engine.viewFor(0).you.bench[0]?.canEvolve).toBe(false);
    expect(engine.viewFor(0).you.bench[0]?.evolveBlockedReasonZh).toContain('刚刚出场');
  });
});

describe('熔岩瀑布之渊（csve1-169，#14）', () => {
  it('弃牌区[火]能量附着于备战[火]宝可梦并放置 2 个伤害指示物；每回合 1 次', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [FIRE_FISH, FIRE_FISH, MAGMA, ULTRA_BALL, FIRE, PSY, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL, FIXTURE_BENCH_60], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60]],
      benchSeats: [0],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, MAGMA) });
    expect(engine.viewFor(0).stadium?.cardId).toBe(MAGMA);
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'use-stadium' }), 'action-not-allowed');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.stadiumUsedThisTurn).toBe(false);

    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, ULTRA_BALL) });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [handIndex(engine, 0, FIRE), handIndex(engine, 0, PSY)] });
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });

    turnCommand(engine, 0, { type: 'use-stadium' });
    const energySelect = choiceOf(engine, 0);
    expect(energySelect.kind).toBe('select-card');
    expect(energySelect.source).toBe('discard');
    expect(energySelect.step).toBe(1);
    expect(energySelect.stepCount).toBe(2);
    const fireCandidate = energySelect.cardCandidates.find((candidate) => candidate.card.cardId === FIRE);
    const psyCandidate = energySelect.cardCandidates.find((candidate) => candidate.card.cardId === PSY);
    expect(fireCandidate?.selectable).not.toBe(false);
    expect(psyCandidate?.selectable).toBe(false);
    answerChoice(engine, 0, { type: 'select-card', candidateIds: [fireCandidate?.candidateId as string] });

    const targetSelect = choiceOf(engine, 0);
    expect(targetSelect.kind).toBe('select-target');
    expect(targetSelect.source).toBe('own-bench');
    expect(targetSelect.step).toBe(2);
    expect(targetSelect.stepCount).toBe(2);
    const benchCandidate = targetSelect.cardCandidates.find((candidate) => candidate.candidateId === 'bench-0');
    expect(benchCandidate?.selectable).not.toBe(false);
    answerChoice(engine, 0, { type: 'select-target', candidateIds: [benchCandidate?.candidateId as string] });

    const bench = engine.viewFor(0).you.bench[0];
    expect(bench?.energies.map((energy) => energy.card.cardId)).toEqual([FIRE]);
    expect(bench?.damageCounters).toBe(2);
    expect(engine.viewFor(0).you.stadiumUsedThisTurn).toBe(true);
    expectEngineError(() => turnCommand(engine, 0, { type: 'use-stadium' }), 'action-not-allowed');
  });

  it('备战区没有[火]宝可梦时不消耗本回合次数', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [FIRE_FISH, MAGMA, ULTRA_BALL, FIRE, DRAGON, PSY, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL, FIXTURE_BENCH_60], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60]],
      benchSeats: [0],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, MAGMA) });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, ULTRA_BALL) });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [handIndex(engine, 0, FIRE), handIndex(engine, 0, PSY)] });
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    expect(engine.viewFor(0).you.bench[0]?.card.cardId).toBe(DRAGON);
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'use-stadium' }), 'action-not-allowed');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.stadiumUsedThisTurn).toBe(false);
  });

  it('2 个伤害指示物使备战宝可梦昏厥时结算奖赏并继续当前回合', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [DRAGON, FIXTURE_FIRE_20, MAGMA, ULTRA_BALL, FIRE, PSY, WATER],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL, FIXTURE_BENCH_60], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60]],
      benchSeats: [0],
    });
    expect(engine.viewFor(0).you.bench[0]?.card.cardId).toBe(FIXTURE_FIRE_20);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, MAGMA) });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, ULTRA_BALL) });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [handIndex(engine, 0, FIRE), handIndex(engine, 0, PSY)] });
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    turnCommand(engine, 0, { type: 'use-stadium' });
    const energySelect = choiceOf(engine, 0);
    const fireCandidate = energySelect.cardCandidates.find((candidate) => candidate.card.cardId === FIRE);
    answerChoice(engine, 0, { type: 'select-card', candidateIds: [fireCandidate?.candidateId as string] });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'select-target', candidateIds: ['bench-0'] });
    expect(eventTypes(engine, 0)).toContain('pokemon-knocked-out');
    const prize = choiceOf(engine, 1);
    expect(prize.kind).toBe('take-prizes');
    answerChoice(engine, 1, { type: 'take-prizes', prizes: [prize.candidates[0] as number] });
    expect(engine.viewFor(0).activeSeat).toBe(0);
    expect(eventTypes(engine, 0)).toContain('prizes-taken');
  });
});

describe('拖拖蚓（csv3c-095，#14）', () => {
  it('营养铁质：附着 3 个[钢]能量时最大 HP +100，并计入勇气护符', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [DRAGON, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, COURAGE, PSY, WATER],
        [FIXTURE_NEUTRAL, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VMAX],
        [FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VMAX, FIXTURE_VICTIM],
      ],
    });
    const ability = engine.viewFor(0).you.active?.abilities.find((entry) => entry.name === '营养铁质');
    expect(ability).toMatchObject({ supported: true, usable: false });
    expect(ability?.unusableReasonZh).toContain('持续生效');
    expect(engine.viewFor(0).you.active?.maxHp).toBe(130);
    attachOnOwnTurns(engine, 0, FIXTURE_STEEL_ENERGY, 3);
    expect(engine.viewFor(0).you.active?.energies).toHaveLength(3);
    expect(engine.viewFor(0).you.active?.maxHp).toBe(230);
    turnCommand(engine, 0, { type: 'attach-tool', handIndex: handIndex(engine, 0, COURAGE), target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.maxHp).toBe(280);
    expect(engine.viewFor(1).opponent.active?.maxHp).toBe(280);
  });

  it('刺穿：战斗伤害 100 + 备战狙击 30（不计弱点/抵抗）；目标数受限', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [DRAGON, WATER, WATER, WATER, WATER, PSY, PSY],
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VMAX],
        [FIXTURE_WATER_WEAK, FIXTURE_VMAX, FIXTURE_VICTIM, FIXTURE_ATTACKER],
      ],
      benchSeats: [1],
    });
    attachOnOwnTurns(engine, 0, WATER, 4);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const snipe = choiceOf(engine, 0);
    expect(snipe.kind).toBe('select-target');
    expect(snipe.source).toBe('opponent-bench');
    expect(snipe.min).toBe(1);
    expect(snipe.max).toBe(1);
    expectEngineError(() => answerChoice(engine, 0, { type: 'select-target', candidateIds: ['active'] }), 'illegal-choice');
    expectEngineError(() => answerChoice(engine, 0, { type: 'select-target', candidateIds: ['opponent-bench-0', 'opponent-bench-1'] }), 'illegal-choice');
    answerChoice(engine, 0, { type: 'select-target', candidateIds: ['opponent-bench-0'] });
    expect(engine.viewFor(0).opponent.active?.damageCounters).toBe(10);
    expect(engine.viewFor(0).opponent.bench[0]?.damageCounters).toBe(3);
    const attack = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    expect(attack).toMatchObject({ attackName: '刺穿', baseDamage: 100, damage: 100 });
  });

  it('对手没有备战宝可梦时不创建目标选择，只结算战斗伤害', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [DRAGON, WATER, WATER, WATER, WATER, PSY, PSY],
        [FIXTURE_NEUTRAL, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VMAX],
        [FIXTURE_WATER_WEAK, FIXTURE_VMAX, FIXTURE_VICTIM, FIXTURE_ATTACKER],
      ],
    });
    attachOnOwnTurns(engine, 0, WATER, 4);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(engine.viewFor(0).opponent.active?.damageCounters).toBe(10);
    const attack = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    expect(attack).toMatchObject({ attackName: '刺穿', baseDamage: 100, damage: 100 });
  });
});

describe('古玉鱼ex（csv3c-031，#14）', () => {
  it('妒火中烧：将对手牌库上方 2 张放于其弃牌区并公开', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [FIRE_FISH, FIRE, PSY, PSY, PSY, WATER, WATER],
        [FIXTURE_NEUTRAL, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK],
        [FIXTURE_VMAX, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, REGIROCK, FIXTURE_ATTACKER, FIXTURE_VICTIM],
      ],
    });
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, FIRE), target: { slot: 'active' } });
    endTurn(engine);
    endTurn(engine);
    // 座位 1 的回合开始各抽 1 张；此时牌库仍有 ≥3 张，可弃置 2 张。
    const deckBefore = engine.viewFor(0).opponent.deckCount;
    expect(deckBefore).toBeGreaterThanOrEqual(3);
    const discardBefore = engine.viewFor(0).opponent.discard.length;
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    expect(engine.viewFor(0).opponent.deckCount).toBe(deckBefore - 3); // 弃置 2 张 + 下个回合开始抽 1 张
    expect(engine.viewFor(0).opponent.discard).toHaveLength(discardBefore + 2);
    const mill = engine.viewFor(0).events.filter((event) => event.type === 'deck-milled').at(-1);
    expect(mill).toMatchObject({ type: 'deck-milled', targetSeat: 1 });
    if (mill?.type === 'deck-milled') {
      expect(mill.cards).toHaveLength(2);
    }
  });

  it('火焰巨浪：100 伤害 + 至多 3 只备战各附着 1 张牌库基本火能量并重洗；可选 0 只', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      fill: FIRE,
      hands: [
        [FIRE_FISH, FIRE, FIRE, FIXTURE_BENCH_60, FIXTURE_BENCH_60, FIXTURE_BENCH_60, PSY],
        [FIXTURE_NEUTRAL, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      // 座位 0 回合 1/3/5 各抽 1 张 FIRE；之后牌库顶是 2 张 FIRE 供附着。
      rest: [
        [FIRE, FIRE, FIRE, FIRE, FIRE, FIXTURE_NEUTRAL],
        [FIRE, FIRE, FIRE, FIRE],
      ],
      benchSeats: [0],
    });
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, FIRE), target: { slot: 'active' } });
    endTurn(engine);
    endTurn(engine);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, FIRE), target: { slot: 'active' } });
    endTurn(engine);
    endTurn(engine);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 1, target: { slot: 'active' } });
    const targetSelect = choiceOf(engine, 0);
    expect(targetSelect.kind).toBe('select-target');
    expect(targetSelect.source).toBe('own-bench');
    expect(targetSelect.min).toBe(0);
    expect(targetSelect.max).toBe(3);
    expect(targetSelect.cardCandidates.filter((candidate) => candidate.selectable !== false)).toHaveLength(3);
    answerChoice(engine, 0, { type: 'select-target', candidateIds: ['bench-0', 'bench-1', 'bench-2'] });
    const attached = engine.viewFor(0).you.bench.map((pokemon) => pokemon.energies.length);
    expect(attached).toEqual([1, 1, 0]);
    expect(engine.viewFor(0).opponent.active?.damageCounters).toBe(10);
    const attack = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    expect(attack).toMatchObject({ attackName: '火焰巨浪', baseDamage: 100, damage: 100 });
    expect(eventTypes(engine, 0)).toContain('deck-shuffled');
  });

  it('火焰巨浪可以选择 0 只备战宝可梦（仍造成战斗伤害与重洗）', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      fill: FIRE,
      hands: [
        [FIRE_FISH, FIRE, FIRE, FIXTURE_BENCH_60, PSY, PSY, PSY],
        [FIXTURE_NEUTRAL, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIRE, FIRE, FIRE, FIRE, FIXTURE_NEUTRAL],
        [FIRE, FIRE, FIRE, FIRE],
      ],
      benchSeats: [0],
    });
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, FIRE), target: { slot: 'active' } });
    endTurn(engine);
    endTurn(engine);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, FIRE), target: { slot: 'active' } });
    endTurn(engine);
    endTurn(engine);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 1, target: { slot: 'active' } });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'select-target', candidateIds: [] });
    expect(engine.viewFor(0).you.bench[0]?.energies).toHaveLength(0);
    expect(engine.viewFor(0).opponent.active?.damageCounters).toBe(10);
    expect(eventTypes(engine, 0)).toContain('deck-shuffled');
  });
});

describe('雷吉奇卡斯（csve1-098，#14）', () => {
  it('古代睿智：没有指定雷吉系列时不可用；有雷吉洛克时可从弃牌区附着至多 3 张能量', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [REGI, MEW, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, COURAGE, PSY],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL, FIXTURE_BENCH_60], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60]],
    });
    endTurn(engine); // 座位 1 先攻
    const blocked = engine.viewFor(0).you.active?.abilities.find((entry) => entry.name === '古代睿智');
    expect(blocked).toMatchObject({ supported: true, usable: false });
    expect(blocked?.unusableReasonZh).toContain('雷吉洛克');
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 }),
      'action-not-allowed',
    );

    const ready = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [REGI, REGIROCK, ULTRA_BALL, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, COURAGE],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL, FIXTURE_BENCH_60], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60]],
    });
    endTurn(ready.engine);
    turnCommand(ready.engine, 0, { type: 'play-basic', handIndex: handIndex(ready.engine, 0, REGIROCK) });
    turnCommand(ready.engine, 0, { type: 'play-trainer', handIndex: handIndex(ready.engine, 0, ULTRA_BALL) });
    choiceOf(ready.engine, 0);
    const firstEnergy = handIndex(ready.engine, 0, FIXTURE_STEEL_ENERGY);
    const secondEnergy = ready.engine.viewFor(0).you.hand.findIndex((card, index) => index !== firstEnergy && card.cardId === FIXTURE_STEEL_ENERGY);
    answerChoice(ready.engine, 0, { type: 'discard-hand', handIndices: [firstEnergy, secondEnergy] });
    answerChoice(ready.engine, 0, { type: 'search-deck', candidateIds: [] });
    expect(ready.engine.viewFor(0).you.discard.filter((card) => card.cardId === FIXTURE_STEEL_ENERGY)).toHaveLength(2);
    expect(ready.engine.viewFor(0).you.active?.abilities.find((entry) => entry.name === '古代睿智')?.usable).toBe(true);

    turnCommand(ready.engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
    const selectCards = choiceOf(ready.engine, 0);
    expect(selectCards.kind).toBe('select-card');
    expect(selectCards.source).toBe('discard');
    expect(selectCards.min).toBe(0);
    expect(selectCards.max).toBe(2);
    const energies = selectCards.cardCandidates.filter((candidate) => candidate.selectable !== false);
    answerChoice(ready.engine, 0, { type: 'select-card', candidateIds: energies.map((candidate) => candidate.candidateId) });
    const selectTarget = choiceOf(ready.engine, 0);
    expect(selectTarget.kind).toBe('select-target');
    expect(selectTarget.source).toBe('own-field');
    answerChoice(ready.engine, 0, { type: 'select-target', candidateIds: ['active'] });
    expect(ready.engine.viewFor(0).you.active?.energies).toHaveLength(2);
  });

  it('巨人破坏：对手战斗宝可梦为 VMAX 时基础伤害 300，否则 150', () => {
    const vsVmax = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [REGI, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, PSY],
        [FIXTURE_VMAX, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM, FIXTURE_ATTACKER],
        [FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM, FIXTURE_ATTACKER, REGIROCK],
      ],
    });
    attachOnOwnTurns(vsVmax.engine, 0, FIXTURE_STEEL_ENERGY, 5);
    turnCommand(vsVmax.engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    expect(vsVmax.engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '巨人破坏',
      baseDamage: 300,
      damage: 300,
    });

    const vsNormal = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [REGI, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, FIXTURE_STEEL_ENERGY, PSY],
        [FIXTURE_NEUTRAL, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM, FIXTURE_ATTACKER],
        [FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM, FIXTURE_ATTACKER, REGIROCK],
      ],
    });
    attachOnOwnTurns(vsNormal.engine, 0, FIXTURE_STEEL_ENERGY, 5);
    turnCommand(vsNormal.engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    expect(vsNormal.engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '巨人破坏',
      baseDamage: 150,
      damage: 150,
    });
  });
});

describe('梦幻ex（csve1-056，#14）', () => {
  it('再起动：手牌已有 3 张时不可用；弃到 2 张后可抽到 3 张且每回合 1 次', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: false,
      hands: [
        [MEW, ULTRA_BALL, ULTRA_BALL, PSY, PSY, PSY, PSY],
        [DRAGON, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [[FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM], [FIXTURE_NEUTRAL, FIXTURE_BENCH_60]],
    });
    endTurn(engine); // 座位 0 回合 2，回合开始抽牌后手牌 8 张
    const blocked = engine.viewFor(0).you.active?.abilities.find((entry) => entry.name === '再起动');
    expect(blocked).toMatchObject({ supported: true, usable: false });
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 }),
      'action-not-allowed',
    );
    // 两次高级球各弃 2 张代价（检索 0 张），手牌到 2 张。
    for (let round = 0; round < 2; round += 1) {
      turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, ULTRA_BALL) });
      choiceOf(engine, 0);
      const first = handIndex(engine, 0, PSY);
      const second = engine.viewFor(0).you.hand.findIndex((card, index) => index !== first && card.cardId === PSY);
      answerChoice(engine, 0, { type: 'discard-hand', handIndices: [first, second] });
      answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    }
    expect(engine.viewFor(0).you.handCount).toBe(1);
    turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 });
    expect(engine.viewFor(0).you.handCount).toBe(3);
    expect(eventTypes(engine, 0)).toContain('ability-used');
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'use-ability', target: { slot: 'active' }, abilityIndex: 0 }),
      'action-not-allowed',
    );
  });

  it('基因侵入：复制对手战斗宝可梦的基础伤害招式，并按实际攻击者属性结算', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [MEW, WATER, WATER, WATER, PSY, PSY, PSY],
        [FIXTURE_ATTACKER, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM],
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM],
      ],
    });
    attachOnOwnTurns(engine, 0, WATER, 3);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const copy = choiceOf(engine, 0);
    expect(copy.kind).toBe('copy-attack');
    expect(copy.source).toBe('opponent-active');
    expect(copy.candidates).toEqual([0]);
    expect(engine.viewFor(1).pendingChoice).toBeNull();
    expectEngineError(() => answerChoice(engine, 0, { type: 'copy-attack', attackIndex: 5 }), 'illegal-choice');
    answerChoice(engine, 0, { type: 'copy-attack', attackIndex: 0 });
    // 复制固定 70 伤害的基础招式。
    expect(engine.viewFor(0).opponent.active?.damageCounters).toBe(7);
    const attack = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    expect(attack).toMatchObject({ attackName: '测试击倒', baseDamage: 70, damage: 70 });
  });

  it('基因侵入：复制带说明文的已接入招式（冰雹利刃），无附着水能量时按无效果结算', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [MEW, WATER, WATER, WATER, PSY, PSY, PSY],
        [CHIEN_PAO, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM],
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM],
      ],
    });
    attachOnOwnTurns(engine, 0, WATER, 3);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'copy-attack', attackIndex: 0 });
    // 梦幻ex 身上没有附着水能量以外的可用对象？实际上 3 张水能量来自攻击费用，
    // 可以被「冰雹利刃」选为弃置对象；这里选择 0 张，按无伤害结算并结束回合。
    const discardEnergy = choiceOf(engine, 0);
    expect(discardEnergy.kind).toBe('discard-energy');
    expect(discardEnergy.min).toBe(0);
    answerChoice(engine, 0, { type: 'discard-energy', candidateIds: [] });
    const attack = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    expect(attack).toMatchObject({ attackName: '冰雹利刃', baseDamage: 0, damage: 0 });
  });

  it('基因侵入：对手战斗宝可梦没有已接入招式时整体拒绝且不消耗硬币', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [MEW, WATER, WATER, WATER, PSY, PSY, PSY],
        [FIXTURE_UNSUPPORTED, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM],
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM],
      ],
    });
    attachOnOwnTurns(engine, 0, WATER, 3);
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } }), 'unsupported-card');
    expect(engine.version).toBe(version);
    expect(eventTypes(engine, 0)).not.toContain('attack-used');
  });
});

describe('古简蜗ex（csv3c-015，#14）', () => {
  it('贪欲藤蔓：对手已获得 0 张奖赏卡时造成 0 点备战伤害并公开记录招式', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [SNAIL, GRASS, GRASS, GRASS, PSY, PSY, PSY],
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_WATER_WEAK, FIXTURE_VICTIM],
        [FIXTURE_WATER_WEAK, FIXTURE_VMAX, FIXTURE_VICTIM],
      ],
      benchSeats: [1],
    });
    attachOnOwnTurns(engine, 0, GRASS, 3);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(engine.viewFor(0).opponent.bench[0]?.damageCounters).toBe(0);
    const attack = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    expect(attack).toMatchObject({ attackName: '贪欲藤蔓', baseDamage: 0, damage: 0 });
  });

  it('贪欲藤蔓：对手已获得奖赏卡张数×60 造成备战伤害且不计弱点/抵抗', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [FIXTURE_VICTIM, SNAIL, FIXTURE_BENCH_60, GRASS, GRASS, GRASS, PSY],
        [FIXTURE_ATTACKER, FIXTURE_NEUTRAL, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_WATER_WEAK, FIXTURE_VMAX],
        [FIXTURE_WATER_WEAK, FIXTURE_VMAX, FIXTURE_VICTIM],
      ],
      benchSeats: [0, 1],
    });
    // 回合 1：给备战区的古简蜗ex 附着第 1 张草能量（备战序号 0）。
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, GRASS), target: { slot: 'bench', index: 0 } });
    endTurn(engine);
    // 回合 2：座位 1 用免费 70 招式击倒座位 0 的 30 HP 战斗宝可梦并取得 1 张奖赏卡。
    expect(engine.viewFor(1).activeSeat).toBe(1);
    turnCommand(engine, 1, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const prize = choiceOf(engine, 1);
    expect(prize.kind).toBe('take-prizes');
    answerChoice(engine, 1, { type: 'take-prizes', prizes: [prize.candidates[0] as number] });
    const replacement = choiceOf(engine, 0);
    expect(replacement.kind).toBe('choose-replacement');
    // 备战区顺序：[古简蜗ex, 测试备战60]；升前古简蜗ex。
    answerChoice(engine, 0, { type: 'choose-replacement', benchIndex: replacement.candidates[0] as number });
    expect(engine.viewFor(0).you.active?.card.cardId).toBe(SNAIL);
    // 回合 3：第 2 张草能量。
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, GRASS), target: { slot: 'active' } });
    endTurn(engine);
    endTurn(engine);
    // 回合 5：第 3 张草能量后攻击（草草无 由 3 张草满足）。
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: handIndex(engine, 0, GRASS), target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.energies).toHaveLength(3);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const snipe = choiceOf(engine, 0);
    expect(snipe.kind).toBe('select-target');
    expect(snipe.source).toBe('opponent-bench');
    answerChoice(engine, 0, { type: 'select-target', candidateIds: ['opponent-bench-0'] });
    expect(engine.viewFor(0).opponent.bench[0]?.damageCounters).toBe(6);
    const attack = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    expect(attack).toMatchObject({ attackName: '贪欲藤蔓', baseDamage: 0, damage: 0 });
  });

  it('森林燃烧：固定 220 伤害按弱点/抵抗结算', () => {
    const { engine } = scenario({
      winner: 0,
      goFirst: true,
      hands: [
        [SNAIL, GRASS, GRASS, GRASS, GRASS, PSY, PSY],
        [FIXTURE_WATER_WEAK, FIRE, FIRE, FIRE, FIRE, FIRE, FIRE],
      ],
      rest: [
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_VMAX, FIXTURE_VICTIM],
        [FIXTURE_NEUTRAL, FIXTURE_BENCH_60, FIXTURE_VMAX, FIXTURE_VICTIM],
      ],
    });
    attachOnOwnTurns(engine, 0, GRASS, 4);
    turnCommand(engine, 0, { type: 'attack', attackIndex: 1, target: { slot: 'active' } });
    const attack = engine.viewFor(0).events.filter((event) => event.type === 'attack-used').at(-1);
    // 草属性攻击水属性弱点 ×2：220 → 440；200 HP 的对手战斗宝可梦昏厥。
    expect(attack).toMatchObject({ attackName: '森林燃烧', baseDamage: 220, damage: 440 });
    expect(eventTypes(engine, 0)).toContain('pokemon-knocked-out');
  });
});

/**
 * 用真实的 C/D 预设各打一局完整对局（含镜像与两个先后攻方向）：
 * 一个只做合法选择的确定性机器人驱动双方，直到产生唯一终态。
 * 期望结果只要求“完整结束且双方终态一致”，不预设胜者，避免把实现细节
 * 绑进测试；胜负仍由冻结规则与真实卡牌文本决定。
 */
describe('C/D 预设完整对局（#14 验收）', () => {
  function presetDocument(code: 'A' | 'B' | 'C' | 'D') {
    const service = loadReleaseCatalog();
    const preset = service.content.decks.find((deck) => deck.code === code);
    if (preset === undefined) {
      throw new Error(`发行目录缺少预设 ${code}`);
    }
    const document = presetDeckDocument(preset, service.content);
    if (document === null) {
      throw new Error(`预设 ${code} 无法转换为卡组文档`);
    }
    return document;
  }

  function playPresetGame(deckA: 'C' | 'D', deckB: 'C' | 'D', firstSeat: MatchSeat): MatchEngine {
    const catalog = releaseCatalogContent();
    const sessionId = `session-preset-${deckA}-${deckB}-${firstSeat}`;
    const config: MatchEngineConfig = {
      sessionId,
      decks: [presetDocument(deckA), presetDocument(deckB)],
      nicknames: ['甲', '乙'],
      catalog,
      // 确定性洗牌；牌库检索会多次重洗，预留足够随机输出。
      random: new SequenceRandomSource(Array.from({ length: 40_000 }, () => 0)),
      trainerEffects: PRODUCTION_TRAINER_EFFECTS,
      stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
      attackEffects: PRODUCTION_ATTACK_EFFECTS,
      abilityEffects: PRODUCTION_ABILITY_EFFECTS,
      toolEffects: PRODUCTION_TOOL_EFFECTS,
      passiveAbilityEffects: PRODUCTION_PASSIVE_ABILITY_EFFECTS,
    };
    const engine = new MatchEngine(config);
    let commandSeq = 0;
    const exec = (seat: MatchSeat, command: Record<string, unknown>): void => {
      commandSeq += 1;
      engine.execute(seat, {
        commandId: `preset-${commandSeq}`,
        sessionId,
        expectedVersion: engine.version,
        ...command,
      } as MatchClientMessage);
    };
    const tryExec = (seat: MatchSeat, command: Record<string, unknown>): boolean => {
      try {
        exec(seat, command);
        return true;
      } catch (error) {
        if (error instanceof MatchEngineError) {
          return false;
        }
        throw error;
      }
    };
    const answer = (seat: MatchSeat, pending: MatchPendingChoiceView): void => {
      const base = { choiceId: pending.choiceId };
      switch (pending.kind) {
        case 'turn-order':
          exec(seat, { ...base, type: 'choose-turn-order', goFirst: seat === firstSeat });
          return;
        case 'place-setup': {
          const basics = engine.viewFor(seat).you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
          exec(seat, { ...base, type: 'place-setup', active: basics[0] as number, bench: basics.slice(1, 2) });
          return;
        }
        case 'resolve-compensation':
          exec(seat, { ...base, type: 'resolve-compensation', draw: 0 });
          return;
        case 'place-bench':
          exec(seat, { ...base, type: 'place-bench', bench: [] });
          return;
        case 'discard-hand':
          exec(seat, { ...base, type: 'discard-hand', handIndices: pending.candidates.slice(0, pending.min) });
          return;
        case 'search-deck': {
          const selectable = pending.cardCandidates.filter((candidate) => candidate.selectable !== false);
          exec(seat, {
            ...base,
            type: 'search-deck',
            candidateIds: pending.min === 0 ? [] : selectable.slice(0, pending.min).map((candidate) => candidate.candidateId),
          });
          return;
        }
        case 'choose-mode': {
          const mode = pending.modes.find((entry) => entry.available);
          exec(seat, { ...base, type: 'choose-mode', modeId: mode?.modeId as string });
          return;
        }
        case 'switch-opponent':
          exec(seat, { ...base, type: 'switch-opponent', benchIndex: pending.candidates[0] as number });
          return;
        case 'choose-own-bench':
          exec(seat, { ...base, type: 'choose-own-bench', benchIndex: pending.candidates[0] as number });
          return;
        case 'attach-hand-energy':
          exec(seat, { ...base, type: 'attach-hand-energy', candidateId: pending.cardCandidates[0]?.candidateId as string });
          return;
        case 'discard-energy':
          exec(seat, {
            ...base,
            type: 'discard-energy',
            candidateIds: pending.min === 0 ? [] : pending.cardCandidates.slice(0, pending.min).map((candidate) => candidate.candidateId),
          });
          return;
        case 'select-card': {
          const selectable = pending.cardCandidates.filter((candidate) => candidate.selectable !== false);
          exec(seat, {
            ...base,
            type: 'select-card',
            candidateIds: pending.min === 0 ? [] : selectable.slice(0, pending.min).map((candidate) => candidate.candidateId),
          });
          return;
        }
        case 'select-target': {
          const selectable = pending.cardCandidates.filter((candidate) => candidate.selectable !== false);
          exec(seat, {
            ...base,
            type: 'select-target',
            candidateIds: pending.min === 0 ? [] : selectable.slice(0, pending.min).map((candidate) => candidate.candidateId),
          });
          return;
        }
        case 'copy-attack': {
          const attacks = engine.viewFor(seat).opponent.active?.attacks ?? [];
          const supported = attacks.find((attack) => pending.candidates.includes(attack.index) && attack.supported);
          exec(seat, { ...base, type: 'copy-attack', attackIndex: supported?.index as number });
          return;
        }
        case 'take-prizes':
          exec(seat, { ...base, type: 'take-prizes', prizes: pending.candidates.slice(0, pending.min) });
          return;
        case 'choose-replacement':
          exec(seat, { ...base, type: 'choose-replacement', benchIndex: pending.candidates[0] as number });
          return;
        default:
          throw new Error(`机器人未处理的待决选择 ${pending.kind}`);
      }
    };
    for (let step = 0; step < 20_000 && engine.result === null; step += 1) {
      const pendingSeat = ([0, 1] as const).find((seat) => engine.viewFor(seat).pendingChoice !== null);
      if (pendingSeat !== undefined) {
        answer(pendingSeat, engine.viewFor(pendingSeat).pendingChoice as MatchPendingChoiceView);
        continue;
      }
      const view = engine.viewFor(0);
      if (view.phase !== 'playing') {
        throw new Error(`机器人驱动在 ${view.phase} 阶段失去待决选择`);
      }
      const seat = view.activeSeat as MatchSeat;
      const side = engine.viewFor(seat);
      const energyIndex = side.you.hand.findIndex((card) => card.kind === 'energy');
      if (energyIndex >= 0) {
        tryExec(seat, { type: 'attach-energy', handIndex: energyIndex, target: { slot: 'active' } });
      }
      let attacked = false;
      for (const attack of side.you.active?.attacks ?? []) {
        if (tryExec(seat, { type: 'attack', attackIndex: attack.index, target: { slot: 'active' } })) {
          attacked = true;
          break;
        }
      }
      if (!attacked) {
        exec(seat, { type: 'end-turn' });
      }
    }
    if (engine.result === null) {
      throw new Error('预设对局在限定步数内没有产生唯一终态');
    }
    return engine;
  }

  const games: readonly { readonly a: 'C' | 'D'; readonly b: 'C' | 'D'; readonly first: MatchSeat }[] = [
    { a: 'C', b: 'D', first: 0 },
    { a: 'C', b: 'D', first: 1 },
    { a: 'D', b: 'C', first: 0 },
    { a: 'D', b: 'C', first: 1 },
    { a: 'C', b: 'C', first: 0 },
    { a: 'C', b: 'C', first: 1 },
    { a: 'D', b: 'D', first: 0 },
    { a: 'D', b: 'D', first: 1 },
  ];

  it.each(games.map((game) => [game.a, game.b, game.first] as const))(
    '预设 %s vs %s（先攻座位 %i）能完整结束且双方终态一致',
    (deckA, deckB, first) => {
      const engine = playPresetGame(deckA, deckB, first);
      const resultA = engine.viewFor(0).result;
      const resultB = engine.viewFor(1).result;
      expect(resultA).not.toBeNull();
      expect(resultB).toEqual(resultA);
      expect(resultA?.reason).toMatch(/^(prizes|no-pokemon|deck-out|simultaneous)$/u);
      // 终态后拒绝继续操作。
      expectEngineError(() => turnCommand(engine, 0, { type: 'end-turn' }), 'match-finished');
    },
    30_000,
  );
});
