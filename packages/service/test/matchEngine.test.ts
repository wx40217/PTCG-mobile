import { describe, expect, it } from 'vitest';
import type { MatchClientMessage, MatchPendingChoiceView, MatchSeat, MatchView } from '@ptcg/protocol';
import { MatchEngineError, MatchSession, MatchEngine, type MatchEngineConfig } from '../src/match.ts';
import {
  OpeningHandScript,
  SequenceRandomSource,
  countBasicPokemon,
  deckDocumentFromCards,
  releaseCatalogContent,
} from './support/matchTestKit.ts';

const BASIC = 'csve1-035'; // 荧光鱼：基础宝可梦
const BASIC_B = 'csve1-057'; // 月石：基础宝可梦
const ENERGY = 'cbb1c-1803'; // 基本水能量（同名基本能量不限张数）

function deck(basics: number, energies: number, basicId = BASIC): string[] {
  return [...Array(basics).fill(basicId), ...Array(energies).fill(ENERGY)];
}

function engineConfig(decks: readonly [string[], string[]], outputs: readonly number[]): MatchEngineConfig {
  return {
    sessionId: 'session-test',
    decks: [deckDocumentFromCards(decks[0]), deckDocumentFromCards(decks[1])],
    nicknames: ['小智', '小茂'],
    catalog: releaseCatalogContent(),
    random: new SequenceRandomSource(outputs),
  };
}

/**
 * 用可计划随机源构造一局；`plan` 必须按引擎实际消费顺序调用 `planHand`/`deal`。
 * 测试确定性只通过服务端内部随机源注入，不经过任何客户端可见的种子或牌序。
 */
function scenario(
  decks: readonly [string[], string[]],
  winner: 0 | 1,
  plan: (script: OpeningHandScript) => void,
): MatchEngine {
  const script = new OpeningHandScript(decks);
  plan(script);
  return new MatchEngine(engineConfig(decks, [winner, ...script.outputs]));
}

/** 双方各带 2 张基础宝可梦的正常发牌。 */
function normalScript(winner: 0 | 1 = 0): { engine: MatchEngine } {
  const deck0 = deck(6, 14);
  const deck1 = deck(6, 14);
  const script = new OpeningHandScript([deck0, deck1]);
  script.planHand(0, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
  script.deal(0);
  script.planHand(1, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
  script.deal(1);
  return { engine: new MatchEngine(engineConfig([deck0, deck1], [winner, ...script.outputs])) };
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
  } satisfies MatchClientMessage);
}

function placeSetup(engine: MatchEngine, seat: MatchSeat, active: number, bench: readonly number[]): void {
  const view = engine.viewFor(seat);
  engine.execute(seat, {
    type: 'place-setup',
    commandId: `c-place-${seat}-${engine.version}`,
    sessionId: 'session-test',
    expectedVersion: view.version,
    choiceId: choiceId(view),
    active,
    bench,
  } satisfies MatchClientMessage);
}

function placeBench(engine: MatchEngine, seat: MatchSeat, bench: readonly number[]): void {
  const view = engine.viewFor(seat);
  engine.execute(seat, {
    type: 'place-bench',
    commandId: `c-bench-${seat}-${engine.version}`,
    sessionId: 'session-test',
    expectedVersion: view.version,
    choiceId: choiceId(view),
    bench,
  } satisfies MatchClientMessage);
}

function resolveCompensation(engine: MatchEngine, seat: MatchSeat, draw: number): void {
  const view = engine.viewFor(seat);
  engine.execute(seat, {
    type: 'resolve-compensation',
    commandId: `c-draw-${seat}-${engine.version}`,
    sessionId: 'session-test',
    expectedVersion: view.version,
    choiceId: choiceId(view),
    draw,
  } satisfies MatchClientMessage);
}

/** 自动处理任何待决选择直到进入 playing，用于只关心最终状态的测试。 */
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
    if (choice.kind === 'place-setup') {
      const active = view.you.hand.findIndex((card) => card.isBasicPokemon);
      placeSetup(engine, owner, active, []);
      continue;
    }
    if (choice.kind === 'compensation-draw') {
      resolveCompensation(engine, owner, 0);
      continue;
    }
    if (choice.kind === 'place-bench') {
      placeBench(engine, owner, []);
      continue;
    }
    throw new Error(`未预期的待决选择：${choice.kind}`);
  }
  throw new Error('开局流程没有在限定步数内完成');
}

/** 在无补抽的正常局面上完成双方放置，进入 playing。 */
function completeNormalSetup(engine: MatchEngine): void {
  finishOpening(engine);
}

describe('开局引擎：先后攻选择', () => {
  it('服务端随机决定获选玩家；只有获选玩家能明确选择，先攻顺序按选择决定', () => {
    const { engine } = normalScript(0);
    expect(engine.viewFor(0).phase).toBe('turn-order');
    expect(engine.viewFor(0).pendingChoice?.kind).toBe('turn-order');
    expect(engine.viewFor(1).pendingChoice).toBeNull();
    expect(engine.viewFor(1).waitingForOpponentChoice).toBe(true);

    // 未获选的座位不能代替选择：用当前唯一的 choiceId 从错误座位提交。
    expect(() =>
      engine.execute(1, {
        type: 'choose-turn-order',
        commandId: 'c-bad-seat',
        sessionId: 'session-test',
        expectedVersion: engine.version,
        choiceId: choiceId(engine.viewFor(0)),
        goFirst: true,
      }),
    ).toThrowError(MatchEngineError);

    chooseTurnOrder(engine, 0, false);
    expect(engine.viewFor(0).firstSeat).toBe(1);
    expect(engine.viewFor(0).events.some((event) => event.type === 'turn-order-chosen' && event.seat === 0 && event.goFirst === false)).toBe(true);
    // 首攻为后手座位，先手座位先放置。
    expect(engine.viewFor(1).pendingChoice?.kind).toBe('place-setup');
    expect(engine.viewFor(1).pendingChoice?.seat).toBe(1);
  });

  it('获胜者选择后随机流只由服务端消费：手牌与先后攻事件按服务端随机产生', () => {
    const { engine } = normalScript(0);
    const before = engine.viewFor(0);
    chooseTurnOrder(engine, 0, true);
    const after = engine.viewFor(0);
    expect(after.version).toBe(before.version + 1);
    expect(after.you.handCount).toBe(7);
  });
});

describe('开局引擎：正常开局', () => {
  it('洗牌发 7 张、放奖赏、盖放、公开翻面并只进入一次首回合', () => {
    const { engine } = normalScript(0);
    chooseTurnOrder(engine, 0, true);
    const setupView = engine.viewFor(0);
    expect(setupView.phase).toBe('setup');
    expect(setupView.you.handCount).toBe(7);
    expect(setupView.you.prizeCount).toBe(0);
    expect(setupView.you.setupPlaced).toBe(false);

    placeSetup(engine, 0, 0, [1]);
    // 对手还没有放置：对手的初始宝可梦身份不可见。
    const waiting = engine.viewFor(1);
    expect(waiting.opponent.setupPlaced).toBe(true);
    expect(waiting.opponent.active).toBeNull();
    expect(waiting.opponent.bench).toHaveLength(0);

    placeSetup(engine, 1, 0, [1]);
    const playing0 = engine.viewFor(0);
    const playing1 = engine.viewFor(1);
    expect(playing0.phase).toBe('playing');
    expect(playing0.turn).toBe(1);
    expect(playing0.activeSeat).toBe(0);
    // 双方各盖放 2 张（战斗 + 1 备战），首回合玩家回合开始再抽 1 张。
    expect(playing0.you.handCount).toBe(6);
    expect(playing1.you.handCount).toBe(5);
    expect(playing0.you.prizeCount).toBe(6);
    expect(playing1.you.prizeCount).toBe(6);
    expect(playing0.you.deckCount).toBe(20 - 7 - 6 - 1);
    expect(playing1.you.deckCount).toBe(20 - 7 - 6);
    // 公开翻面后双方初始宝可梦可见。
    expect(playing0.opponent.active).not.toBeNull();
    expect(playing0.opponent.bench).toHaveLength(1);
    expect(playing0.you.active?.card.cardId).toBe(BASIC);
    const started = playing0.events.filter((event) => event.type === 'turn-started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ seat: 0, turn: 1 });
    // 没有重抽、没有补抽。
    expect(playing0.events.some((event) => event.type === 'mulligan')).toBe(false);
    expect(playing0.events.some((event) => event.type === 'compensation-declared')).toBe(false);
  });

  it('首回合后没有待决选择；后续开局命令被拒绝且不改变版本', () => {
    const { engine } = normalScript(0);
    chooseTurnOrder(engine, 0, true);
    completeNormalSetup(engine);
    const version = engine.version;
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(() =>
      engine.execute(0, {
        type: 'choose-turn-order',
        commandId: 'c-late',
        sessionId: 'session-test',
        expectedVersion: version,
        choiceId: 'choice-any',
        goFirst: true,
      }),
    ).toThrowError(MatchEngineError);
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
  });
});

describe('开局引擎：重抽与补抽（冻结 G5/G7）', () => {
  it('单方重抽：对手先完成到 7. 才公开；补抽上限为该次 5.d.，可放弃 0 张', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      // 座位 0 第一次没有基础宝可梦，重抽后成功。
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
    });
    chooseTurnOrder(engine, 0, true);

    // G5.b.：有基础宝可梦的对手先得到盖放选择；此时无基础方的手牌尚未展示。
    const opponentPlace = engine.viewFor(1);
    expect(opponentPlace.pendingChoice).toMatchObject({ kind: 'place-setup', seat: 1 });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(opponentPlace.events.some((event) => event.type === 'mulligan')).toBe(false);
    placeSetup(engine, 1, 0, []);

    // 对手提交后才轮到无基础方展示并重抽，然后才拿到盖放选择。
    const afterReveal = engine.viewFor(0);
    expect(afterReveal.pendingChoice).toMatchObject({ kind: 'place-setup', seat: 0 });
    const mulligans = afterReveal.events.filter((event) => event.type === 'mulligan');
    expect(mulligans).toHaveLength(1);
    expect(mulligans[0]).toMatchObject({ seat: 0, count: 1, shared: false });
    expect((mulligans[0] as { cards: readonly unknown[] }).cards).toHaveLength(7);
    expect(afterReveal.you.mulligans).toBe(1);
    expect(afterReveal.you.soloMulligans).toBe(1);
    // 对手在 5.b. 已完成到 7.：奖赏卡已放置，属于公开张数。
    expect(engine.viewFor(1).you.prizeCount).toBe(6);
    placeSetup(engine, 0, 0, []);

    // 座位 0 没有单独重抽过：0 不产生补抽；座位 1 的上限为座位 0 的 5.d. 次数。
    const compensation = engine.viewFor(1);
    expect(compensation.pendingChoice).toMatchObject({ kind: 'compensation-draw', min: 0, max: 1, seat: 1 });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(engine.viewFor(0).waitingForOpponentChoice).toBe(true);

    const version = engine.version;
    const handBefore = engine.viewFor(1).you.handCount;
    resolveCompensation(engine, 1, 0);
    const resolved = engine.viewFor(1);
    expect(resolved.you.handCount).toBe(handBefore);
    expect(resolved.events.filter((event) => event.type === 'compensation-declared')).toHaveLength(1);
    expect(resolved.phase).toBe('playing');
    expect(engine.version).toBe(version + 1);
  });

  it('单方重抽：补抽到的基础宝可梦可通过最终备战选择盖放，翻面前对对手隐藏', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
    });
    chooseTurnOrder(engine, 0, true);
    placeSetup(engine, 1, 0, []);
    placeSetup(engine, 0, 0, []);

    // 双方放完奖赏卡后，座位 1 的剩余牌库顶是一张基础宝可梦。
    const compensation = engine.viewFor(1);
    expect(compensation.pendingChoice).toMatchObject({ kind: 'compensation-draw', max: 1 });
    resolveCompensation(engine, 1, 1);
    const benchChoice = engine.viewFor(1);
    expect(benchChoice.pendingChoice).toMatchObject({ kind: 'place-bench', candidates: [6], max: 1 });
    // 对手仍看不到这张盖放的基础宝可梦。
    const opponentView = engine.viewFor(0);
    expect(opponentView.opponent.active).toBeNull();
    expect(opponentView.opponent.bench).toHaveLength(0);
    expect(opponentView.events.some((event) => event.type === 'compensation-declared' && event.count === 1)).toBe(true);

    placeBench(engine, 1, [6]);
    const playing = engine.viewFor(0);
    expect(playing.phase).toBe('playing');
    expect(playing.opponent.bench).toHaveLength(1);
    expect(playing.opponent.bench.map((entry) => entry.card.cardId)).toContain(BASIC);
    expect(playing.events.some((event) => event.type === 'bench-placed' && event.seat === 1 && event.count === 1)).toBe(true);
  });

  it('单方连续重抽：第二次跳过 5.b.，对手补抽上限为 2 且不会重复放奖赏卡', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.returnHand(0);
      script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
    });
    chooseTurnOrder(engine, 0, true);
    placeSetup(engine, 1, 0, []);
    // 第二次重抽跳过 5.b.：座位 1 的奖赏卡只放一次，两次 5.d. 都是公开记录。
    const afterReveals = engine.viewFor(0);
    expect(afterReveals.events.filter((event) => event.type === 'mulligan')).toHaveLength(2);
    expect(afterReveals.events.filter((event) => event.type === 'prizes-placed')).toHaveLength(1);
    expect(afterReveals.you.mulligans).toBe(2);
    expect(afterReveals.you.soloMulligans).toBe(2);
    placeSetup(engine, 0, 0, []);
    expect(engine.viewFor(1).pendingChoice).toMatchObject({ kind: 'compensation-draw', max: 2, seat: 1 });
  });

  it('双方共同重抽（5.a.）：共同重洗不计任何一方 5.d.，补抽上限为 0', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(2, 18, BASIC_B);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.returnHand(1);
      script.planHand(1, [BASIC_B, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    chooseTurnOrder(engine, 0, true);
    const afterJoint = engine.viewFor(0);
    const mulligans = afterJoint.events.filter((event) => event.type === 'mulligan');
    expect(mulligans).toHaveLength(2);
    expect(mulligans.every((event) => event.type === 'mulligan' && event.shared)).toBe(true);
    expect(afterJoint.you.mulligans).toBe(1);
    expect(afterJoint.you.soloMulligans).toBe(0);
    expect(afterJoint.opponent.mulligans).toBe(1);
    expect(afterJoint.opponent.soloMulligans).toBe(0);

    placeSetup(engine, 0, 0, []);
    placeSetup(engine, 1, 0, []);
    // 双方都没有执行 5.d.：没有任何补抽选择，直接 playing。
    expect(engine.viewFor(0).phase).toBe('playing');
    expect(engine.viewFor(0).events.some((event) => event.type === 'compensation-declared')).toBe(false);
    expect(engine.viewFor(1).pendingChoice).toBeNull();
  });

  it('共同重抽后再发生单方重抽：只有对手单独重抽的次数进入补抽（差值）', () => {
    const deck0 = deck(2, 25);
    const deck1 = deck(2, 25, BASIC_B);
    const engine = scenario([deck0, deck1], 0, (script) => {
      // 第一轮：双方都没有基础 → 共同重洗；座位 0 仍没有，座位 1 成功。
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.returnHand(1);
      script.planHand(1, [BASIC_B, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      // 第二轮：只有座位 0 没有基础 → 单方 5.d.。
      script.returnHand(0);
      script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
    });
    chooseTurnOrder(engine, 0, true);

    // 共同重洗后只有座位 0 无基础：对手先到 7.，然后座位 0 单独重抽。
    const opponentPlace = engine.viewFor(1);
    expect(opponentPlace.pendingChoice).toMatchObject({ kind: 'place-setup', seat: 1 });
    placeSetup(engine, 1, 0, []);
    placeSetup(engine, 0, 0, []);

    const jointView = engine.viewFor(0);
    expect(jointView.you.mulligans).toBe(2);
    expect(jointView.you.soloMulligans).toBe(1);
    expect(jointView.opponent.mulligans).toBe(1);
    expect(jointView.opponent.soloMulligans).toBe(0);
    // 座位 0 的补抽上限来自座位 1 的 5.d. 次数 = 0；
    // 座位 1 的补抽上限来自座位 0 的 5.d. 次数 = 1（差值正确）。
    expect(engine.viewFor(1).pendingChoice).toMatchObject({ kind: 'compensation-draw', min: 0, max: 1, seat: 1 });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
  });

  it('G6：零补抽时仍可在对战开始前盖放剩余基础宝可梦；战斗不变且备战上限 5', () => {
    const deck0 = deck(6, 14);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [BASIC, BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    chooseTurnOrder(engine, 0, true);
    placeSetup(engine, 0, 0, []);
    placeSetup(engine, 1, 0, []);
    const seat0Choice = engine.viewFor(0);
    expect(seat0Choice.pendingChoice).toMatchObject({ kind: 'place-bench', min: 0, max: 2, candidates: [0, 1] });
    // 数字超出候选或上限、重复、非基础序号都必须被拒绝且不改版本。
    const version = engine.version;
    expect(() => placeBench(engine, 0, [0, 1, 2])).toThrowError(MatchEngineError);
    expect(() => placeBench(engine, 0, [99])).toThrowError(MatchEngineError);
    expect(() => placeBench(engine, 0, [0, 0])).toThrowError(MatchEngineError);
    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.bench).toHaveLength(0);

    placeBench(engine, 0, [1]);
    const afterSelf = engine.viewFor(0);
    expect(afterSelf.you.bench).toHaveLength(1);
    expect(afterSelf.you.active?.card.cardId).toBe(BASIC);
    // 5 张手牌 + 公开翻面后首回合开始的 1 张抽牌。
    expect(afterSelf.you.handCount).toBe(6);
    // 座位 1 手上没有剩余基础宝可梦：最终阶段直接跳过，进入公开翻面。
    expect(engine.viewFor(1).pendingChoice).toBeNull();
    expect(engine.viewFor(1).phase).toBe('playing');
  });

  it('非法补抽数量被拒绝且不改变状态', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
    });
    chooseTurnOrder(engine, 0, true);
    placeSetup(engine, 1, 0, []);
    placeSetup(engine, 0, 0, []);
    const compensation = engine.viewFor(1);
    const version = engine.version;
    const hand = engine.viewFor(1).you.handCount;
    for (const draw of [2, -1, 1.5]) {
      expect(() =>
        engine.execute(1, {
          type: 'resolve-compensation',
          commandId: `c-bad-${draw}`,
          sessionId: 'session-test',
          expectedVersion: version,
          choiceId: choiceId(compensation),
          draw,
        } as MatchClientMessage),
      ).toThrowError(MatchEngineError);
      expect(engine.version).toBe(version);
      expect(engine.viewFor(1).you.handCount).toBe(hand);
    }
  });
});

describe('开局引擎：非法与越权选择', () => {
  it('非法初始卡（非基础宝可梦、重复、超上限、越界）被拒绝且不改变状态', () => {
    const deck0 = deck(10, 10);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      // 手牌：6 张基础 + 1 张能量，用于覆盖非基础/重复/超上限三类非法放置。
      script.planHand(0, [BASIC, BASIC, BASIC, BASIC, BASIC, BASIC, ENERGY], [BASIC, BASIC, BASIC, BASIC, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    chooseTurnOrder(engine, 0, true);
    const view = engine.viewFor(0);
    const version = view.version;

    // 第 6 张是能量，不是基础宝可梦。
    expect(() => placeSetup(engine, 0, 6, [])).toThrowError(MatchEngineError);
    // 重复使用同一张手牌。
    expect(() => placeSetup(engine, 0, 0, [0])).toThrowError(MatchEngineError);
    // 超过 5 张备战。
    expect(() => placeSetup(engine, 0, 0, [1, 2, 3, 4, 5, 6])).toThrowError(MatchEngineError);
    // 越界序号。
    expect(() => placeSetup(engine, 0, 99, [])).toThrowError(MatchEngineError);

    expect(engine.version).toBe(version);
    expect(engine.viewFor(0).you.active).toBeNull();
    expect(engine.viewFor(0).you.setupPlaced).toBe(false);
  });

  it('另一个座位不能替他人选择：越权被拒绝', () => {
    const { engine } = normalScript(0);
    chooseTurnOrder(engine, 0, true);
    const view = engine.viewFor(0);
    expect(() =>
      engine.execute(1, {
        type: 'place-setup',
        commandId: 'c-cross',
        sessionId: 'session-test',
        expectedVersion: engine.version,
        choiceId: choiceId(view),
        active: 0,
        bench: [],
      }),
    ).toThrowError(MatchEngineError);
    expect(engine.version).toBe(view.version);
  });

  it('旧选择 ID 不能结算当前选择：stale-choice 且状态不变', () => {
    const { engine } = normalScript(0);
    chooseTurnOrder(engine, 0, true);
    const firstChoice = choiceId(engine.viewFor(0));
    placeSetup(engine, 0, 0, []);
    const secondChoice = choiceId(engine.viewFor(1));
    expect(secondChoice).not.toBe(firstChoice);
    const version = engine.version;
    let code: string | undefined;
    try {
      engine.execute(1, {
        type: 'place-setup',
        commandId: 'c-old-choice',
        sessionId: 'session-test',
        expectedVersion: version,
        choiceId: firstChoice,
        active: 0,
        bench: [],
      });
    } catch (error) {
      code = error instanceof MatchEngineError ? error.code : undefined;
    }
    expect(code).toBe('stale-choice');
    expect(engine.version).toBe(version);
    expect(engine.viewFor(1).you.setupPlaced).toBe(false);
  });

  it('G5.b. 时序：对手先盖放并放奖赏卡，之后才公开无基础方手牌；提交后身份仍隐藏', () => {
    const deck0 = deck(2, 18, BASIC_B);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [BASIC_B, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
    });
    chooseTurnOrder(engine, 0, true);

    // 座位 1 的盖放选择到达时，座位 0 的手牌尚未展示，载荷里没有月石或重抽记录。
    const beforePlacement = engine.viewFor(1);
    expect(beforePlacement.pendingChoice).toMatchObject({ kind: 'place-setup', seat: 1 });
    expect(beforePlacement.events.some((event) => event.type === 'mulligan')).toBe(false);
    expect(JSON.stringify(beforePlacement)).not.toContain('月石');
    expect(JSON.stringify(beforePlacement)).not.toContain(BASIC_B);

    placeSetup(engine, 1, 0, []);
    const afterPlacement = engine.viewFor(1);
    const eventTypes = afterPlacement.events.map((event) => `${event.type}:${event.type === 'setup-placed' || event.type === 'prizes-placed' || event.type === 'mulligan' ? event.seat : ''}`);
    expect(eventTypes.indexOf('setup-placed:1')).toBeGreaterThanOrEqual(0);
    expect(eventTypes.indexOf('prizes-placed:1')).toBeGreaterThan(eventTypes.indexOf('setup-placed:1'));
    expect(eventTypes.indexOf('mulligan:0')).toBeGreaterThan(eventTypes.indexOf('prizes-placed:1'));

    // 座位 0 在自己的重抽展示（按规则公开）之外仍看不到座位 1 的盖放身份。
    const aView = engine.viewFor(0);
    expect(aView.opponent.setupPlaced).toBe(true);
    expect(aView.opponent.active).toBeNull();
    expect(aView.opponent.bench).toHaveLength(0);
    expect(JSON.stringify(aView)).not.toContain(BASIC);
  });
});

describe('对局会话：认证、去重与版本', () => {
  function sessionHarness() {
    const deck0 = deck(6, 14);
    const deck1 = deck(6, 14);
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [0];
    script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
    outputs.push(...script.outputs);
    const session = new MatchSession(engineConfig([deck0, deck1], outputs));
    return { session, handle0: session.handleFor(0), handle1: session.handleFor(1) };
  }

  it('相同命令 ID 的精确重传返回第一次结果且不重复生效', () => {
    const { session, handle0 } = sessionHarness();
    const view = session.viewFor(handle0);
    const command: MatchClientMessage = {
      type: 'choose-turn-order',
      commandId: 'c-dup',
      sessionId: 'session-test',
      expectedVersion: view.version,
      choiceId: choiceId(view),
      goFirst: true,
    };
    const first = session.submit(handle0, command);
    const version = session.version;
    const replay = session.submit(handle0, command);
    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({ ok: true, duplicate: true, version });
    // 换载荷复用同一命令 ID 被识别为 ID 复用。
    const reused = session.submit(handle0, { ...command, goFirst: false });
    expect(reused).toMatchObject({ ok: false, code: 'command-id-reused' });
    expect(session.version).toBe(version);
  });

  it('过期版本被拒绝且不修改状态；按座位隔离命令 ID 结果', () => {
    const { session, handle0, handle1 } = sessionHarness();
    const view0 = session.viewFor(handle0);
    const command: MatchClientMessage = {
      type: 'choose-turn-order',
      commandId: 'c-seeded',
      sessionId: 'session-test',
      expectedVersion: 999,
      choiceId: choiceId(view0),
      goFirst: true,
    };
    const rejected = session.submit(handle0, command);
    expect(rejected).toMatchObject({ ok: false, code: 'stale-version' });
    expect(session.version).toBe(1);

    const accepted = session.submit(handle0, { ...command, expectedVersion: 1 });
    expect(accepted.ok).toBe(true);
    // 另一个座位用同样的命令 ID 不会拿到座位 0 的结果，而是按自己的状态裁决。
    const cross = session.submit(handle1, {
      type: 'place-setup',
      commandId: 'c-seeded',
      sessionId: 'session-test',
      expectedVersion: session.version,
      choiceId: choiceId(session.viewFor(handle0)),
      active: 0,
      bench: [],
    });
    expect(cross.ok).toBe(false);
    if (!cross.ok) {
      expect(cross.code).toBe('not-your-choice');
      expect(JSON.stringify(cross.view?.opponent.hand)).toBe('[]');
    }
  });

  it('伪造、缺失或空座位凭据一律失败，且不返回任何私人视图字段', () => {
    const { session, handle0 } = sessionHarness();
    const ownView = session.viewFor(handle0);
    const secretCard = ownView.you.hand[0]?.cardId as string;
    const secretName = ownView.you.hand[0]?.nameZh as string;
    const command: MatchClientMessage = {
      type: 'choose-turn-order',
      commandId: 'c-forged',
      sessionId: 'session-test',
      expectedVersion: 1,
      choiceId: choiceId(ownView),
      goFirst: true,
    };
    const forgedHandles: readonly unknown[] = [
      { seat: 0, token: 'forged-token' },
      { seat: 1, token: 'forged-token' },
      { seat: 0 },
      { seat: 1 },
      { token: 'forged-token' },
      {},
      null,
      undefined,
      42,
      'seat-0',
    ];
    for (const forged of forgedHandles) {
      const result = session.submit(forged as never, command);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not-in-match');
        // 未认证句柄的失败必须完全省略 view：不得按座位默认投影手牌。
        expect('view' in result).toBe(false);
      }
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secretCard);
      expect(serialized).not.toContain(secretName);
      expect(serialized).not.toContain('"hand"');
    }
    // 读取路径同样只抛领域错误，不泄露任何视图。
    for (const forged of [null, undefined, { seat: 0 }, {}]) {
      expect(() => session.viewFor(forged as never)).toThrowError(MatchEngineError);
    }
    expect(session.version).toBe(1);
    expect(handle0.seat).toBe(0);
  });

  it('最后一方提交后的重复回传不再次进入首回合', () => {
    const { session, handle0, handle1 } = sessionHarness();
    const v0 = session.viewFor(handle0);
    const choose: MatchClientMessage = {
      type: 'choose-turn-order',
      commandId: 'c-choose',
      sessionId: 'session-test',
      expectedVersion: v0.version,
      choiceId: choiceId(v0),
      goFirst: true,
    };
    expect(session.submit(handle0, choose).ok).toBe(true);
    const p0: MatchClientMessage = {
      type: 'place-setup',
      commandId: 'c-p0',
      sessionId: 'session-test',
      expectedVersion: session.version,
      choiceId: choiceId(session.viewFor(handle0)),
      active: 0,
      bench: [],
    };
    expect(session.submit(handle0, p0).ok).toBe(true);
    const p1: MatchClientMessage = {
      type: 'place-setup',
      commandId: 'c-p1',
      sessionId: 'session-test',
      expectedVersion: session.version,
      choiceId: choiceId(session.viewFor(handle1)),
      active: 0,
      bench: [],
    };
    const finished = session.submit(handle1, p1);
    expect(finished.ok).toBe(true);
    if (finished.ok) {
      expect(finished.view.phase).toBe('playing');
      expect(finished.view.events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
    }
    const replay = session.submit(handle1, p1);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.duplicate).toBe(true);
      expect(replay.view.events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
    }
    expect(session.version).toBe(4);
  });
});

describe('隐藏信息投影', () => {
  it('对手手牌、牌库顺序与奖赏身份从不进入视图；翻面前初始宝可梦保持隐藏', () => {
    const deck0 = deck(6, 14, BASIC_B); // 座位 0 使用专属基础身份（月石）
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [BASIC_B, BASIC_B, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    chooseTurnOrder(engine, 0, true);
    placeSetup(engine, 0, 0, [1]);
    const vsOpponent = engine.viewFor(1);
    const serialized = JSON.stringify(vsOpponent);
    // 座位 0 的手牌/盖放身份（月石）没有出现在座位 1 的载荷里。
    expect(serialized).not.toContain(BASIC_B);
    expect(serialized).not.toContain('月石');
    expect(vsOpponent.opponent.hand).toHaveLength(0);
    expect(vsOpponent.opponent.handCount).toBe(5); // 座位 0 已盖放 2 张
    expect(vsOpponent.opponent.prizeCount).toBe(0); // 对方还未放奖赏卡
    expect(vsOpponent.opponent.active).toBeNull();
    expect(vsOpponent.opponent.bench).toHaveLength(0);
    // 自家视图携带自己的完整手牌，基础标记可用于放置。
    expect(vsOpponent.you.hand).toHaveLength(7);
    expect(vsOpponent.you.hand.some((card) => card.isBasicPokemon)).toBe(true);
    // 牌库与奖赏只有张数。
    expect(serialized).not.toContain('deckOrder');
    expect(serialized).not.toContain('instanceId');
  });

  it('重抽公开展示的手牌只包含重抽方展示的 7 张；对方手牌仍不泄露', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(6, 14);
    const engine = scenario([deck0, deck1], 0, (script) => {
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
    });
    chooseTurnOrder(engine, 0, true);
    // 5.b. 下对手先盖放；提交后座位 0 才展示。
    placeSetup(engine, 1, 0, []);
    const view1 = engine.viewFor(1);
    const mulligan = view1.events.find((event) => event.type === 'mulligan');
    expect(mulligan).toBeDefined();
    if (mulligan !== undefined && mulligan.type === 'mulligan') {
      expect(mulligan.cards.every((card) => card.cardId === ENERGY)).toBe(true);
      expect(mulligan.shared).toBe(false);
    }
    const serialized = JSON.stringify(view1);
    // 座位 0 重抽后手牌里只有 1 张基础宝可梦，不在这份公开记录里。
    expect(view1.you.handCount).toBe(6); // 座位 1 已盖放战斗宝可梦
    expect(view1.opponent.handCount).toBe(7);
    expect(view1.opponent.hand).toHaveLength(0);
    expect(countBasicPokemon(engine.viewFor(0).you.hand.map((card) => card.cardId))).toBe(1);
    expect(serialized).not.toContain('instanceId');
  });
});
