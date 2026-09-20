import {
  parseDeckDocument,
  parseDeckValidationResponse,
  type DeckDocument,
  type DeckValidationResponse,
} from './deck.ts';

/**
 * 房间准备契约（T06）。
 *
 * 房间是「朋友约定参与同一场对战的入口」：服务地址与 6 位房间码分开输入，
 * 加入同一个房间不代表对局已经开始。两个认证座位以设备身份绑定，昵称只作
 * 显示；第三人无法通过重名占用座位。
 *
 * 隐藏信息边界在协议层就固定：每个座位只收到自己的卡组摘要，对手座位
 * `deck` 字段永远是 `null`（解析器主动拒绝违反该约束的载荷）。准备完成后
 * 由服务端校验并固定卡组、环境与目录修订；换卡组会撤销准备。
 *
 * 房间准备的变更彼此独立（双方各自选卡组/准备），因此这里的房间命令只需要
 * `commandId` 做重传幂等；带 `expectedVersion` 的按序命令契约从对局命令
 * （T07）开始。房间快照仍带版本号，客户端可据此忽略乱序旧快照。
 */

export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = /^[0-9]{6}$/u;

export type RoomSeat = 0 | 1;

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value);
}

export interface RoomCommandBase {
  /** 客户端生成的唯一命令 ID；相同 ID 的重传必须返回同一结果，不重复生效。 */
  readonly commandId: string;
}

export interface CreateRoomCommand extends RoomCommandBase {
  readonly type: 'create-room';
}

export interface JoinRoomCommand extends RoomCommandBase {
  readonly type: 'join-room';
  readonly code: string;
}

export interface SelectDeckCommand extends RoomCommandBase {
  readonly type: 'select-deck';
  readonly deck: DeckDocument;
}

export interface SetReadyCommand extends RoomCommandBase {
  readonly type: 'set-ready';
  readonly ready: boolean;
}

export interface LeaveRoomCommand extends RoomCommandBase {
  readonly type: 'leave-room';
}

export type RoomClientMessage =
  | CreateRoomCommand
  | JoinRoomCommand
  | SelectDeckCommand
  | SetReadyCommand
  | LeaveRoomCommand;

/** 本人座位的卡组摘要；对手永远收不到这个结构，只收得到 `deckSelected`。 */
export interface RoomDeckSummary {
  readonly totalCards: number;
  /** 服务端按当前目录独立校验的完整结果（含着精确问题与涉及卡牌）。 */
  readonly validation: DeckValidationResponse;
}

export interface RoomSeatView {
  readonly seat: RoomSeat;
  readonly occupied: boolean;
  readonly host: boolean;
  readonly nickname: string | null;
  readonly ready: boolean;
  /** 该座位当前是否有活跃连接；开局后返回 UI 会让它变为 false，但不释放座位。 */
  readonly online: boolean;
  /** 是否已选择卡组；对手只看得到这个布尔值，看不到卡表。 */
  readonly deckSelected: boolean;
  /** 仅本人座位携带；对手座位必须为 `null`。 */
  readonly deck: RoomDeckSummary | null;
}

export interface RoomMatchView {
  /** 服务端生成的唯一对局会话 ID。 */
  readonly sessionId: string;
  /** 初始状态版本；后续对局命令必须基于它推进。 */
  readonly version: number;
}

export type RoomStatus = 'waiting' | 'started';

export interface RoomView {
  readonly code: string;
  /** 房间快照版本；每次房间可见状态变化递增，用于忽略乱序旧快照。 */
  readonly version: number;
  readonly status: RoomStatus;
  readonly you: RoomSeatView;
  readonly opponent: RoomSeatView;
  /** 双方准备齐全后只建立一次；重传/重复命令返回同一个会话与版本。 */
  readonly match: RoomMatchView | null;
}

export interface RoomSnapshotMessage {
  readonly type: 'room';
  readonly room: RoomView;
}

export type RoomLeaveReason = 'left' | 'host-left';

export interface RoomLeftMessage {
  readonly type: 'room-left';
  readonly code: string;
  readonly reason: RoomLeaveReason;
  readonly commandId?: string;
}

export interface RoomClosedMessage {
  readonly type: 'room-closed';
  readonly code: string;
  readonly reason: 'host-left';
}

export const ROOM_ERROR_CODES = [
  'invalid-room-code',
  'room-not-found',
  'room-closed',
  'room-full',
  'already-in-room',
  'not-in-room',
  'seat-taken-over',
  'invalid-deck',
  'deck-required',
  'deck-not-ready',
  'match-started',
  'catalog-unavailable',
  'rate-limited',
  'command-id-reused',
  'invalid-message',
] as const;

export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number];

export function isRoomErrorCode(value: unknown): value is RoomErrorCode {
  return typeof value === 'string' && (ROOM_ERROR_CODES as readonly string[]).includes(value);
}

export interface RoomErrorMessage {
  readonly type: 'room-error';
  readonly code: RoomErrorCode;
  readonly message: string;
  /** 对应命令；无法归属的命令（如畸形消息）省略。 */
  readonly commandId?: string;
  /** 版本冲突等场景回传服务端当前快照，让客户端重新同步。 */
  readonly room?: RoomView;
  /** 卡组未就绪时回传服务端独立校验的具体问题。 */
  readonly validation?: DeckValidationResponse;
  /** 限速时建议的重试等待毫秒数。 */
  readonly retryAfterMs?: number;
}

export type RoomServerMessage = RoomSnapshotMessage | RoomLeftMessage | RoomClosedMessage | RoomErrorMessage;

export type ParseResult<T> = { readonly ok: true; readonly message: T } | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/* ------------------------------------------------------------------ */
/* 客户端房间命令                                                      */
/* ------------------------------------------------------------------ */

/**
 * 解析一条房间命令。
 *
 * 返回 `null` 表示这不是房间命令（调用方按未知类型处理）；结构错误通过
 * `ParseResult` 的失败分支报告。
 */
export function parseRoomClientMessage(decoded: unknown): ParseResult<RoomClientMessage> | null {
  if (!isRecord(decoded)) {
    return null;
  }
  const type = decoded['type'];
  if (type !== 'create-room' && type !== 'join-room' && type !== 'select-deck' && type !== 'set-ready' && type !== 'leave-room') {
    return null;
  }
  const commandId = decoded['commandId'];
  if (!isNonEmptyString(commandId)) {
    return { ok: false, error: `${type}.commandId 缺失` };
  }
  if (type === 'create-room') {
    return { ok: true, message: { type, commandId } };
  }
  if (type === 'join-room') {
    const code = decoded['code'];
    if (!isRoomCode(code)) {
      return { ok: false, error: 'join-room.code 必须是 6 位数字' };
    }
    return { ok: true, message: { type, commandId, code } };
  }
  if (type === 'select-deck') {
    const parsed = parseDeckDocument(decoded['deck']);
    if (!parsed.ok) {
      return { ok: false, error: `select-deck.deck 无效：${parsed.errors[0] ?? '结构错误'}` };
    }
    return { ok: true, message: { type, commandId, deck: parsed.deck } };
  }
  if (type === 'set-ready') {
    const ready = decoded['ready'];
    if (typeof ready !== 'boolean') {
      return { ok: false, error: 'set-ready.ready 必须是布尔值' };
    }
    return { ok: true, message: { type, commandId, ready } };
  }
  return { ok: true, message: { type: 'leave-room', commandId } };
}

/* ------------------------------------------------------------------ */
/* 服务端房间消息                                                      */
/* ------------------------------------------------------------------ */

function parseSeatView(value: unknown, seat: RoomSeat, opponent: boolean): ParseResult<RoomSeatView> {
  if (!isRecord(value)) {
    return { ok: false, error: '座位视图必须是对象' };
  }
  if (value['seat'] !== seat) {
    return { ok: false, error: `座位视图 seat 必须是 ${seat}` };
  }
  if (typeof value['occupied'] !== 'boolean' || typeof value['host'] !== 'boolean' || typeof value['ready'] !== 'boolean') {
    return { ok: false, error: '座位视图缺少 occupied/host/ready 布尔字段' };
  }
  if (typeof value['online'] !== 'boolean') {
    return { ok: false, error: '座位视图缺少 online' };
  }
  if (typeof value['deckSelected'] !== 'boolean') {
    return { ok: false, error: '座位视图缺少 deckSelected' };
  }
  const nickname = value['nickname'];
  if (nickname !== null && typeof nickname !== 'string') {
    return { ok: false, error: '座位视图 nickname 必须是字符串或 null' };
  }
  const rawDeck = value['deck'];
  let deck: RoomDeckSummary | null = null;
  if (rawDeck !== null && rawDeck !== undefined) {
    if (opponent) {
      // 隐私边界：对手载荷中出现卡组摘要即视为协议违规，客户端不得渲染它。
      return { ok: false, error: '对手座位不得携带卡组摘要' };
    }
    if (!isRecord(rawDeck)) {
      return { ok: false, error: '卡组摘要必须是对象' };
    }
    if (!Number.isInteger(rawDeck['totalCards'])) {
      return { ok: false, error: '卡组摘要缺少 totalCards' };
    }
    const validation = parseDeckValidationResponse(rawDeck['validation']);
    if (validation === null) {
      return { ok: false, error: '卡组摘要的校验结果结构无效' };
    }
    deck = { totalCards: rawDeck['totalCards'] as number, validation };
  }
  return {
    ok: true,
    message: {
      seat,
      occupied: value['occupied'],
      host: value['host'],
      nickname,
      ready: value['ready'],
      online: value['online'],
      deckSelected: value['deckSelected'],
      deck,
    },
  };
}

function parseRoomView(value: unknown): ParseResult<RoomView> | null {
  if (!isRecord(value)) {
    return { ok: false, error: '房间快照必须是对象' };
  }
  const code = value['code'];
  if (!isRoomCode(code)) {
    return { ok: false, error: '房间快照的 code 必须是 6 位数字' };
  }
  if (!Number.isInteger(value['version']) || (value['version'] as number) < 1) {
    return { ok: false, error: '房间快照缺少版本号' };
  }
  const status = value['status'];
  if (status !== 'waiting' && status !== 'started') {
    return { ok: false, error: '房间快照的 status 非法' };
  }
  const rawYou = value['you'];
  const rawOpponent = value['opponent'];
  if (!isRecord(rawYou) || !isRecord(rawOpponent)) {
    return { ok: false, error: '房间快照缺少 you/opponent' };
  }
  const youSeat = rawYou['seat'];
  const opponentSeat = rawOpponent['seat'];
  if ((youSeat !== 0 && youSeat !== 1) || (opponentSeat !== 0 && opponentSeat !== 1) || youSeat === opponentSeat) {
    return { ok: false, error: '房间快照的座位映射非法' };
  }
  const parsedYou = parseSeatView(rawYou, youSeat, false);
  if (!parsedYou.ok) {
    return parsedYou;
  }
  const parsedOpponent = parseSeatView(rawOpponent, opponentSeat, true);
  if (!parsedOpponent.ok) {
    return parsedOpponent;
  }
  const rawMatch = value['match'];
  let match: RoomMatchView | null = null;
  if (rawMatch !== null && rawMatch !== undefined) {
    if (!isRecord(rawMatch) || !isNonEmptyString(rawMatch['sessionId']) || !Number.isInteger(rawMatch['version'])) {
      return { ok: false, error: '房间快照的 match 结构无效' };
    }
    match = { sessionId: rawMatch['sessionId'], version: rawMatch['version'] as number };
  }
  if (status === 'started' && match === null) {
    return { ok: false, error: '已开局的房间必须携带对局会话' };
  }
  return {
    ok: true,
    message: {
      code,
      version: value['version'] as number,
      status,
      you: parsedYou.message,
      opponent: parsedOpponent.message,
      match,
    },
  };
}

/**
 * 解析一条服务端房间消息；不是房间消息时返回 `null`。
 *
 * 对手座位携带卡组摘要、对局状态缺失等违反契约的载荷会被拒绝，而不是
 * 静默丢弃字段 —— 隐私边界不能靠“界面恰好没渲染”来保证。
 */
export function parseRoomServerMessage(decoded: unknown): ParseResult<RoomServerMessage> | null {
  if (!isRecord(decoded)) {
    return null;
  }
  const type = decoded['type'];
  if (type === 'room') {
    const room = parseRoomView(decoded['room']);
    if (room === null) {
      return null;
    }
    return room.ok ? { ok: true, message: { type: 'room', room: room.message } } : room;
  }
  if (type === 'room-left') {
    const code = decoded['code'];
    if (!isRoomCode(code)) {
      return { ok: false, error: 'room-left.code 必须是 6 位数字' };
    }
    const reason = decoded['reason'];
    if (reason !== 'left' && reason !== 'host-left') {
      return { ok: false, error: 'room-left.reason 非法' };
    }
    const commandId = decoded['commandId'];
    if (commandId !== undefined && !isNonEmptyString(commandId)) {
      return { ok: false, error: 'room-left.commandId 非法' };
    }
    return {
      ok: true,
      message: { type: 'room-left', code, reason, ...(commandId === undefined ? {} : { commandId }) },
    };
  }
  if (type === 'room-closed') {
    const code = decoded['code'];
    if (!isRoomCode(code) || decoded['reason'] !== 'host-left') {
      return { ok: false, error: 'room-closed 结构非法' };
    }
    return { ok: true, message: { type: 'room-closed', code, reason: 'host-left' } };
  }
  if (type === 'room-error') {
    const code = decoded['code'];
    if (!isRoomErrorCode(code)) {
      return { ok: false, error: `未知的房间错误码: ${String(code)}` };
    }
    const message = decoded['message'];
    if (typeof message !== 'string') {
      return { ok: false, error: 'room-error.message 缺失' };
    }
    const commandId = decoded['commandId'];
    if (commandId !== undefined && !isNonEmptyString(commandId)) {
      return { ok: false, error: 'room-error.commandId 非法' };
    }
    const retryAfterMs = decoded['retryAfterMs'];
    if (retryAfterMs !== undefined && (!Number.isInteger(retryAfterMs) || (retryAfterMs as number) < 0)) {
      return { ok: false, error: 'room-error.retryAfterMs 非法' };
    }
    let room: RoomView | undefined;
    if (decoded['room'] !== undefined) {
      const parsedRoom = parseRoomView(decoded['room']);
      if (parsedRoom === null || !parsedRoom.ok) {
        return parsedRoom ?? { ok: false, error: 'room-error.room 结构非法' };
      }
      room = parsedRoom.message;
    }
    let validation: DeckValidationResponse | undefined;
    if (decoded['validation'] !== undefined) {
      const parsedValidation = parseDeckValidationResponse(decoded['validation']);
      if (parsedValidation === null) {
        return { ok: false, error: 'room-error.validation 结构无效' };
      }
      validation = parsedValidation;
    }
    return {
      ok: true,
      message: {
        type: 'room-error',
        code,
        message,
        ...(commandId === undefined ? {} : { commandId }),
        ...(room === undefined ? {} : { room }),
        ...(validation === undefined ? {} : { validation }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs: retryAfterMs as number }),
      },
    };
  }
  return null;
}
