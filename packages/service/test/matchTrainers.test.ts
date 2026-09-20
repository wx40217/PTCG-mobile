import { describe, expect, it } from 'vitest';
import type {
  CatalogContent,
  MatchClientMessage,
  MatchPendingChoiceView,
  MatchSeat,
  MatchView,
} from '@ptcg/protocol';
import {
  MatchEngine,
  MatchEngineError,
  MatchSession,
  attackEffectKey,
  type AttackEffectResolver,
  type MatchEngineConfig,
  type StadiumEffect,
  type TrainerEffect,
} from '../src/match.ts';
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
 * 训练家卡行为测试（T10 / #11）。
 *
 * 预期来源是冻结卡面文字（data/decks/...effect-matrix.json 的 full_text_zh）与
 * 官方 basic_rules05「先攻玩家的首回合无法使用支援者卡」。测试不对比实现自己
 * 生成的快照，而是给出明确的手牌/牌库/随机序列并断言双方可见结果。
 */

const SESSION = 'session-trainers';
const WATER = 'cbb1c-1803'; // 基本水能量
const PSY = 'cbb2c-1102'; // 基本超能量
const FISH = 'csve1-035'; // 荧光鱼：基础·水·HP50
const MOON = 'csve1-057'; // 月石：基础·超·HP90（等级球边界包含）
const SYLVEON_V = 'csve1-062'; // 仙子伊布V：基础·V·HP200
const SYLVEON_VMAX = 'csve1-063'; // 仙子伊布VMAX：VMAX 不是「宝可梦V」
const CHIEN_PAO = 'csv3c-043'; // 古剑豹ex：基础·ex·HP220（等级球排除）
const STEEL_WORM = 'csv3c-095'; // 拖拖蚓：基础·钢·HP130
const POKE_BALL = 'cbb1c-1701';
const GREAT_BALL = 'cbb1c-1702';
const ULTRA_BALL = 'cbb1c-1703';
const LEVEL_BALL = 'cbb2c-1002';
const LETTER = 'csv2c-111';
const SERENA = 'csve1-152';
const DEEP_BOWL = 'csv2c-127';
const UNSUPPORTED_TRAINER = 'csve1-138'; // 珠贝：本票未实现

function water(count: number): string[] {
  return Array.from({ length: count }, () => WATER);
}

function psy(count: number): string[] {
  return Array.from({ length: count }, () => PSY);
}

/** 按首次出现顺序聚合同名卡，与 `deckDocumentFromCardsWith` 的物化顺序一致。 */
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

/**
 * 构造引擎内的实际牌序：6 张基本超能量作为奖赏填充（最先被取走），随后是
 * 检索/牌库顶测试所需的 `postOpening` 顺序，最后是手牌额外卡与补位水能量。
 * 引擎会把同名卡聚合成组，因此这里先用相同规则分组，保证洗牌计划与引擎一致。
 */
function buildDeck(hand: readonly string[], postOpening: readonly string[]): string[] {
  const cards = [...psy(6), ...postOpening];
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
  return groupByFirstOccurrence([...cards, ...water(fill)]);
}

function configFor(options: {
  decks: readonly [readonly string[], readonly string[]];
  winner: MatchSeat;
  catalog: CatalogContent;
  outputs: readonly number[];
  trainerEffects?: ReadonlyMap<string, TrainerEffect>;
  stadiumEffects?: ReadonlyMap<string, StadiumEffect>;
  attackEffects?: ReadonlyMap<string, AttackEffectResolver>;
}): MatchEngineConfig {
  return {
    sessionId: SESSION,
    decks: [
      deckDocumentFromCardsWith(options.decks[0], options.catalog),
      deckDocumentFromCardsWith(options.decks[1], options.catalog),
    ],
    nicknames: ['小智', '小茂'],
    catalog: options.catalog,
    random: new SequenceRandomSource(options.outputs),
    trainerEffects: options.trainerEffects ?? PRODUCTION_TRAINER_EFFECTS,
    stadiumEffects: options.stadiumEffects ?? PRODUCTION_STADIUM_EFFECTS,
    ...(options.attackEffects === undefined ? {} : { attackEffects: options.attackEffects }),
  };
}

function planSeat(script: OpeningHandScript, seat: MatchSeat, hand: readonly string[], deck: readonly string[]): void {
  const pool = [...deck];
  for (const cardId of hand) {
    const index = pool.indexOf(cardId);
    if (index < 0) {
      throw new Error(`规划手牌失败：牌库中没有 ${cardId}`);
    }
    pool.splice(index, 1);
  }
  script.planHand(seat, hand, pool.splice(0, 6));
}

interface ScenarioResult {
  readonly engine: MatchEngine;
  readonly random: SequenceRandomSource;
  readonly config: MatchEngineConfig;
}

interface ScenarioOptions {
  readonly hands: readonly [readonly string[], readonly string[]];
  readonly rest?: readonly [readonly string[], readonly string[]];
  readonly winner?: MatchSeat;
  readonly goFirst?: boolean;
  readonly extraRandom?: readonly number[];
  readonly shuffleDeckSizes?: readonly number[];
  readonly benchBasics?: boolean;
  readonly catalog?: CatalogContent;
  readonly trainerEffects?: ReadonlyMap<string, TrainerEffect>;
  readonly stadiumEffects?: ReadonlyMap<string, StadiumEffect>;
  readonly attackEffects?: ReadonlyMap<string, AttackEffectResolver>;
}

function buildTrainerConfig(options: ScenarioOptions, outputs: readonly number[]): MatchEngineConfig {
  const catalog = options.catalog ?? releaseCatalogContent();
  const rest = options.rest ?? [[], []];
  const decks: [string[], string[]] = [buildDeck(options.hands[0], rest[0]), buildDeck(options.hands[1], rest[1])];
  return configFor({
    decks,
    winner: options.winner ?? 0,
    catalog,
    outputs,
    trainerEffects: options.trainerEffects,
    stadiumEffects: options.stadiumEffects,
    attackEffects: options.attackEffects,
  });
}

function plannedRandoms(options: ScenarioOptions, winner: MatchSeat): number[] {
  const rest = options.rest ?? [[], []];
  const decks: [string[], string[]] = [buildDeck(options.hands[0], rest[0]), buildDeck(options.hands[1], rest[1])];
  const script = new OpeningHandScript(decks);
  planSeat(script, 0, options.hands[0], decks[0]);
  planSeat(script, 1, options.hands[1], decks[1]);
  const shuffleValues: number[] = [];
  for (const size of options.shuffleDeckSizes ?? []) {
    for (let index = 0; index < size - 1; index += 1) {
      shuffleValues.push(0);
    }
  }
  return [winner === 0 ? 0 : 1, ...script.outputs, ...(options.extraRandom ?? []), ...shuffleValues];
}

function trainerScenario(options: ScenarioOptions): ScenarioResult {
  const winner = options.winner ?? 0;
  const goFirst = options.goFirst ?? true;
  const config = buildTrainerConfig(options, plannedRandoms(options, winner));
  const engine = new MatchEngine(config);
  const random = config.random as SequenceRandomSource;
  chooseTurnOrder(engine, winner, goFirst);
  finishOpening(engine, options.benchBasics ?? false);
  return { engine, random, config };
}

let sessionSequence = 0;
function sessionCommandId(prefix: string): string {
  sessionSequence += 1;
  return `${prefix}-${sessionSequence}`;
}

/** 用 MatchSession 完成开局；用于命令去重与过期选择测试。 */
function sessionScenario(options: ScenarioOptions): { session: MatchSession; random: SequenceRandomSource } {
  const winner = options.winner ?? 0;
  const config = buildTrainerConfig(options, plannedRandoms(options, winner));
  const session = new MatchSession(config);
  const handle = (seat: MatchSeat) => session.handleFor(seat);
  const initial = session.viewFor(handle(winner));
  session.submit(handle(winner), {
    type: 'choose-turn-order',
    commandId: sessionCommandId('to'),
    sessionId: SESSION,
    expectedVersion: initial.version,
    choiceId: (initial.pendingChoice as MatchPendingChoiceView).choiceId,
    goFirst: true,
  });
  for (let step = 0; step < 200; step += 1) {
    const owner = ([0, 1] as const).find((seat) => session.viewFor(handle(seat)).pendingChoice !== null);
    if (owner === undefined) {
      if (session.viewFor(handle(0)).phase !== 'playing') {
        throw new Error('会话开局流程停滞');
      }
      return { session, random: config.random as SequenceRandomSource };
    }
    const view = session.viewFor(handle(owner));
    const choice = view.pendingChoice as MatchPendingChoiceView;
    const base = {
      commandId: sessionCommandId('open'),
      sessionId: SESSION,
      expectedVersion: view.version,
      choiceId: choice.choiceId,
    };
    if (choice.kind === 'place-setup') {
      const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
      const active = basics[0] as number;
      const bench = options.benchBasics === true ? basics.filter((index) => index !== active).slice(0, 5) : [];
      const result = session.submit(handle(owner), { type: 'place-setup', ...base, active, bench });
      expect(result.ok).toBe(true);
      continue;
    }
    if (choice.kind === 'compensation-draw') {
      const result = session.submit(handle(owner), { type: 'resolve-compensation', ...base, draw: 0 });
      expect(result.ok).toBe(true);
      continue;
    }
    if (choice.kind === 'place-bench') {
      const result = session.submit(handle(owner), { type: 'place-bench', ...base, bench: options.benchBasics === true ? choice.candidates : [] });
      expect(result.ok).toBe(true);
      continue;
    }
    throw new Error(`会话开局出现未知选择 ${choice.kind}`);
  }
  throw new Error('会话开局未完成');
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

function finishOpening(engine: MatchEngine, benchBasics: boolean): void {
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
      const bench = benchBasics ? basics.filter((index) => index !== active).slice(0, 5) : [];
      answerChoice(engine, owner, { type: 'place-setup', active, bench });
      continue;
    }
    if (choice.kind === 'compensation-draw') {
      answerChoice(engine, owner, { type: 'resolve-compensation', draw: 0 });
      continue;
    }
    if (choice.kind === 'place-bench') {
      answerChoice(engine, owner, { type: 'place-bench', bench: benchBasics ? choice.candidates : [] });
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

function handIndex(engine: MatchEngine, seat: MatchSeat, predicate: (card: MatchView['you']['hand'][number]) => boolean): number {
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

/* ------------------------------------------------------------------ */
/* 类别限制、首回合与持久状态                                            */
/* ------------------------------------------------------------------ */

describe('训练家类别限制（T10 / #11）', () => {
  it('物品每回合不限张数；先攻玩家最初回合可以使用物品', () => {
    const { engine, random } = trainerScenario({
      hands: [
        [POKE_BALL, POKE_BALL, FISH, FISH, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      extraRandom: [1, 1],
    });
    // 两次精灵球都反面：各消耗 1 次随机，不触发检索/洗牌。
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === POKE_BALL) });
    expect(engine.viewFor(0).events.filter((event) => event.type === 'trainer-played')).toHaveLength(1);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === POKE_BALL) });
    expect(engine.viewFor(0).events.filter((event) => event.type === 'trainer-played')).toHaveLength(2);
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(false);
    // 先攻首回合物品可用且没有受到招式限制影响。
    expect(random.remaining).toBe(0);
  });

  it('先攻玩家最初回合不能使用支援者；拒绝不消耗手牌与版本', () => {
    const { engine } = trainerScenario({
      hands: [
        [SERENA, FISH, FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
    });
    const version = engine.version;
    const handBefore = engine.viewFor(0).you.handCount;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === SERENA) }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.handCount).toBe(handBefore);
    expect(eventTypes(engine, 0)).not.toContain('trainer-played');
  });

  it('每个自己的回合只能使用 1 张支援者；第二个支援者被拒绝', () => {
    const { engine } = trainerScenario({
      hands: [
        [SERENA, SERENA, FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 1,
      benchBasics: true,
    });
    // 座位 1 先攻；座位 0 在第 2 回合使用支援者。
    turnCommand(engine, 1, { type: 'end-turn' });
    expect(engine.viewFor(0).activeSeat).toBe(0);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === SERENA) });
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(true);
    // 莎莉娜两个模式：模式 1 可用（手牌非空），先回答模式再弃 1 张水能量。
    const mode = choiceOf(engine, 0);
    answerChoice(engine, 0, { type: 'choose-mode', modeId: 'discard-draw-five' });
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [choiceOf(engine, 0).candidates[1] as number] });
    void mode;
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === SERENA) }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
  });

  it('竞技场：每回合 1 张、不能放同名、放上后持续存在并替换不同名竞技场', () => {
    const fixtureCards: FixtureCardInput[] = [
      { id: 'fix-stadium', nameZh: '夹具竞技场', cardClass: 'trainer', effectiveCategory: '竞技场' },
    ];
    const catalog = fixtureCatalog(fixtureCards);
    const fixtureStadiumKey = 'fx:fixture:夹具竞技场:fix-stadium';
    const noopStadium: StadiumEffect = {
      canUse: () => ({ ok: false, code: 'action-not-allowed', message: '夹具竞技场没有可用效果。' }),
      use: () => undefined,
    };
    const trainerEffects = new Map(PRODUCTION_TRAINER_EFFECTS);
    trainerEffects.set(fixtureStadiumKey, { canPlay: () => ({ ok: true }), play: () => undefined });
    const stadiumEffects = new Map(PRODUCTION_STADIUM_EFFECTS);
    stadiumEffects.set(fixtureStadiumKey, noopStadium);
    // 深钵镇与夹具竞技场各 1 张；先放深钵镇，再放夹具竞技场会替换。
    const { engine } = trainerScenario({
      hands: [
        [DEEP_BOWL, DEEP_BOWL, 'fix-stadium', FISH, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      catalog,
      trainerEffects,
      stadiumEffects,
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === DEEP_BOWL) });
    expect(engine.viewFor(0).stadium?.cardId).toBe(DEEP_BOWL);
    expect(engine.viewFor(1).stadium?.cardId).toBe(DEEP_BOWL);
    // 每回合 1 张：同一回合不能放第二张竞技场。
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === 'fix-stadium') }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
    // 换到对手回合后再回来：同名深钵镇仍被拒绝，不同名的夹具竞技场替换旧卡。
    turnCommand(engine, 0, { type: 'end-turn' });
    turnCommand(engine, 1, { type: 'end-turn' });
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === DEEP_BOWL) }),
      'action-not-allowed',
    );
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === 'fix-stadium') });
    expect(engine.viewFor(0).stadium?.cardId).toBe('fix-stadium');
    expect(engine.viewFor(0).you.discard.some((card) => card.cardId === DEEP_BOWL)).toBe(true);
    const placed = engine.viewFor(0).events.filter((event) => event.type === 'stadium-placed');
    expect(placed).toHaveLength(2);
    expect(placed[1]?.type === 'stadium-placed' && placed[1].replaced?.cardId).toBe(DEEP_BOWL);
  });

  it('竞技场每回合只能放 1 张（同一回合第二张不同名也被拒绝）', () => {
    const fixtureCards: FixtureCardInput[] = [
      { id: 'fix-stadium', nameZh: '夹具竞技场', cardClass: 'trainer', effectiveCategory: '竞技场' },
    ];
    const catalog = fixtureCatalog(fixtureCards);
    const fixtureStadiumKey = 'fx:fixture:夹具竞技场:fix-stadium';
    const trainerEffects = new Map(PRODUCTION_TRAINER_EFFECTS);
    trainerEffects.set(fixtureStadiumKey, { canPlay: () => ({ ok: true }), play: () => undefined });
    const { engine } = trainerScenario({
      hands: [
        [DEEP_BOWL, 'fix-stadium', FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      catalog,
      trainerEffects,
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === DEEP_BOWL) });
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === 'fix-stadium') }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
  });

  it('未注册效果的身份卡以 unsupported-card 拒绝且不消耗随机与手牌', () => {
    const { engine, random } = trainerScenario({
      hands: [
        [UNSUPPORTED_TRAINER, FISH, FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
    });
    const before = random.remaining;
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === UNSUPPORTED_TRAINER) }),
      'unsupported-card',
    );
    expect(engine.version).toBe(version);
    expect(random.remaining).toBe(before);
    expect(engine.viewFor(0).you.handCount).toBe(7);
    expect(eventTypes(engine, 0)).not.toContain('trainer-played');
  });
});

/* ------------------------------------------------------------------ */
/* 精灵球：硬币 + 检索                                                    */
/* ------------------------------------------------------------------ */

describe('精灵球（cbb1c-1701）：硬币正面检索宝可梦、反面不检索', () => {
  it('正面：公开硬币结果、候选只含宝可梦，选择后展示并列入手牌并重洗', () => {
    const { engine } = trainerScenario({
      hands: [
        [POKE_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO, STEEL_WORM], []],
      winner: 0,
      extraRandom: [0], // 硬币正面
      shuffleDeckSizes: [46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === POKE_BALL) });
    const view = engine.viewFor(0);
    expect(view.events.some((event) => event.type === 'coin-flip' && event.result === 'heads')).toBe(true);
    const choice = choiceOf(engine, 0);
    expect(choice.kind).toBe('search-deck');
    expect(choice.source).toBe('deck');
    expect(choice.step).toBe(1);
    expect(choice.stepCount).toBe(1);
    expect(choice.min).toBe(0);
    expect(choice.max).toBe(1);
    expect(choice.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([CHIEN_PAO, STEEL_WORM]);
    expect(choice.cardCandidates.every((candidate) => candidate.selectable)).toBe(true);
    const deckBefore = view.you.deckCount;
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [choice.cardCandidates[1]?.candidateId] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.hand.some((card) => card.cardId === STEEL_WORM)).toBe(true);
    expect(after.you.deckCount).toBe(deckBefore - 1);
    const revealed = after.events.find((event) => event.type === 'cards-searched');
    expect(revealed?.type === 'cards-searched' && revealed.cards.map((card) => card.cardId)).toEqual([STEEL_WORM]);
    expect(after.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
  });

  it('可以 0 张：空选择结束检索、不展示结果，但仍重洗牌库', () => {
    const { engine } = trainerScenario({
      hands: [
        [POKE_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO, STEEL_WORM], []],
      winner: 0,
      extraRandom: [0], // 硬币正面
      shuffleDeckSizes: [46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === POKE_BALL) });
    const choice = choiceOf(engine, 0);
    expect(choice.min).toBe(0);
    expect(choice.cardCandidates.length).toBeGreaterThan(0);
    const handBefore = engine.viewFor(0).you.handCount;
    const deckBefore = engine.viewFor(0).you.deckCount;
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.handCount).toBe(handBefore);
    expect(after.you.deckCount).toBe(deckBefore);
    expect(after.events.some((event) => event.type === 'cards-searched')).toBe(false);
    expect(after.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
  });

  it('反面：不创建检索选择、不洗牌，只消耗 1 次随机', () => {
    const { engine, random } = trainerScenario({
      hands: [
        [POKE_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[CHIEN_PAO], []],
      winner: 0,
      extraRandom: [1], // 反面
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === POKE_BALL) });
    const view = engine.viewFor(0);
    expect(view.pendingChoice).toBeNull();
    expect(view.events.some((event) => event.type === 'coin-flip' && event.result === 'tails')).toBe(true);
    expect(view.events.some((event) => event.type === 'deck-shuffled')).toBe(false);
    expect(view.events.some((event) => event.type === 'cards-searched')).toBe(false);
    expect(random.remaining).toBe(0);
  });

  it('正面但没有宝可梦：按检索失败处理，重洗牌库且不产生公开检索结果', () => {
    const { engine } = trainerScenario({
      hands: [
        [POKE_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      extraRandom: [0],
      shuffleDeckSizes: [47],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === POKE_BALL) });
    const view = engine.viewFor(0);
    expect(view.pendingChoice).toBeNull();
    expect(view.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
    expect(view.events.some((event) => event.type === 'cards-searched')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 超级球：牌库顶 7 张                                                    */
/* ------------------------------------------------------------------ */

describe('超级球（cbb1c-1702）：查看牌库上方 7 张并选择其中 1 张宝可梦', () => {
  it('查看上方 7 张：全部作为私人候选展示，只有宝可梦可选；选择后其余放回并重洗', () => {
    const { engine } = trainerScenario({
      hands: [
        [GREAT_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      // 牌库顶 7 张：荧光鱼 + 6 张水能量（回合开始已抽走 1 张基本超能量）；
      // 古剑豹ex 在这次查看的 7 张之外，不能被选中。
      rest: [[PSY, FISH, FISH, WATER, WATER, WATER, WATER, WATER, WATER, CHIEN_PAO], []],
      winner: 0,
      shuffleDeckSizes: [45],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === GREAT_BALL) });
    const choice = choiceOf(engine, 0);
    expect(choice.kind).toBe('search-deck');
    expect(choice.source).toBe('top-deck');
    expect(choice.min).toBe(0);
    expect(choice.max).toBe(1);
    // 冻结卡面文字要求“查看上方 7 张”：全部 7 张都作为私人候选展示。
    expect(choice.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([
      FISH,
      WATER,
      WATER,
      WATER,
      WATER,
      WATER,
      WATER,
    ]);
    // 只有宝可梦可以选；能量只是被看到。
    expect(choice.cardCandidates.filter((candidate) => candidate.selectable).map((candidate) => candidate.card.cardId)).toEqual([FISH]);
    // 提交不可选的被查看卡被拒绝，状态与选择保持不变。
    const version = engine.version;
    const nonSelectable = choice.cardCandidates.find((candidate) => !candidate.selectable);
    expect(nonSelectable).toBeDefined();
    expectEngineError(
      () => answerChoice(engine, 0, { type: 'search-deck', candidateIds: [nonSelectable?.candidateId as string] }),
      'illegal-choice',
    );
    expect(engine.version).toBe(version);
    expect(choiceOf(engine, 0).choiceId).toBe(choice.choiceId);
    const chosen = choice.cardCandidates.find((candidate) => candidate.selectable);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [chosen?.candidateId as string] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.hand.some((card) => card.cardId === FISH)).toBe(true);
    expect(after.events.some((event) => event.type === 'cards-searched')).toBe(true);
    expect(after.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
  });

  it('前 7 张没有宝可梦时仍展示全部被查看卡，可提交 0 张并重洗', () => {
    const { engine } = trainerScenario({
      hands: [
        [GREAT_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      // 上方 7 张：精灵球 + 6 张水能量（无宝可梦）；古剑豹ex 在第 8 张。
      rest: [[POKE_BALL, WATER, WATER, WATER, WATER, WATER, WATER, WATER, CHIEN_PAO], []],
      winner: 0,
      shuffleDeckSizes: [47],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === GREAT_BALL) });
    const choice = choiceOf(engine, 0);
    expect(choice.kind).toBe('search-deck');
    expect(choice.source).toBe('top-deck');
    expect(choice.min).toBe(0);
    expect(choice.max).toBe(0);
    expect(choice.cardCandidates).toHaveLength(7);
    expect(choice.cardCandidates.every((candidate) => candidate.selectable === false)).toBe(true);
    // 被查看的 7 张只在选择者视图；对手只看到等待，载荷不含这张未公开的卡。
    expect(engine.viewFor(1).pendingChoice).toBeNull();
    expect(engine.viewFor(1).waitingForOpponentChoice).toBe(true);
    expect(JSON.stringify(engine.viewFor(1))).not.toContain(POKE_BALL);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.events.some((event) => event.type === 'cards-searched')).toBe(false);
    expect(after.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
  });

  it('有宝可梦候选时仍可提交 0 张：不展示结果但重洗牌库', () => {
    const { engine } = trainerScenario({
      hands: [
        [GREAT_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[PSY, FISH, FISH, WATER, WATER, WATER, WATER, WATER, WATER, CHIEN_PAO], []],
      winner: 0,
      shuffleDeckSizes: [47],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === GREAT_BALL) });
    const choice = choiceOf(engine, 0);
    expect(choice.min).toBe(0);
    const handBefore = engine.viewFor(0).you.handCount;
    const deckBefore = engine.viewFor(0).you.deckCount;
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.handCount).toBe(handBefore);
    expect(after.you.deckCount).toBe(deckBefore);
    expect(after.events.some((event) => event.type === 'cards-searched')).toBe(false);
    expect(after.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 高级球：弃 2 张手牌代价 + 检索                                          */
/* ------------------------------------------------------------------ */

describe('高级球（cbb1c-1703）：弃 2 张手牌后检索宝可梦', () => {
  it('两步选择：先支付代价再检索；弃牌公开、检索展示、洗牌', () => {
    const { engine } = trainerScenario({
      hands: [
        [ULTRA_BALL, WATER, PSY, FISH, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO], []],
      winner: 0,
      shuffleDeckSizes: [46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === ULTRA_BALL) });
    const discardChoice = choiceOf(engine, 0);
    expect(discardChoice.kind).toBe('discard-hand');
    expect(discardChoice.step).toBe(1);
    expect(discardChoice.stepCount).toBe(2);
    expect(discardChoice.min).toBe(2);
    expect(discardChoice.max).toBe(2);
    expect(discardChoice.candidates).toHaveLength(6);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0, 1] });
    const discarded = engine.viewFor(0).events.find((event) => event.type === 'cards-discarded');
    expect(discarded?.type === 'cards-discarded' && discarded.cards.map((card) => card.cardId)).toEqual([WATER, PSY]);
    const searchChoice = choiceOf(engine, 0);
    expect(searchChoice.kind).toBe('search-deck');
    expect(searchChoice.step).toBe(2);
    expect(searchChoice.stepCount).toBe(2);
    expect(searchChoice.min).toBe(0);
    expect(searchChoice.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([CHIEN_PAO]);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [searchChoice.cardCandidates[0]?.candidateId] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.hand.some((card) => card.cardId === CHIEN_PAO)).toBe(true);
  });

  it('代价不足：手牌只剩高级球 + 1 张时拒绝且不消耗卡牌/随机', () => {
    const fixture: FixtureCardInput[] = [{ id: 'fix-item', nameZh: '夹具物品', cardClass: 'trainer', effectiveCategory: '物品' }];
    const catalog = fixtureCatalog(fixture);
    const trainerEffects = new Map(PRODUCTION_TRAINER_EFFECTS);
    trainerEffects.set('fx:fixture:夹具物品:fix-item', { canPlay: () => ({ ok: true }), play: () => undefined });
    const { engine, random } = trainerScenario({
      hands: [
        [ULTRA_BALL, FISH, 'fix-item', 'fix-item', 'fix-item', 'fix-item', 'fix-item'],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      catalog,
      trainerEffects,
    });
    for (let i = 0; i < 5; i += 1) {
      turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === 'fix-item') });
    }
    expect(engine.viewFor(0).you.handCount).toBe(2);
    const before = random.remaining;
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === ULTRA_BALL) }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
    expect(random.remaining).toBe(before);
    expect(engine.viewFor(0).you.handCount).toBe(2);
  });

  it('代价已支付后检索失败：弃牌保留、重洗牌库、不产生检索结果', () => {
    const { engine } = trainerScenario({
      hands: [
        [ULTRA_BALL, WATER, PSY, FISH, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      shuffleDeckSizes: [47],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === ULTRA_BALL) });
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0, 1] });
    const view = engine.viewFor(0);
    expect(view.pendingChoice).toBeNull();
    expect(view.you.discard.some((card) => card.cardId === WATER)).toBe(true);
    expect(view.you.discard.some((card) => card.cardId === PSY)).toBe(true);
    expect(view.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
    expect(view.events.some((event) => event.type === 'cards-searched')).toBe(false);
  });

  it('代价已支付后选择 0 张：弃牌保留、重洗牌库、不产生检索结果', () => {
    const { engine } = trainerScenario({
      hands: [
        [ULTRA_BALL, WATER, PSY, FISH, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO], []],
      winner: 0,
      shuffleDeckSizes: [47],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === ULTRA_BALL) });
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0, 1] });
    const searchChoice = choiceOf(engine, 0);
    expect(searchChoice.kind).toBe('search-deck');
    expect(searchChoice.min).toBe(0);
    const handBefore = engine.viewFor(0).you.handCount;
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const view = engine.viewFor(0);
    expect(view.pendingChoice).toBeNull();
    expect(view.you.handCount).toBe(handBefore);
    expect(view.you.discard.some((card) => card.cardId === WATER)).toBe(true);
    expect(view.you.discard.some((card) => card.cardId === PSY)).toBe(true);
    expect(view.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
    expect(view.events.some((event) => event.type === 'cards-searched')).toBe(false);
  });

  it('非法代价张数与重复序号被拒绝，状态与待决选择保持不变', () => {
    const { engine } = trainerScenario({
      hands: [
        [ULTRA_BALL, WATER, PSY, FISH, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO], []],
      winner: 0,
      shuffleDeckSizes: [46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === ULTRA_BALL) });
    const choiceId = choiceOf(engine, 0).choiceId;
    const version = engine.version;
    expectEngineError(() => answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0] }), 'illegal-choice');
    expectEngineError(() => answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0, 0] }), 'illegal-choice');
    expectEngineError(() => answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0, 99] }), 'illegal-choice');
    expect(engine.version).toBe(version);
    expect(choiceOf(engine, 0).choiceId).toBe(choiceId);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0, 1] });
    expect(choiceOf(engine, 0).kind).toBe('search-deck');
  });
});

/* ------------------------------------------------------------------ */
/* 等级球：HP ≤ 90                                                       */
/* ------------------------------------------------------------------ */

describe('等级球（cbb2c-1002）：检索 HP≤90 的宝可梦', () => {
  it('只列出 HP≤90 的目标（HP90 含、HP220 ex 排除）', () => {
    const { engine } = trainerScenario({
      hands: [
        [LEVEL_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, MOON, CHIEN_PAO, STEEL_WORM], []],
      winner: 0,
      shuffleDeckSizes: [46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LEVEL_BALL) });
    const choice = choiceOf(engine, 0);
    expect(choice.min).toBe(0);
    expect(choice.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([MOON]);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [choice.cardCandidates[0]?.candidateId] });
    expect(engine.viewFor(0).you.hand.some((card) => card.cardId === MOON)).toBe(true);
  });

  it('没有 HP≤90 目标时检索失败并重洗', () => {
    const { engine } = trainerScenario({
      hands: [
        [LEVEL_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO, STEEL_WORM], []],
      winner: 0,
      shuffleDeckSizes: [46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LEVEL_BALL) });
    const view = engine.viewFor(0);
    expect(view.pendingChoice).toBeNull();
    expect(view.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
    expect(view.events.some((event) => event.type === 'cards-searched')).toBe(false);
  });

  it('有 HP≤90 目标时也可选择 0 张：不展示结果但重洗牌库', () => {
    const { engine } = trainerScenario({
      hands: [
        [LEVEL_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, MOON, CHIEN_PAO, STEEL_WORM], []],
      winner: 0,
      shuffleDeckSizes: [47],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LEVEL_BALL) });
    const choice = choiceOf(engine, 0);
    expect(choice.min).toBe(0);
    const handBefore = engine.viewFor(0).you.handCount;
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.handCount).toBe(handBefore);
    expect(after.events.some((event) => event.type === 'cards-searched')).toBe(false);
    expect(after.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 鼓励信：条件卡                                                        */
/* ------------------------------------------------------------------ */

describe('鼓励信（csv2c-111）：上一个对手回合己方昏厥时才可使用', () => {
  it('条件不成立时拒绝，手牌与版本不变', () => {
    const { engine } = trainerScenario({
      hands: [
        [LETTER, FISH, FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
    });
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LETTER) }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.handCount).toBe(7);
  });

  it('对手回合发生昏厥后，下一次自己的回合可以使用并检索最多 3 张基本能量', () => {
    const ATTACKER = 'fix-attacker';
    const fixture: FixtureCardInput[] = [
      {
        id: ATTACKER,
        nameZh: '夹具攻击手',
        cardClass: 'pokemon',
        subtypes: ['基础'],
        type: '水',
        hp: 100,
        attacks: [{ name: '夹具攻击', cost: ['水'], damage: '60', text: null }],
      },
    ];
    const catalog = fixtureCatalog(fixture);
    const { engine } = trainerScenario({
      hands: [
        [FISH, MOON, LETTER, LETTER, WATER, WATER, WATER],
        [ATTACKER, WATER, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      benchBasics: true,
      catalog,
      shuffleDeckSizes: [46, 46],
    });
    // 回合 1：座位 0 结束。
    turnCommand(engine, 0, { type: 'end-turn' });
    // 回合 2：座位 1 附能并昏厥座位 0 的战斗宝可梦（荧光鱼 HP50）。
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: handIndex(engine, 1, (card) => card.cardId === WATER), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    // 座位 1 取 1 张奖赏；座位 0 从备战区升前（月石）。
    const prizeChoice = choiceOf(engine, 1);
    expect(prizeChoice.kind).toBe('take-prizes');
    answerChoice(engine, 1, { type: 'take-prizes', prizes: [0] });
    const replacement = choiceOf(engine, 0);
    expect(replacement.kind).toBe('choose-replacement');
    answerChoice(engine, 0, { type: 'choose-replacement', benchIndex: replacement.candidates[0] });
    // 回合 3：座位 0 可以使用鼓励信。
    expect(engine.viewFor(0).activeSeat).toBe(0);
    expect(engine.viewFor(0).you.koDuringLastOpponentTurn).toBe(true);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LETTER) });
    const search = choiceOf(engine, 0);
    expect(search.kind).toBe('search-deck');
    expect(search.min).toBe(0);
    expect(search.max).toBe(3);
    const energyCandidates = search.cardCandidates.filter((candidate) => candidate.card.kind === 'energy');
    expect(energyCandidates.length).toBeGreaterThanOrEqual(2);
    answerChoice(engine, 0, {
      type: 'search-deck',
      candidateIds: energyCandidates.slice(0, 2).map((candidate) => candidate.candidateId),
    });
    expect(engine.viewFor(0).you.handCount).toBeGreaterThanOrEqual(2);
    // 「最多 3 张」允许找 0 张：空选择提交成功、不产生新的公开检索结果，但仍重洗牌库。
    const searchedBefore = engine.viewFor(0).events.filter((event) => event.type === 'cards-searched').length;
    const shuffledBefore = engine.viewFor(0).events.filter((event) => event.type === 'deck-shuffled').length;
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LETTER) });
    const zeroChoice = choiceOf(engine, 0);
    expect(zeroChoice.min).toBe(0);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const zeroView = engine.viewFor(0);
    expect(zeroView.pendingChoice).toBeNull();
    expect(zeroView.events.filter((event) => event.type === 'cards-searched').length).toBe(searchedBefore);
    expect(zeroView.events.filter((event) => event.type === 'deck-shuffled').length).toBeGreaterThan(shuffledBefore);
  });

  it('宝可梦检查造成的昏厥不算上一个对手回合：下一次自己的回合不能使用', () => {
    const POISONER = 'fix-poisoner';
    const fixture: FixtureCardInput[] = [
      {
        id: POISONER,
        nameZh: '夹具毒攻手',
        cardClass: 'pokemon',
        subtypes: ['基础'],
        type: '水',
        hp: 100,
        attacks: [{ name: '毒击', cost: ['水'], damage: '40', text: '使目标中毒。' }],
      },
    ];
    const catalog = fixtureCatalog(fixture);
    const attackEffects = new Map<string, AttackEffectResolver>([
      [
        attackEffectKey(`fx:fixture:夹具毒攻手:${POISONER}`, '毒击'),
        (context) => {
          context.dealDamage();
          context.addSpecialCondition(context.defenderSeat, { slot: 'active' }, '中毒');
        },
      ],
    ]);
    const { engine } = trainerScenario({
      hands: [
        [FISH, MOON, LETTER, WATER, WATER, WATER, WATER],
        [POISONER, WATER, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      benchBasics: true,
      catalog,
      attackEffects,
      shuffleDeckSizes: [46, 46],
    });
    // 回合 1：座位 0 结束。
    turnCommand(engine, 0, { type: 'end-turn' });
    // 回合 2：座位 1 用毒击造成 40 点并中毒；荧光鱼剩 10 HP，不在招式处理末尾昏厥，
    // 而是在回合结束后的宝可梦检查中因中毒昏厥（冻结 F：不属于任何回合的回合内）。
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: handIndex(engine, 1, (card) => card.cardId === WATER), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    // 招式造成 40 点后荧光鱼仍有 10 HP（未在招式处理末尾昏厥）；回合结束后的
    // 宝可梦检查再放置 1 个中毒指示物，随后确认昏厥。
    const damageEvents = engine.viewFor(1).events.filter((event) => event.type === 'damage-counters-placed');
    expect(damageEvents.slice(-2).map((event) => (event.type === 'damage-counters-placed' ? event.count : -1))).toEqual([4, 1]);
    expect(engine.viewFor(1).events.some((event) => event.type === 'pokemon-knocked-out')).toBe(true);
    const prizeChoice = choiceOf(engine, 1);
    expect(prizeChoice.kind).toBe('take-prizes');
    answerChoice(engine, 1, { type: 'take-prizes', prizes: [0] });
    const replacement = choiceOf(engine, 0);
    expect(replacement.kind).toBe('choose-replacement');
    answerChoice(engine, 0, { type: 'choose-replacement', benchIndex: replacement.candidates[0] });
    // 回合 3：检查昏厥不得满足「鼓励信」。
    expect(engine.viewFor(0).activeSeat).toBe(0);
    expect(engine.viewFor(0).you.koDuringLastOpponentTurn).toBe(false);
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LETTER) }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
  });

  it('没有过一次对手回合昏厥后的下个回合，条件恢复为不成立', () => {
    const { engine } = trainerScenario({
      hands: [
        [LETTER, FISH, FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 0,
      benchBasics: true,
    });
    turnCommand(engine, 0, { type: 'end-turn' });
    expect(engine.viewFor(1).you.koDuringLastOpponentTurn).toBe(false);
    turnCommand(engine, 1, { type: 'end-turn' });
    expect(engine.viewFor(0).you.koDuringLastOpponentTurn).toBe(false);
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LETTER) }),
      'action-not-allowed',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 莎莉娜：抽牌与换位                                                    */
/* ------------------------------------------------------------------ */

describe('莎莉娜（csve1-152）：二选一效果', () => {
  it('模式 1：弃 1..3 张后抽到手牌 5 张', () => {
    const { engine } = trainerScenario({
      hands: [
        [SERENA, PSY, PSY, FISH, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 1,
      benchBasics: true,
    });
    turnCommand(engine, 1, { type: 'end-turn' });
    // 座位 0 回合开始抽 1 张后手牌？战斗宝可梦盖放消耗 1，开局共 7 张。
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === SERENA) });
    const modeChoice = choiceOf(engine, 0);
    expect(modeChoice.kind).toBe('choose-mode');
    expect(modeChoice.step).toBe(1);
    expect(modeChoice.stepCount).toBe(2);
    expect(modeChoice.modes.map((mode) => mode.modeId)).toEqual(['discard-draw-five', 'switch-opponent-v']);
    expect(modeChoice.modes[0]?.available).toBe(true);
    expect(modeChoice.modes[1]?.available).toBe(false);
    answerChoice(engine, 0, { type: 'choose-mode', modeId: 'discard-draw-five' });
    const discardChoice = choiceOf(engine, 0);
    expect(discardChoice.kind).toBe('discard-hand');
    expect(discardChoice.min).toBe(1);
    expect(discardChoice.max).toBe(3);
    expect(discardChoice.step).toBe(2);
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0, 1] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.handCount).toBe(5);
    expect(after.you.discard.filter((card) => card.cardId === PSY)).toHaveLength(2);
    const drawn = after.events.filter((event) => event.type === 'card-drawn');
    expect(drawn.length).toBeGreaterThanOrEqual(1);
  });

  it('模式 2：把手牌为空时的模式 1 标为不可用；没有目标时模式 2 也不可用', () => {
    const { engine } = trainerScenario({
      hands: [
        [SERENA, FISH, FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 1,
      benchBasics: true,
    });
    turnCommand(engine, 1, { type: 'end-turn' });
    // 先把座位 0 手牌清空：作为战斗宝可梦的荧光鱼等已消耗，手牌为莎莉娜 + 4 张能量 + 回合抽牌。
    // 这里只验证提交不可用模式被拒绝且选择保持。
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === SERENA) });
    const modeChoice = choiceOf(engine, 0);
    expect(modeChoice.modes[0]?.available).toBe(true);
    expectEngineError(() => answerChoice(engine, 0, { type: 'choose-mode', modeId: 'switch-opponent-v' }), 'illegal-choice');
    expect(choiceOf(engine, 0).choiceId).toBe(modeChoice.choiceId);
    answerChoice(engine, 0, { type: 'choose-mode', modeId: 'discard-draw-five' });
    answerChoice(engine, 0, { type: 'discard-hand', handIndices: [0] });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
  });

  it('两个效果都不可用时拒绝使用，不消耗支援者次数与手牌', () => {
    const EMPTIER = 'fix-emptier';
    const fixture: FixtureCardInput[] = [{ id: EMPTIER, nameZh: '夹具清手', cardClass: 'trainer', effectiveCategory: '物品' }];
    const catalog = fixtureCatalog(fixture);
    const trainerEffects = new Map(PRODUCTION_TRAINER_EFFECTS);
    trainerEffects.set('fx:fixture:夹具清手:fix-emptier', {
      canPlay: () => ({ ok: true }),
      play: (context) =>
        context.startDiscardChoice({ min: 0, max: context.handCount(), descriptionZh: '夹具清手：弃置任意张其他手牌。', followUp: null }),
    });
    const { engine } = trainerScenario({
      hands: [
        [SERENA, FISH, EMPTIER, EMPTIER, EMPTIER, EMPTIER, EMPTIER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 1,
      catalog,
      trainerEffects,
    });
    turnCommand(engine, 1, { type: 'end-turn' });
    // 座位 0 第 2 回合：用夹具物品弃掉除莎莉娜以外的全部手牌。
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === EMPTIER) });
    const discardChoice = choiceOf(engine, 0);
    const serenaIndex = engine.viewFor(0).you.hand.findIndex((card) => card.cardId === SERENA);
    answerChoice(engine, 0, {
      type: 'discard-hand',
      handIndices: discardChoice.candidates.filter((index) => index !== serenaIndex),
    });
    expect(engine.viewFor(0).you.hand.map((card) => card.cardId)).toEqual([SERENA]);
    // 手牌只剩莎莉娜，对手备战区又没有「宝可梦V」：使用不会产生任何变化，必须拒绝。
    const version = engine.version;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === SERENA) }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.handCount).toBe(1);
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(false);
  });

  it('弃牌效果不可用但互换可用时仍可使用并只提供互换模式', () => {
    const EMPTIER = 'fix-emptier';
    const fixture: FixtureCardInput[] = [{ id: EMPTIER, nameZh: '夹具清手', cardClass: 'trainer', effectiveCategory: '物品' }];
    const catalog = fixtureCatalog(fixture);
    const trainerEffects = new Map(PRODUCTION_TRAINER_EFFECTS);
    trainerEffects.set('fx:fixture:夹具清手:fix-emptier', {
      canPlay: () => ({ ok: true }),
      play: (context) =>
        context.startDiscardChoice({ min: 0, max: context.handCount(), descriptionZh: '夹具清手：弃置任意张其他手牌。', followUp: null }),
    });
    const { engine } = trainerScenario({
      hands: [
        [SERENA, FISH, EMPTIER, EMPTIER, EMPTIER, EMPTIER, EMPTIER],
        [FISH, SYLVEON_V, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 1,
      benchBasics: true,
      catalog,
      trainerEffects,
    });
    turnCommand(engine, 1, { type: 'end-turn' });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === EMPTIER) });
    const discardChoice = choiceOf(engine, 0);
    const serenaIndex = engine.viewFor(0).you.hand.findIndex((card) => card.cardId === SERENA);
    answerChoice(engine, 0, {
      type: 'discard-hand',
      handIndices: discardChoice.candidates.filter((index) => index !== serenaIndex),
    });
    expect(engine.viewFor(0).you.hand.map((card) => card.cardId)).toEqual([SERENA]);
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === SERENA) });
    const modeChoice = choiceOf(engine, 0);
    expect(modeChoice.kind).toBe('choose-mode');
    expect(modeChoice.modes[0]?.available).toBe(false);
    expect(modeChoice.modes[1]?.available).toBe(true);
    answerChoice(engine, 0, { type: 'choose-mode', modeId: 'switch-opponent-v' });
    const switchChoice = choiceOf(engine, 0);
    expect(switchChoice.kind).toBe('switch-opponent');
    expect(switchChoice.candidates).toHaveLength(1);
    answerChoice(engine, 0, { type: 'switch-opponent', benchIndex: switchChoice.candidates[0] });
    expect(engine.viewFor(1).you.active?.card.cardId).toBe(SYLVEON_V);
  });

  it('模式 2：对手备战区的「宝可梦V」与战斗宝可梦互换；VMAX 不可选', () => {
    const { engine } = trainerScenario({
      hands: [
        [SERENA, FISH, FISH, WATER, WATER, WATER, WATER],
        [FISH, SYLVEON_V, SYLVEON_VMAX, WATER, WATER, WATER, WATER],
      ],
      rest: [[], []],
      winner: 1,
      benchBasics: true,
    });
    // 座位 1 先攻，盖放战斗=荧光鱼、备战=仙子伊布V 与 VMAX；结束回合。
    turnCommand(engine, 1, { type: 'end-turn' });
    // 座位 0 使用莎莉娜第二效果。
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === SERENA) });
    const modeChoice = choiceOf(engine, 0);
    expect(modeChoice.modes[1]?.available).toBe(true);
    answerChoice(engine, 0, { type: 'choose-mode', modeId: 'switch-opponent-v' });
    const switchChoice = choiceOf(engine, 0);
    expect(switchChoice.kind).toBe('switch-opponent');
    expect(switchChoice.source).toBe('opponent-bench');
    expect(switchChoice.candidates).toHaveLength(1);
    answerChoice(engine, 0, { type: 'switch-opponent', benchIndex: switchChoice.candidates[0] });
    const opponentView = engine.viewFor(1);
    expect(opponentView.you.active?.card.cardId).toBe(SYLVEON_V);
    expect(opponentView.you.bench.some((pokemon) => pokemon.card.cardId === FISH)).toBe(true);
    const switched = engine.viewFor(0).events.find((event) => event.type === 'bench-switched');
    expect(switched?.type === 'bench-switched' && switched.active.cardId).toBe(SYLVEON_V);
    expect(switched?.type === 'bench-switched' && switched.bench.cardId).toBe(FISH);
  });
});

/* ------------------------------------------------------------------ */
/* 深钵镇：竞技场持续状态                                                */
/* ------------------------------------------------------------------ */

describe('深钵镇（csv2c-127）：双方每回合 1 次检索基础非规则宝可梦进备战区', () => {
  it('放置后持续存在；使用效果检索基础宝可梦直接进备战区并消耗本回合次数', () => {
    const { engine } = trainerScenario({
      hands: [
        [DEEP_BOWL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, MOON, STEEL_WORM, SYLVEON_V], []],
      winner: 0,
      shuffleDeckSizes: [46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === DEEP_BOWL) });
    expect(engine.viewFor(0).stadium?.cardId).toBe(DEEP_BOWL);
    expect(engine.viewFor(0).you.stadiumPlayedThisTurn).toBe(true);
    expect(engine.viewFor(0).you.stadiumUsedThisTurn).toBe(false);
    turnCommand(engine, 0, { type: 'use-stadium' });
    const choice = choiceOf(engine, 0);
    expect(choice.kind).toBe('search-deck');
    expect(choice.min).toBe(0);
    expect(choice.max).toBe(1);
    // 基础且无规则：月石与拖拖蚓；仙子伊布V（V规则）排除。
    expect(choice.cardCandidates.map((candidate) => candidate.card.cardId).sort()).toEqual([MOON, STEEL_WORM].sort());
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [choice.cardCandidates[0]?.candidateId] });
    const after = engine.viewFor(0);
    expect(after.you.bench.some((pokemon) => pokemon.card.cardId === choice.cardCandidates[0]?.card.cardId)).toBe(true);
    expect(after.you.stadiumUsedThisTurn).toBe(true);
    const revealed = after.events.find((event) => event.type === 'cards-searched');
    expect(revealed?.type === 'cards-searched' && revealed.destination).toBe('bench');
    // 同一回合第二次使用被拒绝且不改变状态。
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'use-stadium' }), 'action-not-allowed');
    expect(engine.version).toBe(version);
  });

  it('牌库没有目标时仍可宣告使用：检索失败、重洗并消耗本回合次数', () => {
    const { engine } = trainerScenario({
      hands: [
        [DEEP_BOWL, FISH, FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, SYLVEON_V], []],
      winner: 0,
      benchBasics: true,
      shuffleDeckSizes: [47],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === DEEP_BOWL) });
    // 牌库只有水能量与拥有规则的仙子伊布V：没有合法目标，但隐藏区域内容不能
    // 作为可否使用的条件；仍然宣告、检索失败、重洗并消耗本回合次数。
    turnCommand(engine, 0, { type: 'use-stadium' });
    const view = engine.viewFor(0);
    expect(view.pendingChoice).toBeNull();
    expect(view.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
    expect(view.events.some((event) => event.type === 'cards-searched')).toBe(false);
    expect(view.you.stadiumUsedThisTurn).toBe(true);
    expect(view.you.bench.some((pokemon) => pokemon.card.cardId === SYLVEON_V)).toBe(false);
    // 同一回合第二次使用仍被拒绝。
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'use-stadium' }), 'action-not-allowed');
    expect(engine.version).toBe(version);
  });

  it('有目标时也可选择 0 张：重洗并消耗本回合次数', () => {
    const { engine } = trainerScenario({
      hands: [
        [DEEP_BOWL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, MOON, STEEL_WORM, SYLVEON_V], []],
      winner: 0,
      shuffleDeckSizes: [47],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === DEEP_BOWL) });
    const benchBefore = engine.viewFor(0).you.bench.length;
    turnCommand(engine, 0, { type: 'use-stadium' });
    const choice = choiceOf(engine, 0);
    expect(choice.min).toBe(0);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [] });
    const after = engine.viewFor(0);
    expect(after.pendingChoice).toBeNull();
    expect(after.you.bench.length).toBe(benchBefore);
    expect(after.events.some((event) => event.type === 'cards-searched')).toBe(false);
    expect(after.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
    expect(after.you.stadiumUsedThisTurn).toBe(true);
  });

  it('双方各自每回合 1 次；换回合后重置', () => {
    const { engine } = trainerScenario({
      hands: [
        [DEEP_BOWL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, MOON], [WATER, MOON]],
      winner: 0,
      shuffleDeckSizes: [46, 46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === DEEP_BOWL) });
    turnCommand(engine, 0, { type: 'use-stadium' });
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [choiceOf(engine, 0).cardCandidates[0]?.candidateId] });
    turnCommand(engine, 0, { type: 'end-turn' });
    // 座位 1 的回合：竞技场仍在，双方使用次数重置，座位 1 可以使用。
    expect(engine.viewFor(1).stadium?.cardId).toBe(DEEP_BOWL);
    expect(engine.viewFor(1).you.stadiumUsedThisTurn).toBe(false);
    turnCommand(engine, 1, { type: 'use-stadium' });
    answerChoice(engine, 1, { type: 'search-deck', candidateIds: [choiceOf(engine, 1).cardCandidates[0]?.candidateId] });
    expect(engine.viewFor(1).you.stadiumUsedThisTurn).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 空牌库：已知无效果不得使用（冻结 B-01/B-04）                           */
/* ------------------------------------------------------------------ */

/**
 * 构造座位 0 首回合结束后牌库用尽的短牌局（用于公开张数为 0 的行为）。
 * `remainingAfterDraw` 是首回合抽牌之后仍在牌库的卡（为空则牌库为 0），
 * 第一张在抽牌前位于牌库顶；牌序按“手牌 + 6 张奖赏 + 剩余”展开。
 */
function shortDeckEngine(
  hand: readonly string[],
  remainingAfterDraw: readonly string[] = [],
  extraRandom: readonly number[] = [],
): { engine: MatchEngine; random: SequenceRandomSource } {
  const rest = remainingAfterDraw.length > 0 ? remainingAfterDraw : [PSY];
  const layout0 = groupByFirstOccurrence([...hand, ...psy(6), ...rest]);
  const layout1 = groupByFirstOccurrence([FISH, ...water(6), ...psy(6)]);
  const script = new OpeningHandScript([layout0, layout1]);
  script.planOrder(0, layout0);
  script.planOrder(1, layout1);
  const config = configFor({
    decks: [layout0, layout1],
    winner: 0,
    catalog: releaseCatalogContent(),
    outputs: [0, ...script.outputs, ...extraRandom],
  });
  const engine = new MatchEngine(config);
  chooseTurnOrder(engine, 0, true);
  finishOpening(engine, false);
  return { engine, random: config.random as SequenceRandomSource };
}

function engineErrorMessage(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MatchEngineError) {
      return error.message;
    }
    throw error;
  }
  throw new Error('预期抛出 MatchEngineError，但没有');
}

describe('空牌库：检索与竞技场效果不得使用（冻结 B-01/B-04）', () => {
  it('公开张数为 0 时所有检索训练家卡整体拒绝：手牌、随机与版本不变', () => {
    const { engine, random } = shortDeckEngine([FISH, POKE_BALL, GREAT_BALL, ULTRA_BALL, LEVEL_BALL, WATER, WATER]);
    expect(engine.viewFor(0).you.deckCount).toBe(0);
    const remainingRandom = random.remaining;
    const handBefore = engine.viewFor(0).you.handCount;
    expect(handBefore).toBe(7);
    for (const cardId of [POKE_BALL, GREAT_BALL, ULTRA_BALL, LEVEL_BALL]) {
      const versionBefore = engine.version;
      const eventsBefore = engine.viewFor(0).events.length;
      const message = engineErrorMessage(() =>
        turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === cardId) }),
      );
      expect(message).toContain('牌库');
      expect(engine.version).toBe(versionBefore);
      expect(engine.viewFor(0).you.handCount).toBe(handBefore);
      expect(engine.viewFor(0).events.length).toBe(eventsBefore);
      expect(engine.viewFor(0).you.discard).toHaveLength(0);
      expect(engine.viewFor(0).you.hand.some((card) => card.cardId === cardId)).toBe(true);
      expect(engine.viewFor(0).pendingChoice).toBeNull();
      expect(engine.viewFor(0).events.some((event) => event.type === 'coin-flip')).toBe(false);
      // 高级球即使有足够的代价手牌，也不能因支付代价而允许无效果使用。
      expect(random.remaining).toBe(remainingRandom);
    }
  });

  it('鼓励信与深钵镇在公开张数为 0 时拒绝：不消耗支援者次数与竞技场次数', () => {
    const { engine } = shortDeckEngine([FISH, LETTER, DEEP_BOWL, WATER, WATER, WATER, WATER]);
    expect(engine.viewFor(0).you.deckCount).toBe(0);
    const letterMessage = engineErrorMessage(() =>
      turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === LETTER) }),
    );
    expect(letterMessage).toContain('牌库');
    expect(engine.viewFor(0).you.supporterUsedThisTurn).toBe(false);
    expect(engine.viewFor(0).you.hand.some((card) => card.cardId === LETTER)).toBe(true);

    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === DEEP_BOWL) });
    expect(engine.viewFor(0).stadium?.cardId).toBe(DEEP_BOWL);
    expect(engine.viewFor(0).you.stadiumUsedThisTurn).toBe(false);
    const version = engine.version;
    const stadiumMessage = engineErrorMessage(() => turnCommand(engine, 0, { type: 'use-stadium' }));
    expect(stadiumMessage).toContain('牌库');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.stadiumUsedThisTurn).toBe(false);
    expect(engine.viewFor(0).you.bench).toHaveLength(0);
  });

  it('对照：非空牌库没有目标时仍可宣告、检索失败并重洗；有目标时给出私人候选', () => {
    // 空牌库：拒绝。
    const empty = shortDeckEngine([FISH, POKE_BALL, WATER, WATER, WATER, WATER, WATER]);
    expect(empty.engine.viewFor(0).you.deckCount).toBe(0);
    expectEngineError(
      () => turnCommand(empty.engine, 0, { type: 'play-trainer', handIndex: handIndex(empty.engine, 0, (card) => card.cardId === POKE_BALL) }),
      'action-not-allowed',
    );

    // 非空但隐藏区域没有宝可梦：硬币正面后按检索失败处理，仍重洗牌库。
    const hiddenNoTarget = shortDeckEngine([FISH, POKE_BALL, WATER, WATER, WATER, WATER, WATER], [PSY, PSY], [0]);
    expect(hiddenNoTarget.engine.viewFor(0).you.deckCount).toBe(1);
    turnCommand(hiddenNoTarget.engine, 0, {
      type: 'play-trainer',
      handIndex: handIndex(hiddenNoTarget.engine, 0, (card) => card.cardId === POKE_BALL),
    });
    const failed = hiddenNoTarget.engine.viewFor(0);
    expect(failed.pendingChoice).toBeNull();
    expect(failed.events.some((event) => event.type === 'coin-flip' && event.result === 'heads')).toBe(true);
    expect(failed.events.some((event) => event.type === 'deck-shuffled')).toBe(true);
    expect(failed.events.some((event) => event.type === 'cards-searched')).toBe(false);
    expect(failed.you.deckCount).toBe(1);

    // 非空且隐藏区域有目标：允许检索并私下给出候选。
    const hiddenTarget = shortDeckEngine([FISH, POKE_BALL, WATER, WATER, WATER, WATER, WATER], [PSY, MOON], [0]);
    expect(hiddenTarget.engine.viewFor(0).you.deckCount).toBe(1);
    turnCommand(hiddenTarget.engine, 0, {
      type: 'play-trainer',
      handIndex: handIndex(hiddenTarget.engine, 0, (card) => card.cardId === POKE_BALL),
    });
    const choice = choiceOf(hiddenTarget.engine, 0);
    expect(choice.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([MOON]);
  });
});

/* ------------------------------------------------------------------ */
/* 隐私、去重与过期选择                                                  */
/* ------------------------------------------------------------------ */

describe('训练家选择的隐私、去重与过期保护', () => {
  it('检索候选只出现在选择者视图；对手只看到等待与公开结果', () => {
    const { engine } = trainerScenario({
      hands: [
        [POKE_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO, STEEL_WORM], []],
      winner: 0,
      extraRandom: [0],
      shuffleDeckSizes: [46],
    });
    turnCommand(engine, 0, { type: 'play-trainer', handIndex: handIndex(engine, 0, (card) => card.cardId === POKE_BALL) });
    const mine = engine.viewFor(0);
    const theirs = engine.viewFor(1);
    expect(mine.pendingChoice?.cardCandidates.map((candidate) => candidate.card.cardId)).toEqual([CHIEN_PAO, STEEL_WORM]);
    expect(theirs.pendingChoice).toBeNull();
    expect(theirs.waitingForOpponentChoice).toBe(true);
    const serialized = JSON.stringify(theirs);
    expect(serialized).not.toContain(CHIEN_PAO);
    expect(serialized).not.toContain(STEEL_WORM);
    answerChoice(engine, 0, { type: 'search-deck', candidateIds: [mine.pendingChoice?.cardCandidates[0]?.candidateId as string] });
    const theirAfter = engine.viewFor(1);
    expect(JSON.stringify(theirAfter)).toContain(CHIEN_PAO);
    expect(JSON.stringify(theirAfter)).not.toContain(STEEL_WORM);
  });

  it('相同命令 ID 的重复回答返回第一次结果且不重复生效', () => {
    const { session } = sessionScenario({
      hands: [
        [POKE_BALL, FISH, WATER, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO, STEEL_WORM], []],
      winner: 0,
      extraRandom: [0],
      shuffleDeckSizes: [46],
    });
    const handle = session.handleFor(0);
    const ballIndex = session.viewFor(handle).you.hand.findIndex((card) => card.cardId === POKE_BALL);
    const play = {
      type: 'play-trainer',
      commandId: 'dup-play',
      sessionId: SESSION,
      expectedVersion: session.version,
      handIndex: ballIndex,
    } as MatchClientMessage;
    const first = session.submit(handle, play);
    expect(first.ok).toBe(true);
    const duplicate = session.submit(handle, play);
    expect(duplicate.ok && duplicate.duplicate).toBe(true);
    const versionAfterPlay = session.version;
    expect(versionAfterPlay).toBeGreaterThan(1);
    const choice = session.viewFor(handle).pendingChoice as MatchPendingChoiceView;
    const answer = {
      type: 'search-deck',
      commandId: 'dup-answer',
      sessionId: SESSION,
      expectedVersion: session.version,
      choiceId: choice.choiceId,
      candidateIds: [choice.cardCandidates[0]?.candidateId],
    } as MatchClientMessage;
    expect(session.submit(handle, answer).ok).toBe(true);
    const again = session.submit(handle, answer);
    expect(again.ok && again.duplicate).toBe(true);
    expect(session.version).toBe(versionAfterPlay + 1);
    // 不同载荷复用命令 ID 被拒绝。
    const reused = session.submit(handle, { ...answer, candidateIds: [choice.cardCandidates[1]?.candidateId as string] } as MatchClientMessage);
    expect(reused.ok).toBe(false);
    expect(reused.ok === false && reused.code).toBe('command-id-reused');
  });

  it('已过期选择 ID 的回答被拒绝，新状态不受旧提示影响', () => {
    const { session } = sessionScenario({
      hands: [
        [POKE_BALL, POKE_BALL, FISH, WATER, WATER, WATER, WATER],
        [FISH, FISH, WATER, WATER, WATER, WATER, WATER],
      ],
      rest: [[WATER, CHIEN_PAO, STEEL_WORM], []],
      winner: 0,
      extraRandom: [0, 0],
      shuffleDeckSizes: [46, 45],
    });
    const handle = session.handleFor(0);
    const playBall = (commandId: string): void => {
      const view = session.viewFor(handle);
      const index = view.you.hand.findIndex((card) => card.cardId === POKE_BALL);
      const result = session.submit(handle, {
        type: 'play-trainer',
        commandId,
        sessionId: SESSION,
        expectedVersion: view.version,
        handIndex: index,
      } as MatchClientMessage);
      expect(result.ok).toBe(true);
    };
    playBall('stale-play-1');
    const firstChoice = session.viewFor(handle).pendingChoice as MatchPendingChoiceView;
    const firstAnswer = {
      type: 'search-deck',
      commandId: 'stale-answer-1',
      sessionId: SESSION,
      expectedVersion: session.version,
      choiceId: firstChoice.choiceId,
      candidateIds: [firstChoice.cardCandidates[0]?.candidateId as string],
    } as MatchClientMessage;
    expect(session.submit(handle, firstAnswer).ok).toBe(true);
    playBall('stale-play-2');
    const secondChoice = session.viewFor(handle).pendingChoice as MatchPendingChoiceView;
    expect(secondChoice.choiceId).not.toBe(firstChoice.choiceId);
    const stale = session.submit(handle, {
      ...firstAnswer,
      commandId: 'stale-answer-2',
      expectedVersion: session.version,
    } as MatchClientMessage);
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.code).toBe('stale-choice');
    // 第二个选择仍可正常回答。
    const ok = session.submit(handle, {
      type: 'search-deck',
      commandId: 'fresh-answer',
      sessionId: SESSION,
      expectedVersion: session.version,
      choiceId: secondChoice.choiceId,
      candidateIds: [secondChoice.cardCandidates[0]?.candidateId as string],
    } as MatchClientMessage);
    expect(ok.ok).toBe(true);
  });
});
