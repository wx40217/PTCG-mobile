import { randomInt, randomUUID } from 'node:crypto';
import {
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN,
  isRoomCode,
  parseDeckDocument,
  validateDeck,
  type CatalogContent,
  type DeckDocument,
  type DeckValidationResponse,
  type RoomClientMessage,
  type RoomErrorCode,
  type RoomSeat,
  type RoomServerMessage,
  type RoomSeatView,
  type RoomView,
} from '@ptcg/protocol';

/**
 * 房间注册表（T06）。
 *
 * 职责：
 *   - 生成不可预测、无冲突的 6 位房间码；
 *   - 两个认证座位（按设备身份绑定，昵称只作显示）；第三人/重复加入/错误房间
 *     都有明确的错误码，且没有任何旁观者视图；
 *   - 加入尝试限速；
 *   - 选择卡组时用服务端当前目录独立校验；准备时再次校验并固定卡组与规则/
 *     环境修订；换卡组立即撤销准备；
 *   - 双方准备齐全后只建立一次对局会话（唯一 `sessionId` 与初始版本 1），
 *     命令重传按座位去重，返回同一结果；
 *   - 房主在开局前离开关闭房间；来宾离开释放座位；开局后离开只标记离线，
 *     不关闭对局、不构成认输。
 *
 * 注册表是纯同步的：Node 的事件循环让「并发准备」串行处理，配合每个座位的
 * 命令去重缓存，重复/并发命令不会创建第二场对局。出站消息通过 `channel`
 * 注入，便于在真实 socket 与测试记录器之间切换。
 */

export interface RoomCatalogView {
  readonly content: CatalogContent;
  readonly catalogVersion: string;
}

export interface RoomLimits {
  readonly joinAttempts: number;
  readonly joinWindowMs: number;
  readonly createAttempts: number;
  readonly createWindowMs: number;
  /** 未开局且长期无活动的房间回收时间。 */
  readonly roomIdleTtlMs: number;
  /** 已关闭房间码的墓碑保留时间，用于区分「不存在」与「已关闭」。 */
  readonly closedCodeTtlMs: number;
  /** 每个座位保留的命令去重条数。 */
  readonly commandHistorySize: number;
}

export const DEFAULT_ROOM_LIMITS: RoomLimits = {
  joinAttempts: 5,
  joinWindowMs: 10_000,
  createAttempts: 5,
  createWindowMs: 60_000,
  roomIdleTtlMs: 2 * 60 * 60_000,
  closedCodeTtlMs: 60_000,
  commandHistorySize: 32,
};

export interface RoomConnection {
  readonly connectionId: string;
  readonly deviceId: string;
  readonly nickname: string;
}

export interface RoomChannel {
  /** 把消息发给指定连接；连接已不存在时实现应静默忽略。 */
  send(connectionId: string, message: RoomServerMessage): void;
}

export interface RoomRegistryOptions {
  readonly now?: () => number;
  readonly limits?: Partial<RoomLimits>;
  /** 房间码生成器；测试注入确定性/碰撞序列。默认 `crypto.randomInt`。 */
  readonly generateCode?: () => string;
  readonly newSessionId?: () => string;
  /** 当前目录访问器；目录未加载时返回 null，选卡组/准备会给出明确错误。 */
  readonly catalog: () => RoomCatalogView | null;
  readonly channel: RoomChannel;
  readonly logger?: (event: string, fields: Record<string, unknown>) => void;
}

export interface RoomRegistry {
  createRoom(connection: RoomConnection): void;
  joinRoom(connection: RoomConnection, code: string): void;
  handleCommand(connection: RoomConnection, message: RoomClientMessage): void;
  /** 断线：座位保留（可在新连接上重入），只把连接标记为离线。 */
  detachConnection(connectionId: string): void;
}

interface FrozenDeck {
  readonly deck: DeckDocument;
  readonly validation: DeckValidationResponse;
  readonly environmentId: string;
  readonly catalogVersion: string;
  readonly dataRevision: string;
  readonly frozenAt: number;
}

interface CachedResponse {
  readonly fingerprint: string;
  readonly message: RoomServerMessage;
}

interface SeatState {
  deviceId: string;
  nickname: string;
  connectionId: string | null;
  deck: DeckDocument | null;
  validation: DeckValidationResponse | null;
  ready: boolean;
  frozen: FrozenDeck | null;
  readonly commands: Map<string, CachedResponse>;
  readonly commandOrder: string[];
}

interface MatchState {
  readonly sessionId: string;
  readonly version: number;
  readonly createdAt: number;
  readonly seats: readonly [string, string];
  readonly frozenDecks: readonly [FrozenDeck, FrozenDeck];
}

interface RoomState {
  readonly code: string;
  version: number;
  status: 'waiting' | 'started';
  createdAt: number;
  lastActivityAt: number;
  seats: [SeatState | null, SeatState | null];
  match: MatchState | null;
}

/** 六个数字的房间码；`crypto.randomInt` 排除可预测的 `Math.random`。 */
function defaultGenerateCode(): string {
  return String(randomInt(0, 10 ** ROOM_CODE_LENGTH)).padStart(ROOM_CODE_LENGTH, '0');
}

function fingerprintOf(message: RoomClientMessage): string {
  const record: Record<string, unknown> = { ...message };
  delete record['commandId'];
  const keys = Object.keys(record).sort();
  return JSON.stringify(keys.map((key) => [key, record[key]]));
}

function totalCards(deck: DeckDocument): number {
  return deck.cards.reduce((sum, entry) => sum + entry.count, 0);
}

class SlidingWindowLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  public constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  public check(key: string, now: number): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number } {
    const history = (this.attempts.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (history.length >= this.max) {
      this.attempts.set(key, history);
      const retryAfterMs = this.windowMs - (now - (history[0] as number));
      return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
    }
    history.push(now);
    this.attempts.set(key, history);
    return { allowed: true };
  }
}

export function createRoomRegistry(options: RoomRegistryOptions): RoomRegistry {
  const now = options.now ?? (() => Date.now());
  const limits: RoomLimits = { ...DEFAULT_ROOM_LIMITS, ...options.limits };
  const generateCode = options.generateCode ?? defaultGenerateCode;
  const newSessionId = options.newSessionId ?? (() => randomUUID());
  const log = options.logger ?? (() => undefined);

  const rooms = new Map<string, RoomState>();
  /** 设备 → 房间码；一个设备同一时间只能在一个房间里。 */
  const deviceRoom = new Map<string, string>();
  /** 房间码 → 关闭时间戳；用于区分「不存在」与「已关闭」。 */
  const closedCodes = new Map<string, number>();
  /** connectionId → 设备身份；命令必须由当前活跃连接发出。 */
  const connections = new Map<string, RoomConnection>();

  const joinLimiter = new SlidingWindowLimiter(limits.joinAttempts, limits.joinWindowMs);
  const createLimiter = new SlidingWindowLimiter(limits.createAttempts, limits.createWindowMs);

  function noteActivity(room: RoomState): void {
    room.lastActivityAt = now();
  }

  function dropConnection(connectionId: string | null): void {
    if (connectionId !== null) {
      connections.delete(connectionId);
    }
  }

  function sweep(): void {
    const at = now();
    for (const [code, room] of rooms) {
      if (room.status === 'waiting' && at - room.lastActivityAt > limits.roomIdleTtlMs) {
        rooms.delete(code);
        closedCodes.set(code, at);
        for (const seat of room.seats) {
          if (seat !== null) {
            deviceRoom.delete(seat.deviceId);
            dropConnection(seat.connectionId);
          }
        }
        log('room.expired', { code });
      }
    }
    for (const [code, closedAt] of closedCodes) {
      if (at - closedAt > limits.closedCodeTtlMs) {
        closedCodes.delete(code);
      }
    }
  }

  function sendTo(connectionId: string | null, message: RoomServerMessage): void {
    if (connectionId !== null) {
      options.channel.send(connectionId, message);
    }
  }

  function snapshot(room: RoomState, seat: RoomSeat): RoomServerMessage {
    return { type: 'room', room: roomViewFor(room, seat) };
  }

  function sendSnapshot(room: RoomState, seat: RoomSeat): RoomServerMessage {
    const state = room.seats[seat];
    const message = snapshot(room, seat);
    sendTo(state?.connectionId ?? null, message);
    return message;
  }

  function sendOther(room: RoomState, seat: RoomSeat): void {
    const state = room.seats[seat];
    sendTo(state?.connectionId ?? null, snapshot(room, seat));
  }

  function broadcast(room: RoomState): void {
    sendOther(room, 0);
    sendOther(room, 1);
  }

  function sendError(
    connectionId: string,
    code: RoomErrorCode,
    message: string,
    extra: {
      readonly commandId?: string;
      readonly validation?: DeckValidationResponse;
      readonly retryAfterMs?: number;
      readonly room?: RoomView;
    } = {},
  ): RoomServerMessage {
    const result: RoomServerMessage = {
      type: 'room-error',
      code,
      message,
      ...(extra.commandId === undefined ? {} : { commandId: extra.commandId }),
      ...(extra.validation === undefined ? {} : { validation: extra.validation }),
      ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
      ...(extra.room === undefined ? {} : { room: extra.room }),
    };
    sendTo(connectionId, result);
    return result;
  }

  function seatViewFor(room: RoomState, seat: RoomSeat, viewer: RoomSeat): RoomSeatView {
    const state = room.seats[seat];
    if (state === null) {
      return {
        seat,
        occupied: false,
        host: seat === 0,
        nickname: null,
        ready: false,
        online: false,
        deckSelected: false,
        deck: null,
      };
    }
    const own = seat === viewer;
    return {
      seat,
      occupied: true,
      host: seat === 0,
      nickname: state.nickname,
      ready: state.ready,
      online: state.connectionId !== null,
      deckSelected: state.deck !== null,
      // 隐私边界：对手座位永远不携带卡组摘要，客户端解析器也会拒绝泄露载荷。
      deck:
        own && state.deck !== null && state.validation !== null
          ? { totalCards: totalCards(state.deck), validation: state.validation }
          : null,
    };
  }

  function roomViewFor(room: RoomState, viewer: RoomSeat): RoomView {
    const other: RoomSeat = viewer === 0 ? 1 : 0;
    return {
      code: room.code,
      version: room.version,
      status: room.status,
      you: seatViewFor(room, viewer, viewer),
      opponent: seatViewFor(room, other, viewer),
      match: room.match === null ? null : { sessionId: room.match.sessionId, version: room.match.version },
    };
  }

  function findSeat(room: RoomState, deviceId: string): RoomSeat | null {
    if (room.seats[0]?.deviceId === deviceId) {
      return 0;
    }
    if (room.seats[1]?.deviceId === deviceId) {
      return 1;
    }
    return null;
  }

  function cacheResponse(seat: SeatState, message: RoomClientMessage, response: RoomServerMessage): void {
    seat.commands.set(message.commandId, { fingerprint: fingerprintOf(message), message: response });
    seat.commandOrder.push(message.commandId);
    while (seat.commandOrder.length > limits.commandHistorySize) {
      const oldest = seat.commandOrder.shift();
      if (oldest !== undefined) {
        seat.commands.delete(oldest);
      }
    }
  }

  type ResolvedSeat =
    | { readonly room: RoomState; readonly seat: RoomSeat; readonly state: SeatState }
    | { readonly rejected: RoomServerMessage };

  function requireSeat(connection: RoomConnection, message: RoomClientMessage): ResolvedSeat {
    const code = deviceRoom.get(connection.deviceId);
    if (code === undefined) {
      return {
        rejected: sendError(connection.connectionId, 'not-in-room', '你还没有加入任何房间。', {
          commandId: message.commandId,
        }),
      };
    }
    const room = rooms.get(code);
    const seat = room === undefined ? null : findSeat(room, connection.deviceId);
    if (room === undefined || seat === null) {
      deviceRoom.delete(connection.deviceId);
      return {
        rejected: sendError(connection.connectionId, 'room-closed', '房间已关闭。', { commandId: message.commandId }),
      };
    }
    const state = room.seats[seat] as SeatState;
    if (state.connectionId !== connection.connectionId) {
      return {
        rejected: sendError(connection.connectionId, 'seat-taken-over', '本座位已由新的连接接管，请重新加入。', {
          commandId: message.commandId,
          room: roomViewFor(room, seat),
        }),
      };
    }
    const cached = state.commands.get(message.commandId);
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprintOf(message)) {
        return {
          rejected: sendError(connection.connectionId, 'command-id-reused', '命令 ID 已用于不同的请求，请使用新的命令 ID。', {
            commandId: message.commandId,
            room: roomViewFor(room, seat),
          }),
        };
      }
      sendTo(connection.connectionId, cached.message);
      return { rejected: cached.message };
    }
    return { room, seat, state };
  }

  function selectDeck(
    room: RoomState,
    seat: RoomSeat,
    state: SeatState,
    message: Extract<RoomClientMessage, { type: 'select-deck' }>,
  ): RoomServerMessage {
    const connectionId = state.connectionId as string;
    if (room.status === 'started') {
      return sendError(connectionId, 'match-started', '对局已经建立，不能再更换卡组。', {
        commandId: message.commandId,
        room: roomViewFor(room, seat),
      });
    }
    const parsed = parseDeckDocument(message.deck);
    if (!parsed.ok) {
      return sendError(connectionId, 'invalid-deck', parsed.errors[0] ?? '卡组结构无效。', {
        commandId: message.commandId,
      });
    }
    const catalog = options.catalog();
    if (catalog === null) {
      return sendError(connectionId, 'catalog-unavailable', '服务端卡牌目录未加载，暂时无法校验卡组。', {
        commandId: message.commandId,
      });
    }
    const validation = validateDeck(parsed.deck, catalog);
    state.deck = parsed.deck;
    state.validation = validation;
    // 换卡组（含同卡组重新提交）都撤销准备：双方必须基于已确认的同一份卡组开局。
    state.ready = false;
    state.frozen = null;
    room.version += 1;
    noteActivity(room);
    log('room.deck_selected', {
      code: room.code,
      seat,
      totalCards: validation.totalCards,
      legal: validation.legal,
      ready: validation.ready,
    });
    const response = sendSnapshot(room, seat);
    sendOther(room, seat === 0 ? 1 : 0);
    return response;
  }

  function setReady(
    room: RoomState,
    seat: RoomSeat,
    state: SeatState,
    message: Extract<RoomClientMessage, { type: 'set-ready' }>,
  ): RoomServerMessage {
    const connectionId = state.connectionId as string;
    if (room.status === 'started') {
      return sendError(connectionId, 'match-started', '对局已经建立，不能再更改准备状态。', {
        commandId: message.commandId,
        room: roomViewFor(room, seat),
      });
    }
    if (!message.ready) {
      state.ready = false;
      state.frozen = null;
      room.version += 1;
      noteActivity(room);
      log('room.unready', { code: room.code, seat });
      const response = sendSnapshot(room, seat);
      sendOther(room, seat === 0 ? 1 : 0);
      return response;
    }
    if (state.deck === null) {
      return sendError(connectionId, 'deck-required', '请先选择一副卡组再准备。', { commandId: message.commandId });
    }
    const catalog = options.catalog();
    if (catalog === null) {
      return sendError(connectionId, 'catalog-unavailable', '服务端卡牌目录未加载，暂时无法准备。', {
        commandId: message.commandId,
      });
    }
    // 准备时重新校验并固定修订；客户端声明的就绪状态从不被信任。
    const validation = validateDeck(state.deck, catalog);
    state.validation = validation;
    if (!validation.ready) {
      state.ready = false;
      state.frozen = null;
      return sendError(connectionId, 'deck-not-ready', '卡组还不能用于正式对战，请根据校验结果调整。', {
        commandId: message.commandId,
        validation,
        room: roomViewFor(room, seat),
      });
    }
    state.ready = true;
    state.frozen = {
      deck: state.deck,
      validation,
      environmentId: validation.environmentId,
      catalogVersion: validation.catalogVersion,
      dataRevision: validation.dataRevision,
      frozenAt: now(),
    };
    room.version += 1;
    noteActivity(room);
    log('room.ready', {
      code: room.code,
      seat,
      totalCards: validation.totalCards,
      catalogVersion: validation.catalogVersion,
    });

    const first = room.seats[0];
    const second = room.seats[1];
    if (first !== null && second !== null && first.ready && second.ready && room.match === null) {
      // 双方都就绪且尚未开局：只在这里创建一次对局会话。
      room.match = {
        sessionId: newSessionId(),
        version: 1,
        createdAt: now(),
        seats: [first.deviceId, second.deviceId],
        frozenDecks: [first.frozen as FrozenDeck, second.frozen as FrozenDeck],
      };
      room.status = 'started';
      room.version += 1;
      log('room.match_created', {
        code: room.code,
        sessionId: room.match.sessionId,
        version: room.match.version,
        catalogVersion: first.frozen?.catalogVersion,
        environmentId: first.frozen?.environmentId,
        totalCards: [
          totalCards((first.frozen as FrozenDeck).deck),
          totalCards((second.frozen as FrozenDeck).deck),
        ],
      });
      const response = sendSnapshot(room, seat);
      sendOther(room, seat === 0 ? 1 : 0);
      return response;
    }

    const response = sendSnapshot(room, seat);
    sendOther(room, seat === 0 ? 1 : 0);
    return response;
  }

  function leaveRoom(
    room: RoomState,
    seat: RoomSeat,
    state: SeatState,
    message: Extract<RoomClientMessage, { type: 'leave-room' }>,
  ): RoomServerMessage {
    const other: RoomSeat = seat === 0 ? 1 : 0;
    if (room.status === 'started') {
      // 开局后返回 UI 不是认输：只标记离线，保留座位、卡组与对局会话。
      state.connectionId = null;
      room.version += 1;
      noteActivity(room);
      log('room.detached_after_start', { code: room.code, seat });
      sendOther(room, other);
      return { type: 'room-left', code: room.code, reason: 'left', commandId: message.commandId };
    }
    if (seat === 0) {
      // 房主在开局前离开：关闭房间并通知剩余座位。
      rooms.delete(room.code);
      closedCodes.set(room.code, now());
      deviceRoom.delete(state.deviceId);
      dropConnection(state.connectionId);
      const otherState = room.seats[other];
      if (otherState !== null) {
        deviceRoom.delete(otherState.deviceId);
        sendTo(otherState.connectionId, { type: 'room-closed', code: room.code, reason: 'host-left' });
        dropConnection(otherState.connectionId);
      }
      log('room.host_left', { code: room.code });
      return { type: 'room-left', code: room.code, reason: 'host-left', commandId: message.commandId };
    }
    // 来宾离开：释放座位；房间只剩房主（或空房立即回收）。
    room.seats[seat] = null;
    deviceRoom.delete(state.deviceId);
    dropConnection(state.connectionId);
    room.version += 1;
    noteActivity(room);
    log('room.guest_left', { code: room.code, seat });
    sendOther(room, other);
    if (room.seats[0] === null && room.seats[1] === null) {
      rooms.delete(room.code);
      closedCodes.set(room.code, now());
    }
    return { type: 'room-left', code: room.code, reason: 'left', commandId: message.commandId };
  }

  return {
    createRoom(connection): void {
      sweep();
      connections.set(connection.connectionId, connection);
      const existing = deviceRoom.get(connection.deviceId);
      if (existing !== undefined) {
        const room = rooms.get(existing);
        const seat = room === undefined ? null : findSeat(room, connection.deviceId);
        if (room !== undefined && seat !== null) {
          // 重传/重复建房：回到已有房间，不产生第二间房。
          const state = room.seats[seat] as SeatState;
          state.connectionId = connection.connectionId;
          state.nickname = connection.nickname;
          noteActivity(room);
          sendSnapshot(room, seat);
          return;
        }
      }
      const limit = createLimiter.check(connection.deviceId, now());
      if (!limit.allowed) {
        sendError(connection.connectionId, 'rate-limited', '建房请求过于频繁，请稍后再试。', {
          retryAfterMs: limit.retryAfterMs,
        });
        return;
      }
      let code: string | undefined;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const candidate = generateCode();
        if (!ROOM_CODE_PATTERN.test(candidate)) {
          throw new Error(`房间码生成器返回了非法值: ${candidate}`);
        }
        if (!rooms.has(candidate) && !closedCodes.has(candidate)) {
          code = candidate;
          break;
        }
      }
      if (code === undefined) {
        sendError(connection.connectionId, 'rate-limited', '暂时无法分配房间码，请稍后再试。', { retryAfterMs: 1000 });
        return;
      }
      const at = now();
      const seat0: SeatState = {
        deviceId: connection.deviceId,
        nickname: connection.nickname,
        connectionId: connection.connectionId,
        deck: null,
        validation: null,
        ready: false,
        frozen: null,
        commands: new Map(),
        commandOrder: [],
      };
      const room: RoomState = {
        code,
        version: 1,
        status: 'waiting',
        createdAt: at,
        lastActivityAt: at,
        seats: [seat0, null],
        match: null,
      };
      rooms.set(code, room);
      deviceRoom.set(connection.deviceId, code);
      log('room.created', { code });
      sendSnapshot(room, 0);
    },

    joinRoom(connection, code): void {
      sweep();
      connections.set(connection.connectionId, connection);
      const limit = joinLimiter.check(connection.deviceId, now());
      if (!limit.allowed) {
        sendError(connection.connectionId, 'rate-limited', '加入尝试过于频繁，请稍后再试。', {
          retryAfterMs: limit.retryAfterMs,
        });
        return;
      }
      if (!isRoomCode(code)) {
        sendError(connection.connectionId, 'invalid-room-code', '房间码必须是 6 位数字。');
        return;
      }
      const current = deviceRoom.get(connection.deviceId);
      if (current !== undefined && current !== code) {
        const currentRoom = rooms.get(current);
        const currentSeat = currentRoom === undefined ? null : findSeat(currentRoom, connection.deviceId);
        sendError(connection.connectionId, 'already-in-room', `你已经在一个房间（${current}）里，请先离开。`, {
          ...(currentRoom === undefined || currentSeat === null ? {} : { room: roomViewFor(currentRoom, currentSeat) }),
        });
        return;
      }
      const room = rooms.get(code);
      if (room === undefined) {
        if (closedCodes.has(code)) {
          sendError(connection.connectionId, 'room-closed', '该房间已关闭。');
        } else {
          sendError(connection.connectionId, 'room-not-found', '没有找到这个房间，请确认房间码与服务地址。');
        }
        return;
      }
      const existingSeat = findSeat(room, connection.deviceId);
      if (existingSeat !== null) {
        // 同一设备重复加入（含重连）：占据原座位，昵称只更新显示。
        const state = room.seats[existingSeat] as SeatState;
        state.connectionId = connection.connectionId;
        state.nickname = connection.nickname;
        noteActivity(room);
        log('room.rejoined', { code: room.code, seat: existingSeat });
        sendSnapshot(room, existingSeat);
        sendOther(room, existingSeat === 0 ? 1 : 0);
        return;
      }
      if (room.status === 'started' || (room.seats[0] !== null && room.seats[1] !== null)) {
        sendError(connection.connectionId, 'room-full', '房间的两个座位都已被占用。');
        return;
      }
      const seat: RoomSeat = room.seats[0] === null ? 0 : 1;
      const seatState: SeatState = {
        deviceId: connection.deviceId,
        nickname: connection.nickname,
        connectionId: connection.connectionId,
        deck: null,
        validation: null,
        ready: false,
        frozen: null,
        commands: new Map(),
        commandOrder: [],
      };
      room.seats[seat] = seatState;
      deviceRoom.set(connection.deviceId, room.code);
      room.version += 1;
      noteActivity(room);
      log('room.joined', { code: room.code, seat });
      broadcast(room);
    },

    handleCommand(connection, message): void {
      sweep();
      connections.set(connection.connectionId, connection);
      if (message.type === 'create-room') {
        this.createRoom(connection);
        return;
      }
      if (message.type === 'join-room') {
        this.joinRoom(connection, message.code);
        return;
      }
      const resolved = requireSeat(connection, message);
      if ('rejected' in resolved) {
        return;
      }
      const { room, seat, state } = resolved;
      if (message.type === 'select-deck') {
        cacheResponse(state, message, selectDeck(room, seat, state, message));
        return;
      }
      if (message.type === 'set-ready') {
        cacheResponse(state, message, setReady(room, seat, state, message));
        return;
      }
      const response = leaveRoom(room, seat, state, message);
      // 显式离开：连接记录同步移除（开局后保留 deviceRoom，允许同一身份重入同一座位）。
      dropConnection(connection.connectionId);
      cacheResponse(state, message, response);
      // 离开的结果只发给离开者；其他座位的通知已由 leaveRoom 内部完成。
      sendTo(connection.connectionId, response);
    },

    detachConnection(connectionId): void {
      const connection = connections.get(connectionId);
      if (connection === undefined) {
        return;
      }
      connections.delete(connectionId);
      const code = deviceRoom.get(connection.deviceId);
      if (code === undefined) {
        return;
      }
      const room = rooms.get(code);
      if (room === undefined) {
        deviceRoom.delete(connection.deviceId);
        return;
      }
      const seat = findSeat(room, connection.deviceId);
      if (seat === null) {
        deviceRoom.delete(connection.deviceId);
        return;
      }
      const state = room.seats[seat];
      if (state === null || state.connectionId !== connectionId) {
        return;
      }
      // 非预期断线不释放座位：允许同一身份重连恢复。显式离开才释放。
      state.connectionId = null;
      room.version += 1;
      noteActivity(room);
      const other: RoomSeat = seat === 0 ? 1 : 0;
      sendOther(room, other);
      log('room.disconnected', { code: room.code, seat });
    },
  };
}
