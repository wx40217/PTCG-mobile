import { describe, expect, it } from 'vitest';
import type {
  CatalogCard,
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
  judgeWinConditions,
  prizeValueOf,
  type AttackEffectResolver,
  type MatchEngineConfig,
  type SpecialCondition,
} from '../src/match.ts';
import {
  OpeningHandScript,
  SequenceRandomSource,
  deckDocumentFromCardsWith,
  fixtureCatalog,
  type FixtureCardInput,
} from './support/matchTestKit.ts';

/* ------------------------------------------------------------------ */
/* 夹具与测试工具                                                      */
/* ------------------------------------------------------------------ */

const ATTACKER = 'fix-attacker'; // 基础，水，HP 100，撤退 1
const ATTACKER_LOW = 'fix-attacker-low'; // 基础，水，HP 20，可攻击，用于同归于尽
const VICTIM = 'fix-victim'; // 基础，水，HP 30
const VICTIM_BIG = 'fix-victim-big'; // 基础，水，HP 60
const VICTIM_LOW = 'fix-victim-low'; // 基础，水，HP 20
const VICTIM_EX = 'fix-victim-ex'; // 基础，水，HP 20，ex=2 张奖赏卡
const VICTIM_VMAX = 'fix-victim-vmax'; // 基础，水，HP 20，VMAX=3 张奖赏卡
const PROBE = 'fix-probe'; // 基础，水，HP 10，用于隐私探针
const ENERGY = 'fix-energy'; // 基本水能量

const ATTACK = {
  heavy: 0,
  light: 1,
  poison: 2,
  burn: 3,
  sleep: 4,
  paralyze: 5,
  confuse: 6,
  sacrifice: 7,
  double: 8,
  draw: 9,
} as const;

const FIXTURE_CARDS: readonly FixtureCardInput[] = [
  {
    id: ATTACKER,
    nameZh: '夹具攻击手',
    cardClass: 'pokemon',
    subtypes: ['基础'],
    type: '水',
    hp: 100,
    retreat: 1,
    attacks: [
      { name: '重击', cost: ['水'], damage: '100' },
      { name: '轻击', cost: ['水'], damage: '10' },
      { name: '毒针', cost: ['水'], damage: null, text: '使目标中毒。' },
      { name: '灼伤光线', cost: ['水'], damage: null, text: '使目标灼伤。' },
      { name: '催眠术', cost: ['水'], damage: null, text: '使目标睡眠。' },
      { name: '麻痹电击', cost: ['水'], damage: null, text: '使目标麻痹。' },
      { name: '迷惑光线', cost: ['水'], damage: null, text: '使目标混乱。' },
      { name: '同归于尽', cost: ['水'], damage: '10', text: '对双方战斗宝可梦各放置伤害指示物。' },
      { name: '双重打击', cost: ['水'], damage: '10', text: '对对手战斗与备战宝可梦各放置伤害指示物。' },
      { name: '抽牌', cost: ['水'], damage: null, text: '抽 3 张卡。' },
    ],
  },
  {
    id: ATTACKER_LOW,
    nameZh: '夹具低血攻击手',
    cardClass: 'pokemon',
    subtypes: ['基础'],
    type: '水',
    hp: 20,
    retreat: 1,
    attacks: [
      { name: '同归于尽', cost: ['水'], damage: '10', text: '对双方战斗宝可梦各放置伤害指示物。' },
      { name: '轻击', cost: ['水'], damage: '10' },
    ],
  },
  { id: VICTIM, nameZh: '夹具靶子', cardClass: 'pokemon', subtypes: ['基础'], type: '水', hp: 30, retreat: 0, attacks: [] },
  { id: VICTIM_BIG, nameZh: '夹具大靶子', cardClass: 'pokemon', subtypes: ['基础'], type: '水', hp: 60, retreat: 0, attacks: [] },
  { id: VICTIM_LOW, nameZh: '夹具小靶子', cardClass: 'pokemon', subtypes: ['基础'], type: '水', hp: 20, retreat: 0, attacks: [] },
  {
    id: VICTIM_EX,
    nameZh: '夹具ex',
    cardClass: 'pokemon',
    subtypes: ['基础', 'ex'],
    type: '水',
    hp: 20,
    retreat: 0,
    specialRuleTextZh: 'ex规则：当宝可梦ex昏厥时，对手将拿取2张奖赏卡。',
    attacks: [],
  },
  {
    id: VICTIM_VMAX,
    nameZh: '夹具VMAX',
    cardClass: 'pokemon',
    subtypes: ['基础', 'VMAX'],
    type: '水',
    hp: 20,
    retreat: 0,
    specialRuleTextZh: 'VMAX规则：当宝可梦VMAX昏厥时，对手将拿取3张奖赏卡。',
    attacks: [],
  },
  { id: PROBE, nameZh: '夹具探针', cardClass: 'pokemon', subtypes: ['基础'], type: '水', hp: 10, retreat: 0, attacks: [] },
  { id: ENERGY, nameZh: '夹具能量', cardClass: 'energy', subtypes: ['基本能量'], type: '水' },
];

const CATALOG: CatalogContent = fixtureCatalog(FIXTURE_CARDS);

function cardDefinition(id: string): CatalogCard {
  const card = CATALOG.cards.find((entry) => entry.id === id);
  if (card === undefined) {
    throw new Error(`夹具目录缺少 ${id}`);
  }
  return card;
}

function effectsFor(entries: readonly [string, AttackEffectResolver][]): ReadonlyMap<string, AttackEffectResolver> {
  return new Map(entries);
}

function attackerEffect(attackIndex: number, resolver: AttackEffectResolver): readonly [string, AttackEffectResolver] {
  const name = (FIXTURE_CARDS[0]?.attacks?.[attackIndex]?.name ?? '') as string;
  return [attackEffectKey(`fx:fixture:夹具攻击手:${ATTACKER}`, name), resolver];
}

function statusEffect(attackIndex: number, condition: SpecialCondition): readonly [string, AttackEffectResolver] {
  return attackerEffect(attackIndex, (ctx) => ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, condition));
}

function lowAttackerEffect(attackName: string, resolver: AttackEffectResolver): readonly [string, AttackEffectResolver] {
  return [attackEffectKey(`fx:fixture:夹具低血攻击手:${ATTACKER_LOW}`, attackName), resolver];
}

function configFor(
  decks: readonly [readonly string[], readonly string[]],
  outputs: readonly number[],
  attackEffects?: ReadonlyMap<string, AttackEffectResolver>,
  catalog: CatalogContent = CATALOG,
): MatchEngineConfig {
  return {
    sessionId: 'session-test',
    decks: [deckDocumentFromCardsWith(decks[0], catalog), deckDocumentFromCardsWith(decks[1], catalog)],
    nicknames: ['小智', '小茂'],
    catalog,
    random: new SequenceRandomSource(outputs),
    ...(attackEffects === undefined ? {} : { attackEffects }),
  };
}

function choiceId(view: MatchView): string {
  if (view.pendingChoice === null) {
    throw new Error('期望存在待决选择');
  }
  return view.pendingChoice.choiceId;
}

function chooseTurnOrder(engine: MatchEngine, seat: MatchSeat, goFirst: boolean): void {
  const view = engine.viewFor(seat);
  engine.execute(seat, {
    type: 'choose-turn-order',
    commandId: `c-to-${seat}-${engine.version}`,
    sessionId: 'session-test',
    expectedVersion: view.version,
    choiceId: choiceId(view),
    goFirst,
  });
}

interface OpenOptions {
  readonly decks: readonly [readonly string[], readonly string[]];
  readonly hand0: readonly string[];
  readonly prizes0: readonly string[];
  readonly hand1: readonly string[];
  readonly prizes1: readonly string[];
  readonly effects?: ReadonlyMap<string, AttackEffectResolver>;
  readonly extraRandom?: readonly number[];
  readonly winner?: MatchSeat;
  /** 初始盖放时每个座位放进备战区的基础宝可梦数量。 */
  readonly bench?: Partial<Record<MatchSeat, number>>;
}

interface OpenedEngine {
  readonly engine: MatchEngine;
  /** 与引擎共用同一个脚本随机源，便于断言失败命令是否消耗随机。 */
  readonly random: SequenceRandomSource;
}

/** 完成开局（含指定数量的初始备战）；获胜方固定先攻；同时暴露随机源。 */
function openEngineWithRandom(options: OpenOptions): OpenedEngine {
  const script = new OpeningHandScript([options.decks[0], options.decks[1]]);
  script.planHand(0, options.hand0, options.prizes0);
  script.deal(0);
  script.planHand(1, options.hand1, options.prizes1);
  script.deal(1);
  const winner = options.winner ?? 0;
  const random = new SequenceRandomSource([winner, ...script.outputs, ...(options.extraRandom ?? [])]);
  const engine = new MatchEngine({
    sessionId: 'session-test',
    decks: [deckDocumentFromCardsWith(options.decks[0], CATALOG), deckDocumentFromCardsWith(options.decks[1], CATALOG)],
    nicknames: ['小智', '小茂'],
    catalog: CATALOG,
    random,
    ...(options.effects === undefined ? {} : { attackEffects: options.effects }),
  });
  chooseTurnOrder(engine, winner, true);
  for (let step = 0; step < 100; step += 1) {
    const owner = ([0, 1] as const).find((seat) => engine.viewFor(seat).pendingChoice !== null);
    if (owner === undefined) {
      if (engine.phase !== 'playing') {
        throw new Error(`开局流程在 ${engine.phase} 阶段停滞`);
      }
      return { engine, random };
    }
    const view = engine.viewFor(owner);
    const choice = view.pendingChoice as MatchPendingChoiceView;
    const base = {
      commandId: `open-${owner}-${engine.version}`,
      sessionId: 'session-test',
      expectedVersion: view.version,
      choiceId: choice.choiceId,
    };
    if (choice.kind === 'place-setup') {
      const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
      const benchCount = options.bench?.[owner] ?? 0;
      engine.execute(owner, { ...base, type: 'place-setup', active: basics[0] as number, bench: basics.slice(1, 1 + benchCount) });
      continue;
    }
    if (choice.kind === 'compensation-draw') {
      engine.execute(owner, { ...base, type: 'resolve-compensation', draw: 0 });
      continue;
    }
    if (choice.kind === 'place-bench') {
      engine.execute(owner, { ...base, type: 'place-bench', bench: [] });
      continue;
    }
    throw new Error(`未预期的开局待决选择：${choice.kind}`);
  }
  throw new Error('开局流程没有在限定步数内完成');
}

function openEngine(options: OpenOptions): MatchEngine {
  return openEngineWithRandom(options).engine;
}

function turnCommand(engine: MatchEngine, seat: MatchSeat, command: Record<string, unknown>): void {
  engine.execute(seat, {
    commandId: `c-turn-${seat}-${engine.version}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-test',
    expectedVersion: engine.version,
    ...command,
  } as MatchClientMessage);
}

function expectEngineError(fn: () => void, code: string): void {
  let caught: MatchEngineError | undefined;
  try {
    fn();
  } catch (error) {
    if (error instanceof MatchEngineError) {
      caught = error;
    } else {
      throw error;
    }
  }
  expect(caught?.code).toBe(code);
}

function energyIndex(engine: MatchEngine, seat: MatchSeat): number {
  return engine.viewFor(seat).you.hand.findIndex((card) => card.kind === 'energy');
}

function endTurn(engine: MatchEngine, seat: MatchSeat): void {
  turnCommand(engine, seat, { type: 'end-turn' });
}

/** 恰好 7 张手牌；用于开局规划。 */
function handWith(active: string, extras: readonly string[] = []): string[] {
  return [active, ...extras, ...Array(Math.max(0, 7 - 1 - extras.length)).fill(ENERGY)].slice(0, 7);
}

/** 20 张卡组：给定基础宝可梦 + 基本能量。 */
function decksWith(basics0: readonly string[], basics1: readonly string[], size = 20): [string[], string[]] {
  return [
    [...basics0, ...Array(size - basics0.length).fill(ENERGY)],
    [...basics1, ...Array(size - basics1.length).fill(ENERGY)],
  ];
}

function standardDecks(active0: string, active1: string, size = 20): [string[], string[]] {
  return decksWith([active0], [active1], size);
}

function prizes(ids: readonly string[]): string[] {
  return [...ids, ...Array(Math.max(0, 6 - ids.length)).fill(ENERGY)].slice(0, 6);
}

/* ------------------------------------------------------------------ */
/* A. 特殊状态与宝可梦检查                                             */
/* ------------------------------------------------------------------ */

describe('T09 特殊状态共存、替换与宝可梦检查', () => {
  it('施加特殊状态：公开事件与双方视图一致', () => {
    const effects = effectsFor([statusEffect(ATTACK.poison, '中毒')]);
    const [deck0, deck1] = standardDecks(ATTACKER, ATTACKER);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
    });
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: ATTACK.poison, target: { slot: 'active' } });

    const view0 = engine.viewFor(0);
    expect(view0.you.active?.statuses).toEqual(['中毒']);
    expect(view0.you.active?.damageCounters).toBe(1); // 回合结束的宝可梦检查放置 1 个指示物。
    expect(engine.viewFor(1).opponent.active?.statuses).toEqual(['中毒']);
    expect(view0.events.find((event) => event.type === 'status-inflicted')).toMatchObject({
      type: 'status-inflicted',
      seat: 1,
      targetSeat: 0,
      condition: '中毒',
    });
    expect(view0.events.find((event) => event.type === 'damage-counters-placed')).toMatchObject({ seat: 0, targetSeat: 0, count: 1 });
  });

  it('中毒/灼伤可与任意状态叠加；睡眠/麻痹/混乱互斥且新状态替换旧状态', () => {
    const effects = effectsFor([
      attackerEffect(ATTACK.poison, (ctx) => {
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '中毒');
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '灼伤');
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '睡眠');
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '麻痹');
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '混乱');
      }),
    ]);
    const [deck0, deck1] = standardDecks(ATTACKER, ATTACKER);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
      extraRandom: [1], // 回合结束的宝可梦检查：灼伤抛硬币为反面，状态继续。
    });
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: ATTACK.poison, target: { slot: 'active' } });

    expect(engine.viewFor(0).you.active?.statuses).toEqual(['中毒', '灼伤', '混乱']);
    expect(engine.viewFor(0).you.active?.damageCounters).toBe(3); // 中毒 1 + 灼伤 2
    const inflicted = engine.viewFor(0).events.filter((event) => event.type === 'status-inflicted');
    expect(inflicted.map((event) => (event.type === 'status-inflicted' ? event.condition : ''))).toEqual([
      '中毒',
      '灼伤',
      '睡眠',
      '麻痹',
      '混乱',
    ]);
  });

  it('宝可梦检查按中毒→灼伤→睡眠→麻痹顺序确认，随机结果与恢复公开可解释', () => {
    const effects = effectsFor([
      attackerEffect(ATTACK.poison, (ctx) => {
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '中毒');
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '灼伤');
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '睡眠');
      }),
    ]);
    const [deck0, deck1] = standardDecks(VICTIM_BIG, ATTACKER);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(VICTIM_BIG),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
      extraRandom: [0, 1], // 灼伤正面（恢复），睡眠反面（继续）。
    });
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: ATTACK.poison, target: { slot: 'active' } });

    const view = engine.viewFor(0);
    expect(view.you.active?.damageCounters).toBe(3);
    expect(view.you.active?.statuses).toEqual(['中毒', '睡眠']);
    const checkupEvents = view.events.filter(
      (event) => event.type === 'checkup-flip' || event.type === 'status-recovered' || (event.type === 'damage-counters-placed' && event.targetSeat === 0),
    );
    const shape = checkupEvents.map((event) =>
      event.type === 'damage-counters-placed'
        ? `damage:${event.count}`
        : event.type === 'checkup-flip'
          ? `${event.condition}:${event.result}`
          : `${event.condition}:${event.cause}`,
    );
    expect(shape).toEqual(['damage:1', 'damage:2', '灼伤:heads', '灼伤:checkup', '睡眠:tails']);
  });

  it('麻痹在持有者的下一个回合结束后的宝可梦检查恢复，期间禁止招式与撤退', () => {
    const effects = effectsFor([statusEffect(ATTACK.paralyze, '麻痹')]);
    const [deck0, deck1] = decksWith([ATTACKER, VICTIM], [ATTACKER]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER, [VICTIM]),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
      bench: { 0: 1 },
    });
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: ATTACK.paralyze, target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.statuses).toEqual(['麻痹']);

    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.light, target: { slot: 'active' } }), 'action-not-allowed');
    expectEngineError(() => turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 0 }), 'action-not-allowed');
    expect(engine.viewFor(0).you.active?.statuses).toEqual(['麻痹']);

    endTurn(engine, 0);
    expect(engine.viewFor(0).you.active?.statuses).toEqual([]);
    expect(engine.viewFor(0).events.find((event) => event.type === 'status-recovered' && event.condition === '麻痹')).toMatchObject({
      cause: 'checkup',
    });
  });

  it('睡眠抛硬币：反面继续、正面在宝可梦检查恢复', () => {
    const effects = effectsFor([statusEffect(ATTACK.sleep, '睡眠')]);
    const [deck0, deck1] = decksWith([ATTACKER, VICTIM], [ATTACKER]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER, [VICTIM]),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
      bench: { 0: 1 },
      extraRandom: [1, 0], // turn 2 检查反面继续；turn 3 检查正面恢复。
    });
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: ATTACK.sleep, target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.statuses).toEqual(['睡眠']);

    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.light, target: { slot: 'active' } }), 'action-not-allowed');
    expectEngineError(() => turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 0 }), 'action-not-allowed');
    endTurn(engine, 0);
    expect(engine.viewFor(0).you.active?.statuses).toEqual([]);
    expect(engine.viewFor(0).you.active?.damageCounters).toBe(0);
  });

  it('撤退到备战区会清除特殊状态并公开说明', () => {
    const effects = effectsFor([statusEffect(ATTACK.poison, '中毒')]);
    const [deck0, deck1] = decksWith([ATTACKER, VICTIM], [ATTACKER]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER, [VICTIM]),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
      bench: { 0: 1 },
    });
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: ATTACK.poison, target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.statuses).toEqual(['中毒']);

    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 0 });
    expect(engine.viewFor(0).you.active?.statuses).toEqual([]);
    expect(engine.viewFor(0).you.bench[0]?.statuses).toEqual([]);
    expect(engine.viewFor(0).events.find((event) => event.type === 'status-recovered' && event.condition === '中毒')).toMatchObject({
      cause: 'retreat',
    });

    // 已清除的中毒不会在后续宝可梦检查再次造成伤害。
    const damageBefore = engine.viewFor(0).you.active?.damageCounters ?? 0;
    endTurn(engine, 0);
    expect(engine.viewFor(0).you.active?.damageCounters).toBe(damageBefore);
  });

  it('效果试图给备战宝可梦施加特殊状态时整条招式回滚（不留下伤害）', () => {
    const effects = effectsFor([
      attackerEffect(ATTACK.poison, (ctx) => {
        ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'active' }, 1);
        ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'bench', index: 0 }, '中毒');
      }),
    ]);
    const [deck0, deck1] = decksWith([ATTACKER], [ATTACKER, VICTIM]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER, [VICTIM]),
      prizes1: prizes([]),
      effects,
      bench: { 1: 1 },
    });
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    const version = engine.version;
    const events = JSON.stringify(engine.viewFor(0).events);
    expectEngineError(() => turnCommand(engine, 1, { type: 'attack', attackIndex: ATTACK.poison, target: { slot: 'active' } }), 'illegal-target');
    expect(engine.version).toBe(version);
    expect(JSON.stringify(engine.viewFor(0).events)).toBe(events);
    expect(engine.viewFor(0).you.active?.damageCounters).toBe(0);
    expect(engine.viewFor(0).you.active?.statuses).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* B. 混乱                                                             */
/* ------------------------------------------------------------------ */

describe('T09 混乱（攻击宣言抛硬币）', () => {
  function confusedEngine(extraRandom: readonly number[]): MatchEngine {
    const effects = effectsFor([statusEffect(ATTACK.confuse, '混乱')]);
    const [deck0, deck1] = standardDecks(ATTACKER, ATTACKER);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
      extraRandom,
    });
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: ATTACK.confuse, target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.statuses).toEqual(['混乱']);
    return engine;
  }

  it('反面：招式失败、自身放置 3 个伤害指示物并结束回合', () => {
    const engine = confusedEngine([1]);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } });

    const view = engine.viewFor(0);
    expect(view.you.active?.damageCounters).toBe(3);
    expect(view.opponent.active?.damageCounters).toBe(0);
    expect(view.events.some((event) => event.type === 'attack-used' && event.attackName === '重击')).toBe(false);
    expect(view.events.find((event) => event.type === 'confusion-flip')).toMatchObject({ result: 'tails', selfDamageCounters: 3 });
    expect(engine.viewFor(1).turn).toBe(4); // 招式失败视作未使用，但仍结束回合。
    expect(engine.viewFor(1).activeSeat).toBe(1);
  });

  it('正面：招式正常结算（混乱状态保留）', () => {
    const engine = confusedEngine([0]);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.light, target: { slot: 'active' } });
    const view = engine.viewFor(0);
    expect(view.you.active?.damageCounters).toBe(0);
    expect(view.opponent.active?.damageCounters).toBe(1);
    expect(view.events.find((event) => event.type === 'attack-used' && event.attackName === '轻击')).toMatchObject({ attackName: '轻击', damage: 10 });
    expect(view.you.active?.statuses).toEqual(['混乱']);
  });

  /** 对局进行到座位 0 的回合、战斗宝可梦处于混乱；extraRandom 从该次招式开始消费。 */
  function confusedOpening(
    extraEffects: readonly [string, AttackEffectResolver][],
    extraRandom: readonly number[],
  ): OpenedEngine {
    const effects = effectsFor([statusEffect(ATTACK.confuse, '混乱'), ...extraEffects]);
    const [deck0, deck1] = standardDecks(ATTACKER, ATTACKER);
    const opened = openEngineWithRandom({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
      extraRandom,
    });
    endTurn(opened.engine, 0);
    turnCommand(opened.engine, 1, { type: 'attach-energy', handIndex: energyIndex(opened.engine, 1), target: { slot: 'active' } });
    turnCommand(opened.engine, 1, { type: 'attack', attackIndex: ATTACK.confuse, target: { slot: 'active' } });
    expect(opened.engine.viewFor(0).you.active?.statuses).toEqual(['混乱']);
    turnCommand(opened.engine, 0, { type: 'attach-energy', handIndex: energyIndex(opened.engine, 0), target: { slot: 'active' } });
    return opened;
  }

  it('效果登记失败先于硬币：不消耗随机、不追加事件且双方视图与版本不变', () => {
    const { engine, random } = confusedOpening(
      [
        attackerEffect(ATTACK.heavy, (ctx) => {
          // 先登记一个合法操作，再登记非法数量：整条招式都不得留下任何痕迹。
          ctx.dealDamage();
          ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'active' }, 0);
        }),
      ],
      [0, 1],
    );
    const version = engine.version;
    const events = JSON.stringify(engine.viewFor(0).events);
    const view0 = JSON.stringify(engine.viewFor(0));
    const view1 = JSON.stringify(engine.viewFor(1));
    const remaining = random.remaining;

    expectEngineError(
      () => turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } }),
      'illegal-choice',
    );

    expect(engine.version).toBe(version);
    expect(random.remaining).toBe(remaining);
    expect(JSON.stringify(engine.viewFor(0).events)).toBe(events);
    expect(JSON.stringify(engine.viewFor(0))).toBe(view0);
    expect(JSON.stringify(engine.viewFor(1))).toBe(view1);
  });

  it('登记失败不重掷硬币：修正后重试仍按原随机序列抛出反面并自伤结束回合', () => {
    let calls = 0;
    const { engine } = confusedOpening(
      [
        attackerEffect(ATTACK.heavy, (ctx) => {
          calls += 1;
          if (calls === 1) {
            ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'active' }, 0);
            return;
          }
          ctx.dealDamage();
        }),
      ],
      [1],
    );
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } }),
      'illegal-choice',
    );
    expect(engine.viewFor(0).events.some((event) => event.type === 'confusion-flip')).toBe(false);

    // 修正后重试：若上次失败消耗了硬币，这次会因随机源耗尽而失败或得到错误结果。
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } });
    const view = engine.viewFor(0);
    expect(calls).toBe(2);
    expect(view.you.active?.damageCounters).toBe(3);
    expect(view.events.filter((event) => event.type === 'confusion-flip')).toHaveLength(1);
    expect(view.events.find((event) => event.type === 'confusion-flip')).toMatchObject({ result: 'tails', selfDamageCounters: 3 });
    expect(view.events.some((event) => event.type === 'attack-used' && event.attackName === '重击')).toBe(false);
    expect(view.events.some((event) => event.type === 'damage-counters-placed' && event.targetSeat === 1)).toBe(false);
  });

  it('正面：暂存效果恰好应用一次；反面：登记通过的暂存效果全部丢弃', () => {
    const run = (flip: number): { readonly view: MatchView; readonly calls: number } => {
      let calls = 0;
      const { engine } = confusedOpening(
        [
          attackerEffect(ATTACK.light, (ctx) => {
            calls += 1;
            ctx.dealDamage();
          }),
        ],
        [flip],
      );
      turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.light, target: { slot: 'active' } });
      return { view: engine.viewFor(0), calls };
    };

    const heads = run(0);
    expect(heads.calls).toBe(1);
    expect(heads.view.events.filter((event) => event.type === 'confusion-flip')).toHaveLength(1);
    expect(heads.view.events.find((event) => event.type === 'confusion-flip')).toMatchObject({ result: 'heads', selfDamageCounters: 0 });
    expect(heads.view.you.active?.damageCounters).toBe(0);
    expect(heads.view.opponent.active?.damageCounters).toBe(1);
    expect(
      heads.view.events.filter((event) => event.type === 'damage-counters-placed' && event.targetSeat === 1),
    ).toHaveLength(1);

    const tails = run(1);
    // 反面只做登记与校验，不应用任何暂存效果；自身 3 个指示物并结束回合。
    expect(tails.calls).toBe(1);
    expect(tails.view.you.active?.damageCounters).toBe(3);
    expect(tails.view.opponent.active?.damageCounters).toBe(0);
    expect(tails.view.events.filter((event) => event.type === 'confusion-flip')).toHaveLength(1);
    expect(tails.view.events.find((event) => event.type === 'confusion-flip')).toMatchObject({ result: 'tails', selfDamageCounters: 3 });
    expect(tails.view.events.some((event) => event.type === 'damage-counters-placed' && event.targetSeat === 1)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* C. 昏厥、奖赏与胜负                                                 */
/* ------------------------------------------------------------------ */

describe('T09 昏厥、奖赏卡与胜负', () => {
  it('招式昏厥：宝可梦与附加卡进弃牌区，取奖赏卡选择属于正确玩家', () => {
    const [deck0, deck1] = decksWith([ATTACKER, PROBE], [VICTIM, VICTIM]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([PROBE]),
      hand1: handWith(VICTIM, [VICTIM]),
      prizes1: prizes([]),
      bench: { 1: 1 },
    });
    endTurn(engine, 0);
    // 座位 1 给靶子附能（验证昏厥后附着卡随宝可梦进弃牌区）。
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    const prizesBefore = engine.viewFor(0).you.prizeCount;
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } });

    const afterKo = engine.viewFor(1);
    expect(afterKo.you.active).toBeNull();
    expect(afterKo.you.bench).toHaveLength(1);
    expect(afterKo.you.discard.some((card) => card.cardId === VICTIM)).toBe(true);
    expect(afterKo.you.discard.some((card) => card.cardId === ENERGY)).toBe(true);
    expect(afterKo.events.find((event) => event.type === 'pokemon-knocked-out')).toMatchObject({ targetSeat: 1, prizeCount: 1 });

    // 取奖赏卡属于造成昏厥的座位 0；对手不能代替选择。
    expect(engine.viewFor(0).pendingChoice).toMatchObject({ kind: 'take-prizes', min: 1, max: 1 });
    expect(engine.viewFor(1).waitingForOpponentChoice).toBe(true);
    expectEngineError(
      () =>
        turnCommand(engine, 1, {
          type: 'take-prizes',
          choiceId: choiceId(engine.viewFor(0)),
          prizes: [0],
        }),
      'not-your-choice',
    );

    const takeView = engine.viewFor(0);
    turnCommand(engine, 0, { type: 'take-prizes', choiceId: choiceId(takeView), prizes: [3] });
    const afterTake = engine.viewFor(0);
    expect(afterTake.you.prizeCount).toBe(prizesBefore - 1);
    expect(afterTake.you.handCount).toBe(takeView.you.handCount + 1);
    expect(afterTake.events.find((event) => event.type === 'prizes-taken')).toMatchObject({ seat: 0, count: 1, remaining: prizesBefore - 1 });
    expect(JSON.stringify(afterTake.events.at(-1))).not.toContain('cardId');

    // 之后轮到被昏厥方选择补充战斗宝可梦；选择后才继续。
    expect(engine.viewFor(1).pendingChoice).toMatchObject({ kind: 'choose-replacement', candidates: [0] });
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'choose-replacement', choiceId: choiceId(engine.viewFor(1)), benchIndex: 0 }),
      'not-your-choice',
    );
    turnCommand(engine, 1, { type: 'choose-replacement', choiceId: choiceId(engine.viewFor(1)), benchIndex: 0 });
    const afterReplacement = engine.viewFor(1);
    expect(afterReplacement.you.active?.card.cardId).toBe(VICTIM);
    expect(afterReplacement.you.bench).toHaveLength(0);
    expect(afterReplacement.events.find((event) => event.type === 'replacement-placed')).toMatchObject({ seat: 1 });
    expect(afterReplacement.result).toBeNull();
  });

  it('多只昏厥（含备战）合计奖赏；无后备时判定败北', () => {
    const effects = effectsFor([
      attackerEffect(ATTACK.double, (ctx) => {
        ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'active' }, 2);
        ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'bench', index: 0 }, 2);
      }),
    ]);
    const [deck0, deck1] = decksWith([ATTACKER], [VICTIM_LOW, VICTIM_LOW]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(VICTIM_LOW, [VICTIM_LOW]),
      prizes1: prizes([]),
      effects,
      bench: { 1: 1 },
    });
    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.double, target: { slot: 'active' } });

    expect(engine.viewFor(1).you.active).toBeNull();
    expect(engine.viewFor(1).you.bench).toHaveLength(0);
    expect(engine.viewFor(1).you.discard.filter((card) => card.cardId === VICTIM_LOW)).toHaveLength(2);
    expect(engine.viewFor(0).pendingChoice).toMatchObject({ kind: 'take-prizes', min: 2, max: 2 });
    turnCommand(engine, 0, { type: 'take-prizes', choiceId: choiceId(engine.viewFor(0)), prizes: [0, 1] });
    expect(engine.viewFor(0).events.find((event) => event.type === 'prizes-taken')).toMatchObject({ count: 2, remaining: 4 });
    expect(engine.viewFor(1).result).toMatchObject({ winner: 0, reason: 'no-pokemon' });
    expect(engine.viewFor(0).result).toEqual(engine.viewFor(1).result);
    expect(engine.viewFor(1).pendingChoice).toBeNull();
  });

  it('双方战斗宝可梦同时昏厥：下一回合轮到的玩家先放战斗宝可梦', () => {
    const effects = effectsFor([
      lowAttackerEffect('同归于尽', (ctx) => {
        ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'active' }, 2);
        ctx.placeDamageCounters(ctx.seat, { slot: 'active' }, 2);
      }),
    ]);
    const [deck0, deck1] = decksWith([ATTACKER_LOW, VICTIM_LOW], [VICTIM_LOW, VICTIM_LOW]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER_LOW, [VICTIM_LOW]),
      prizes0: prizes([]),
      hand1: handWith(VICTIM_LOW, [VICTIM_LOW]),
      prizes1: prizes([]),
      effects,
      bench: { 0: 1, 1: 1 },
    });
    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });

    // 先各取 1 张奖赏卡（座位 0 先取，再座位 1）。
    expect(engine.viewFor(0).pendingChoice).toMatchObject({ kind: 'take-prizes' });
    turnCommand(engine, 0, { type: 'take-prizes', choiceId: choiceId(engine.viewFor(0)), prizes: [0] });
    expect(engine.viewFor(1).pendingChoice).toMatchObject({ kind: 'take-prizes' });
    turnCommand(engine, 1, { type: 'take-prizes', choiceId: choiceId(engine.viewFor(1)), prizes: [0] });

    // 同时昏厥的补充顺序：座位 0 刚结束回合，下一回合是座位 1 → 座位 1 先选。
    expect(engine.viewFor(1).pendingChoice).toMatchObject({ kind: 'choose-replacement' });
    expect(engine.viewFor(0).waitingForOpponentChoice).toBe(true);
    turnCommand(engine, 1, { type: 'choose-replacement', choiceId: choiceId(engine.viewFor(1)), benchIndex: 0 });
    expect(engine.viewFor(0).pendingChoice).toMatchObject({ kind: 'choose-replacement' });
    turnCommand(engine, 0, { type: 'choose-replacement', choiceId: choiceId(engine.viewFor(0)), benchIndex: 0 });
    expect(engine.viewFor(0).result).toBeNull();
    expect(engine.viewFor(0).you.active?.card.cardId).toBe(VICTIM_LOW);
    expect(engine.viewFor(1).you.active?.card.cardId).toBe(VICTIM_LOW);
  });

  it('双方战斗宝可梦同时昏厥且双方都无后备：判定平局（同时满足胜负条件判定表）', () => {
    const effects = effectsFor([
      lowAttackerEffect('同归于尽', (ctx) => {
        ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'active' }, 2);
        ctx.placeDamageCounters(ctx.seat, { slot: 'active' }, 2);
      }),
    ]);
    const [deck0, deck1] = decksWith([ATTACKER_LOW], [VICTIM_LOW]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER_LOW),
      prizes0: prizes([]),
      hand1: handWith(VICTIM_LOW),
      prizes1: prizes([]),
      effects,
    });
    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    // 双方取 1 张奖赏卡后判定「双方都没有能放于战斗场的宝可梦」→ 平局。
    turnCommand(engine, 0, { type: 'take-prizes', choiceId: choiceId(engine.viewFor(0)), prizes: [0] });
    turnCommand(engine, 1, { type: 'take-prizes', choiceId: choiceId(engine.viewFor(1)), prizes: [0] });
    expect(engine.viewFor(0).result).toMatchObject({ winner: null, reason: 'simultaneous' });
    expect(engine.viewFor(1).result).toEqual(engine.viewFor(0).result);
    expect(engine.viewFor(0).result?.conditions).toEqual(
      expect.arrayContaining([
        { seat: 0, condition: 'no-pokemon' },
        { seat: 1, condition: 'no-pokemon' },
      ]),
    );
  });

  it('特殊奖赏数量：ex 为 2 张、VMAX 为 3 张（按卡面规则文字）', () => {
    expect(prizeValueOf(cardDefinition(VICTIM_EX))).toBe(2);
    expect(prizeValueOf(cardDefinition(VICTIM_VMAX))).toBe(3);
    expect(prizeValueOf(cardDefinition(VICTIM))).toBe(1);

    const run = (victim: string, expectedPrizeCount: number): void => {
      const [deck0, deck1] = decksWith([ATTACKER], [victim, victim]);
      const engine = openEngine({
        decks: [deck0, deck1],
        hand0: handWith(ATTACKER),
        prizes0: prizes([]),
        hand1: handWith(victim, [victim]),
        prizes1: prizes([]),
        bench: { 1: 1 },
      });
      endTurn(engine, 0);
      endTurn(engine, 1);
      turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
      turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } });
      expect(engine.viewFor(1).events.find((event) => event.type === 'pokemon-knocked-out')).toMatchObject({ prizeCount: expectedPrizeCount });
      expect(engine.viewFor(0).pendingChoice).toMatchObject({ kind: 'take-prizes', min: expectedPrizeCount, max: expectedPrizeCount });
    };
    run(VICTIM_EX, 2);
    run(VICTIM_VMAX, 3);
  });

  it('最后奖赏：剩余奖赏不足时取完剩余张数即获胜，且不再产生待决选择', () => {
    const [deck0, deck1] = decksWith([ATTACKER], [VICTIM_VMAX, VICTIM_VMAX]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(VICTIM_VMAX, [VICTIM_VMAX]),
      prizes1: prizes([]),
      bench: { 1: 1 },
    });
    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    // 第一次昏厥：取 3 张（6 → 3）。
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'take-prizes', choiceId: choiceId(engine.viewFor(0)), prizes: [0, 1, 2] });
    turnCommand(engine, 1, { type: 'choose-replacement', choiceId: choiceId(engine.viewFor(1)), benchIndex: 0 });
    expect(engine.viewFor(0).you.prizeCount).toBe(3);
    expect(engine.viewFor(0).result).toBeNull();

    // 第二次昏厥：恰好等于剩余奖赏，直接取完并获胜。
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } });
    const final = engine.viewFor(0);
    expect(final.you.prizeCount).toBe(0);
    expect(final.pendingChoice).toBeNull();
    expect(final.result).toMatchObject({ winner: 0, reason: 'prizes' });
    expect(final.events.find((event) => event.type === 'prizes-taken' && event.remaining === 0)).toMatchObject({ count: 3, seat: 0 });
    expectEngineError(() => turnCommand(engine, 0, { type: 'end-turn' }), 'match-finished');
  });

  it('一般效果抽空不判败，只有回合开始抽空判败北', () => {
    const effects = effectsFor([attackerEffect(ATTACK.draw, (ctx) => ctx.drawCards(3))]);
    const deck0 = [ATTACKER, ...Array(16).fill(ENERGY)]; // 首回合与第三回合各抽 1 后剩 2 张，全部由效果抽走。
    const deck1 = [ATTACKER, ...Array(19).fill(ENERGY)];
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
      effects,
    });
    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    const before = engine.viewFor(0).you.handCount;
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.draw, target: { slot: 'active' } });
    const afterDraw = engine.viewFor(0);
    expect(afterDraw.you.deckCount).toBe(0);
    expect(afterDraw.you.handCount).toBe(before + 2); // 牌库只剩 2 张：抽到没有为止。
    expect(afterDraw.result).toBeNull(); // 一般效果抽空本身不判败。
    expect(afterDraw.events.find((event) => event.type === 'card-drawn' && event.seat === 0 && event.count === 2)).toBeDefined();

    endTurn(engine, 1); // 效果抽牌已结束座位 0 的回合；结束座位 1 的回合后轮到座位 0 抽牌。
    const deckedOut = engine.viewFor(0);
    expect(deckedOut.cannotDraw).toBe(true);
    expect(deckedOut.result).toMatchObject({ winner: 1, reason: 'deck-out' });
    expect(engine.viewFor(1).events.filter((event) => event.type === 'match-finished')).toHaveLength(1);
  });

  it('冻结判定表：11 种组合逐行与官方 Ver 3.1.0 表一致', () => {
    const t = (a: boolean, b: boolean) => [a, b] as const;
    // 行 1–5：平局。
    expect(judgeWinConditions(t(true, false), t(true, false))).toMatchObject({ winner: null, reason: 'simultaneous' });
    expect(judgeWinConditions(t(false, true), t(false, true))).toMatchObject({ winner: null, reason: 'simultaneous' });
    expect(judgeWinConditions(t(true, true), t(true, true))).toMatchObject({ winner: null, reason: 'simultaneous' });
    expect(judgeWinConditions(t(true, true), t(false, false))).toMatchObject({ winner: null, reason: 'simultaneous' });
    expect(judgeWinConditions(t(false, false), t(true, true))).toMatchObject({ winner: null, reason: 'simultaneous' });
    // 行 6–8：自己获胜。
    expect(judgeWinConditions(t(true, true), t(false, true))).toMatchObject({ winner: 0, reason: 'prizes' });
    expect(judgeWinConditions(t(true, false), t(true, true))).toMatchObject({ winner: 0, reason: 'prizes' });
    expect(judgeWinConditions(t(true, false), t(false, true))).toMatchObject({ winner: 0, reason: 'prizes' });
    // 行 9–11：自己败北（票数比较，不采用 first-match）。
    expect(judgeWinConditions(t(true, true), t(true, false))).toMatchObject({ winner: 1 });
    expect(judgeWinConditions(t(false, true), t(true, true))).toMatchObject({ winner: 1 });
    expect(judgeWinConditions(t(false, true), t(true, false))).toMatchObject({ winner: 1, reason: 'prizes' });
    // 无条件：未结束。
    expect(judgeWinConditions(t(false, false), t(false, false))).toBeNull();
  });

  it('非法取奖赏卡选择失败不改变状态（数量、越界、重复、旧选择）', () => {
    const [deck0, deck1] = decksWith([ATTACKER, PROBE], [VICTIM, VICTIM]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([PROBE]),
      hand1: handWith(VICTIM, [VICTIM]),
      prizes1: prizes([]),
      bench: { 1: 1 },
    });
    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } });
    const view = engine.viewFor(0);
    const choice = view.pendingChoice as MatchPendingChoiceView;
    const version = engine.version;
    const eventCount = view.events.length;
    const prizeCount = view.you.prizeCount;

    for (const invalid of [
      { type: 'take-prizes', choiceId: choice.choiceId, prizes: [] },
      { type: 'take-prizes', choiceId: choice.choiceId, prizes: [0, 1] },
      { type: 'take-prizes', choiceId: choice.choiceId, prizes: [99] },
    ] as const) {
      expectEngineError(() => turnCommand(engine, 0, invalid), 'illegal-choice');
    }
    expectEngineError(() => turnCommand(engine, 0, { type: 'take-prizes', choiceId: 'choice-stale', prizes: [0] }), 'stale-choice');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).events).toHaveLength(eventCount);
    expect(engine.viewFor(0).you.prizeCount).toBe(prizeCount);
    // 合法选择仍然可用。
    turnCommand(engine, 0, { type: 'take-prizes', choiceId: choice.choiceId, prizes: [0] });
    expect(engine.viewFor(0).you.prizeCount).toBe(prizeCount - 1);
  });
});

/* ------------------------------------------------------------------ */
/* D. 认输与终态                                                        */
/* ------------------------------------------------------------------ */

describe('T09 认输与唯一权威终态', () => {
  function playingEngine(): MatchEngine {
    const [deck0, deck1] = standardDecks(ATTACKER, ATTACKER);
    return openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([]),
      hand1: handWith(ATTACKER),
      prizes1: prizes([]),
    });
  }

  it('确认认输：终态只生成一次、双方结果一致、结束后拒绝继续操作', () => {
    const engine = playingEngine();
    turnCommand(engine, 1, { type: 'concede' });
    const view0 = engine.viewFor(0);
    const view1 = engine.viewFor(1);
    expect(view0.result).toEqual({ winner: 0, reason: 'concede', conditions: [] });
    expect(view1.result).toEqual(view0.result);
    expect(view0.pendingChoice).toBeNull();
    expect(view0.events.filter((event) => event.type === 'conceded')).toHaveLength(1);
    expect(view0.events.filter((event) => event.type === 'match-finished')).toHaveLength(1);
    expect(view0.events.find((event) => event.type === 'conceded')).toMatchObject({ seat: 1 });

    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 1, { type: 'concede' }), 'match-finished');
    expectEngineError(() => turnCommand(engine, 0, { type: 'end-turn' }), 'match-finished');
    expect(engine.version).toBe(version);
    expect(view0.events.filter((event) => event.type === 'match-finished')).toHaveLength(1);
  });

  it('开局阶段也可以认输，待决选择随之作废', () => {
    const [deck0, deck1] = standardDecks(ATTACKER, ATTACKER);
    const script = new OpeningHandScript([deck0, deck1]);
    script.planHand(0, handWith(ATTACKER), prizes([]));
    script.deal(0);
    script.planHand(1, handWith(ATTACKER), prizes([]));
    script.deal(1);
    const engine = new MatchEngine(configFor([deck0, deck1], [0, ...script.outputs]));
    expect(engine.viewFor(0).pendingChoice?.kind).toBe('turn-order');
    turnCommand(engine, 1, { type: 'concede' });
    expect(engine.viewFor(0).result).toMatchObject({ winner: 0, reason: 'concede' });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(engine.viewFor(0).phase).toBe('turn-order');
  });

  it('会话层：同一认输命令重传返回首次结果，新命令得到 match-finished', () => {
    const [deck0, deck1] = standardDecks(ATTACKER, ATTACKER);
    const script = new OpeningHandScript([deck0, deck1]);
    script.planHand(0, handWith(ATTACKER), prizes([]));
    script.deal(0);
    script.planHand(1, handWith(ATTACKER), prizes([]));
    script.deal(1);
    const session = new MatchSession(configFor([deck0, deck1], [0, ...script.outputs]));
    const handle0 = session.handleFor(0);
    const view = session.viewFor(handle0);
    const command = { type: 'concede', commandId: 'c-concede', sessionId: 'session-test', expectedVersion: view.version } as const;
    const first = session.submit(handle0, command);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const replay = session.submit(handle0, command);
    expect(replay).toMatchObject({ ok: true, duplicate: true });
    // 终态后新命令基于当前版本也被拒绝为 match-finished（旧版本则是 stale-version）。
    const current = session.viewFor(handle0).version;
    const second = session.submit(handle0, { ...command, commandId: 'c-concede-2', expectedVersion: current });
    expect(second).toMatchObject({ ok: false, code: 'match-finished' });
    expect(session.viewFor(handle0).events.filter((event) => event.type === 'conceded')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* E. 奖赏隐私                                                          */
/* ------------------------------------------------------------------ */

describe('T09 奖赏身份隐私', () => {
  it('奖赏未被取走前双方载荷不含身份；取走后只进入本人手牌，公开记录不含身份', () => {
    const [deck0, deck1] = decksWith([ATTACKER, PROBE], [VICTIM, VICTIM, PROBE]);
    const engine = openEngine({
      decks: [deck0, deck1],
      hand0: handWith(ATTACKER),
      prizes0: prizes([PROBE]),
      hand1: handWith(VICTIM, [VICTIM]),
      prizes1: prizes([PROBE]),
      bench: { 1: 1 },
    });
    expect(JSON.stringify(engine.viewFor(0))).not.toContain(PROBE);
    expect(JSON.stringify(engine.viewFor(1))).not.toContain(PROBE);
    expect(engine.viewFor(1).you.prizeCount).toBe(6);

    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: ATTACK.heavy, target: { slot: 'active' } });
    expect(JSON.stringify(engine.viewFor(0))).not.toContain(PROBE);
    expect(JSON.stringify(engine.viewFor(1))).not.toContain(PROBE);

    turnCommand(engine, 0, { type: 'take-prizes', choiceId: choiceId(engine.viewFor(0)), prizes: [0] });
    const after = engine.viewFor(0);
    // 取走的奖赏进入本人手牌（私人信息），对手载荷没有身份。
    expect(after.you.hand.some((card) => card.cardId === PROBE)).toBe(true);
    expect(JSON.stringify(engine.viewFor(1))).not.toContain(PROBE);
    const publicEvents = JSON.stringify(after.events);
    expect(publicEvents).not.toContain(PROBE);
    expect(after.events.find((event) => event.type === 'prizes-taken')).toEqual(
      expect.objectContaining({ type: 'prizes-taken', seat: 0, count: 1, remaining: 5 }),
    );
    expect(after.events.find((event) => event.type === 'prizes-taken')).not.toHaveProperty('card');
    expect(after.events.find((event) => event.type === 'prizes-taken')).not.toHaveProperty('cards');
  });
});
