import { describe, expect, it } from 'vitest';
import type {
  CatalogContent,
  MatchClientMessage,
  MatchPendingChoiceView,
  MatchPokemonRef,
  MatchSeat,
  MatchView,
} from '@ptcg/protocol';
import {
  MatchEngine,
  MatchEngineError,
  MatchSession,
  attackEffectKey,
  calculateDamage,
  energyCoversCost,
  type AttackEffectResolver,
  type MatchEngineConfig,
  type MatchSeatHandle,
} from '../src/match.ts';
import {
  OpeningHandScript,
  SequenceRandomSource,
  deckDocumentFromCardsWith,
  fixtureCatalog,
  releaseCatalogContent,
  type FixtureCardInput,
} from './support/matchTestKit.ts';

const BASIC = 'csve1-035'; // 荧光鱼：基础宝可梦，水枪 1 水 10 伤害
const BASIC_B = 'csve1-057'; // 月石：基础宝可梦
const ENERGY = 'cbb1c-1803'; // 基本水能量

function deck(basics: number, energies: number, basicId = BASIC): string[] {
  return [...Array(basics).fill(basicId), ...Array(energies).fill(ENERGY)];
}

function configFor(
  catalog: CatalogContent,
  decks: readonly [readonly string[], readonly string[]],
  outputs: readonly number[],
  attackEffects?: ReadonlyMap<string, AttackEffectResolver>,
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

function scenario(
  decks: readonly [readonly string[], readonly string[]],
  winner: MatchSeat,
  plan: (script: OpeningHandScript) => void,
  attackEffects?: ReadonlyMap<string, AttackEffectResolver>,
  catalog: CatalogContent = releaseCatalogContent(),
): MatchEngine {
  const script = new OpeningHandScript(decks);
  plan(script);
  return new MatchEngine(configFor(catalog, decks, [winner, ...script.outputs], attackEffects));
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

function finishOpening(engine: MatchEngine): void {
  for (let step = 0; step < 100; step += 1) {
    const owner = ([0, 1] as const).find((seat) => engine.viewFor(seat).pendingChoice !== null);
    if (owner === undefined) {
      if (engine.phase !== 'playing') {
        throw new Error(`开局流程在 ${engine.phase} 阶段停滞`);
      }
      return;
    }
    const view = engine.viewFor(owner);
    const choice = view.pendingChoice as MatchPendingChoiceView;
    const command = (extra: Record<string, unknown>): MatchClientMessage =>
      ({
        commandId: `c-open-${owner}-${engine.version}`,
        sessionId: 'session-test',
        expectedVersion: view.version,
        choiceId: choice.choiceId,
        ...extra,
      }) as MatchClientMessage;
    if (choice.kind === 'place-setup') {
      const active = view.you.hand.findIndex((card) => card.isBasicPokemon);
      engine.execute(owner, command({ type: 'place-setup', active, bench: [] }));
      continue;
    }
    if (choice.kind === 'compensation-draw') {
      engine.execute(owner, command({ type: 'resolve-compensation', draw: 0 }));
      continue;
    }
    if (choice.kind === 'place-bench') {
      engine.execute(owner, command({ type: 'place-bench', bench: [] }));
      continue;
    }
    throw new Error(`未预期的待决选择：${choice.kind}`);
  }
  throw new Error('开局流程没有在限定步数内完成');
}

/** 用发行目录完成一局正常开局并进入 playing；先攻由 `winner` 决定。 */
function playingEngine(winner: MatchSeat = 0): MatchEngine {
  const deck0 = deck(6, 14);
  const deck1 = deck(6, 14);
  const engine = scenario([deck0, deck1], winner, (script) => {
    script.planHand(0, [BASIC, BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
  });
  chooseTurnOrder(engine, winner, true);
  finishOpening(engine);
  return engine;
}

function turnCommand(engine: MatchEngine, seat: MatchSeat, command: Record<string, unknown>): void {
  engine.execute(seat, {
    commandId: `c-turn-${seat}-${engine.version}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-test',
    expectedVersion: engine.version,
    ...command,
  } as MatchClientMessage);
}

function firstHandIndex(engine: MatchEngine, seat: MatchSeat, predicate: (card: MatchView['you']['hand'][number]) => boolean): number {
  const index = engine.viewFor(seat).you.hand.findIndex(predicate);
  if (index < 0) {
    throw new Error('手牌中没有满足条件的卡');
  }
  return index;
}

function basicIndex(engine: MatchEngine, seat: MatchSeat): number {
  return firstHandIndex(engine, seat, (card) => card.isBasicPokemon);
}

function energyIndex(engine: MatchEngine, seat: MatchSeat): number {
  return firstHandIndex(engine, seat, (card) => card.kind === 'energy');
}

function endTurn(engine: MatchEngine, seat: MatchSeat): void {
  turnCommand(engine, seat, { type: 'end-turn' });
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
/* A. 回合开始与先攻限制                                                */
/* ------------------------------------------------------------------ */

describe('回合开始与先攻首回合限制（#9）', () => {
  it('每次回合开始必须抽 1 张；结束回合切换到对手并开始其回合', () => {
    const engine = playingEngine(0);
    const v0 = engine.viewFor(0);
    expect(v0.phase).toBe('playing');
    expect(v0.turn).toBe(1);
    expect(v0.activeSeat).toBe(0);
    // 首回合玩家在回合开始时已抽 1 张：7 张初始手牌 − 1 张盖放 + 1 张抽牌。
    expect(v0.you.handCount).toBe(7);
    expect(v0.events.filter((event) => event.type === 'card-drawn' && event.seat === 0)).toHaveLength(1);
    expect(v0.cannotDraw).toBe(false);

    endTurn(engine, 0);
    const v1 = engine.viewFor(1);
    expect(v1.turn).toBe(2);
    expect(v1.activeSeat).toBe(1);
    expect(v1.you.handCount).toBe(7);
    expect(v1.events.filter((event) => event.type === 'turn-ended' && event.seat === 0 && event.turn === 1)).toHaveLength(1);
    expect(v1.events.filter((event) => event.type === 'turn-started' && event.seat === 1 && event.turn === 2)).toHaveLength(1);
    expect(v1.events.filter((event) => event.type === 'card-drawn' && event.seat === 1)).toHaveLength(1);
  });

  it('先攻玩家在自己的最初回合不能使用招式，但可以先附能再被拒绝且状态不变', () => {
    const engine = playingEngine(0);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    expect(engine.viewFor(0).you.energyAttachedThisTurn).toBe(true);

    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } }), 'action-not-allowed');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.active?.damageCounters).toBe(0);
    expect(engine.viewFor(0).events.some((event) => event.type === 'attack-used')).toBe(false);
  });

  it('后攻玩家的最初回合可以使用招式（先攻限制只作用于先攻玩家）', () => {
    const engine = playingEngine(0);
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    // 水枪 10 伤害：打向座位 0 的战斗宝可梦（水属性荧光鱼，弱点是雷，不触发）。
    const v0 = engine.viewFor(0);
    expect(v0.you.active?.damageCounters).toBe(1);
    expect(v0.opponent.active?.damageCounters).toBe(0);
    expect(engine.viewFor(1).activeSeat).toBe(0);
    expect(engine.viewFor(1).turn).toBe(3);
  });

  it('非当前玩家不能执行任何回合动作：not-your-turn 且状态不变', () => {
    const engine = playingEngine(0);
    const version = engine.version;
    for (const command of [
      { type: 'play-basic', handIndex: basicIndex(engine, 1) },
      { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } },
      { type: 'attack', attackIndex: 0, target: { slot: 'active' } },
      { type: 'end-turn' },
    ]) {
      expectEngineError(() => turnCommand(engine, 1, command), 'not-your-turn');
    }
    expect(engine.version).toBe(version);
  });

  it('牌库为空时回合开始无法抽卡：如实标记 cannotDraw，不伪造胜负，也不允许继续操作', () => {
    // 座位 0 共 14 张（先攻回合抽最后 1 张）；座位 1 共 13 张（轮到其回合开始时牌库为空）。
    const deck0 = deck(4, 10);
    const deck1 = deck(4, 9);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [BASIC, BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY], [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY], [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    chooseTurnOrder(engine, 0, true);
    finishOpening(engine);
    expect(engine.viewFor(0).cannotDraw).toBe(false);
    endTurn(engine, 0);
    const blocked = engine.viewFor(1);
    expect(blocked.cannotDraw).toBe(true);
    expect(blocked.activeSeat).toBe(1);
    expect(blocked.events.some((event) => event.type === 'draw-blocked' && event.seat === 1 && event.turn === 2)).toBe(true);
    expect(blocked.phase).toBe('playing');

    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 1, { type: 'end-turn' }), 'action-not-allowed');
    expectEngineError(() => turnCommand(engine, 1, { type: 'play-basic', handIndex: basicIndex(engine, 1) }), 'action-not-allowed');
    expect(engine.version).toBe(version);
    // 没有伪造任何结束/胜负记录。
    expect(JSON.stringify(blocked.events)).not.toContain('match-finished');
    expect(JSON.stringify(blocked.events)).not.toContain('conceded');
  });
});

/* ------------------------------------------------------------------ */
/* B. 基础宝可梦与备战区                                                */
/* ------------------------------------------------------------------ */

describe('基础宝可梦进备战区（#9）', () => {
  it('基础宝可梦可放入备战区并可在一回合内放多只；对手可见身份', () => {
    const engine = playingEngine(0);
    const before = engine.viewFor(0);
    const benchBasic = before.you.hand.findIndex((card) => card.isBasicPokemon);
    expect(benchBasic).toBeGreaterThanOrEqual(0);
    turnCommand(engine, 0, { type: 'play-basic', handIndex: benchBasic });
    expect(engine.viewFor(0).you.bench).toHaveLength(1);
    expect(engine.viewFor(1).opponent.bench).toHaveLength(1);
    expect(engine.viewFor(1).opponent.bench[0]?.card.cardId).toBe(BASIC);
    expect(engine.viewFor(1).opponent.hand).toHaveLength(0); // 隐私：对手仍然没有手牌身份
    expect(engine.viewFor(1).opponent.handCount).toBeGreaterThan(0);

    const secondBasic = engine.viewFor(0).you.hand.findIndex((card) => card.isBasicPokemon);
    turnCommand(engine, 0, { type: 'play-basic', handIndex: secondBasic });
    expect(engine.viewFor(0).you.bench).toHaveLength(2);
  });

  it('非基础宝可梦、越界序号与满 5 张都被拒绝且不改变状态', () => {
    // 手牌 7 张基础宝可梦：盖放 1 张战斗后可以逐一填满 5 张备战，再做上限拒绝。
    const deck0 = deck(10, 10);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [BASIC, BASIC, BASIC, BASIC, BASIC, BASIC, BASIC], [BASIC, BASIC, BASIC, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    chooseTurnOrder(engine, 0, true);
    finishOpening(engine);

    const energySlot = energyIndex(engine, 0);
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'play-basic', handIndex: energySlot }), 'illegal-target');
    expectEngineError(() => turnCommand(engine, 0, { type: 'play-basic', handIndex: 99 }), 'illegal-target');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.bench).toHaveLength(0);

    // 手牌剩余 6 张基础：先放满 5 张。
    for (let i = 0; i < 5; i += 1) {
      turnCommand(engine, 0, { type: 'play-basic', handIndex: basicIndex(engine, 0) });
    }
    expect(engine.viewFor(0).you.bench).toHaveLength(5);
    const fullVersion = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'play-basic', handIndex: basicIndex(engine, 0) }), 'action-not-allowed');
    expect(engine.version).toBe(fullVersion);
    expect(engine.viewFor(0).you.bench).toHaveLength(5);
  });
});

/* ------------------------------------------------------------------ */
/* C. 附能                                                              */
/* ------------------------------------------------------------------ */

describe('每回合附能（#9）', () => {
  it('每个回合只能附着 1 张能量；下一回合重置，对手能看到附着结果', () => {
    const engine = playingEngine(0);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.energies).toHaveLength(1);
    expect(engine.viewFor(1).opponent.active?.energies).toHaveLength(1);
    expect(engine.viewFor(1).opponent.active?.energies[0]?.card.cardId).toBe(ENERGY);

    const version = engine.version;
    const handBefore = engine.viewFor(0).you.handCount;
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } }),
      'action-not-allowed',
    );
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.handCount).toBe(handBefore);

    endTurn(engine, 0);
    // 新回合开始重置双方标记：等待方的旧标记不会残留。
    expect(engine.viewFor(0).you.energyAttachedThisTurn).toBe(false);
    endTurn(engine, 1);
    expect(engine.viewFor(0).you.energyAttachedThisTurn).toBe(false);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.energies).toHaveLength(2);
  });

  it('非法目标不消耗本回合附能次数：失败后仍可合法附着', () => {
    const engine = playingEngine(0);
    const index = energyIndex(engine, 0);
    expectEngineError(
      () => turnCommand(engine, 0, { type: 'attach-energy', handIndex: index, target: { slot: 'bench', index: 0 } }),
      'illegal-target',
    );
    expect(engine.viewFor(0).you.energyAttachedThisTurn).toBe(false);
    // 同一张手牌仍然存在，合法目标可以成功附着。
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: index, target: { slot: 'active' } });
    expect(engine.viewFor(0).you.active?.energies).toHaveLength(1);
  });

  it('能量以外的卡不能附着；特殊能量未接入时以 unsupported-card 拒绝', () => {
    const engine = playingEngine(0);
    const basic = basicIndex(engine, 0);
    expectEngineError(() => turnCommand(engine, 0, { type: 'attach-energy', handIndex: basic, target: { slot: 'active' } }), 'illegal-target');

    // 用夹具目录验证特殊能量：未注册效果时不得近似执行。
    const specialEnergy = fixtureCatalog([
      { id: 'fix-special-energy', nameZh: '特殊水能量', cardClass: 'energy', subtypes: ['特殊能量'], type: '水' },
      { id: 'fix-basic', nameZh: '夹具基础', cardClass: 'pokemon', subtypes: ['基础'], type: '水', hp: 100, retreat: 1 },
    ]);
    const fixtureDeck = ['fix-basic', ...Array(19).fill('fix-special-energy')];
    const engine2 = scenario([fixtureDeck, fixtureDeck], 0, (script) => {
      script.planHand(0, ['fix-basic', 'fix-special-energy', 'fix-special-energy', 'fix-special-energy', 'fix-special-energy', 'fix-special-energy', 'fix-special-energy'], Array(6).fill('fix-special-energy'));
      script.deal(0);
      script.planHand(1, ['fix-basic', ...Array(6).fill('fix-special-energy')], Array(6).fill('fix-special-energy'));
      script.deal(1);
    }, undefined, specialEnergy);
    chooseTurnOrder(engine2, 0, true);
    finishOpening(engine2);
    const specialIndex = firstHandIndex(engine2, 0, (card) => card.nameZh === '特殊水能量');
    expectEngineError(
      () => turnCommand(engine2, 0, { type: 'attach-energy', handIndex: specialIndex, target: { slot: 'active' } }),
      'unsupported-card',
    );
    expect(engine2.viewFor(0).you.active?.energies).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* D. 撤退                                                              */
/* ------------------------------------------------------------------ */

describe('撤退（#9）', () => {
  /** 开局时把第二张基础宝可梦也放到备战区，并附 2 张能量（费用 1 的荧光鱼）。 */
  function retreatReady(winner: MatchSeat = 0): MatchEngine {
    const engine = playingEngine(winner);
    while (engine.viewFor(winner).you.bench.length < 1) {
      const index = engine.viewFor(winner).you.hand.findIndex((card) => card.isBasicPokemon);
      if (index < 0) {
        throw new Error('开局手牌没有可用于备战的基础宝可梦');
      }
      turnCommand(engine, winner, { type: 'play-basic', handIndex: index });
    }
    turnCommand(engine, winner, { type: 'attach-energy', handIndex: energyIndex(engine, winner), target: { slot: 'active' } });
    return engine;
  }

  it('撤退支付所选能量、交换战斗与备战、保留剩余能量与伤害；本回合只能撤退 1 次', () => {
    const engine = retreatReady(0);
    const v = engine.viewFor(0);
    expect(v.you.active?.card.cardId).toBe(BASIC);
    expect(v.you.active?.retreatCost).toBe(1);
    expect(v.you.active?.energies).toHaveLength(1);
    const benchCardId = v.you.bench[0]?.card.cardId;

    turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 0 });
    const after = engine.viewFor(0);
    expect(after.you.active?.card.cardId).toBe(benchCardId);
    expect(after.you.bench).toHaveLength(1);
    expect(after.you.bench[0]?.card.cardId).toBe(BASIC);
    // 支付的能量进弃牌区；撤退的宝可梦保留剩余能量（这里费用用掉了唯一一张）。
    expect(after.you.discard.filter((card) => card.cardId === ENERGY)).toHaveLength(1);
    expect(after.you.bench[0]?.energies).toHaveLength(0);
    expect(after.you.retreatedThisTurn).toBe(true);

    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'retreat', energyIndices: [], benchIndex: 0 }), 'action-not-allowed');
    expect(engine.version).toBe(version);
  });

  it('撤退费用数量、序号越界与重复一律拒绝，且不扣能量也不消耗本回合次数', () => {
    const engine = retreatReady(0);
    const version = engine.version;
    for (const indices of [[], [0, 0], [5], [-1]]) {
      expectEngineError(() => turnCommand(engine, 0, { type: 'retreat', energyIndices: indices, benchIndex: 0 }), 'illegal-cost');
    }
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.active?.energies).toHaveLength(1);
    expect(engine.viewFor(0).you.retreatedThisTurn).toBe(false);
    // 非法目标序号同样拒绝。
    expectEngineError(() => turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 9 }), 'illegal-target');
    expect(engine.version).toBe(version);

    // 失败之后合法的撤退仍然可用。
    turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 0 });
    expect(engine.viewFor(0).you.retreatedThisTurn).toBe(true);
  });

  it('备战区为空时不能撤退', () => {
    const engine = playingEngine(0);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    expectEngineError(() => turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 0 }), 'action-not-allowed');
  });

  it('“无法撤退”与睡眠/麻痹效果阻止撤退，效果清除后恢复（会话级效果接口）', () => {
    const fixture = fixtureCatalog([
      {
        id: 'fix-attacker',
        nameZh: '夹具攻击手',
        cardClass: 'pokemon',
        subtypes: ['基础'],
        type: '水',
        hp: 100,
        retreat: 1,
        attacks: [
          { name: '锁定', cost: ['水'], damage: null, text: '使目标无法撤退或睡眠。' },
          { name: '解除', cost: ['水'], damage: null, text: '清除目标效果。' },
        ],
      },
      { id: 'fix-energy', nameZh: '夹具能量', cardClass: 'energy', subtypes: ['基本能量'], type: '水' },
    ]);
    const fixDeck = ['fix-attacker', ...Array(15).fill('fix-energy')];
    const effects = new Map<string, AttackEffectResolver>([
      [
        attackEffectKey('fx:fixture:夹具攻击手:fix-attacker', '锁定'),
        (ctx) => {
          ctx.setCannotRetreat(ctx.defenderSeat, { slot: 'active' }, true);
        },
      ],
      [
        attackEffectKey('fx:fixture:夹具攻击手:fix-attacker', '解除'),
        (ctx) => {
          ctx.setCannotRetreat(ctx.defenderSeat, { slot: 'active' }, false);
        },
      ],
    ]);
    const engine = scenario(
      [fixDeck, fixDeck],
      0,
      (script) => {
        script.planHand(0, ['fix-attacker', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy'], Array(6).fill('fix-energy'));
        script.deal(0);
        script.planHand(1, ['fix-attacker', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy'], Array(6).fill('fix-energy'));
        script.deal(1);
      },
      effects,
      fixture,
    );
    chooseTurnOrder(engine, 0, true);
    finishOpening(engine);

    // 先攻首回合不能攻击：结束；后攻（座位 1）附着能量并使用「锁定」。
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    // 座位 0 的回合：放一张基础到备战区，尝试撤退被“无法撤退”拒绝。
    const basic = engine.viewFor(0).you.hand.findIndex((card) => card.isBasicPokemon);
    if (basic >= 0) {
      turnCommand(engine, 0, { type: 'play-basic', handIndex: basic });
    }
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    expectEngineError(() => turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 0 }), 'action-not-allowed');
  });

  it('睡眠状态阻止撤退；撤退本身会清除特殊状态与效果标记', () => {
    const fixture = fixtureCatalog([
      {
        id: 'fix-attacker',
        nameZh: '夹具催眠手',
        cardClass: 'pokemon',
        subtypes: ['基础'],
        type: '水',
        hp: 100,
        retreat: 1,
        attacks: [
          { name: '催眠', cost: ['水'], damage: null, text: '使目标睡眠。' },
          { name: '唤醒', cost: [], damage: '10', text: null },
        ],
      },
      { id: 'fix-energy', nameZh: '夹具能量', cardClass: 'energy', subtypes: ['基本能量'], type: '水' },
    ]);
    const fixDeck = ['fix-attacker', ...Array(15).fill('fix-energy')];
    const effects = new Map<string, AttackEffectResolver>([
      [
        attackEffectKey('fx:fixture:夹具催眠手:fix-attacker', '催眠'),
        (ctx) => ctx.addSpecialCondition(ctx.defenderSeat, { slot: 'active' }, '睡眠'),
      ],
    ]);
    const engine = scenario(
      [fixDeck, fixDeck],
      0,
      (script) => {
        script.planHand(0, ['fix-attacker', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy'], Array(6).fill('fix-energy'));
        script.deal(0);
        script.planHand(1, ['fix-attacker', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy', 'fix-energy'], Array(6).fill('fix-energy'));
        script.deal(1);
      },
      effects,
      fixture,
    );
    chooseTurnOrder(engine, 0, true);
    finishOpening(engine);
    endTurn(engine, 0);
    turnCommand(engine, 1, { type: 'attach-energy', handIndex: energyIndex(engine, 1), target: { slot: 'active' } });
    turnCommand(engine, 1, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    // 座位 0 被睡眠；先放备战宝可梦，撤退被拒绝。
    const basic = engine.viewFor(0).you.hand.findIndex((card) => card.isBasicPokemon);
    if (basic >= 0) {
      turnCommand(engine, 0, { type: 'play-basic', handIndex: basic });
    }
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    expectEngineError(() => turnCommand(engine, 0, { type: 'retreat', energyIndices: [0], benchIndex: 0 }), 'action-not-allowed');
  });
});

/* ------------------------------------------------------------------ */
/* E. 招式、伤害顺序与效果接口                                          */
/* ------------------------------------------------------------------ */

describe('招式与伤害计算顺序（#9）', () => {
  const FIXTURE_CARDS: readonly FixtureCardInput[] = [
    {
      id: 'fix-attacker',
      nameZh: '夹具水手',
      cardClass: 'pokemon',
      subtypes: ['基础'],
      type: '水',
      hp: 100,
      retreat: 1,
      attacks: [{ name: '水炮', cost: ['水'], damage: '40' }],
    },
    {
      id: 'fix-weak-resist',
      nameZh: '夹具双抗',
      cardClass: 'pokemon',
      subtypes: ['基础'],
      type: '雷',
      hp: 120,
      weakness: '水×2',
      resistance: '水-30',
      retreat: 1,
      attacks: [],
    },
    {
      id: 'fix-resist-only',
      nameZh: '夹具抵抗',
      cardClass: 'pokemon',
      subtypes: ['基础'],
      type: '雷',
      hp: 120,
      resistance: '水-40',
      retreat: 1,
      attacks: [],
    },
    {
      id: 'fix-effect',
      nameZh: '夹具效果',
      cardClass: 'pokemon',
      subtypes: ['基础'],
      type: '水',
      hp: 100,
      retreat: 1,
      attacks: [{ name: '附加效果', cost: ['水'], damage: '10', text: '抽 1 张卡。' }],
    },
    {
      id: 'fix-energy',
      nameZh: '夹具能量',
      cardClass: 'energy',
      subtypes: ['基本能量'],
      type: '水',
    },
  ];

  function fixtureEngine(
    defenderId: string,
    attackEffects?: ReadonlyMap<string, AttackEffectResolver>,
  ): MatchEngine {
    const catalog = fixtureCatalog(FIXTURE_CARDS);
    const deck0 = ['fix-attacker', ...Array(15).fill('fix-energy')];
    const deck1 = [defenderId, ...Array(15).fill('fix-energy')];
    const engine = scenario(
      [deck0, deck1],
      0,
      (script) => {
        script.planHand(0, ['fix-attacker', ...Array(6).fill('fix-energy')], Array(6).fill('fix-energy'));
        script.deal(0);
        script.planHand(1, [defenderId, ...Array(6).fill('fix-energy')], Array(6).fill('fix-energy'));
        script.deal(1);
      },
      attackEffects,
      catalog,
    );
    chooseTurnOrder(engine, 0, true);
    finishOpening(engine);
    return engine;
  }

  /** 座位 0 先攻：结束回合 → 座位 1 结束回合 → 座位 0 附能并使用基础伤害招式。 */
  function attackAfterFirstTurn(engine: MatchEngine): void {
    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
  }

  it('费用不足、目标非法与先攻限制都在使用招式前被拒绝', () => {
    const engine = fixtureEngine('fix-weak-resist');
    // 先攻首回合不能使用招式（哪怕有费用）。
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } }), 'action-not-allowed');
    endTurn(engine, 0);
    endTurn(engine, 1);
    // 费用不足：没有附着能量。
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } }), 'insufficient-energy');
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: 9, target: { slot: 'active' } }), 'illegal-target');
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'bench', index: 0 } }), 'illegal-target');
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'bench', index: 9 } }), 'illegal-target');
  });

  it('基础伤害 → 弱点（×2）→ 抵抗（−30）的顺序：40 水打 水×2/水−30 得 50', () => {
    const engine = fixtureEngine('fix-weak-resist');
    attackAfterFirstTurn(engine);
    const defender = engine.viewFor(1).you.active;
    expect(defender?.damageCounters).toBe(5);
    const attackEvent = engine.viewFor(1).events.find((event) => event.type === 'attack-used');
    expect(attackEvent).toMatchObject({ attackName: '水炮', baseDamage: 40, damage: 50 });
    // 若错误地先算抵抗再算弱点会得到 (40−30)×2 = 20，必须排除。
    expect(calculateDamage(40, '水', '水×2', '水-30')).toBe(50);
    expect(calculateDamage(40, '水', '水×2', null)).toBe(80);
    expect(calculateDamage(40, '水', null, '水-30')).toBe(10);
    expect(calculateDamage(40, '雷', '水×2', '水-30')).toBe(40);
  });

  it('抵抗令最终伤害 ≤ 0 时不放置伤害指示物，但记录 attack-used', () => {
    const engine = fixtureEngine('fix-resist-only');
    attackAfterFirstTurn(engine);
    expect(engine.viewFor(1).you.active?.damageCounters).toBe(0);
    const events = engine.viewFor(1).events;
    expect(events.find((event) => event.type === 'attack-used')).toMatchObject({ baseDamage: 40, damage: 0 });
    expect(events.filter((event) => event.type === 'damage-counters-placed')).toHaveLength(0);
  });

  it('使用招式不消耗能量，使用后回合结束并由对手开始回合', () => {
    const engine = fixtureEngine('fix-weak-resist');
    attackAfterFirstTurn(engine);
    // 攻击者的能量仍在身上。
    expect(engine.viewFor(0).you.active?.energies).toHaveLength(1);
    const v0 = engine.viewFor(0);
    expect(v0.activeSeat).toBe(1);
    expect(v0.turn).toBe(4);
    expect(v0.events.some((event) => event.type === 'turn-ended' && event.seat === 0 && event.turn === 3)).toBe(true);
    expect(v0.events.some((event) => event.type === 'turn-started' && event.seat === 1 && event.turn === 4)).toBe(true);
  });

  it('未注册说明文的招式一律 unsupported-card，不按近似伤害执行', () => {
    const catalog = fixtureCatalog(FIXTURE_CARDS);
    const deck0 = ['fix-effect', ...Array(15).fill('fix-energy')];
    const deck1 = ['fix-weak-resist', ...Array(15).fill('fix-energy')];
    const engine2 = scenario(
      [deck0, deck1],
      0,
      (script) => {
        script.planHand(0, ['fix-effect', ...Array(6).fill('fix-energy')], Array(6).fill('fix-energy'));
        script.deal(0);
        script.planHand(1, ['fix-weak-resist', ...Array(6).fill('fix-energy')], Array(6).fill('fix-energy'));
        script.deal(1);
      },
      undefined,
      catalog,
    );
    chooseTurnOrder(engine2, 0, true);
    finishOpening(engine2);
    endTurn(engine2, 0);
    endTurn(engine2, 1);
    turnCommand(engine2, 0, { type: 'attach-energy', handIndex: energyIndex(engine2, 0), target: { slot: 'active' } });
    const version = engine2.version;
    expectEngineError(() => turnCommand(engine2, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } }), 'unsupported-card');
    expect(engine2.version).toBe(version);
    expect(engine2.viewFor(1).you.active?.damageCounters).toBe(0);
  });

  it('会话级效果接口：dealDamage 走弱点/抵抗，placeDamageCounters 直接放置', () => {
    const catalog = fixtureCatalog(FIXTURE_CARDS);
    const dealEffects = new Map<string, AttackEffectResolver>([
      [attackEffectKey('fx:fixture:夹具效果:fix-effect', '附加效果'), (ctx) => ctx.dealDamage()],
    ]);
    const directEffects = new Map<string, AttackEffectResolver>([
      [attackEffectKey('fx:fixture:夹具效果:fix-effect', '附加效果'), (ctx) => ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'active' }, 2)],
    ]);
    const build = (effects: ReadonlyMap<string, AttackEffectResolver>): MatchEngine => {
      const deck0 = ['fix-effect', ...Array(15).fill('fix-energy')];
      const deck1 = ['fix-weak-resist', ...Array(15).fill('fix-energy')];
      const engine = scenario(
        [deck0, deck1],
        0,
        (script) => {
          script.planHand(0, ['fix-effect', ...Array(6).fill('fix-energy')], Array(6).fill('fix-energy'));
          script.deal(0);
          script.planHand(1, ['fix-weak-resist', ...Array(6).fill('fix-energy')], Array(6).fill('fix-energy'));
          script.deal(1);
        },
        effects,
        catalog,
      );
      chooseTurnOrder(engine, 0, true);
      finishOpening(engine);
      endTurn(engine, 0);
      endTurn(engine, 1);
      turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
      turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
      return engine;
    };
    // dealDamage：10 基础 → 弱点 ×2 → 抵抗 −30 = 0，不放置指示物。
    const dealt = build(dealEffects);
    expect(dealt.viewFor(1).you.active?.damageCounters).toBe(0);
    // placeDamageCounters：直接放置 2 个指示物，无视弱点/抵抗。
    const direct = build(directEffects);
    expect(direct.viewFor(1).you.active?.damageCounters).toBe(2);
    expect(direct.viewFor(1).events.find((event) => event.type === 'damage-counters-placed')).toMatchObject({
      seat: 0,
      targetSeat: 1,
      count: 2,
    });
  });

  it('效果接口变更在整条命令成功后才应用：中途报错不留下部分状态', () => {
    const catalog = fixtureCatalog(FIXTURE_CARDS);
    const effects = new Map<string, AttackEffectResolver>([
      [
        attackEffectKey('fx:fixture:夹具水手:fix-attacker', '水炮'),
        (ctx) => {
          // 第一步合法、第二步引用不存在的备战目标：整条命令不得留下第一步的伤害。
          ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'active' }, 2);
          ctx.placeDamageCounters(ctx.defenderSeat, { slot: 'bench', index: 99 }, 1);
        },
      ],
    ]);
    const engine = fixtureEngine('fix-weak-resist', effects);
    endTurn(engine, 0);
    endTurn(engine, 1);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    const version = engine.version;
    expectEngineError(() => turnCommand(engine, 0, { type: 'attack', attackIndex: 0, target: { slot: 'active' } }), 'illegal-target');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(1).you.active?.damageCounters).toBe(0);
    expect(engine.viewFor(1).events.some((event) => event.type === 'damage-counters-placed')).toBe(false);
    // 招式未生效，回合也没有结束。
    expect(engine.viewFor(0).activeSeat).toBe(0);
    expect(engine.viewFor(0).turn).toBe(3);
    expect(catalog.cards.some((card) => card.id === 'fix-attacker')).toBe(true);
  });

  it('纯函数：费用覆盖（无色由任意能量满足，同属性必须匹配）与伤害纯函数输入校验', () => {
    expect(energyCoversCost(['水'], ['水'])).toBe(true);
    expect(energyCoversCost(['水'], ['火'])).toBe(false);
    expect(energyCoversCost(['无', '无'], ['水', '火'])).toBe(true);
    expect(energyCoversCost(['无', '无', '无'], ['水', '火'])).toBe(false);
    expect(energyCoversCost(['水', '无'], ['水', '火'])).toBe(true);
    expect(energyCoversCost(['水'], [null])).toBe(false);
    expect(calculateDamage(10, '水', null, '水-30')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* F. 会话：认证、幂等、版本与原子失败                                   */
/* ------------------------------------------------------------------ */

describe('对局会话：回合命令的认证、去重与版本（#9）', () => {
  function sessionWithPlaying(): { session: MatchSession; handle0: MatchSeatHandle } {
    const deck0 = deck(6, 14);
    const deck1 = deck(6, 14);
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [0];
    script.planHand(0, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
    outputs.push(...script.outputs);
    const session = new MatchSession(configFor(releaseCatalogContent(), [deck0, deck1], outputs));
    const handle0 = session.handleFor(0);
    const view = session.viewFor(handle0);
    const choose: MatchClientMessage = {
      type: 'choose-turn-order',
      commandId: 'c-choose',
      sessionId: 'session-test',
      expectedVersion: view.version,
      choiceId: choiceId(view),
      goFirst: true,
    };
    session.submit(handle0, choose);
    // 用会话驱动完成开局（两侧都只放战斗宝可梦）。
    for (let step = 0; step < 40 && session.viewFor(handle0).phase !== 'playing'; step += 1) {
      for (const seat of [0, 1] as const) {
        const handle = session.handleFor(seat);
        const seatView = session.viewFor(handle);
        const choice = seatView.pendingChoice;
        if (choice === null) {
          continue;
        }
        if (choice.kind === 'place-setup') {
          session.submit(handle, {
            type: 'place-setup',
            commandId: `c-setup-${seat}-${session.version}`,
            sessionId: 'session-test',
            expectedVersion: seatView.version,
            choiceId: choice.choiceId,
            active: seatView.you.hand.findIndex((card) => card.isBasicPokemon),
            bench: [],
          } as MatchClientMessage);
        } else if (choice.kind === 'place-bench') {
          session.submit(handle, {
            type: 'place-bench',
            commandId: `c-bench-${seat}-${session.version}`,
            sessionId: 'session-test',
            expectedVersion: seatView.version,
            choiceId: choice.choiceId,
            bench: [],
          } as MatchClientMessage);
        } else if (choice.kind === 'compensation-draw') {
          session.submit(handle, {
            type: 'resolve-compensation',
            commandId: `c-comp-${seat}-${session.version}`,
            sessionId: 'session-test',
            expectedVersion: seatView.version,
            choiceId: choice.choiceId,
            draw: 0,
          } as MatchClientMessage);
        }
      }
    }
    expect(session.viewFor(handle0).phase).toBe('playing');
    return { session, handle0 };
  }

  it('相同命令 ID 的精确重传只执行一次；换载荷得到 command-id-reused', () => {
    const { session, handle0 } = sessionWithPlaying();
    const view = session.viewFor(handle0);
    const handIndex = view.you.hand.findIndex((card) => card.kind === 'energy');
    const command: MatchClientMessage = {
      type: 'attach-energy',
      commandId: 'c-attach-dup',
      sessionId: 'session-test',
      expectedVersion: view.version,
      handIndex,
      target: { slot: 'active' },
    };
    const first = session.submit(handle0, command);
    expect(first.ok).toBe(true);
    const versionAfter = session.version;
    const replay = session.submit(handle0, command);
    expect(replay).toMatchObject({ ok: true, duplicate: true, version: versionAfter });
    expect(session.viewFor(handle0).you.active?.energies).toHaveLength(1);

    const reused = session.submit(handle0, { ...command, target: { slot: 'bench', index: 0 } });
    expect(reused).toMatchObject({ ok: false, code: 'command-id-reused' });
    expect(session.version).toBe(versionAfter);
  });

  it('旧版本与并发第二条命令被拒绝且状态只应用一次', () => {
    const { session, handle0 } = sessionWithPlaying();
    const view = session.viewFor(handle0);
    const handIndex = view.you.hand.findIndex((card) => card.kind === 'energy');
    const first: MatchClientMessage = {
      type: 'play-basic',
      commandId: 'c-basic-1',
      sessionId: 'session-test',
      expectedVersion: view.version,
      handIndex: view.you.hand.findIndex((card) => card.isBasicPokemon),
    };
    expect(session.submit(handle0, first).ok).toBe(true);
    const afterFirst = session.version;
    // 第二条命令仍以旧版本提交：整条拒绝，状态不变。
    const second = { ...first, commandId: 'c-basic-2', handIndex } as MatchClientMessage;
    expect(session.submit(handle0, second)).toMatchObject({ ok: false, code: 'stale-version' });
    expect(session.version).toBe(afterFirst);
    expect(session.viewFor(handle0).you.bench).toHaveLength(1);
  });

  it('未认证句柄拿不到任何视图，即使是失败的回合命令', () => {
    const { session, handle0 } = sessionWithPlaying();
    const view = session.viewFor(handle0);
    const secret = view.you.hand[0]?.cardId as string;
    const result = session.submit(
      { seat: 0, token: 'forged' } as never,
      {
        type: 'end-turn',
        commandId: 'c-forged-turn',
        sessionId: 'session-test',
        expectedVersion: view.version,
      } as MatchClientMessage,
    );
    expect(result).toMatchObject({ ok: false, code: 'not-in-match' });
    if (!result.ok) {
      expect('view' in result).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('"hand"');
  });
});

/* ------------------------------------------------------------------ */
/* G. 隐私投影                                                          */
/* ------------------------------------------------------------------ */

describe('回合内隐藏信息投影（#9）', () => {
  it('对手始终没有手牌身份；公开区能量/伤害/招式可见且无内部实例 ID', () => {
    const engine = playingEngine(0);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    const v = engine.viewFor(1);
    const serialized = JSON.stringify(v);
    expect(v.opponent.hand).toHaveLength(0);
    expect(v.opponent.handCount).toBeGreaterThan(0);
    expect(v.opponent.active?.energies).toHaveLength(1);
    expect(v.opponent.active?.attacks.length).toBeGreaterThan(0);
    expect(serialized).not.toContain('instanceId');
    expect(serialized).not.toContain('deckOrder');
    // 对手的牌库/奖赏只有张数。
    expect(v.opponent.deckCount).toBeGreaterThan(0);
    expect(v.opponent.prizeCount).toBe(6);
    // 本人视图包含完整手牌，能量卡可用于附能选择。
    expect(v.you.hand.length).toBe(v.you.handCount);
    expect(v.you.hand.some((card) => card.kind === 'energy')).toBe(true);
  });

  it('公开记录只包含合法公开信息：抽牌只有张数，附能/伤害是公开状态', () => {
    const engine = playingEngine(0);
    turnCommand(engine, 0, { type: 'attach-energy', handIndex: energyIndex(engine, 0), target: { slot: 'active' } });
    const events = engine.viewFor(1).events;
    const drawn = events.find((event) => event.type === 'card-drawn');
    expect(drawn).toMatchObject({ type: 'card-drawn', seat: 0, count: 1 });
    expect('cards' in (drawn as object)).toBe(false);
    const attached = events.find((event) => event.type === 'energy-attached');
    expect(attached).toMatchObject({ type: 'energy-attached', seat: 0, target: { slot: 'active' } });
  });
});
