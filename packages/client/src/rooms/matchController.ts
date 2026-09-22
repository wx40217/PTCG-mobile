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
  /** 仅由已接受的权威房间快照指定下一局；旧会话消息仍不可抢占。 */
  adoptSession(sessionId: string): void;
  subscribe(listener: (state: MatchState) => void): () => void;
  /** 原样重发一条尚未确认的对局命令（相同 commandId），用于恢复时重试。 */
  replay(message: MatchClientMessage): void;
  chooseTurnOrder(goFirst: boolean): void;
  placeSetup(active: number, bench: readonly number[]): void;
  resolveCompensation(draw: number): void;
  placeBench(bench: readonly number[]): void;
  /** 回合内：把 1 张基础宝可梦从手牌放到备战区。 */
  playBasic(handIndex: number): void;
  /** 回合内：把 1 张能量从手牌附着于自己的宝可梦。 */
  attachEnergy(handIndex: number, target: MatchPokemonRef): void;
  /** 回合内：从手牌使出进化宝可梦，放于场上对应宝可梦身上完成进化。 */
  evolve(handIndex: number, target: MatchPokemonRef): void;
  /** 回合内：使用自己场上宝可梦的特性。 */
  useAbility(abilityIndex: number, target: MatchPokemonRef): void;
  /** 回合内：将手牌中的 1 张宝可梦道具附着于自己的宝可梦。 */
  attachTool(handIndex: number, target: MatchPokemonRef): void;
  /** 回合内：支付选定的撤退能量并换入备战宝可梦。 */
  retreat(energyIndices: readonly number[], benchIndex: number): void;
  /** 回合内：使用战斗宝可梦的招式。 */
  attack(attackIndex: number, target: MatchPokemonRef): void;
  /** 回合内：主动结束回合。 */
  endTurn(): void;
  /** 回合内：使用手牌中的训练家卡（物品/支援者/竞技场）。 */
  playTrainer(handIndex: number): void;
  /** 回合内：使用场上竞技场的效果（每名玩家每回合 1 次）。 */
  useStadium(): void;
  /** 支付代价/效果弃牌：从本人手牌选择并放于弃牌区。 */
  discardHand(handIndices: readonly number[]): void;
  /** 牌库检索：按候选 ID 选择并依效果放置。 */
  searchDeck(candidateIds: readonly string[]): void;
  /** 二选一效果：选择一个可用模式。 */
  chooseMode(modeId: string): void;
  /** 选择对手备战宝可梦与战斗宝可梦互换。 */
  switchOpponent(benchIndex: number): void;
  /** 卡牌效果：选择自己的 1 只备战宝可梦（如附着能量与回复 HP 的目标）。 */
  chooseOwnBench(benchIndex: number): void;
  /** 卡牌效果：从手牌选择 1 张能量；候选 ID 只在本次选择内有效。 */
  attachHandEnergy(candidateId: string): void;
  /** 卡牌效果：从自己场上宝可梦附着的能量中选择并放于弃牌区。 */
  discardEnergy(candidateIds: readonly string[]): void;
  /** 卡牌效果：从弃牌区/对手手牌等私有区域选择卡牌（如捩木、莉佳的邀请）。 */
  selectCard(candidateIds: readonly string[]): void;
  /** 卡牌效果：选择场上目标（如刺穿/贪欲藤蔓的备战目标、火焰巨浪的备战目标）。 */
  selectTarget(candidateIds: readonly string[]): void;
  /** 卡牌效果：「基因侵入」复制对手战斗宝可梦的 1 个招式。 */
  copyAttack(attackIndex: number): void;
  /** 昏厥结算：从本人未公开的奖赏卡中取走指定序号。 */
  takePrizes(prizes: readonly number[]): void;
  /** 昏厥结算：从备战区选择 1 只宝可梦升为战斗宝可梦。 */
  chooseReplacement(benchIndex: number): void;
  /** 确认认输（需以界面确认步骤为前提）；任意对局阶段可用。 */
  concede(): void;
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

export interface MatchControllerOptions {
  /** 发出命令、等待确认时通知（用于持久化原命令以便恢复时原样重发）。 */
  readonly onCommandPending?: (message: MatchClientMessage) => void;
  /** 等待结束（匹配的直接结果或错误）时通知；断线不清除持久化的重试命令。 */
  readonly onCommandSettled?: (commandId: string) => void;
}

export function createMatchController(
  connection: Pick<LiveConnection, 'closed' | 'send' | 'onMessage' | 'onClosed'>,
  onChange: (state: MatchState) => void,
  options: MatchControllerOptions = {},
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

  /** 等待结束并通知持久化层；断线路径不使用它，保留未确认命令供重连重发。 */
  function settlePending(): void {
    if (pendingRequest === null) {
      return;
    }
    const commandId = pendingRequest.commandId;
    pendingRequest = null;
    options.onCommandSettled?.(commandId);
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
    if (view.result !== null) {
      fail('match-finished', '对局已经结束。');
      return null;
    }
    if (view.phase !== 'playing') {
      fail('action-not-allowed', '对战尚未开始，暂时不能执行回合动作。');
      return null;
    }
    return view;
  }

  /** 认输的公共前置：任何对局阶段都可以确认认输，但终态后不再发送。 */
  function currentLive(): MatchView | null {
    const view = state.view;
    if (view === null) {
      fail('match-not-found', '还没有收到对局状态，暂时不能操作。');
      return null;
    }
    if (view.result !== null) {
      fail('match-finished', '对局已经结束。');
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
        settlePending();
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
      settlePending();
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
    // 断线不通知 onCommandSettled：持久化的未确认命令必须保留，供重连后重发。
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
    const message = build(view, commandId);
    if (send(message)) {
      pendingRequest = { commandId };
      options.onCommandPending?.(message);
      update({ pending: true, error: null });
    }
  }

  return {
    get state() {
      return state;
    },
    adoptSession(sessionId) {
      if (state.sessionId === sessionId) {
        return;
      }
      pendingRequest = null;
      publish({ ...INITIAL_MATCH_STATE, sessionId });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replay(message) {
      if (state.pending || connection.closed) {
        return;
      }
      if (send(message)) {
        pendingRequest = { commandId: message.commandId };
        update({ pending: true, error: null });
      }
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
    playTrainer(handIndex) {
      submit((view, commandId) => ({
        type: 'play-trainer',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        handIndex,
      }), false);
    },
    useStadium() {
      submit((view, commandId) => ({
        type: 'use-stadium',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
      }), false);
    },
    discardHand(handIndices) {
      submit((view, commandId) => ({
        type: 'discard-hand',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        handIndices: [...handIndices],
      }), true);
    },
    searchDeck(candidateIds) {
      submit((view, commandId) => ({
        type: 'search-deck',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        candidateIds: [...candidateIds],
      }), true);
    },
    chooseMode(modeId) {
      submit((view, commandId) => ({
        type: 'choose-mode',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        modeId,
      }), true);
    },
    switchOpponent(benchIndex) {
      submit((view, commandId) => ({
        type: 'switch-opponent',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        benchIndex,
      }), true);
    },
    chooseOwnBench(benchIndex) {
      submit((view, commandId) => ({
        type: 'choose-own-bench',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        benchIndex,
      }), true);
    },
    attachHandEnergy(candidateId) {
      submit((view, commandId) => ({
        type: 'attach-hand-energy',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        candidateId,
      }), true);
    },
    discardEnergy(candidateIds) {
      submit((view, commandId) => ({
        type: 'discard-energy',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        candidateIds: [...candidateIds],
      }), true);
    },
    selectCard(candidateIds) {
      submit((view, commandId) => ({
        type: 'select-card',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        candidateIds: [...candidateIds],
      }), true);
    },
    selectTarget(candidateIds) {
      submit((view, commandId) => ({
        type: 'select-target',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        candidateIds: [...candidateIds],
      }), true);
    },
    copyAttack(attackIndex) {
      submit((view, commandId) => ({
        type: 'copy-attack',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        attackIndex,
      }), true);
    },
    evolve(handIndex, target) {
      submit((view, commandId) => ({
        type: 'evolve',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        handIndex,
        target: { ...target },
      }), false);
    },
    useAbility(abilityIndex, target) {
      submit((view, commandId) => ({
        type: 'use-ability',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        abilityIndex,
        target: { ...target },
      }), false);
    },
    attachTool(handIndex, target) {
      submit((view, commandId) => ({
        type: 'attach-tool',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        handIndex,
        target: { ...target },
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
    takePrizes(prizes) {
      submit((view, commandId) => ({
        type: 'take-prizes',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        prizes: [...prizes],
      }), true);
    },
    chooseReplacement(benchIndex) {
      submit((view, commandId) => ({
        type: 'choose-replacement',
        commandId,
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: (view.pendingChoice as NonNullable<MatchView['pendingChoice']>).choiceId,
        benchIndex,
      }), true);
    },
    concede() {
      if (state.pending) {
        return;
      }
      const view = currentLive();
      if (view === null) {
        return;
      }
      const commandId = newCommandId();
      const message = { type: 'concede' as const, commandId, sessionId: view.sessionId, expectedVersion: view.version };
      if (send(message)) {
        pendingRequest = { commandId };
        options.onCommandPending?.(message);
        update({ pending: true, error: null });
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
