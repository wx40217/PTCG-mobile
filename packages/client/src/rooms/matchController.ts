import type { LiveConnection, MatchClientMessage, MatchPokemonRef, MatchView } from '@ptcg/protocol';

/**
 * 对局客户端状态机（#8 开局 + #9 真实回合）。
 *
 * 只消费服务端按座位投影的对局视图：待决选择属于谁、有哪些合法候选、版本号
 * 都由服务端给出。命令携带当前 `sessionId`、对局版本与（开局选择的）`choiceId`；
 * 服务端拒绝过期/越权/旧选择/非法回合动作后，客户端必须基于最新视图重新确认。
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
  placeBench(bench: readonly number[]): void;
  /** 回合内：把 1 张基础宝可梦从手牌放到备战区。 */
  playBasic(handIndex: number): void;
  /** 回合内：把 1 张能量从手牌附着于自己的宝可梦。 */
  attachEnergy(handIndex: number, target: MatchPokemonRef): void;
  /** 回合内：支付选定的撤退能量并换入备战宝可梦。 */
  retreat(energyIndices: readonly number[], benchIndex: number): void;
  /** 回合内：使用战斗宝可梦的招式。 */
  attack(attackIndex: number, target: MatchPokemonRef): void;
  /** 回合内：主动结束回合。 */
  endTurn(): void;
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

  /** 回合命令的公共前置：必须有当前视图且对局已进入 playing。 */
  function currentPlaying(): MatchView | null {
    const view = state.view;
    if (view === null) {
      fail('match-not-found', '还没有收到对局状态，暂时不能操作。');
      return null;
    }
    if (view.phase !== 'playing') {
      fail('action-not-allowed', '对战尚未开始，暂时不能执行回合动作。');
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
      const newer = state.view === null || message.view.version >= state.view.version;
      if (direct) {
        // 与本机等待命令匹配的直接结果才结束等待；乱序时若比自己先收到的
        // 对手广播旧，保留更新的视图，只结束等待，避免 pending 卡死。
        pendingRequest = null;
        if (!newer) {
          update({ pending: false });
          return;
        }
        publish({ sessionId: message.view.sessionId, view: message.view, pending: false, error: null });
        return;
      }
      // 无命令关联的授权广播：只刷新当前视图，不结束本机等待、不清除错误；
      // 否则对手的一次动作广播会把自己的匹配结果当成旧回包丢弃。
      if (!newer) {
        return;
      }
      publish({ ...state, sessionId: message.view.sessionId, view: message.view });
      return;
    }
    if (message.type === 'match-error') {
      if (message.commandId !== undefined && message.commandId !== pendingRequest?.commandId) {
        return;
      }
      pendingRequest = null;
      if (message.view !== undefined && (state.sessionId === null || message.view.sessionId === state.sessionId)) {
        const newer = state.view === null || message.view.version >= state.view.version;
        publish({
          sessionId: message.view.sessionId,
          view: newer ? message.view : state.view,
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

  function submit(build: (view: MatchView, commandId: string) => MatchClientMessage, requireChoice: boolean): void {
    if (state.pending) {
      return;
    }
    const view = requireChoice ? currentChoice() : currentPlaying();
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
      }), true);
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
      }), true);
    },
    resolveCompensation(draw) {
      submit((view, commandId) => ({
        type: 'resolve-compensation',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        draw,
      }), true);
    },
    placeBench(bench) {
      submit((view, commandId) => ({
        type: 'place-bench',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        bench: [...bench],
      }), true);
    },
    playBasic(handIndex) {
      submit((view, commandId) => ({
        type: 'play-basic',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        handIndex,
      }), false);
    },
    attachEnergy(handIndex, target) {
      submit((view, commandId) => ({
        type: 'attach-energy',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        handIndex,
        target: { ...target },
      }), false);
    },
    retreat(energyIndices, benchIndex) {
      submit((view, commandId) => ({
        type: 'retreat',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        energyIndices: [...energyIndices],
        benchIndex,
      }), false);
    },
    attack(attackIndex, target) {
      submit((view, commandId) => ({
        type: 'attack',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        attackIndex,
        target: { ...target },
      }), false);
    },
    endTurn() {
      submit((view, commandId) => ({
        type: 'end-turn',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
      }), false);
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
