import {
  isRoomCode,
  type DeckDocument,
  type DeckValidationResponse,
  type LiveConnection,
  type RoomView,
} from '@ptcg/protocol';

/**
 * 房间客户端状态机。
 *
 * 只依赖握手后的 `LiveConnection`：发送房间命令并消费服务端个性化快照。
 * 所有房间变更都由服务端裁定；这里不做“乐观就绪”，避免界面显示服务端从未
 * 确认过的准备状态。命令携带当前 `roomId` 与 `expectedVersion`，服务端拒绝
 * 过期/错目标的命令后必须由用户基于最新快照重新确认；快照与离开/关闭结果
 * 都按房间实例与版本去重，旧重放不会回退客户端状态。
 *
 * 服务端按设备保留命令结果（含离开/重入与房间码复用之后），旧命令的缓存
 * 快照或缓存错误可能晚于新房间的响应到达。因此客户端还做两层防护：
 *   - 直接结果带 `commandId`，只有与当前等待命令匹配的结果才会被采纳；
 *   - 已离开/已关闭的房间实例留下墓碑，没有当前命令关联的快照不能把它们
 *     重新激活，也不会在加入新房间时抢占界面。服务端对当前命令的直接回答
 *     不受墓碑限制，真正的建房/重入/重连仍然可用。
 */

export type RoomPhase = 'idle' | 'joining' | 'in-room' | 'left' | 'closed' | 'disconnected';

export interface RoomErrorState {
  readonly code: string;
  readonly message: string;
  readonly validation?: DeckValidationResponse;
  readonly retryAfterMs?: number;
}

export interface RoomState {
  readonly phase: RoomPhase;
  readonly room: RoomView | null;
  readonly error: RoomErrorState | null;
  /** 已发出命令、等待服务端结果；期间不接受重复提交。 */
  readonly pending: boolean;
  /** 最近一次创建/加入的房间码；离开或关闭后仍可用于提示。 */
  readonly lastCode: string | null;
}

export interface RoomController {
  readonly state: RoomState;
  subscribe(listener: (state: RoomState) => void): () => void;
  createRoom(): void;
  joinRoom(code: string): void;
  selectDeck(deck: DeckDocument): void;
  setReady(ready: boolean): void;
  leaveRoom(): void;
  clearError(): void;
  dispose(): void;
}

export const INITIAL_ROOM_STATE: RoomState = {
  phase: 'idle',
  room: null,
  error: null,
  pending: false,
  lastCode: null,
};

/** 正在等待服务端结果的命令；用于把当前命令的直接结果与旧缓存重放区分开。 */
interface PendingRequest {
  readonly commandId: string;
  readonly kind: 'create' | 'join' | 'select' | 'ready' | 'leave';
  readonly code?: string;
  readonly roomId?: string;
}

/** 保留的已离开实例墓碑数量；只需覆盖最近几次跨房间重放。 */
const ABANDONED_ROOM_LIMIT = 8;

function newCommandId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRoomController(
  connection: LiveConnection,
  onChange: (state: RoomState) => void,
): RoomController {
  let state: RoomState = INITIAL_ROOM_STATE;
  const listeners = new Set<(state: RoomState) => void>();
  let pendingRequest: PendingRequest | null = null;
  /** 已离开/已关闭的房间实例墓碑；无命令关联的旧快照不得复活它们。 */
  const abandonedRoomIds = new Set<string>();
  /** 最近离开/关闭的房间；同码加入时携带 roomId，避免误入复用房间码的新实例。 */
  let lastAbandonedRoom: { readonly roomId: string; readonly code: string } | null = null;

  function publish(next: RoomState): void {
    state = next;
    onChange(next);
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        /* 单个订阅者抛错不影响其他订阅者 */
      }
    }
  }

  function update(patch: Partial<RoomState>): void {
    publish({ ...state, ...patch });
  }

  function markAbandoned(roomId: string, code: string): void {
    abandonedRoomIds.delete(roomId);
    abandonedRoomIds.add(roomId);
    while (abandonedRoomIds.size > ABANDONED_ROOM_LIMIT) {
      const oldest = abandonedRoomIds.values().next().value;
      if (oldest === undefined) {
        break;
      }
      abandonedRoomIds.delete(oldest);
    }
    lastAbandonedRoom = { roomId, code };
  }

  function adoptRoom(room: RoomView): void {
    abandonedRoomIds.delete(room.roomId);
    update({ phase: 'in-room', room, error: null, pending: false, lastCode: room.code });
  }

  /**
   * 是否采纳一条房间快照。
   *
   * `direct` 表示服务端对当前等待命令的直接回答（命令 ID 已匹配）；这种结果
   * 可以纠正客户端的陈旧实例，也可以回到被 `room-left` 标记过的同一实例
   * （开局后返回 UI 再建房/重入）。`unsolicited` 表示没有命令关联的广播或
   * 旧式载荷：只允许更新当前房间，或在等待建房/加入时落到未离开过的新实例。
   */
  function acceptSnapshot(room: RoomView, origin: 'direct' | 'unsolicited'): boolean {
    const current = state.room;
    if (current !== null) {
      if (room.roomId === current.roomId) {
        // 同实例按版本去重；相同版本必须给出完全一致的内容（服务端保证）。
        return room.version >= current.version;
      }
      return origin === 'direct';
    }
    const request = pendingRequest;
    if (request === null || (request.kind !== 'create' && request.kind !== 'join')) {
      // 没有当前房间也没有等待中的建房/加入：任何快照都可能是旧缓存重放。
      return false;
    }
    if (request.kind === 'join') {
      if (room.code !== request.code) {
        return false;
      }
      if (request.roomId !== undefined) {
        // 显式重入已知实例（离开后的重入/重连）：墓碑不阻止，实例不匹配则拒绝。
        return room.roomId === request.roomId;
      }
    }
    if (origin === 'direct') {
      return true;
    }
    return !abandonedRoomIds.has(room.roomId);
  }

  function fail(code: string, message: string, extra: { validation?: DeckValidationResponse; retryAfterMs?: number } = {}): void {
    update({
      pending: false,
      error: {
        code,
        message,
        ...(extra.validation === undefined ? {} : { validation: extra.validation }),
        ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
      },
    });
  }

  function send(message: Parameters<LiveConnection['send']>[0]): boolean {
    if (connection.closed) {
      fail('disconnected', '与服务端的连接已断开，请重新连接后再试。');
      return false;
    }
    try {
      connection.send(message);
      return true;
    } catch {
      fail('disconnected', '消息发送失败：与服务端的连接可能已断开。');
      return false;
    }
  }

  const unsubscribeMessage = connection.onMessage((message) => {
    if (message.type === 'room') {
      // 带 commandId 的直接结果必须对应当前等待的命令；旧命令的缓存快照
      //（包括跨房间重放）一律丢弃，不能抢占新房间的界面。
      if (message.commandId !== undefined && message.commandId !== pendingRequest?.commandId) {
        return;
      }
      if (acceptSnapshot(message.room, message.commandId === undefined ? 'unsolicited' : 'direct')) {
        pendingRequest = null;
        adoptRoom(message.room);
      }
      return;
    }
    if (message.type === 'room-left') {
      // 旧命令的缓存离开结果不能把当前房间误判为已离开。
      if (message.commandId !== undefined && message.commandId !== pendingRequest?.commandId) {
        return;
      }
      if (state.room !== null) {
        if (state.room.roomId !== message.roomId || state.room.version > message.version) {
          return;
        }
      } else if (pendingRequest?.kind !== 'leave') {
        // 没有当前房间也没有等待中的离开命令：旧重放不得改写界面。
        return;
      }
      pendingRequest = null;
      markAbandoned(message.roomId, message.code);
      update({ phase: message.reason === 'left' ? 'left' : 'closed', room: null, pending: false, error: null, lastCode: message.code });
      return;
    }
    if (message.type === 'room-closed') {
      if (state.room !== null) {
        if (state.room.roomId !== message.roomId || state.room.version > message.version) {
          return;
        }
      } else if (pendingRequest === null || pendingRequest.roomId !== message.roomId) {
        // 等待其他房间（或没有等待）时，旧房间的关闭通知不得清空状态。
        return;
      }
      pendingRequest = null;
      markAbandoned(message.roomId, message.code);
      update({ phase: 'closed', room: null, pending: false, error: null, lastCode: message.code });
      return;
    }
    if (message.type === 'room-error') {
      // 旧命令的缓存错误（可能带旧房间快照）整条丢弃：既不展示陈旧错误，
      // 也不借机把界面切回已经离开的房间。
      if (message.commandId !== undefined && message.commandId !== pendingRequest?.commandId) {
        return;
      }
      // 冲突时服务端会回传当前快照，先同步再展示错误。
      if (message.room !== undefined && acceptSnapshot(message.room, 'direct')) {
        abandonedRoomIds.delete(message.room.roomId);
        publish({ ...state, phase: 'in-room', room: message.room, pending: false, lastCode: message.room.code });
      }
      pendingRequest = null;
      fail(message.code, message.message, {
        ...(message.validation === undefined ? {} : { validation: message.validation }),
        ...(message.retryAfterMs === undefined ? {} : { retryAfterMs: message.retryAfterMs }),
      });
    }
  });

  const unsubscribeClosed = connection.onClosed(() => {
    pendingRequest = null;
    update({
      phase: 'disconnected',
      room: state.room,
      pending: false,
      error: { code: 'disconnected', message: '与服务端的连接已断开，房间操作已暂停。' },
    });
  });

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    createRoom() {
      if (state.pending || state.phase === 'in-room') {
        return;
      }
      const commandId = newCommandId();
      if (send({ type: 'create-room', commandId })) {
        pendingRequest = { commandId, kind: 'create' };
        update({ phase: 'joining', pending: true, error: null });
      }
    },
    joinRoom(code) {
      if (state.pending) {
        return;
      }
      const trimmed = code.trim();
      if (!isRoomCode(trimmed)) {
        // 本地先给出明确格式错误，不发网络请求；服务地址是否正确由服务端回答。
        fail('invalid-room-code', '房间码必须是 6 位数字。');
        return;
      }
      // 已知旧房间实例时带上 roomId：房间码可能被回收复用，不能静默加入新实例。
      // 离开过同一房间码时同样携带，既支持真正的重入，也让复用的新实例明确拒绝。
      const known =
        state.room !== null && state.room.code === trimmed
          ? state.room
          : lastAbandonedRoom !== null && lastAbandonedRoom.code === trimmed
            ? lastAbandonedRoom
            : undefined;
      const commandId = newCommandId();
      const message = {
        type: 'join-room' as const,
        commandId,
        code: trimmed,
        ...(known === undefined ? {} : { roomId: known.roomId }),
      };
      if (send(message)) {
        pendingRequest = {
          commandId,
          kind: 'join',
          code: trimmed,
          ...(known === undefined ? {} : { roomId: known.roomId }),
        };
        update({ phase: 'joining', pending: true, error: null });
      }
    },
    selectDeck(deck) {
      const room = state.room;
      if (state.pending || room === null || room.status !== 'waiting') {
        return;
      }
      const commandId = newCommandId();
      if (send({ type: 'select-deck', commandId, roomId: room.roomId, expectedVersion: room.version, deck })) {
        pendingRequest = { commandId, kind: 'select' };
        update({ pending: true, error: null });
      }
    },
    setReady(ready) {
      const room = state.room;
      if (state.pending || room === null || room.status !== 'waiting') {
        return;
      }
      const commandId = newCommandId();
      if (send({ type: 'set-ready', commandId, roomId: room.roomId, expectedVersion: room.version, ready })) {
        pendingRequest = { commandId, kind: 'ready' };
        update({ pending: true, error: null });
      }
    },
    leaveRoom() {
      const room = state.room;
      if (state.pending || room === null) {
        return;
      }
      const commandId = newCommandId();
      if (send({ type: 'leave-room', commandId, roomId: room.roomId, expectedVersion: room.version })) {
        pendingRequest = { commandId, kind: 'leave' };
        update({ pending: true });
      }
    },
    clearError() {
      if (state.error !== null) {
        update({ error: null });
      }
    },
    dispose() {
      unsubscribeMessage();
      unsubscribeClosed();
      listeners.clear();
    },
  };
}
