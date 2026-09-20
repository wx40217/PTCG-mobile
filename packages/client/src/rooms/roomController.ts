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
 * 确认过的准备状态。快照按版本丢弃乱序旧包，重传命令沿用同一结果。
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
      update({ phase: message.reason === 'left' ? 'left' : 'closed', room: null, pending: false, error: null, lastCode: message.code });
      return;
    }
    if (message.type === 'room-closed') {
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
      if (send({ type: 'join-room', commandId: newCommandId(), code: trimmed })) {
        update({ phase: 'joining', pending: true, error: null });
      }
    },
    selectDeck(deck) {
      if (state.pending || state.room === null || state.room.status !== 'waiting') {
        return;
      }
      if (send({ type: 'select-deck', commandId: newCommandId(), deck })) {
        update({ pending: true, error: null });
      }
    },
    setReady(ready) {
      if (state.pending || state.room === null || state.room.status !== 'waiting') {
        return;
      }
      if (send({ type: 'set-ready', commandId: newCommandId(), ready })) {
        update({ pending: true, error: null });
      }
    },
    leaveRoom() {
      if (state.pending || state.room === null) {
        return;
      }
      if (send({ type: 'leave-room', commandId: newCommandId() })) {
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
