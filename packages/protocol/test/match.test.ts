import { describe, expect, it } from 'vitest';
import {
  MATCH_ERROR_CODES,
  parseMatchClientMessage,
  parseMatchServerMessage,
  type MatchPokemonView,
  type MatchView,
} from '../src/match.ts';
import { parseClientMessage, parseServerMessage } from '../src/messages.ts';

const CARD = {
  cardId: 'csve1-035',
  nameZh: '荧光鱼',
  kind: 'pokemon',
  classLabelZh: '宝可梦',
  isBasicPokemon: true,
  evolvesFrom: null,
  type: '水',
  hp: 50,
  printDisplayNumber: 'CSVE1C 035/177',
} as const;

const ENERGY_CARD = {
  cardId: 'cbb1c-1803',
  nameZh: '基本水能量',
  kind: 'energy',
  classLabelZh: '能量',
  isBasicPokemon: false,
  evolvesFrom: null,
  type: '水',
  hp: null,
  printDisplayNumber: 'CBB1C 1803/06',
} as const;

function pokemonView(overrides: Partial<MatchPokemonView> = {}): MatchPokemonView {
  return {
    card: CARD,
    damageCounters: 0,
    statuses: [],
    energies: [],
    tools: [],
    maxHp: 50,
    attacks: [
      { index: 0, name: '水枪', cost: ['水'], damageText: '10', effectTextZh: null, supported: true },
      { index: 1, name: '海之伴奏', cost: [], damageText: null, effectTextZh: '选择手牌中的水能量…', supported: false },
    ],
    abilities: [],
    canEvolve: true,
    evolveBlockedReasonZh: null,
    retreatCost: 1,
    weakness: '雷×2',
    resistance: null,
    ...overrides,
  };
}

function matchView(overrides: Partial<MatchView> = {}): MatchView {
  return {
    sessionId: 'session-1',
    version: 3,
    phase: 'setup',
    turn: 0,
    activeSeat: null,
    firstSeat: 0,
    you: {
      seat: 0,
      nickname: '小智',
      hand: [CARD],
      handCount: 1,
      deckCount: 13,
      prizeCount: 0,
      discard: [],
      active: null,
      bench: [],
      setupPlaced: false,
      mulligans: 0,
      soloMulligans: 0,
      revealed: true,
      energyAttachedThisTurn: false,
      retreatedThisTurn: false,
      supporterUsedThisTurn: false,
      stadiumPlayedThisTurn: false,
      stadiumUsedThisTurn: false,
      koDuringLastOpponentTurn: false,
    },
    opponent: {
      seat: 1,
      nickname: '小茂',
      hand: [],
      handCount: 7,
      deckCount: 13,
      prizeCount: 0,
      discard: [],
      active: null,
      bench: [],
      setupPlaced: false,
      mulligans: 1,
      soloMulligans: 1,
      revealed: false,
      energyAttachedThisTurn: false,
      retreatedThisTurn: false,
      supporterUsedThisTurn: false,
      stadiumPlayedThisTurn: false,
      stadiumUsedThisTurn: false,
      koDuringLastOpponentTurn: false,
    },
    stadium: null,
    pendingChoice: {
      choiceId: 'choice-2',
      seat: 0,
      kind: 'place-setup',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 5,
      candidates: [0],
      step: 1,
      stepCount: 1,
      source: 'hand',
      descriptionZh: '请选择战斗与备战宝可梦。',
      cardCandidates: [],
      modes: [],
    },
    waitingForOpponentChoice: false,
    cannotDraw: false,
    result: null,
    events: [
      { seq: 1, type: 'match-created', seats: ['小智', '小茂'] },
      { seq: 2, type: 'turn-order-flip', winner: 0 },
      { seq: 3, type: 'turn-order-chosen', seat: 0, goFirst: true },
      { seq: 4, type: 'mulligan', seat: 1, count: 1, shared: false, cards: [CARD] },
    ],
    ...overrides,
  };
}

const BASE = { commandId: 'c-1', sessionId: 'session-1', expectedVersion: 3 } as const;

describe('对局命令解析（#8 开局 / #9 回合）', () => {
  it('解析四类待决选择命令', () => {
    expect(parseMatchClientMessage({ ...BASE, type: 'choose-turn-order', choiceId: 'choice-2', goFirst: true })).toEqual({
      ok: true,
      message: { ...BASE, type: 'choose-turn-order', choiceId: 'choice-2', goFirst: true },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'place-setup', choiceId: 'choice-2', active: 0, bench: [1, 2] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'place-setup', choiceId: 'choice-2', active: 0, bench: [1, 2] },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'resolve-compensation', choiceId: 'choice-2', draw: 0 })).toEqual({
      ok: true,
      message: { ...BASE, type: 'resolve-compensation', choiceId: 'choice-2', draw: 0 },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'place-bench', choiceId: 'choice-2', bench: [7] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'place-bench', choiceId: 'choice-2', bench: [7] },
    });
  });

  it('解析五类回合命令：放基础、附能、撤退、招式、结束回合', () => {
    expect(parseMatchClientMessage({ ...BASE, type: 'play-basic', handIndex: 2 })).toEqual({
      ok: true,
      message: { ...BASE, type: 'play-basic', handIndex: 2 },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'attach-energy', handIndex: 1, target: { slot: 'active' } })).toEqual({
      ok: true,
      message: { ...BASE, type: 'attach-energy', handIndex: 1, target: { slot: 'active' } },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'attach-energy', handIndex: 1, target: { slot: 'bench', index: 2 } })).toEqual({
      ok: true,
      message: { ...BASE, type: 'attach-energy', handIndex: 1, target: { slot: 'bench', index: 2 } },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'retreat', energyIndices: [0, 2], benchIndex: 1 })).toEqual({
      ok: true,
      message: { ...BASE, type: 'retreat', energyIndices: [0, 2], benchIndex: 1 },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'attack', attackIndex: 0, target: { slot: 'active' } })).toEqual({
      ok: true,
      message: { ...BASE, type: 'attack', attackIndex: 0, target: { slot: 'active' } },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'end-turn' })).toEqual({
      ok: true,
      message: { ...BASE, type: 'end-turn' },
    });
  });

  it('解析昏厥结算与认输命令：取奖赏卡、补充战斗宝可梦、确认认输', () => {
    expect(parseMatchClientMessage({ ...BASE, type: 'take-prizes', choiceId: 'choice-9', prizes: [0, 2] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'take-prizes', choiceId: 'choice-9', prizes: [0, 2] },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'choose-replacement', choiceId: 'choice-9', benchIndex: 1 })).toEqual({
      ok: true,
      message: { ...BASE, type: 'choose-replacement', choiceId: 'choice-9', benchIndex: 1 },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'concede' })).toEqual({
      ok: true,
      message: { ...BASE, type: 'concede' },
    });
    // 结构错误与多余字段整条拒绝。
    expect(parseMatchClientMessage({ ...BASE, type: 'take-prizes', choiceId: 'c', prizes: [-1] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'take-prizes', choiceId: 'c', prizes: [0.5] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'take-prizes', choiceId: 'c' })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'choose-replacement', choiceId: 'c', benchIndex: -1 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'choose-replacement', choiceId: 'c' })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'concede', choiceId: 'c' })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'concede', seed: 1 })).toMatchObject({ ok: false });
  });

  it('非对局命令返回 null，结构错误返回明确错误', () => {
    expect(parseMatchClientMessage({ type: 'create-room', commandId: 'x' })).toBeNull();
    expect(parseMatchClientMessage({ ...BASE, type: 'place-setup', choiceId: 'c', active: -1, bench: [] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'place-setup', choiceId: 'c', active: 0, bench: [1.5] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'resolve-compensation', choiceId: 'c', draw: -1 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'choose-turn-order', choiceId: 'c', goFirst: 'yes' })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'play-basic', handIndex: -1 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'attach-energy', handIndex: 0, target: { slot: 'bench' } })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'attach-energy', handIndex: 0, target: { slot: 'bench', index: -1 } })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'attach-energy', handIndex: 0, target: { slot: 'hand' } })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'retreat', energyIndices: [0, -1], benchIndex: 0 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'attack', attackIndex: 1.5, target: { slot: 'active' } })).toMatchObject({ ok: false });
  });

  it('发行客户端不能夹带随机种子或预设牌序：未知字段整条拒绝', () => {
    const withSeed = parseMatchClientMessage({
      ...BASE,
      type: 'choose-turn-order',
      choiceId: 'choice-2',
      goFirst: true,
      seed: 12345,
    });
    expect(withSeed).toMatchObject({ ok: false });
    if (withSeed !== null && !withSeed.ok) {
      expect(withSeed.error).toContain('seed');
    }

    const withDeckOrder = parseMatchClientMessage({
      ...BASE,
      type: 'place-setup',
      choiceId: 'choice-2',
      active: 0,
      bench: [],
      deckOrder: ['csve1-035'],
    });
    expect(withDeckOrder).toMatchObject({ ok: false });

    // 回合命令同样不能夹带随机输入或隐藏信息。
    const attachWithSeed = parseMatchClientMessage({ ...BASE, type: 'attach-energy', handIndex: 0, target: { slot: 'active' }, seed: 1 });
    expect(attachWithSeed).toMatchObject({ ok: false });
    const attackWithDeckOrder = parseMatchClientMessage({ ...BASE, type: 'attack', attackIndex: 0, target: { slot: 'active' }, deckOrder: [] });
    expect(attackWithDeckOrder).toMatchObject({ ok: false });
    const targetWithUnknown = parseMatchClientMessage({ ...BASE, type: 'attach-energy', handIndex: 0, target: { slot: 'active', index: 0 } });
    expect(targetWithUnknown).toMatchObject({ ok: false });

    // 通用消息入口同样不会把带未知字段的载荷当成合法对局命令。
    expect(
      parseClientMessage(JSON.stringify({ ...BASE, type: 'resolve-compensation', choiceId: 'c', draw: 0, deckOrder: [] })),
    ).toMatchObject({ ok: false });
  });
});

describe('对局服务端消息解析', () => {
  it('解析合法的对局快照与错误', () => {
    const snapshot = parseMatchServerMessage({ type: 'match', view: matchView() });
    expect(snapshot).toMatchObject({ ok: true });
    if (snapshot !== null && snapshot.ok && snapshot.message.type === 'match') {
      expect(snapshot.message.view.you.hand).toHaveLength(1);
      expect(snapshot.message.view.opponent.hand).toHaveLength(0);
      expect(parseServerMessage(JSON.stringify({ type: 'match', view: matchView() }))).toMatchObject({ ok: true });
    }
    expect(
      parseMatchServerMessage({ type: 'match-error', code: 'stale-version', message: '版本过期', commandId: 'c-1', view: matchView() }),
    ).toMatchObject({ ok: true });
    expect(
      parseMatchServerMessage({ type: 'match-error', code: 'opponent-offline', message: '对手已断线，对局进入等待。' }),
    ).toMatchObject({ ok: true });
    expect(parseMatchServerMessage({ type: 'match-error', code: 'no-such-code', message: 'x' })).toMatchObject({ ok: false });
    expect(parseMatchServerMessage({ type: 'room', room: {} })).toBeNull();
  });

  it('解析按座位连接状态与断线预算', () => {
    const view = matchView({
      connection: { youOnline: true, opponentOnline: false, yourDisconnectMs: 30_000, disconnectBudgetMs: 180_000 },
    });
    const parsed = parseMatchServerMessage({ type: 'match', view });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed !== null && parsed.ok && parsed.message.type === 'match') {
      expect(parsed.message.view.connection).toEqual({
        youOnline: true,
        opponentOnline: false,
        yourDisconnectMs: 30_000,
        disconnectBudgetMs: 180_000,
      });
    }
    // 结构非法的连接状态必须被拒绝，而不是静默忽略。
    expect(
      parseMatchServerMessage({
        type: 'match',
        view: { ...matchView(), connection: { youOnline: true, opponentOnline: false, yourDisconnectMs: -1, disconnectBudgetMs: 180_000 } },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseMatchServerMessage({
        type: 'match',
        view: { ...matchView(), connection: { youOnline: 'yes', opponentOnline: false } },
      }),
    ).toMatchObject({ ok: false });
  });

  it('解析断线超时与服务中断两类终局原因', () => {
    for (const reason of ['disconnect-timeout', 'service-interruption'] as const) {
      const result = parseMatchServerMessage({
        type: 'match',
        view: matchView({ result: { winner: reason === 'disconnect-timeout' ? 1 : null, reason, conditions: [] } }),
      });
      expect(result).toMatchObject({ ok: true });
      if (result !== null && result.ok && result.message.type === 'match') {
        expect(result.message.view.result?.reason).toBe(reason);
        expect(result.message.view.result?.winner).toBe(reason === 'disconnect-timeout' ? 1 : null);
      }
    }
    expect(parseMatchServerMessage({ type: 'match', view: matchView({ result: { winner: 0, reason: 'made-up', conditions: [] } }) })).toMatchObject({
      ok: false,
    });

    const parsed = parseMatchServerMessage({
      type: 'match',
      view: matchView({
        result: { winner: null, reason: 'disconnect-timeout', conditions: [] },
        events: [{ seq: 5, type: 'match-finished', winner: null, reason: 'disconnect-timeout', conditions: [] }],
      }),
    });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed !== null && parsed.ok && parsed.message.type === 'match') {
      expect(parsed.message.view.events[parsed.message.view.events.length - 1]).toMatchObject({
        type: 'match-finished',
        reason: 'disconnect-timeout',
        winner: null,
      });
    }
  });

  it('解析回合视图：伤害指示物、附着能量、招式与每回合标记', () => {
    const view = matchView({
      phase: 'playing',
      turn: 2,
      activeSeat: 1,
      you: {
        ...matchView().you,
        active: pokemonView({
          damageCounters: 2,
          energies: [{ energyIndex: 0, card: ENERGY_CARD }],
          retreatCost: 1,
        }),
        bench: [pokemonView({ card: { ...CARD, cardId: 'csve1-057', nameZh: '月石' } })],
        discard: [ENERGY_CARD],
        energyAttachedThisTurn: true,
        retreatedThisTurn: false,
      },
      opponent: {
        ...matchView().opponent,
        revealed: true,
        active: pokemonView(),
      },
    });
    const parsed = parseMatchServerMessage({ type: 'match', view });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed !== null && parsed.ok && parsed.message.type === 'match') {
      expect(parsed.message.view.you.active?.damageCounters).toBe(2);
      expect(parsed.message.view.you.active?.energies[0]?.energyIndex).toBe(0);
      expect(parsed.message.view.you.active?.attacks[0]).toMatchObject({ name: '水枪', supported: true });
      expect(parsed.message.view.you.active?.attacks[1]).toMatchObject({ name: '海之伴奏', supported: false });
      expect(parsed.message.view.you.energyAttachedThisTurn).toBe(true);
      expect(parsed.message.view.you.bench).toHaveLength(1);
      expect(parsed.message.view.you.discard).toHaveLength(1);
    }
  });

  it('回合事件按公开语义解析：抽牌、放基础、附能、撤退、招式、伤害指示物、换回合', () => {
    const view = matchView({
      phase: 'playing',
      turn: 2,
      events: [
        { seq: 1, type: 'turn-started', seat: 1, turn: 2 },
        { seq: 2, type: 'card-drawn', seat: 1, count: 1 },
        { seq: 3, type: 'basic-placed', seat: 1, card: CARD },
        { seq: 4, type: 'energy-attached', seat: 1, card: ENERGY_CARD, target: { slot: 'active' }, targetNameZh: '荧光鱼' },
        { seq: 5, type: 'retreat', seat: 1, active: CARD, bench: CARD },
        { seq: 6, type: 'attack-used', seat: 1, attackName: '水枪', baseDamage: 10, damage: 20 },
        { seq: 7, type: 'damage-counters-placed', seat: 1, targetSeat: 0, count: 2 },
        { seq: 8, type: 'turn-ended', seat: 1, turn: 2 },
      ],
    });
    const parsed = parseMatchServerMessage({ type: 'match', view });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed !== null && parsed.ok && parsed.message.type === 'match') {
      expect(parsed.message.view.events.map((event) => event.type)).toEqual([
        'turn-started',
        'card-drawn',
        'basic-placed',
        'energy-attached',
        'retreat',
        'attack-used',
        'damage-counters-placed',
        'turn-ended',
      ]);
    }
    const drawBlocked = parseMatchServerMessage({
      type: 'match',
      view: matchView({ phase: 'playing', cannotDraw: true, events: [{ seq: 1, type: 'draw-blocked', seat: 0, turn: 3 }] }),
    });
    expect(drawBlocked).toMatchObject({ ok: true });
  });

  it('对手手牌身份出现在载荷中即拒绝（不靠界面不渲染兜底）', () => {
    const leaked = matchView();
    const broken = { ...leaked, opponent: { ...leaked.opponent, hand: [CARD], handCount: 1 } };
    expect(parseMatchServerMessage({ type: 'match', view: broken })).toMatchObject({ ok: false });
  });

  it('翻面前对手初始宝可梦身份出现在载荷中即拒绝', () => {
    const leaked = matchView();
    const broken = {
      ...leaked,
      opponent: { ...leaked.opponent, active: pokemonView(), bench: [pokemonView()] },
    };
    expect(parseMatchServerMessage({ type: 'match', view: broken })).toMatchObject({ ok: false });
    // 公开翻面（playing）后同样的身份是合法公开信息。
    const revealed = { ...broken, phase: 'playing' as const, opponent: { ...broken.opponent, revealed: true } };
    expect(parseMatchServerMessage({ type: 'match', view: revealed })).toMatchObject({ ok: true });
  });

  it('翻面前对手战斗区整体被拒绝：既没有身份也没有可渲染的能量/伤害', () => {
    const broken = matchView({
      opponent: { ...matchView().opponent, active: pokemonView({ damageCounters: 1 }) },
    });
    expect(parseMatchServerMessage({ type: 'match', view: broken })).toMatchObject({ ok: false });
  });

  it('其他人的待决选择不得发到本人视图', () => {
    const leaked = matchView();
    const broken = { ...leaked, pendingChoice: { ...(leaked.pendingChoice as object), seat: 1 } };
    expect(parseMatchServerMessage({ type: 'match', view: broken })).toMatchObject({ ok: false });
  });

  it('公开错误码列表包含越权、旧选择与回合失败码', () => {
    for (const code of [
      'not-your-choice',
      'stale-choice',
      'stale-version',
      'command-id-reused',
      'choice-pending',
      'illegal-choice',
      'not-your-turn',
      'action-not-allowed',
      'illegal-target',
      'illegal-cost',
      'insufficient-energy',
      'unsupported-card',
      'match-finished',
      'opponent-offline',
    ]) {
      expect(MATCH_ERROR_CODES).toContain(code);
    }
  });

  it('重抽事件必须带上是否为共同重洗的公开标记，补抽备战事件使用 bench-placed', () => {
    const view = matchView({
      events: [
        { seq: 1, type: 'mulligan', seat: 0, count: 1, shared: true, cards: [CARD] },
        { seq: 2, type: 'bench-placed', seat: 0, count: 1 },
      ],
    });
    expect(parseMatchServerMessage({ type: 'match', view })).toMatchObject({ ok: true });
    // 缺少 shared 的旧式重抽事件不再被接受：共同重洗与 5.d. 必须在载荷里分开。
    const missingShared = {
      ...view,
      events: [{ seq: 1, type: 'mulligan', seat: 0, count: 1, cards: [CARD] }],
    };
    expect(parseMatchServerMessage({ type: 'match', view: missingShared })).toMatchObject({ ok: false });
    // 旧的 compensation-benched 事件类型不再被接受。
    const legacy = {
      ...view,
      events: [{ seq: 1, type: 'compensation-benched', seat: 0, count: 1 }],
    };
    expect(parseMatchServerMessage({ type: 'match', view: legacy })).toMatchObject({ ok: false });
  });

  it('座位视图必须分别携带总重抽、单独重抽与每回合标记', () => {
    const missingSolo = matchView();
    const { soloMulligans: _solo, ...opponent } = missingSolo.opponent;
    const broken = { ...missingSolo, opponent: { ...opponent, soloMulligans: undefined } };
    expect(parseMatchServerMessage({ type: 'match', view: broken })).toMatchObject({ ok: false });
    const missingFlag = matchView();
    const { energyAttachedThisTurn: _flag, ...you } = missingFlag.you;
    expect(parseMatchServerMessage({ type: 'match', view: { ...missingFlag, you: { ...you, energyAttachedThisTurn: undefined } } })).toMatchObject({
      ok: false,
    });
  });

  it('伤害与伤害指示物必须在载荷中区分：attack-used 带基础/最终伤害，damage-counters-placed 带个数', () => {
    const view = matchView({
      phase: 'playing',
      events: [
        { seq: 1, type: 'attack-used', seat: 0, attackName: '水枪', baseDamage: 10, damage: 20 },
        { seq: 2, type: 'damage-counters-placed', seat: 0, targetSeat: 1, count: 2 },
      ],
    });
    const parsed = parseMatchServerMessage({ type: 'match', view });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed !== null && parsed.ok && parsed.message.type === 'match') {
      expect(parsed.message.view.events[0]).toMatchObject({ type: 'attack-used', baseDamage: 10, damage: 20 });
      expect(parsed.message.view.events[1]).toMatchObject({ type: 'damage-counters-placed', count: 2 });
    }
    // 攻击事件不能把伤害指示物个数混进最终伤害字段之外。
    const badDamage = { ...view, events: [{ seq: 1, type: 'damage-counters-placed', seat: 0, targetSeat: 1, count: -1 }] };
    expect(parseMatchServerMessage({ type: 'match', view: badDamage })).toMatchObject({ ok: false });
  });

  it('解析特殊状态、昏厥、奖赏与终态：状态在宝可梦视图，结果在顶层，奖赏只公开张数', () => {
    const view = matchView({
      phase: 'playing',
      turn: 5,
      activeSeat: 0,
      result: { winner: 0, reason: 'prizes', conditions: [{ seat: 0, condition: 'prizes' }] },
      you: { ...matchView().you, active: pokemonView({ statuses: ['中毒', '灼伤'] }) },
      pendingChoice: null,
      events: [
        { seq: 1, type: 'status-inflicted', seat: 1, targetSeat: 0, targetNameZh: '荧光鱼', condition: '中毒' },
        { seq: 2, type: 'checkup-flip', targetSeat: 0, targetNameZh: '荧光鱼', condition: '灼伤', result: 'tails' },
        { seq: 3, type: 'status-recovered', targetSeat: 0, targetNameZh: '荧光鱼', condition: '睡眠', cause: 'checkup' },
        { seq: 4, type: 'confusion-flip', seat: 0, targetNameZh: '荧光鱼', result: 'tails', selfDamageCounters: 3 },
        { seq: 5, type: 'pokemon-knocked-out', targetSeat: 1, targetNameZh: '月石', prizeCount: 2 },
        { seq: 6, type: 'prizes-taken', seat: 0, count: 2, remaining: 4 },
        { seq: 7, type: 'replacement-placed', seat: 1, card: { ...CARD, cardId: 'csve1-057', nameZh: '月石' } },
        { seq: 8, type: 'conceded', seat: 1 },
        { seq: 9, type: 'match-finished', winner: 0, reason: 'prizes', conditions: [{ seat: 0, condition: 'prizes' }] },
      ],
    });
    const parsed = parseMatchServerMessage({ type: 'match', view });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed !== null && parsed.ok && parsed.message.type === 'match') {
      expect(parsed.message.view.you.active?.statuses).toEqual(['中毒', '灼伤']);
      expect(parsed.message.view.result).toEqual({ winner: 0, reason: 'prizes', conditions: [{ seat: 0, condition: 'prizes' }] });
      const texts = parsed.message.view.events.map((event) => JSON.stringify(event));
      // 奖赏事件只带张数与剩余张数，不携带任何奖赏卡身份。
      expect(texts[5]).not.toContain('card');
      expect(parsed.message.view.events[5]).toMatchObject({ type: 'prizes-taken', seat: 0, count: 2, remaining: 4 });
    }

    // 未知特殊状态、非法终态与非法待决选择类型都被拒绝。
    const badStatus = { ...view, you: { ...view.you, active: pokemonView({ statuses: ['石化'] as never }) } };
    expect(parseMatchServerMessage({ type: 'match', view: badStatus })).toMatchObject({ ok: false });
    const badReason = { ...view, result: { winner: 0, reason: 'first-match', conditions: [] } };
    expect(parseMatchServerMessage({ type: 'match', view: badReason })).toMatchObject({ ok: false });
    const badWinner = { ...view, result: { winner: 2, reason: 'prizes', conditions: [] } };
    expect(parseMatchServerMessage({ type: 'match', view: badWinner })).toMatchObject({ ok: false });
    const badPending = {
      ...view,
      result: null,
      pendingChoice: {
        choiceId: 'c',
        seat: 0,
        kind: 'take-prizes',
        min: 1,
        max: 1,
        benchMin: 0,
        benchMax: 0,
        candidates: [0],
        step: 1,
        stepCount: 1,
        source: 'prizes',
        descriptionZh: '拿取奖赏卡。',
        cardCandidates: [],
        modes: [],
      },
    };
    expect(parseMatchServerMessage({ type: 'match', view: badPending })).toMatchObject({ ok: true });
    const unknownPending = { ...badPending, pendingChoice: { ...badPending.pendingChoice, kind: 'choose-prize' } };
    expect(parseMatchServerMessage({ type: 'match', view: unknownPending })).toMatchObject({ ok: false });
    // 非法公开事件一律拒绝：奖赏张数为负并不是“未公开身份”，而是非法载荷。
    const badPrizes = { ...view, events: [{ seq: 1, type: 'prizes-taken', seat: 0, count: -1, remaining: 6 }] };
    expect(parseMatchServerMessage({ type: 'match', view: badPrizes })).toMatchObject({ ok: false });
  });
});


describe('训练家命令、通用选择与新公开事件（T10 / #11）', () => {
  it('解析出牌、竞技场与四类通用选择命令', () => {
    expect(parseMatchClientMessage({ ...BASE, type: 'play-trainer', handIndex: 3 })).toEqual({
      ok: true,
      message: { ...BASE, type: 'play-trainer', handIndex: 3 },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'use-stadium' })).toEqual({
      ok: true,
      message: { ...BASE, type: 'use-stadium' },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'discard-hand', choiceId: 'choice-9', handIndices: [0, 2] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'discard-hand', choiceId: 'choice-9', handIndices: [0, 2] },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'search-deck', choiceId: 'choice-9', candidateIds: ['c1', 'c2'] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'search-deck', choiceId: 'choice-9', candidateIds: ['c1', 'c2'] },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'choose-mode', choiceId: 'choice-9', modeId: 'switch-opponent-v' })).toEqual({
      ok: true,
      message: { ...BASE, type: 'choose-mode', choiceId: 'choice-9', modeId: 'switch-opponent-v' },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'switch-opponent', choiceId: 'choice-9', benchIndex: 1 })).toEqual({
      ok: true,
      message: { ...BASE, type: 'switch-opponent', choiceId: 'choice-9', benchIndex: 1 },
    });
  });

  it('拒绝新命令的非法载荷与未知字段', () => {
    expect(parseMatchClientMessage({ ...BASE, type: 'play-trainer', handIndex: -1 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'play-trainer', handIndex: 0, seed: [1] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'use-stadium', deckOrder: ['x'] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'search-deck', choiceId: 'c', candidateIds: [''] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'search-deck', choiceId: 'c', candidateIds: [] })).toMatchObject({ ok: true });
    expect(parseMatchClientMessage({ ...BASE, type: 'choose-mode', choiceId: 'c', modeId: '' })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'switch-opponent', choiceId: 'c', benchIndex: -1 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'search-deck', choiceId: 'c', candidateIds: [], extra: true })).toMatchObject({ ok: false });
  });

  it('解析新的公开事件、竞技场视图与通用选择步骤；私人候选只能发给选择者', () => {
    const stadiumCard = { ...CARD, cardId: 'csv2c-127', nameZh: '深钵镇', kind: 'trainer', isBasicPokemon: false, evolvesFrom: null, type: null, hp: null };
    const view = matchView({
      phase: 'playing',
      stadium: stadiumCard,
      you: {
        ...matchView().you,
        supporterUsedThisTurn: true,
        stadiumPlayedThisTurn: true,
        stadiumUsedThisTurn: true,
        koDuringLastOpponentTurn: true,
      },
      pendingChoice: {
        choiceId: 'choice-9',
        seat: 0,
        kind: 'search-deck',
        min: 0,
        max: 3,
        benchMin: 0,
        benchMax: 0,
        candidates: [],
        step: 2,
        stepCount: 2,
        source: 'deck',
        descriptionZh: '鼓励信：选择牌库中最多 3 张基本能量。',
        cardCandidates: [
          { candidateId: 'c1', card: ENERGY_CARD, targetLabelZh: '战斗宝可梦' },
          { candidateId: 'c2', card: CARD, selectable: false },
        ],
        modes: [],
      },
      opponent: { ...matchView().opponent, revealed: true },
      events: [
        { seq: 1, type: 'trainer-played', seat: 0, card: CARD },
        { seq: 2, type: 'coin-flip', seat: 0, cardNameZh: '精灵球', result: 'heads' },
        { seq: 3, type: 'cards-discarded', seat: 0, cards: [ENERGY_CARD] },
        { seq: 4, type: 'cards-searched', seat: 0, destination: 'hand', cards: [CARD] },
        { seq: 5, type: 'deck-shuffled', seat: 0 },
        { seq: 6, type: 'stadium-placed', seat: 0, card: stadiumCard, replaced: null },
        { seq: 7, type: 'bench-switched', seat: 0, targetSeat: 1, active: CARD, bench: CARD },
      ],
    });
    const parsed = parseMatchServerMessage({ type: 'match', view });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed !== null && parsed.ok && parsed.message.type === 'match') {
      expect(parsed.message.view.stadium?.cardId).toBe('csv2c-127');
      expect(parsed.message.view.you.supporterUsedThisTurn).toBe(true);
      expect(parsed.message.view.you.koDuringLastOpponentTurn).toBe(true);
      expect(parsed.message.view.pendingChoice?.step).toBe(2);
      expect(parsed.message.view.pendingChoice?.cardCandidates[0]?.candidateId).toBe('c1');
      expect(parsed.message.view.pendingChoice?.cardCandidates[0]?.selectable).toBeUndefined();
      expect(parsed.message.view.pendingChoice?.cardCandidates[0]?.targetLabelZh).toBe('战斗宝可梦');
      expect(parsed.message.view.pendingChoice?.cardCandidates[1]?.selectable).toBe(false);
      expect(parsed.message.view.events[0]).toMatchObject({ type: 'trainer-played', card: { cardId: 'csve1-035' } });
      expect(parsed.message.view.events[6]).toMatchObject({ type: 'bench-switched', targetSeat: 1 });
    }

    // 选待决选择只能发给本人；对手收到带 cardCandidates 的选择载荷直接拒绝。
    const leaked = { ...view, pendingChoice: { ...(view.pendingChoice as object), seat: 1 } };
    expect(parseMatchServerMessage({ type: 'match', view: leaked })).toMatchObject({ ok: false });
    // 重复 candidateId、step 超过 stepCount、非法 source 都被拒绝。
    const duplicateCandidates = {
      ...view,
      pendingChoice: {
        ...(view.pendingChoice as object),
        cardCandidates: [
          { candidateId: 'c1', card: ENERGY_CARD },
          { candidateId: 'c1', card: CARD },
        ],
      },
    };
    expect(parseMatchServerMessage({ type: 'match', view: duplicateCandidates })).toMatchObject({ ok: false });
    const badStep = { ...view, pendingChoice: { ...(view.pendingChoice as object), step: 3, stepCount: 2 } };
    expect(parseMatchServerMessage({ type: 'match', view: badStep })).toMatchObject({ ok: false });
    const badSource = { ...view, pendingChoice: { ...(view.pendingChoice as object), source: 'library' } };
    expect(parseMatchServerMessage({ type: 'match', view: badSource })).toMatchObject({ ok: false });
    // `selectable` 只接受布尔值。
    const badSelectable = {
      ...view,
      pendingChoice: {
        ...(view.pendingChoice as object),
        cardCandidates: [{ candidateId: 'c1', card: ENERGY_CARD, selectable: 'no' }],
      },
    };
    expect(parseMatchServerMessage({ type: 'match', view: badSelectable })).toMatchObject({ ok: false });
    // `targetLabelZh` 只接受非空字符串或 null。
    const badTargetLabel = {
      ...view,
      pendingChoice: {
        ...(view.pendingChoice as object),
        cardCandidates: [{ candidateId: 'c1', card: ENERGY_CARD, targetLabelZh: 7 }],
      },
    };
    expect(parseMatchServerMessage({ type: 'match', view: badTargetLabel })).toMatchObject({ ok: false });
  });
});

describe('T13 通用选择与复制招式命令（#14）', () => {
  it('解析 select-card / select-target / copy-attack 三类待决选择命令', () => {
    expect(parseMatchClientMessage({ ...BASE, type: 'select-card', choiceId: 'choice-11', candidateIds: ['d1', 'd2'] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'select-card', choiceId: 'choice-11', candidateIds: ['d1', 'd2'] },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'select-target', choiceId: 'choice-11', candidateIds: ['active'] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'select-target', choiceId: 'choice-11', candidateIds: ['active'] },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'select-target', choiceId: 'choice-11', candidateIds: ['opponent-bench-2'] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'select-target', choiceId: 'choice-11', candidateIds: ['opponent-bench-2'] },
    });
    expect(parseMatchClientMessage({ ...BASE, type: 'copy-attack', choiceId: 'choice-11', attackIndex: 1 })).toEqual({
      ok: true,
      message: { ...BASE, type: 'copy-attack', choiceId: 'choice-11', attackIndex: 1 },
    });
  });

  it('拒绝三类新命令的非法载荷与未知字段', () => {
    expect(parseMatchClientMessage({ ...BASE, type: 'select-card', choiceId: 'c', candidateIds: [''] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'select-card', choiceId: 'c', candidateIds: [0] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'select-card', choiceId: 'c', candidateIds: [], seed: 1 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'select-target', choiceId: 'c', candidateIds: ['active'], benchIndex: 0 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'copy-attack', choiceId: 'c', attackIndex: -1 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'copy-attack', choiceId: 'c', attackIndex: 0.5 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'copy-attack', choiceId: 'c', attackIndex: 0, deckOrder: ['x'] })).toMatchObject({ ok: false });
  });

  it('解析新选择种类与新公开事件', () => {
    const selectView = matchView({
      phase: 'playing',
      pendingChoice: {
        choiceId: 'choice-12',
        seat: 0,
        kind: 'select-card',
        min: 0,
        max: 1,
        benchMin: 0,
        benchMax: 0,
        candidates: [],
        step: 1,
        stepCount: 1,
        source: 'opponent-hand',
        descriptionZh: '莉佳的邀请：查看对手手牌并选择 1 张基础宝可梦。',
        cardCandidates: [{ candidateId: 'h1', card: CARD }],
        modes: [],
      },
      events: [
        { seq: 1, type: 'deck-milled', seat: 0, targetSeat: 1, cards: [ENERGY_CARD, CARD] },
        { seq: 2, type: 'pokemon-swapped', seat: 0, target: { slot: 'bench', index: 0 }, fromNameZh: '拖拖蚓', toNameZh: '梦幻ex', toCard: CARD },
      ],
    });
    const parsed = parseMatchServerMessage({ type: 'match', view: selectView });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed !== null && parsed.ok && parsed.message.type === 'match') {
      expect(parsed.message.view.pendingChoice?.kind).toBe('select-card');
      expect(parsed.message.view.pendingChoice?.source).toBe('opponent-hand');
      expect(parsed.message.view.events[0]).toMatchObject({ type: 'deck-milled', targetSeat: 1, cards: [{ cardId: 'cbb1c-1803' }, { cardId: 'csve1-035' }] });
      expect(parsed.message.view.events[1]).toMatchObject({ type: 'pokemon-swapped', target: { slot: 'bench', index: 0 }, fromNameZh: '拖拖蚓' });
    }
    // 目标候选与复制招式选择的 kind/source 也必须通过投影解析。
    const targetView = {
      ...selectView,
      pendingChoice: {
        ...(selectView.pendingChoice as object),
        kind: 'select-target',
        source: 'opponent-bench',
        cardCandidates: [],
      },
    };
    expect(parseMatchServerMessage({ type: 'match', view: targetView })).toMatchObject({ ok: true });
    const copyView = {
      ...selectView,
      pendingChoice: {
        ...(selectView.pendingChoice as object),
        kind: 'copy-attack',
        source: 'opponent-active',
        cardCandidates: [],
      },
    };
    expect(parseMatchServerMessage({ type: 'match', view: copyView })).toMatchObject({ ok: true });
    const ownFieldView = {
      ...selectView,
      pendingChoice: {
        ...(selectView.pendingChoice as object),
        kind: 'select-target',
        source: 'own-field',
        cardCandidates: [],
      },
    };
    expect(parseMatchServerMessage({ type: 'match', view: ownFieldView })).toMatchObject({ ok: true });
  });
});
