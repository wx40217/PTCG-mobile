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
  type: '水',
  hp: null,
  printDisplayNumber: 'CBB1C 1803/06',
} as const;

function pokemonView(overrides: Partial<MatchPokemonView> = {}): MatchPokemonView {
  return {
    card: CARD,
    damageCounters: 0,
    energies: [],
    attacks: [
      { index: 0, name: '水枪', cost: ['水'], damageText: '10', effectTextZh: null, supported: true },
      { index: 1, name: '海之伴奏', cost: [], damageText: null, effectTextZh: '选择手牌中的水能量…', supported: false },
    ],
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
    },
    pendingChoice: {
      choiceId: 'choice-2',
      seat: 0,
      kind: 'place-setup',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 5,
      candidates: [0],
    },
    waitingForOpponentChoice: false,
    cannotDraw: false,
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
    expect(parseMatchServerMessage({ type: 'match-error', code: 'no-such-code', message: 'x' })).toMatchObject({ ok: false });
    expect(parseMatchServerMessage({ type: 'room', room: {} })).toBeNull();
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
});

