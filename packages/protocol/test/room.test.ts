import { describe, expect, it } from 'vitest';
import {
  DECK_FORMAT_VERSION,
  parseClientMessage,
  parseRoomClientMessage,
  parseRoomServerMessage,
  parseServerMessage,
  serializeMessage,
  type DeckValidationResponse,
  type RoomView,
} from '../src/index.ts';

const validation: DeckValidationResponse = {
  formatVersion: DECK_FORMAT_VERSION,
  environmentId: 'zh-cn-standard-2025-06-05',
  catalogVersion: 'a'.repeat(64),
  dataRevision: 'b'.repeat(64),
  totalCards: 60,
  legal: true,
  ready: true,
  problems: [],
};

function roomView(overrides: Partial<RoomView> = {}): RoomView {
  return {
    code: '123456',
    version: 3,
    status: 'waiting',
    you: {
      seat: 0,
      occupied: true,
      host: true,
      nickname: '小智',
      ready: true,
      online: true,
      deckSelected: true,
      deck: { totalCards: 60, validation },
    },
    opponent: {
      seat: 1,
      occupied: true,
      host: false,
      nickname: '小茂',
      ready: false,
      online: true,
      deckSelected: true,
      deck: null,
    },
    match: null,
    ...overrides,
  };
}

describe('房间码契约', () => {
  it('只接受 6 位数字', async () => {
    const { isRoomCode } = await import('../src/index.ts');
    expect(isRoomCode('000000')).toBe(true);
    expect(isRoomCode('123456')).toBe(true);
    expect(isRoomCode('12345')).toBe(false);
    expect(isRoomCode('1234567')).toBe(false);
    expect(isRoomCode('12345a')).toBe(false);
    expect(isRoomCode('１２３４５６')).toBe(false);
  });
});

describe('房间客户端命令解析', () => {
  it('接受建房、加入、选卡组、准备与离开命令', () => {
    const create = parseRoomClientMessage({ type: 'create-room', commandId: 'c1' });
    expect(create).toMatchObject({ ok: true, message: { type: 'create-room', commandId: 'c1' } });

    const join = parseRoomClientMessage({ type: 'join-room', commandId: 'c2', code: '042000' });
    expect(join).toMatchObject({ ok: true, message: { type: 'join-room', code: '042000' } });

    const deck = {
      formatVersion: DECK_FORMAT_VERSION,
      environmentId: 'zh-cn-standard-2025-06-05',
      cards: [{ cardId: 'a', printIdentity: 'print:A:1', effectIdentity: 'fx:a', count: 1 }],
    };
    const select = parseRoomClientMessage({ type: 'select-deck', commandId: 'c3', deck });
    expect(select).toMatchObject({ ok: true, message: { type: 'select-deck' } });

    expect(parseRoomClientMessage({ type: 'set-ready', commandId: 'c4', ready: true })).toMatchObject({ ok: true });
    expect(parseRoomClientMessage({ type: 'leave-room', commandId: 'c5' })).toMatchObject({ ok: true });
  });

  it('拒绝缺 commandId、非法房间码、畸形卡组与非布尔准备值', () => {
    expect(parseRoomClientMessage({ type: 'create-room' })).toMatchObject({ ok: false });
    expect(parseRoomClientMessage({ type: 'join-room', commandId: 'c', code: 'abc' })).toMatchObject({ ok: false });
    expect(parseRoomClientMessage({ type: 'select-deck', commandId: 'c', deck: { nope: true } })).toMatchObject({
      ok: false,
    });
    expect(parseRoomClientMessage({ type: 'set-ready', commandId: 'c', ready: 'yes' })).toMatchObject({ ok: false });
    expect(parseRoomClientMessage({ type: 'leave-room', commandId: '' })).toMatchObject({ ok: false });
  });

  it('非房间消息返回 null，让上层按未知类型处理', () => {
    expect(parseRoomClientMessage({ type: 'hello' })).toBeNull();
    expect(parseRoomClientMessage('not an object')).toBeNull();
  });

  it('统一解析入口同时接受握手与房间命令', () => {
    const parsed = parseClientMessage(JSON.stringify({ type: 'join-room', commandId: 'c', code: '123456' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message).toEqual({ type: 'join-room', commandId: 'c', code: '123456' });
    }
    const invalid = parseClientMessage(JSON.stringify({ type: 'join-room', commandId: 'c', code: '12345' }));
    expect(invalid.ok).toBe(false);
  });
});

describe('房间服务端消息解析', () => {
  it('解析快照并支持座位互换', () => {
    const swapped: RoomView = {
      ...roomView(),
      you: { ...roomView().opponent, seat: 1, host: false, ready: false },
      opponent: { ...roomView().you, seat: 0, host: true, ready: true, deck: null },
    };
    const parsed = parseRoomServerMessage({ type: 'room', room: swapped });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed?.ok) {
      expect(parsed.message.type).toBe('room');
      if (parsed.message.type === 'room') {
        expect(parsed.message.room.you.seat).toBe(1);
        expect(parsed.message.room.opponent.seat).toBe(0);
      }
    }
  });

  it('解析开始后的快照：会话 ID 与初始版本只出现一次', () => {
    const started = roomView({ status: 'started', version: 4, match: { sessionId: 'match-1', version: 1 } });
    const parsed = parseRoomServerMessage({ type: 'room', room: started });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed?.ok && parsed.message.type === 'room') {
      expect(parsed.message.room.match).toEqual({ sessionId: 'match-1', version: 1 });
    }
  });

  it('拒绝对手座位携带卡组摘要，也拒绝 started 缺会话', () => {
    const leaky = roomView();
    const withOpponentDeck = {
      ...leaky,
      opponent: { ...leaky.opponent, deck: { totalCards: 60, validation } },
    };
    expect(parseRoomServerMessage({ type: 'room', room: withOpponentDeck })).toMatchObject({ ok: false });

    const startedWithoutMatch = roomView({ status: 'started', match: null });
    expect(parseRoomServerMessage({ type: 'room', room: startedWithoutMatch })).toMatchObject({ ok: false });
  });

  it('拒绝非法座位映射与旧版本号', () => {
    const sameSeat = roomView();
    sameSeat.you = { ...sameSeat.you, seat: 1 };
    sameSeat.opponent = { ...sameSeat.opponent, seat: 1 };
    expect(parseRoomServerMessage({ type: 'room', room: sameSeat })).toMatchObject({ ok: false });

    const v0 = roomView({ version: 0 });
    expect(parseRoomServerMessage({ type: 'room', room: v0 })).toMatchObject({ ok: false });
  });

  it('解析离开、房主关闭与错误消息（含重试等待与当前快照）', () => {
    expect(parseRoomServerMessage({ type: 'room-left', code: '123456', reason: 'left', commandId: 'c1' })).toMatchObject({
      ok: true,
      message: { type: 'room-left', reason: 'left' },
    });
    expect(parseRoomServerMessage({ type: 'room-closed', code: '123456', reason: 'host-left' })).toMatchObject({
      ok: true,
    });
    expect(
      parseRoomServerMessage({
        type: 'room-error',
        code: 'rate-limited',
        message: '加入尝试过于频繁。',
        commandId: 'c1',
        retryAfterMs: 5000,
      }),
    ).toMatchObject({ ok: true, message: { code: 'rate-limited', retryAfterMs: 5000 } });
    expect(
      parseRoomServerMessage({
        type: 'room-error',
        code: 'deck-not-ready',
        message: '卡组未就绪。',
        validation,
      }),
    ).toMatchObject({ ok: true, message: { code: 'deck-not-ready' } });
    expect(parseRoomServerMessage({ type: 'room-error', code: 'made-up', message: 'x' })).toMatchObject({
      ok: false,
    });
  });

  it('统一序列化与解析入口覆盖房间消息', () => {
    const parsed = parseServerMessage(serializeMessage({ type: 'room', room: roomView() }));
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.message.type).toBe('room');
    }
    const error = parseServerMessage(serializeMessage({ type: 'room-error', code: 'room-not-found', message: '没有这个房间。' }));
    expect(error).toMatchObject({ ok: true, message: { type: 'room-error', code: 'room-not-found' } });
  });

  it('未知类型仍被统一解析器拒绝', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'nope' })).ok).toBe(false);
    expect(parseRoomServerMessage({ type: 'nope' })).toBeNull();
  });
});
