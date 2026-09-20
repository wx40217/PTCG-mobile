import { describe, expect, it } from 'vitest';
import type { MatchClientMessage, MatchSeat, MatchView } from '@ptcg/protocol';
import { MatchEngineError, MatchSession, OpeningEngine, type OpeningEngineConfig } from '../src/match.ts';
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

function engineConfig(decks: readonly [string[], string[]], outputs: readonly number[]): OpeningEngineConfig {
  return {
    sessionId: 'session-test',
    decks: [deckDocumentFromCards(decks[0]), deckDocumentFromCards(decks[1])],
    nicknames: ['小智', '小茂'],
    catalog: releaseCatalogContent(),
    random: new SequenceRandomSource(outputs),
  };
}

/** 获胜者选择先后攻并完成双方初始放置的最短脚本。 */
function normalScript(winner: 0 | 1 = 0): { engine: OpeningEngine } {
  const deck0 = deck(6, 14);
  const deck1 = deck(6, 14);
  const script = new OpeningHandScript([deck0, deck1]);
  const outputs: number[] = [winner];
  script.planHand(0, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
  script.deal(0);
  script.planHand(1, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
  script.deal(1);
  outputs.push(...script.outputs);
  return { engine: new OpeningEngine(engineConfig([deck0, deck1], outputs)) };
}

function choiceId(view: MatchView): string {
  if (view.pendingChoice === null) {
    throw new Error('期望存在待决选择');
  }
  return view.pendingChoice.choiceId;
}

function chooseTurnOrder(engine: OpeningEngine, seat: MatchSeat, goFirst: boolean): void {
  const view = engine.viewFor(seat);
  engine.execute(seat, {
    type: 'choose-turn-order',
    commandId: `c-to-${seat}`,
    sessionId: 'session-test',
    expectedVersion: view.version,
    choiceId: choiceId(view),
    goFirst,
  } satisfies MatchClientMessage);
}

function placeSetup(engine: OpeningEngine, seat: MatchSeat, active: number, bench: readonly number[]): void {
  const view = engine.viewFor(seat);
  engine.execute(seat, {
    type: 'place-setup',
    commandId: `c-place-${seat}-${active}`,
    sessionId: 'session-test',
    expectedVersion: view.version,
    choiceId: choiceId(view),
    active,
    bench,
  } satisfies MatchClientMessage);
}

/** 在无补抽的正常局面上完成双方放置，进入 playing。 */
function completeNormalSetup(engine: OpeningEngine): void {
  placeSetup(engine, 0, 0, []);
  placeSetup(engine, 1, 0, []);
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

describe('开局引擎：重抽与补抽', () => {
  it('单方重抽：对手获得上限为 1 的可选补抽，可放弃（0 张）', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(6, 14);
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [0];
    // 座位 0 第一次没有基础宝可梦，重抽后成功。
    script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
    script.returnHand(0);
    script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    outputs.push(...script.outputs);
    const engine = new OpeningEngine(engineConfig([deck0, deck1], outputs));

    chooseTurnOrder(engine, 0, true);
    const afterDeal = engine.viewFor(0);
    const mulligan = afterDeal.events.filter((event) => event.type === 'mulligan');
    expect(mulligan).toHaveLength(1);
    expect(mulligan[0]).toMatchObject({ seat: 0, count: 1 });
    expect((mulligan[0] as { cards: readonly unknown[] }).cards).toHaveLength(7);
    expect(afterDeal.you.mulligans).toBe(1);

    placeSetup(engine, 0, 0, []);
    placeSetup(engine, 1, 0, []);
    const compensation = engine.viewFor(1);
    expect(compensation.phase).toBe('compensation');
    expect(compensation.pendingChoice).toMatchObject({ kind: 'compensation-draw', min: 0, max: 1, seat: 1 });
    expect(engine.viewFor(0).pendingChoice).toBeNull();
    expect(engine.viewFor(0).waitingForOpponentChoice).toBe(true);

    const version = engine.version;
    const handBefore = engine.viewFor(1).you.handCount;
    engine.execute(1, {
      type: 'resolve-compensation',
      commandId: 'c-draw-0',
      sessionId: 'session-test',
      expectedVersion: version,
      choiceId: choiceId(compensation),
      draw: 0,
    });
    const resolved = engine.viewFor(1);
    expect(resolved.you.handCount).toBe(handBefore);
    expect(resolved.you.bench).toHaveLength(0);
    expect(resolved.events.filter((event) => event.type === 'compensation-declared')).toHaveLength(1);
  });

  it('单方重抽：补抽到的基础宝可梦可选择盖放到备战区，翻面前对对手隐藏', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(6, 14);
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [0];
    script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
    script.returnHand(0);
    script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    outputs.push(...script.outputs);
    const engine = new OpeningEngine(engineConfig([deck0, deck1], outputs));
    chooseTurnOrder(engine, 0, true);
    placeSetup(engine, 0, 0, []);
    placeSetup(engine, 1, 0, []);

    // 双方放完奖赏卡后，座位 1 的剩余牌库顶是一张基础宝可梦。
    script.prizes(0);
    script.prizes(1);
    expect(script.topOfDeck(1)).toBe(BASIC);
    const compensation = engine.viewFor(1);
    engine.execute(1, {
      type: 'resolve-compensation',
      commandId: 'c-draw-max',
      sessionId: 'session-test',
      expectedVersion: compensation.version,
      choiceId: choiceId(compensation),
      draw: 1,
    });
    script.drawTop(1);
    const benchChoice = engine.viewFor(1);
    expect(benchChoice.pendingChoice).toMatchObject({ kind: 'compensation-bench', candidates: [6], max: 1 });
    // 对手仍看不到这张盖放的基础宝可梦。
    const opponentView = engine.viewFor(0);
    expect(opponentView.opponent.bench).toHaveLength(0);
    expect(opponentView.opponent.active).toBeNull();
    expect(opponentView.events.some((event) => event.type === 'compensation-declared' && event.count === 1)).toBe(true);

    engine.execute(1, {
      type: 'place-compensation-bench',
      commandId: 'c-bench-drawn',
      sessionId: 'session-test',
      expectedVersion: benchChoice.version,
      choiceId: choiceId(benchChoice),
      bench: [6],
    });
    const playing = engine.viewFor(0);
    expect(playing.phase).toBe('playing');
    expect(playing.opponent.bench).toHaveLength(1); // 补抽得到的 1 张基础宝可梦
    expect(playing.opponent.bench.map((entry) => entry.card.cardId)).toContain(BASIC);
    expect(playing.events.some((event) => event.type === 'compensation-benched' && event.seat === 1 && event.count === 1)).toBe(true);
  });

  it('双方同时重抽：双方都重抽并各自获得对手重抽次数的补抽上限', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(2, 18, BASIC_B);
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [1];
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
    outputs.push(...script.outputs);
    const engine = new OpeningEngine(engineConfig([deck0, deck1], outputs));

    chooseTurnOrder(engine, 1, true);
    const view = engine.viewFor(0);
    expect(view.events.filter((event) => event.type === 'mulligan')).toHaveLength(2);
    expect(view.you.mulligans).toBe(1);
    expect(view.opponent.mulligans).toBe(1);

    placeSetup(engine, 1, 0, []);
    placeSetup(engine, 0, 0, []);
    // 座位 0 先补抽（对手座位 1 重抽了 1 次）。
    const first = engine.viewFor(0);
    expect(first.pendingChoice).toMatchObject({ kind: 'compensation-draw', seat: 0, max: 1 });
    engine.execute(0, {
      type: 'resolve-compensation',
      commandId: 'c0-draw',
      sessionId: 'session-test',
      expectedVersion: first.version,
      choiceId: choiceId(first),
      draw: 1,
    });
    // 如果抽到基础宝可梦，先结算座位 0 自己的补抽备战选择（可放弃）。
    const maybeBench = engine.viewFor(0);
    if (maybeBench.pendingChoice?.kind === 'compensation-bench') {
      engine.execute(0, {
        type: 'place-compensation-bench',
        commandId: 'c0-bench',
        sessionId: 'session-test',
        expectedVersion: maybeBench.version,
        choiceId: choiceId(maybeBench),
        bench: [],
      });
    }
    // 座位 1 随后补抽。
    const second = engine.viewFor(1);
    expect(second.pendingChoice).toMatchObject({ kind: 'compensation-draw', seat: 1, max: 1 });
    engine.execute(1, {
      type: 'resolve-compensation',
      commandId: 'c1-draw',
      sessionId: 'session-test',
      expectedVersion: second.version,
      choiceId: choiceId(second),
      draw: 0,
    });
    expect(engine.viewFor(0).phase).toBe('playing');
  });

  it('非法补抽数量被拒绝且不改变状态', () => {
    const deck0 = deck(2, 18);
    const deck1 = deck(6, 14);
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [0];
    script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
    script.returnHand(0);
    script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    outputs.push(...script.outputs);
    const engine = new OpeningEngine(engineConfig([deck0, deck1], outputs));
    chooseTurnOrder(engine, 0, true);
    placeSetup(engine, 0, 0, []);
    placeSetup(engine, 1, 0, []);
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
  it('非法初始卡（非基础宝可梦、重复、超上限）被拒绝且不改变状态', () => {
    const deck0 = deck(10, 10);
    const deck1 = deck(6, 14);
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [0];
    // 手牌：6 张基础 + 1 张能量，用于覆盖非基础/重复/超上限三类非法放置。
    script.planHand(0, [BASIC, BASIC, BASIC, BASIC, BASIC, BASIC, ENERGY], [BASIC, BASIC, BASIC, BASIC, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
    outputs.push(...script.outputs);
    const engine = new OpeningEngine(engineConfig([deck0, deck1], outputs));
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
      expect(JSON.stringify(cross.view.opponent.hand)).toBe('[]');
    }
  });

  it('伪造座位句柄无法读取或操作他人视图', () => {
    const { session, handle0 } = sessionHarness();
    const forged = { seat: 1 as const, token: 'forged-token' };
    const read = (() => {
      try {
        return session.viewFor(forged);
      } catch (error) {
        return error instanceof MatchEngineError ? error.code : 'unknown';
      }
    })();
    expect(read).toBe('not-in-match');
    const submitted = session.submit(forged, {
      type: 'choose-turn-order',
      commandId: 'c-forged',
      sessionId: 'session-test',
      expectedVersion: 1,
      choiceId: 'choice-1',
      goFirst: true,
    });
    expect(submitted).toMatchObject({ ok: false, code: 'not-in-match' });
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
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [0];
    script.planHand(0, [BASIC_B, BASIC_B, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
    outputs.push(...script.outputs);
    const engine = new OpeningEngine(engineConfig([deck0, deck1], outputs));
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
    const script = new OpeningHandScript([deck0, deck1]);
    const outputs: number[] = [0];
    script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    script.planHand(1, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(1);
    script.returnHand(0);
    script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
    script.deal(0);
    outputs.push(...script.outputs);
    const engine = new OpeningEngine(engineConfig([deck0, deck1], outputs));
    chooseTurnOrder(engine, 0, true);
    const view1 = engine.viewFor(1);
    const mulligan = view1.events.find((event) => event.type === 'mulligan');
    expect(mulligan).toBeDefined();
    if (mulligan !== undefined && mulligan.type === 'mulligan') {
      expect(mulligan.cards.every((card) => card.cardId === ENERGY)).toBe(true);
    }
    const serialized = JSON.stringify(view1);
    // 座位 0 重抽后手牌里只有 1 张基础宝可梦，不在这份公开记录里。
    expect(view1.you.handCount).toBe(7);
    expect(view1.opponent.handCount).toBe(7);
    expect(view1.opponent.hand).toHaveLength(0);
    expect(countBasicPokemon(view1.you.hand.map((card) => card.cardId))).toBe(1);
    expect(serialized).not.toContain('instanceId');
  });
});
