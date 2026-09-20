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
      // 乱序旧快照不得回退界面状态；版本更高（或首次）才采用。
      if (state.room !== null && message.room.version < state.room.version) {
        return;
      }
      update({ phase: 'in-room', room: message.room, error: null, pending: false, lastCode: message.room.code });
      return;
    }
    if (message.type === 'room-left') {
      // 旧命令的缓存结果可能在后来的重入之后才到达：只处理属于当前房间实例
      // 且不早于当前版本的结果，避免把已重入的房间误判为已离开。
      if (state.room !== null && (state.room.roomId !== message.roomId || state.room.version > message.version)) {
        return;
      }
      update({ phase: message.reason === 'left' ? 'left' : 'closed', room: null, pending: false, error: null, lastCode: message.code });
      return;
    }
    if (message.type === 'room-closed') {
      // 已经处于另一间房（或另一个房间实例）时，旧房间的关闭通知不得清空当前状态。
      if (state.room !== null && state.room.roomId !== message.roomId) {
        return;
      }
      update({ phase: 'closed', room: null, pending: false, error: null, lastCode: message.code });
      return;
    }
    if (message.type === 'room-error') {
      // 冲突时服务端会回传当前快照，先同步再展示错误。
      if (message.room !== undefined && (state.room === null || message.room.version >= state.room.version)) {
        publish({ ...state, phase: 'in-room', room: message.room, pending: false, lastCode: message.room.code });
      }
      fail(message.code, message.message, {
        ...(message.validation === undefined ? {} : { validation: message.validation }),
        ...(message.retryAfterMs === undefined ? {} : { retryAfterMs: message.retryAfterMs }),
      });
    }
  });

  const unsubscribeClosed = connection.onClosed(() => {
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
      if (send({ type: 'create-room', commandId: newCommandId() })) {
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
      const previous = state.room !== null && state.room.code === trimmed ? state.room : undefined;
      const message = {
        type: 'join-room' as const,
        commandId: newCommandId(),
        code: trimmed,
        ...(previous === undefined ? {} : { roomId: previous.roomId }),
      };
      if (send(message)) {
        update({ phase: 'joining', pending: true, error: null });
      }
    },
    selectDeck(deck) {
      const room = state.room;
      if (state.pending || room === null || room.status !== 'waiting') {
        return;
      }
      if (send({ type: 'select-deck', commandId: newCommandId(), roomId: room.roomId, expectedVersion: room.version, deck })) {
        update({ pending: true, error: null });
      }
    },
    setReady(ready) {
      const room = state.room;
      if (state.pending || room === null || room.status !== 'waiting') {
        return;
      }
      if (send({ type: 'set-ready', commandId: newCommandId(), roomId: room.roomId, expectedVersion: room.version, ready })) {
        update({ pending: true, error: null });
      }
    },
    leaveRoom() {
      const room = state.room;
      if (state.pending || room === null) {
        return;
      }
      if (send({ type: 'leave-room', commandId: newCommandId(), roomId: room.roomId, expectedVersion: room.version })) {
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
