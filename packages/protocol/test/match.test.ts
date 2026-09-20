import { describe, expect, it } from 'vitest';
import {
  MATCH_ERROR_CODES,
  parseMatchClientMessage,
  parseMatchServerMessage,
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
      revealed: true,
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
      revealed: false,
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
    events: [
      { seq: 1, type: 'match-created', seats: ['小智', '小茂'] },
      { seq: 2, type: 'turn-order-flip', winner: 0 },
      { seq: 3, type: 'turn-order-chosen', seat: 0, goFirst: true },
      { seq: 4, type: 'mulligan', seat: 1, count: 1, cards: [CARD] },
    ],
    ...overrides,
  };
}

const BASE = { commandId: 'c-1', sessionId: 'session-1', expectedVersion: 3 } as const;

describe('对局命令解析（#8）', () => {
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
    expect(parseMatchClientMessage({ ...BASE, type: 'place-compensation-bench', choiceId: 'choice-2', bench: [7] })).toEqual({
      ok: true,
      message: { ...BASE, type: 'place-compensation-bench', choiceId: 'choice-2', bench: [7] },
    });
  });

  it('非对局命令返回 null，结构错误返回明确错误', () => {
    expect(parseMatchClientMessage({ type: 'create-room', commandId: 'x' })).toBeNull();
    expect(parseMatchClientMessage({ ...BASE, type: 'place-setup', choiceId: 'c', active: -1, bench: [] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'place-setup', choiceId: 'c', active: 0, bench: [1.5] })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'resolve-compensation', choiceId: 'c', draw: -1 })).toMatchObject({ ok: false });
    expect(parseMatchClientMessage({ ...BASE, type: 'choose-turn-order', choiceId: 'c', goFirst: 'yes' })).toMatchObject({ ok: false });
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

  it('对手手牌身份出现在载荷中即拒绝（不靠界面不渲染兜底）', () => {
    const leaked = matchView();
    const broken = { ...leaked, opponent: { ...leaked.opponent, hand: [CARD], handCount: 1 } };
    expect(parseMatchServerMessage({ type: 'match', view: broken })).toMatchObject({ ok: false });
  });

  it('翻面前对手初始宝可梦身份出现在载荷中即拒绝', () => {
    const leaked = matchView();
    const broken = {
      ...leaked,
      opponent: { ...leaked.opponent, active: { card: CARD }, bench: [{ card: CARD }] },
    };
    expect(parseMatchServerMessage({ type: 'match', view: broken })).toMatchObject({ ok: false });
    // 公开翻面（playing）后同样的身份是合法公开信息。
    const revealed = { ...broken, phase: 'playing' as const, opponent: { ...broken.opponent, revealed: true } };
    expect(parseMatchServerMessage({ type: 'match', view: revealed })).toMatchObject({ ok: true });
  });

  it('其他人的待决选择不得发到本人视图', () => {
    const leaked = matchView();
    const broken = { ...leaked, pendingChoice: { ...(leaked.pendingChoice as object), seat: 1 } };
    expect(parseMatchServerMessage({ type: 'match', view: broken })).toMatchObject({ ok: false });
  });

  it('公开错误码列表包含越权与旧选择码', () => {
    for (const code of ['not-your-choice', 'stale-choice', 'stale-version', 'command-id-reused', 'choice-pending', 'illegal-choice']) {
      expect(MATCH_ERROR_CODES).toContain(code);
    }
  });
});
