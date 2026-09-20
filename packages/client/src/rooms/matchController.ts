import type { LiveConnection, MatchClientMessage, MatchView } from '@ptcg/protocol';

/**
 * 开局对局客户端状态机（#8）。
 *
 * 只消费服务端按座位投影的对局视图：待决选择属于谁、有哪些合法候选、版本号
 * 都由服务端给出。命令携带当前 `sessionId`、对局版本与 `choiceId`；服务端拒绝
 * 过期/越权/旧选择后，客户端必须基于最新视图重新确认。
 *
 * 与房间控制器共用一条 `LiveConnection`，但消息与去重互不干扰：只有与当前
 * 等待命令匹配的直接结果才结束等待，无命令关联的对手广播只更新视图。
 */

export interface MatchErrorState {
  readonly code: string;
  readonly message: string;
}

export interface MatchState {
  readonly sessionId: string | null;
  readonly view: MatchView | null;
  /** 已发出命令、等待服务端结果；期间不接受重复提交。 */
  readonly pending: boolean;
  readonly error: MatchErrorState | null;
}

export interface MatchController {
  readonly state: MatchState;
  subscribe(listener: (state: MatchState) => void): () => void;
  chooseTurnOrder(goFirst: boolean): void;
  placeSetup(active: number, bench: readonly number[]): void;
  resolveCompensation(draw: number): void;
  placeCompensationBench(bench: readonly number[]): void;
  clearError(): void;
  dispose(): void;
}

export const INITIAL_MATCH_STATE: MatchState = {
  sessionId: null,
  view: null,
  pending: false,
  error: null,
};

interface PendingRequest {
  readonly commandId: string;
}

function newCommandId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMatchController(
  connection: LiveConnection,
  onChange: (state: MatchState) => void,
): MatchController {
  let state: MatchState = INITIAL_MATCH_STATE;
  const listeners = new Set<(state: MatchState) => void>();
  let pendingRequest: PendingRequest | null = null;

  function publish(next: MatchState): void {
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

  function update(patch: Partial<MatchState>): void {
    publish({ ...state, ...patch });
  }

  function fail(code: string, message: string): void {
    update({ pending: false, error: { code, message } });
  }

  function send(message: MatchClientMessage): boolean {
    if (connection.closed) {
      fail('disconnected', '与服务端的连接已断开，对局操作已暂停。');
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

  /** 对局命令的公共前置：必须有当前视图与属于本人的待决选择。 */
  function currentChoice(): MatchView | null {
    const view = state.view;
    if (view === null || view.pendingChoice === null) {
      fail('choice-pending', '当前没有需要你完成的选择。');
      return null;
    }
    return view;
  }

  const unsubscribeMessage = connection.onMessage((message) => {
    if (message.type === 'match') {
      const direct = message.commandId !== undefined;
      if (direct && message.commandId !== pendingRequest?.commandId) {
        // 旧命令的缓存快照（含跨对局重放）不得抢占当前视图。
        return;
      }
      if (state.sessionId !== null && message.view.sessionId !== state.sessionId) {
        return;
      }
      if (state.view !== null && message.view.version < state.view.version) {
        // 乱序旧快照：保留更新版本，但匹配的直接结果要结束等待，避免卡死。
        if (direct) {
          pendingRequest = null;
          update({ pending: false });
        }
        return;
      }
      pendingRequest = null;
      publish({ sessionId: message.view.sessionId, view: message.view, pending: false, error: null });
      return;
    }
    if (message.type === 'match-error') {
      if (message.commandId !== undefined && message.commandId !== pendingRequest?.commandId) {
        return;
      }
      pendingRequest = null;
      if (message.view !== undefined && (state.sessionId === null || message.view.sessionId === state.sessionId)) {
        publish({
          sessionId: message.view.sessionId,
          view: message.view,
          pending: false,
          error: { code: message.code, message: message.message },
        });
        return;
      }
      fail(message.code, message.message);
    }
  });

  const unsubscribeClosed = connection.onClosed(() => {
    pendingRequest = null;
    update({ pending: false, error: { code: 'disconnected', message: '与服务端的连接已断开，对局操作已暂停。' } });
  });

  function submit(build: (view: MatchView, commandId: string) => MatchClientMessage): void {
    if (state.pending) {
      return;
    }
    const view = currentChoice();
    if (view === null) {
      return;
    }
    const commandId = newCommandId();
    if (send(build(view, commandId))) {
      pendingRequest = { commandId };
      update({ pending: true, error: null });
    }
  }

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
    chooseTurnOrder(goFirst) {
      submit((view, commandId) => ({
        type: 'choose-turn-order',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        goFirst,
      }));
    },
    placeSetup(active, bench) {
      submit((view, commandId) => ({
        type: 'place-setup',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        active,
        bench: [...bench],
      }));
    },
    resolveCompensation(draw) {
      submit((view, commandId) => ({
        type: 'resolve-compensation',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        draw,
      }));
    },
    placeCompensationBench(bench) {
      submit((view, commandId) => ({
        type: 'place-compensation-bench',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        bench: [...bench],
      }));
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
