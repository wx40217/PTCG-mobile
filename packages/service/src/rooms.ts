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
  type LeaveRoomCommand,
  type MatchClientMessage,
  type MatchErrorCode,
  type MatchServerMessage,
  type MatchView,
  type RoomClientMessage,
  type RoomErrorCode,
  type RoomSeat,
  type RoomServerMessage,
  type RoomSeatView,
  type RoomView,
  type RoutedRoomCommandBase,
  type SelectDeckCommand,
  type SetReadyCommand,
} from '@ptcg/protocol';
import { CryptoRandomSource, MatchSession, type RandomSource } from './match.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from './trainerEffects.ts';

/**
 * 房间注册表（T06）。
 *
 * 职责：
 *   - 生成不可预测、无冲突的 6 位房间码与稳定房间实例 ID；
 *   - 两个认证座位（按设备身份绑定，昵称只作显示）；第三人/重复加入/错误房间
 *     都有明确的错误码，且没有任何旁观者视图；
 *   - 加入尝试限速；
 *   - 选择卡组时用服务端当前目录独立校验；准备时再次校验并固定卡组与规则/
 *     环境修订；换卡组立即撤销准备；目录在双方准备之间变化时撤销旧修订的
 *     准备，要求重新确认；
 *   - 双方基于同一目录修订准备齐全后只建立一次对局会话（唯一 `sessionId` 与
 *     初始版本 1），命令重传按设备去重，返回同一结果；
 *   - 房主在开局前离开关闭房间；来宾离开释放座位；开局后离开只标记离线，
 *     不关闭对局、不构成认输。
 *
 * 命令路由以稳定的 `roomId` 为目标，6 位房间码只用于发现房间（会被回收复用）。
 * 所有会改变房间状态的命令都带有 `expectedVersion`：过期或指向其他房间实例的
 * 命令被拒绝且不改动任何状态。同一 `commandId` 的重传（包括离开/重入与房间码
 * 被复用之后）返回第一次的结果，不重复生效。
 *
 * 注册表是纯同步的：Node 的事件循环让「并发准备」串行处理，配合每个设备的
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
  /** 每个设备保留的命令去重条数。 */
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

/** 内存中保留命令历史的设备上限；超出后按最早插入顺序淘汰。 */
const MAX_DEVICE_COMMAND_HISTORIES = 256;

export interface RoomConnection {
  readonly connectionId: string;
  readonly deviceId: string;
  readonly nickname: string;
}

export interface RoomChannel {
  /** 把消息发给指定连接；连接已不存在时实现应静默忽略。 */
  send(connectionId: string, message: RoomServerMessage | MatchServerMessage): void;
}

export interface RoomRegistryOptions {
  readonly now?: () => number;
  readonly limits?: Partial<RoomLimits>;
  /** 房间码生成器；测试注入确定性/碰撞序列。默认 `crypto.randomInt`。 */
  readonly generateCode?: () => string;
  /** 房间实例 ID 生成器；测试注入确定性序列。默认 `crypto.randomUUID`。 */
  readonly newRoomId?: () => string;
  readonly newSessionId?: () => string;
  /** 对局随机源（洗牌、先后攻选择权）；正式服默认 `crypto.randomInt`，测试注入确定性序列。 */
  readonly matchRandom?: RandomSource;
  /** 当前目录访问器；目录未加载时返回 null，选卡组/准备会给出明确错误。 */
  readonly catalog: () => RoomCatalogView | null;
  readonly channel: RoomChannel;
  readonly logger?: (event: string, fields: Record<string, unknown>) => void;
}

export interface RoomRegistry {
  createRoom(connection: RoomConnection): void;
  joinRoom(connection: RoomConnection, code: string): void;
  handleCommand(connection: RoomConnection, message: RoomClientMessage | MatchClientMessage): void;
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

interface CachedCommand {
  readonly fingerprint: string;
  readonly message: RoomServerMessage;
}

interface DeviceCommandHistory {
  readonly entries: Map<string, CachedCommand>;
  readonly order: string[];
}

interface SeatState {
  deviceId: string;
  nickname: string;
  connectionId: string | null;
  deck: DeckDocument | null;
  validation: DeckValidationResponse | null;
  ready: boolean;
  frozen: FrozenDeck | null;
}

interface MatchState {
  readonly sessionId: string;
  readonly version: number;
  readonly createdAt: number;
  /** 创建这场对局的两个设备身份；座位换人后授权与视图仍只属于这里的参与者。 */
  readonly seats: readonly [string, string];
  readonly frozenDecks: readonly [FrozenDeck, FrozenDeck];
  readonly session: MatchSession;
}

interface RoomState {
  /** 稳定房间实例身份；房间码可被回收复用，命令以它为目标。 */
  readonly roomId: string;
  readonly code: string;
  version: number;
  /** `finished`：唯一对局已终局，双方可重新准备新局；旧 `match` 保留供重入查看结果。 */
  status: 'waiting' | 'started' | 'finished';
  createdAt: number;
  lastActivityAt: number;
  seats: [SeatState | null, SeatState | null];
  match: MatchState | null;
}

/** 六个数字的房间码；`crypto.randomInt` 排除可预测的 `Math.random`。 */
function defaultGenerateCode(): string {
  return String(randomInt(0, 10 ** ROOM_CODE_LENGTH)).padStart(ROOM_CODE_LENGTH, '0');
}

/** 命令指纹：同 commandId 的不同请求内容必须被识别为 ID 复用。 */
function fingerprintOf(message: RoomClientMessage): string {
  const record: Record<string, unknown> = { ...message };
  delete record['commandId'];
  const keys = Object.keys(record).sort();
  return JSON.stringify(keys.map((key) => [key, record[key]]));
}

function totalCards(deck: DeckDocument): number {
  return deck.cards.reduce((sum, entry) => sum + entry.count, 0);
}

/** 两张卡组文档是否逐项一致；用于判断 select-deck 是否产生可见变化。 */
function sameDeck(left: DeckDocument | null, right: DeckDocument): boolean {
  if (left === null || left.formatVersion !== right.formatVersion || left.environmentId !== right.environmentId) {
    return false;
  }
  if (left.cards.length !== right.cards.length) {
    return false;
  }
  return left.cards.every((entry, index) => {
    const other = right.cards[index];
    return (
      other !== undefined &&
      entry.cardId === other.cardId &&
      entry.printIdentity === other.printIdentity &&
      entry.effectIdentity === other.effectIdentity &&
      entry.count === other.count
    );
  });
}

/** 冻结修订是否一致（环境 / 目录版本 / 资料修订）。 */
function sameFrozenRevision(left: FrozenDeck, right: FrozenDeck): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.catalogVersion === right.catalogVersion &&
    left.dataRevision === right.dataRevision
  );
}

/** 冻结修订是否就是当前服务目录；不同即为需要重新确认的旧准备。 */
function frozenMatchesCatalog(frozen: FrozenDeck, catalog: RoomCatalogView): boolean {
  return (
    frozen.environmentId === catalog.content.environment.id &&
    frozen.catalogVersion === catalog.catalogVersion &&
    frozen.dataRevision === catalog.content.dataRevision.sourceDigest
  );
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
  const newRoomId = options.newRoomId ?? (() => randomUUID());
  const newSessionId = options.newSessionId ?? (() => randomUUID());
  // 对局随机只来自服务端随机源；客户端载荷无法提供种子或牌序。
  const matchRandom: RandomSource = options.matchRandom ?? new CryptoRandomSource();
  const log = options.logger ?? (() => undefined);

  const rooms = new Map<string, RoomState>();
  const roomsById = new Map<string, RoomState>();
  /** 设备 → 房间实例 ID；一个设备同一时间只能在一个房间里。 */
  const deviceRoom = new Map<string, string>();
  /** 房间码 → 关闭时间戳；用于区分「不存在」与「已关闭」。 */
  const closedCodes = new Map<string, number>();
  /** connectionId → 设备身份；命令必须由当前活跃连接发出。 */
  const connections = new Map<string, RoomConnection>();
  /**
   * 设备 → 最近命令结果。跨座位释放、房间关闭与房间码复用保留，
   * 保证同一 `commandId` 的合法重传始终返回同一结果、不重复生效。
   */
  const commandHistories = new Map<string, DeviceCommandHistory>();

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

  function forgetRoom(room: RoomState): void {
    rooms.delete(room.code);
    roomsById.delete(room.roomId);
  }

  function sweep(): void {
    const at = now();
    for (const [code, room] of rooms) {
      if ((room.status === 'waiting' || room.status === 'finished') && at - room.lastActivityAt > limits.roomIdleTtlMs) {
        forgetRoom(room);
        closedCodes.set(code, at);
        for (const seat of room.seats) {
          if (seat !== null) {
            deviceRoom.delete(seat.deviceId);
            dropConnection(seat.connectionId);
          }
        }
        log('room.expired', { code, roomId: room.roomId });
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

  function snapshot(room: RoomState, seat: RoomSeat, commandId?: string): RoomServerMessage {
    return {
      type: 'room',
      room: roomViewFor(room, seat),
      ...(commandId === undefined ? {} : { commandId }),
    };
  }

  function sendSnapshot(room: RoomState, seat: RoomSeat, commandId?: string): RoomServerMessage {
    const state = room.seats[seat];
    const message = snapshot(room, seat, commandId);
    sendTo(state?.connectionId ?? null, message);
    return message;
  }

  function sendOther(room: RoomState, seat: RoomSeat): void {
    const state = room.seats[seat];
    sendTo(state?.connectionId ?? null, snapshot(room, seat));
  }

  function sendMatchMessage(connectionId: string | null, message: MatchServerMessage): void {
    if (connectionId !== null) {
      options.channel.send(connectionId, message);
    }
  }

  /**
   * 把当前对局的按座位投影发给指定座位；重入/重连时也用它恢复现场。
   * 隐私边界：只有创建这场对局的原始设备能收到按座位投影；座位被释放后换人
   * 加入的设备身份不同，不得继承旧对局（手牌/奖赏/牌库/事件）。
   */
  function sendMatchView(room: RoomState, seat: RoomSeat, commandId?: string): void {
    if (room.match === null) {
      return;
    }
    const state = room.seats[seat];
    if (state === null || room.match.seats[seat] !== state.deviceId) {
      return;
    }
    sendMatchMessage(state.connectionId, {
      type: 'match',
      view: room.match.session.viewFor(room.match.session.handleFor(seat)),
      ...(commandId === undefined ? {} : { commandId }),
    });
  }

  function sendMatchError(
    connectionId: string,
    code: MatchErrorCode,
    message: string,
    extra: { readonly commandId?: string; readonly view?: MatchView } = {},
  ): void {
    sendMatchMessage(connectionId, {
      type: 'match-error',
      code,
      message,
      ...(extra.commandId === undefined ? {} : { commandId: extra.commandId }),
      ...(extra.view === undefined ? {} : { view: extra.view }),
    });
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
      roomId: room.roomId,
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

  /** 当前设备所在房间的个性化快照；不在任何房间时返回 undefined。 */
  function currentAuthorizedView(deviceId: string): RoomView | undefined {
    const roomId = deviceRoom.get(deviceId);
    const room = roomId === undefined ? undefined : roomsById.get(roomId);
    if (room === undefined) {
      return undefined;
    }
    const seat = findSeat(room, deviceId);
    return seat === null ? undefined : roomViewFor(room, seat);
  }

  function lookupCommand(deviceId: string, commandId: string): CachedCommand | undefined {
    return commandHistories.get(deviceId)?.entries.get(commandId);
  }

  function rememberCommand(deviceId: string, message: RoomClientMessage, response: RoomServerMessage): void {
    let history = commandHistories.get(deviceId);
    if (history === undefined) {
      history = { entries: new Map(), order: [] };
      commandHistories.set(deviceId, history);
      while (commandHistories.size > MAX_DEVICE_COMMAND_HISTORIES) {
        const oldestDevice = commandHistories.keys().next().value;
        if (oldestDevice === undefined || oldestDevice === deviceId) {
          break;
        }
        commandHistories.delete(oldestDevice);
      }
    }
    history.entries.set(message.commandId, { fingerprint: fingerprintOf(message), message: response });
    history.order.push(message.commandId);
    while (history.order.length > limits.commandHistorySize) {
      const oldest = history.order.shift();
      if (oldest !== undefined) {
        history.entries.delete(oldest);
      }
    }
  }

  function newSeat(connection: RoomConnection): SeatState {
    return {
      deviceId: connection.deviceId,
      nickname: connection.nickname,
      connectionId: connection.connectionId,
      deck: null,
      validation: null,
      ready: false,
      frozen: null,
    };
  }

  type ResolvedSeat =
    | { readonly room: RoomState; readonly seat: RoomSeat; readonly state: SeatState }
    | { readonly rejected: RoomServerMessage };

  function requireSeat(connection: RoomConnection, message: RoutedRoomCommandBase): ResolvedSeat {
    const room = roomsById.get(message.roomId);
    if (room === undefined) {
      const current = currentAuthorizedView(connection.deviceId);
      return {
        rejected: sendError(connection.connectionId, 'stale-room', '这个房间实例已不存在；房间码可能已被新的房间复用。请按当前房间状态重新操作。', {
          commandId: message.commandId,
          ...(current === undefined ? {} : { room: current }),
        }),
      };
    }
    const seat = findSeat(room, connection.deviceId);
    if (seat === null) {
      const current = currentAuthorizedView(connection.deviceId);
      return {
        rejected: sendError(connection.connectionId, 'not-in-room', '你不在这个房间里。', {
          commandId: message.commandId,
          ...(current === undefined ? {} : { room: current }),
        }),
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
    if (message.expectedVersion !== room.version) {
      return {
        rejected: sendError(
          connection.connectionId,
          'version-conflict',
          `房间状态已更新到版本 ${room.version}，这条命令基于版本 ${message.expectedVersion}，未生效；请按最新状态重新确认。`,
          {
            commandId: message.commandId,
            room: roomViewFor(room, seat),
          },
        ),
      };
    }
    return { room, seat, state };
  }

  /** 把已校验的卡组复制冻结，后续任何客户端提交都不会改变这一份。 */
  function freezeDeck(deck: DeckDocument, validation: DeckValidationResponse): FrozenDeck {
    return {
      deck: {
        formatVersion: deck.formatVersion,
        environmentId: deck.environmentId,
        cards: deck.cards.map((entry) => ({ ...entry })),
      },
      validation,
      environmentId: validation.environmentId,
      catalogVersion: validation.catalogVersion,
      dataRevision: validation.dataRevision,
      frozenAt: now(),
    };
  }

  function selectDeck(
    room: RoomState,
    seat: RoomSeat,
    state: SeatState,
    message: SelectDeckCommand,
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
    const changed = !sameDeck(state.deck, parsed.deck) || state.ready || state.frozen !== null;
    state.deck = parsed.deck;
    state.validation = validation;
    // 换卡组（含同卡组重新提交）都撤销准备：双方必须基于已确认的同一份卡组开局。
    state.ready = false;
    state.frozen = null;
    noteActivity(room);
    if (changed) {
      room.version += 1;
      sendOther(room, seat === 0 ? 1 : 0);
    }
    log('room.deck_selected', {
      code: room.code,
      roomId: room.roomId,
      seat,
      totalCards: validation.totalCards,
      legal: validation.legal,
      ready: validation.ready,
    });
    return sendSnapshot(room, seat, message.commandId);
  }

  /**
   * 双方都已就绪但冻结修订不同（目录在两次准备之间变化）：撤销基于旧修订的
   * 准备并由服务端明确通知，不允许混合修订开局；被撤销的一方必须重新明确确认。
   */
  function refuseIncompatibleReadiness(
    room: RoomState,
    actorSeat: RoomSeat,
    actorState: SeatState,
    message: SetReadyCommand,
    catalog: RoomCatalogView,
  ): RoomServerMessage {
    const revokedSeats: RoomSeat[] = [];
    for (const seat of [0, 1] as const) {
      const state = room.seats[seat];
      if (state !== null && state.ready && state.frozen !== null && !frozenMatchesCatalog(state.frozen, catalog)) {
        state.ready = false;
        state.frozen = null;
        revokedSeats.push(seat);
      }
    }
    if (revokedSeats.length === 0) {
      // 防御性回退：逐项比较不一致但都声称匹配当前目录（理论不可达），
      // 双方都撤销，宁可各自重新确认，也不允许混合修订开局。
      for (const seat of [0, 1] as const) {
        const state = room.seats[seat];
        if (state !== null && (state.ready || state.frozen !== null)) {
          state.ready = false;
          state.frozen = null;
          revokedSeats.push(seat);
        }
      }
    }
    if (revokedSeats.length > 0) {
      room.version += 1;
      noteActivity(room);
    }
    log('room.readiness_revoked', {
      code: room.code,
      roomId: room.roomId,
      seats: revokedSeats,
      catalogVersion: catalog.catalogVersion,
    });
    for (const seat of revokedSeats) {
      const state = room.seats[seat];
      if (state === null || state.connectionId === null) {
        continue;
      }
      sendError(state.connectionId, 'catalog-changed', '目录或规则已更新，准备已撤销；请重新确认卡组并再次准备。', {
        room: roomViewFor(room, seat),
      });
    }
    return sendError(
      actorState.connectionId as string,
      'catalog-changed',
      '对手的准备基于旧目录版本，已撤销并要求对方重新确认；请等待对方再次准备。',
      {
        commandId: message.commandId,
        room: roomViewFor(room, actorSeat),
      },
    );
  }

  function setReady(
    room: RoomState,
    seat: RoomSeat,
    state: SeatState,
    message: SetReadyCommand,
  ): RoomServerMessage {
    const connectionId = state.connectionId as string;
    const other: RoomSeat = seat === 0 ? 1 : 0;
    if (room.status === 'started') {
      return sendError(connectionId, 'match-started', '对局已经建立，不能再更改准备状态。', {
        commandId: message.commandId,
        room: roomViewFor(room, seat),
      });
    }
    if (!message.ready) {
      const changed = state.ready || state.frozen !== null;
      state.ready = false;
      state.frozen = null;
      noteActivity(room);
      if (changed) {
        room.version += 1;
        log('room.unready', { code: room.code, roomId: room.roomId, seat });
        const response = sendSnapshot(room, seat, message.commandId);
        sendOther(room, other);
        return response;
      }
      return sendSnapshot(room, seat, message.commandId);
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
      const changed = state.ready || state.frozen !== null;
      state.ready = false;
      state.frozen = null;
      if (changed) {
        room.version += 1;
        noteActivity(room);
        sendOther(room, other);
      }
      return sendError(connectionId, 'deck-not-ready', '卡组还不能用于正式对战，请根据校验结果调整。', {
        commandId: message.commandId,
        validation,
        room: roomViewFor(room, seat),
      });
    }
    const previousFrozen = state.frozen;
    const frozen = freezeDeck(state.deck, validation);
    const revisionChanged = previousFrozen === null || !sameFrozenRevision(previousFrozen, frozen);
    const becameReady = !state.ready;
    state.ready = true;
    state.frozen = frozen;
    if (becameReady || revisionChanged) {
      room.version += 1;
      noteActivity(room);
      sendOther(room, other);
    }
    log('room.ready', {
      code: room.code,
      roomId: room.roomId,
      seat,
      totalCards: validation.totalCards,
      catalogVersion: validation.catalogVersion,
    });

    const first = room.seats[0];
    const second = room.seats[1];
    if (first !== null && second !== null && first.ready && second.ready && (room.match === null || room.status === 'finished')) {
      const firstFrozen = first.frozen as FrozenDeck;
      const secondFrozen = second.frozen as FrozenDeck;
      if (sameFrozenRevision(firstFrozen, secondFrozen)) {
        // 双方都就绪且修订一致，且尚未开局或上一局已终局：只在这里创建一次对局会话。
        // 重新开局会替换旧的 `match`（旧会话的终局视图不再提供）。
        const sessionId = newSessionId();
        const session = new MatchSession({
          sessionId,
          // 座位 0/1 的卡组顺序与房间座位一致；引擎内部只在服务端持有洗牌顺序。
          decks: [firstFrozen.deck, secondFrozen.deck],
          nicknames: [first.nickname, second.nickname],
          catalog: catalog.content,
          random: matchRandom,
          trainerEffects: PRODUCTION_TRAINER_EFFECTS,
          stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
        });
        room.match = {
          sessionId,
          version: 1,
          createdAt: now(),
          seats: [first.deviceId, second.deviceId],
          frozenDecks: [firstFrozen, secondFrozen],
          session,
        };
        room.status = 'started';
        room.version += 1;
        log('room.match_created', {
          code: room.code,
          roomId: room.roomId,
          sessionId: room.match.sessionId,
          version: room.match.version,
          catalogVersion: firstFrozen.catalogVersion,
          environmentId: firstFrozen.environmentId,
          totalCards: [totalCards(firstFrozen.deck), totalCards(secondFrozen.deck)],
        });
        const response = sendSnapshot(room, seat, message.commandId);
        sendOther(room, other);
        sendMatchView(room, seat);
        sendMatchView(room, other);
        return response;
      }
      return refuseIncompatibleReadiness(room, seat, state, message, catalog);
    }

    return sendSnapshot(room, seat, message.commandId);
  }

  function leaveRoom(
    room: RoomState,
    seat: RoomSeat,
    state: SeatState,
    message: LeaveRoomCommand,
  ): RoomServerMessage {
    const other: RoomSeat = seat === 0 ? 1 : 0;
    if (room.status === 'started') {
      // 开局后返回 UI 不是认输：只标记离线，保留座位、卡组与对局会话。
      state.connectionId = null;
      room.version += 1;
      noteActivity(room);
      log('room.detached_after_start', { code: room.code, roomId: room.roomId, seat });
      sendOther(room, other);
      return { type: 'room-left', roomId: room.roomId, code: room.code, version: room.version, reason: 'left', commandId: message.commandId };
    }
    if (seat === 0) {
      // 房主在开局前离开：关闭房间并通知剩余座位。
      forgetRoom(room);
      closedCodes.set(room.code, now());
      deviceRoom.delete(state.deviceId);
      dropConnection(state.connectionId);
      const otherState = room.seats[other];
      if (otherState !== null) {
        deviceRoom.delete(otherState.deviceId);
        sendTo(otherState.connectionId, {
          type: 'room-closed',
          roomId: room.roomId,
          code: room.code,
          version: room.version,
          reason: 'host-left',
        });
        dropConnection(otherState.connectionId);
      }
      log('room.host_left', { code: room.code, roomId: room.roomId });
      return { type: 'room-left', roomId: room.roomId, code: room.code, version: room.version, reason: 'host-left', commandId: message.commandId };
    }
    // 来宾离开：释放座位；房间只剩房主（或空房立即回收）。
    room.seats[seat] = null;
    deviceRoom.delete(state.deviceId);
    dropConnection(state.connectionId);
    room.version += 1;
    noteActivity(room);
    log('room.guest_left', { code: room.code, roomId: room.roomId, seat });
    sendOther(room, other);
    if (room.seats[0] === null && room.seats[1] === null) {
      forgetRoom(room);
      closedCodes.set(room.code, now());
    }
    return { type: 'room-left', roomId: room.roomId, code: room.code, version: room.version, reason: 'left', commandId: message.commandId };
  }

  function doCreateRoom(connection: RoomConnection, commandId?: string): RoomServerMessage {
    const existingRoomId = deviceRoom.get(connection.deviceId);
    if (existingRoomId !== undefined) {
      const room = roomsById.get(existingRoomId);
      const seat = room === undefined ? null : findSeat(room, connection.deviceId);
      if (room !== undefined && seat !== null) {
        // 重传/重复建房：回到已有房间，不产生第二间房。
        const state = room.seats[seat] as SeatState;
        const changed = state.connectionId !== connection.connectionId || state.nickname !== connection.nickname;
        state.connectionId = connection.connectionId;
        state.nickname = connection.nickname;
        noteActivity(room);
        if (changed) {
          room.version += 1;
          sendOther(room, seat === 0 ? 1 : 0);
        }
        const response = sendSnapshot(room, seat, commandId);
        sendMatchView(room, seat);
        return response;
      }
      deviceRoom.delete(connection.deviceId);
    }
    const limit = createLimiter.check(connection.deviceId, now());
    if (!limit.allowed) {
      return sendError(connection.connectionId, 'rate-limited', '建房请求过于频繁，请稍后再试。', {
        ...(commandId === undefined ? {} : { commandId }),
        retryAfterMs: limit.retryAfterMs,
      });
    }
    let code: string | undefined;
    let roomId: string | undefined;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate = generateCode();
      if (!ROOM_CODE_PATTERN.test(candidate)) {
        throw new Error(`房间码生成器返回了非法值: ${candidate}`);
      }
      if (rooms.has(candidate) || closedCodes.has(candidate)) {
        continue;
      }
      const candidateId = newRoomId();
      if (roomsById.has(candidateId)) {
        continue;
      }
      code = candidate;
      roomId = candidateId;
      break;
    }
    if (code === undefined || roomId === undefined) {
      return sendError(connection.connectionId, 'rate-limited', '暂时无法分配房间码，请稍后再试。', {
        ...(commandId === undefined ? {} : { commandId }),
        retryAfterMs: 1000,
      });
    }
    const at = now();
    const room: RoomState = {
      roomId,
      code,
      version: 1,
      status: 'waiting',
      createdAt: at,
      lastActivityAt: at,
      seats: [newSeat(connection), null],
      match: null,
    };
    rooms.set(code, room);
    roomsById.set(roomId, room);
    deviceRoom.set(connection.deviceId, roomId);
    log('room.created', { code, roomId });
    return sendSnapshot(room, 0, commandId);
  }

  function doJoinRoom(connection: RoomConnection, code: string, knownRoomId?: string, commandId?: string): RoomServerMessage {
    const limit = joinLimiter.check(connection.deviceId, now());
    if (!limit.allowed) {
      return sendError(connection.connectionId, 'rate-limited', '加入尝试过于频繁，请稍后再试。', {
        ...(commandId === undefined ? {} : { commandId }),
        retryAfterMs: limit.retryAfterMs,
      });
    }
    if (!isRoomCode(code)) {
      return sendError(connection.connectionId, 'invalid-room-code', '房间码必须是 6 位数字。', commandId === undefined ? {} : { commandId });
    }
    const currentRoomId = deviceRoom.get(connection.deviceId);
    if (currentRoomId !== undefined) {
      const currentRoom = roomsById.get(currentRoomId);
      if (currentRoom === undefined) {
        deviceRoom.delete(connection.deviceId);
      } else if (currentRoom.code !== code) {
        const currentSeat = findSeat(currentRoom, connection.deviceId);
        return sendError(connection.connectionId, 'already-in-room', `你已经在一个房间（${currentRoom.code}）里，请先离开。`, {
          ...(commandId === undefined ? {} : { commandId }),
          ...(currentSeat === null ? {} : { room: roomViewFor(currentRoom, currentSeat) }),
        });
      }
    }
    const room = rooms.get(code);
    if (room === undefined) {
      if (closedCodes.has(code)) {
        return sendError(connection.connectionId, 'room-closed', '该房间已关闭。', commandId === undefined ? {} : { commandId });
      }
      return sendError(connection.connectionId, 'room-not-found', '没有找到这个房间，请确认房间码与服务地址。', commandId === undefined ? {} : { commandId });
    }
    if (knownRoomId !== undefined && knownRoomId !== room.roomId) {
      // 房间码被回收并复用：不把旧实例的命令/重连静默落到新房间上。
      return sendError(connection.connectionId, 'stale-room', `房间码 ${code} 现在指向另一个房间实例；为避免误入，本次加入未执行。`, commandId === undefined ? {} : { commandId });
    }
    const existingSeat = findSeat(room, connection.deviceId);
    if (existingSeat !== null) {
      // 同一设备重复加入（含重连）：占据原座位，昵称只更新显示。
      const state = room.seats[existingSeat] as SeatState;
      const changed = state.connectionId !== connection.connectionId || state.nickname !== connection.nickname;
      state.connectionId = connection.connectionId;
      state.nickname = connection.nickname;
      noteActivity(room);
      if (changed) {
        room.version += 1;
        sendOther(room, existingSeat === 0 ? 1 : 0);
      }
      log('room.rejoined', { code: room.code, roomId: room.roomId, seat: existingSeat });
      const response = sendSnapshot(room, existingSeat, commandId);
      // 开局后重入：把当前对局现场一并恢复给该座位。
      sendMatchView(room, existingSeat);
      return response;
    }
    if (room.status === 'started' || (room.seats[0] !== null && room.seats[1] !== null)) {
      return sendError(connection.connectionId, 'room-full', '房间的两个座位都已被占用。', commandId === undefined ? {} : { commandId });
    }
    const seat: RoomSeat = room.seats[0] === null ? 0 : 1;
    room.seats[seat] = newSeat(connection);
    deviceRoom.set(connection.deviceId, room.roomId);
    room.version += 1;
    noteActivity(room);
    log('room.joined', { code: room.code, roomId: room.roomId, seat });
    const response = sendSnapshot(room, seat, commandId);
    sendOther(room, seat === 0 ? 1 : 0);
    return response;
  }

  function handleRoutedCommand(
    connection: RoomConnection,
    message: SelectDeckCommand | SetReadyCommand | LeaveRoomCommand,
  ): RoomServerMessage {
    const resolved = requireSeat(connection, message);
    if ('rejected' in resolved) {
      return resolved.rejected;
    }
    const { room, seat, state } = resolved;
    if (message.type === 'select-deck') {
      return selectDeck(room, seat, state, message);
    }
    if (message.type === 'set-ready') {
      return setReady(room, seat, state, message);
    }
    const response = leaveRoom(room, seat, state, message);
    // 离开的结果只发给离开者；其他座位的通知已在 leaveRoom 内部完成。
    sendTo(connection.connectionId, response);
    // 显式离开：连接记录同步移除（开局后保留 deviceRoom，允许同一身份重入同一座位）。
    dropConnection(connection.connectionId);
    return response;
  }

  /**
   * 对局产生唯一终态后，房间进入“已结束、可重新准备”状态：撤销双方准备
   * （保留卡组）并广播房间快照；旧 `match` 保留供重入查看结果，直到下一局
   * 创建时才替换。只在 started → finished 时转换一次。
   */
  function markRoomFinished(room: RoomState): void {
    if (room.match === null || room.match.session.result === null || room.status !== 'started') {
      return;
    }
    room.status = 'finished';
    for (const seatState of room.seats) {
      if (seatState !== null) {
        seatState.ready = false;
        seatState.frozen = null;
      }
    }
    room.version += 1;
    noteActivity(room);
    for (const seat of [0, 1] as const) {
      sendSnapshot(room, seat);
    }
    log('room.match_finished', { code: room.code, roomId: room.roomId, sessionId: room.match.sessionId });
  }

  function handleMatchCommand(connection: RoomConnection, message: MatchClientMessage): void {
    const roomId = deviceRoom.get(connection.deviceId);
    const room = roomId === undefined ? undefined : roomsById.get(roomId);
    if (room === undefined || room.match === null) {
      sendMatchError(connection.connectionId, 'match-not-found', '当前没有正在进行的对局。', { commandId: message.commandId });
      return;
    }
    if (room.match.sessionId !== message.sessionId) {
      sendMatchError(connection.connectionId, 'match-not-found', '这条命令指向的对局会话不存在。', { commandId: message.commandId });
      return;
    }
    const seat = findSeat(room, connection.deviceId);
    if (seat === null) {
      sendMatchError(connection.connectionId, 'not-in-match', '这个设备不在当前对局座位上。', { commandId: message.commandId });
      return;
    }
    // 隐私边界：对局按原始参与设备身份授权；座位换人后新设备即使占座也不能
    // 查看或操作旧对局，更不会借“连接已接管”拿到旧座位的私人视图。
    if (room.match.seats[seat] !== connection.deviceId) {
      sendMatchError(connection.connectionId, 'not-in-match', '这个设备不是这局对战的参与者。', { commandId: message.commandId });
      return;
    }
    const state = room.seats[seat];
    if (state === null || state.connectionId !== connection.connectionId) {
      sendMatchError(connection.connectionId, 'seat-taken-over', '本座位已由新的连接接管，请重新加入。', {
        commandId: message.commandId,
        view: room.match.session.viewFor(room.match.session.handleFor(seat)),
      });
      return;
    }
    const session = room.match.session;
    const result = session.submit(session.handleFor(seat), message);
    if (result.ok) {
      sendMatchMessage(connection.connectionId, { type: 'match', view: result.view, commandId: message.commandId });
      const other: RoomSeat = seat === 0 ? 1 : 0;
      // 给对手的无命令关联广播只刷新其当前授权视图，不结束对方的等待命令；
      // 客户端状态机按此语义保留 pending/error 生命周期。
      sendMatchView(room, other);
      // 产生唯一终态后只转换一次房间状态（结果视图已随上方消息发出）。
      markRoomFinished(room);
      return;
    }
    sendMatchError(connection.connectionId, result.code, result.message, {
      commandId: message.commandId,
      ...(result.view === undefined ? {} : { view: result.view }),
    });
  }

  function handleCommand(connection: RoomConnection, message: RoomClientMessage | MatchClientMessage): void {
    sweep();
    connections.set(connection.connectionId, connection);
    if (isMatchCommand(message)) {
      // 对局命令的去重在 `MatchSession` 内按座位处理；房间命令去重不互相干扰。
      handleMatchCommand(connection, message);
      return;
    }
    const cached = lookupCommand(connection.deviceId, message.commandId);
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprintOf(message)) {
        sendError(connection.connectionId, 'command-id-reused', '命令 ID 已用于不同的请求，请使用新的命令 ID。', {
          commandId: message.commandId,
        });
        return;
      }
      // 合法重传：返回第一次的结果，不重复生效（含离开/重入与房间码复用之后）。
      sendTo(connection.connectionId, cached.message);
      return;
    }
    let response: RoomServerMessage;
    if (message.type === 'create-room') {
      response = doCreateRoom(connection, message.commandId);
    } else if (message.type === 'join-room') {
      response = doJoinRoom(connection, message.code, message.roomId, message.commandId);
    } else {
      response = handleRoutedCommand(connection, message);
    }
    rememberCommand(connection.deviceId, message, response);
  }

  function isMatchCommand(message: RoomClientMessage | MatchClientMessage): message is MatchClientMessage {
    return (
      message.type === 'choose-turn-order' ||
      message.type === 'place-setup' ||
      message.type === 'resolve-compensation' ||
      message.type === 'place-bench' ||
      message.type === 'play-basic' ||
      message.type === 'attach-energy' ||
      message.type === 'retreat' ||
      message.type === 'attack' ||
      message.type === 'end-turn' ||
      message.type === 'take-prizes' ||
      message.type === 'choose-replacement' ||
      message.type === 'play-trainer' ||
      message.type === 'use-stadium' ||
      message.type === 'discard-hand' ||
      message.type === 'search-deck' ||
      message.type === 'choose-mode' ||
      message.type === 'switch-opponent' ||
      message.type === 'concede'
    );
  }

  return {
    createRoom(connection): void {
      sweep();
      connections.set(connection.connectionId, connection);
      doCreateRoom(connection);
    },

    joinRoom(connection, code): void {
      sweep();
      connections.set(connection.connectionId, connection);
      doJoinRoom(connection, code);
    },

    handleCommand,

    detachConnection(connectionId): void {
      const connection = connections.get(connectionId);
      if (connection === undefined) {
        return;
      }
      connections.delete(connectionId);
      const roomId = deviceRoom.get(connection.deviceId);
      if (roomId === undefined) {
        return;
      }
      const room = roomsById.get(roomId);
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
      log('room.disconnected', { code: room.code, roomId: room.roomId, seat });
    },
  };
}
