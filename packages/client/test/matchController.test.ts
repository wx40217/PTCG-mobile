import { describe, expect, it } from 'vitest';
import type { ClientMessage, ConnectionClosedEvent, LiveConnection, ServerMessage } from '@ptcg/protocol';
import { createMatchController } from '../src/rooms/matchController.ts';
import { matchCard, matchPokemon, matchSide, matchView } from './matchHelpers.ts';

type MatchCommand = Extract<ClientMessage, { sessionId: string }>;

interface FakeConnection {
  readonly connection: LiveConnection;
  readonly sent: ClientMessage[];
  emit(message: ServerMessage): void;
  emitClosed(event?: ConnectionClosedEvent): void;
}

function createFakeConnection(): FakeConnection {
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const closedListeners = new Set<(event: ConnectionClosedEvent) => void>();
  const sent: ClientMessage[] = [];
  let closed = false;
  const connection: LiveConnection = {
    session: {
      protocolVersion: 1,
      serverVersion: '0.1.0',
      sessionId: 'connection-1',
      deviceId: 'dev_match_client',
      nickname: '小智',
      registered: true,
    },
    get closed() {
      return closed;
    },
    send(message) {
      sent.push(message);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClosed(listener) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    close() {
      closed = true;
    },
  };
  return {
    connection,
    sent,
    emit(message) {
      for (const listener of [...messageListeners]) {
        listener(message);
      }
    },
    emitClosed(event = { kind: 'disconnected' }) {
      closed = true;
      for (const listener of [...closedListeners]) {
        listener(event);
      }
    },
  };
}

function lastSent(fake: FakeConnection): MatchCommand {
  const command = [...fake.sent].reverse().find((message): message is MatchCommand => 'sessionId' in message);
  if (command === undefined) {
    throw new Error('没有发出对局命令');
  }
  return command;
}

describe('对局控制器', () => {
  it('只采纳属于当前对局会话的视图，并以当前版本与候选 ID 生成命令', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    // 首个对局快照绑定会话；随后其他会话的旧对局快照不得抢占视图。
    const view = matchView({
      pendingChoice: {
        choiceId: 'choice-7',
        seat: 0,
        kind: 'turn-order',
        min: 1,
        max: 1,
        benchMin: 0,
        benchMax: 0,
        candidates: [],

        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
    });
    fake.emit({ type: 'match', view });
    expect(controller.state.view?.version).toBe(3);
    expect(controller.state.sessionId).toBe('session-1');
    fake.emit({ type: 'match', view: matchView({ sessionId: 'other-session', version: 99 }) });
    expect(controller.state.view?.version).toBe(3);

    controller.chooseTurnOrder(true);
    const command = lastSent(fake) as Extract<MatchCommand, { type: 'choose-turn-order' }>;
    expect(command).toMatchObject({
      type: 'choose-turn-order',
      sessionId: 'session-1',
      expectedVersion: 3,
      choiceId: 'choice-7',
      goFirst: true,
    });
    expect(command.commandId.length).toBeGreaterThan(0);
    expect(controller.state.pending).toBe(true);

    // 等待期间重复提交被忽略。
    const count = fake.sent.length;
    controller.chooseTurnOrder(false);
    expect(fake.sent).toHaveLength(count);
  });

  it('匹配的直接结果结束等待；乱序旧直接结果不把视图回退', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({
      type: 'match',
      view: matchView({
        version: 5,
        pendingChoice: {
          choiceId: 'choice-9',
          seat: 0,
          kind: 'place-setup',
          min: 1,
          max: 1,
          benchMin: 0,
          benchMax: 5,
          candidates: [0],

        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
      }),
    });
    controller.placeSetup(0, []);
    const commandId = lastSent(fake).commandId;
    // 先到一条更新的广播（对手动作）：只刷新视图，不结束自己的等待。
    fake.emit({ type: 'match', view: matchView({ version: 7 }) });
    expect(controller.state.view?.version).toBe(7);
    expect(controller.state.pending).toBe(true);
    // 自己的直接结果版本较旧：保留新内容，只结束等待。
    fake.emit({ type: 'match', commandId, view: matchView({ version: 6 }) });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.view?.version).toBe(7);
  });

  it('对手广播先到后，自己的直接失败结果仍要结束等待并展示错误', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({
      type: 'match',
      view: matchView({
        version: 4,
        pendingChoice: {
          choiceId: 'choice-11',
          seat: 0,
          kind: 'compensation-draw',
          min: 0,
          max: 1,
          benchMin: 0,
          benchMax: 0,
          candidates: [],

        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
      }),
    });
    controller.resolveCompensation(1);
    const commandId = lastSent(fake).commandId;
    // 对手动作广播先到：只刷新视图，不清 pending，也不丢弃自己的结果。
    fake.emit({ type: 'match', view: matchView({ version: 5 }) });
    expect(controller.state.pending).toBe(true);
    expect(controller.state.error).toBeNull();
    fake.emit({
      type: 'match-error',
      code: 'stale-version',
      message: '版本已更新',
      commandId,
      view: matchView({ version: 6 }),
    });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.error).toMatchObject({ code: 'stale-version' });
    expect(controller.state.view?.version).toBe(6);
  });

  it('对手广播不重置已有错误；匹配的重复结果只结束一次等待', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({
      type: 'match',
      view: matchView({
        version: 4,
        pendingChoice: {
          choiceId: 'choice-12',
          seat: 0,
          kind: 'place-bench',
          min: 0,
          max: 1,
          benchMin: 0,
          benchMax: 1,
          candidates: [0],

        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
      }),
    });
    controller.placeBench([]);
    const commandId = lastSent(fake).commandId;
    fake.emit({ type: 'match-error', code: 'illegal-choice', message: '非法', commandId, view: matchView({ version: 5 }) });
    expect(controller.state.error).toMatchObject({ code: 'illegal-choice' });
    // 对手的后续广播只更新视图，不把错误生命周期重置成“已解决”。
    fake.emit({ type: 'match', view: matchView({ version: 6 }) });
    expect(controller.state.error).toMatchObject({ code: 'illegal-choice' });
    expect(controller.state.view?.version).toBe(6);
    // 同一条直接结果再次到达（服务端重传）不会重新进入等待或重复报错。
    fake.emit({ type: 'match', commandId, view: matchView({ version: 5 }) });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.view?.version).toBe(6);
  });

  it('对局错误带当前视图时同步并展示；旧命令错误被丢弃', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    const view = matchView({
      pendingChoice: {
        choiceId: 'choice-1',
        seat: 0,
        kind: 'compensation-draw',
        min: 0,
        max: 2,
        benchMin: 0,
        benchMax: 0,
        candidates: [],

        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
    });
    fake.emit({ type: 'match', view });
    controller.resolveCompensation(9);
    const commandId = lastSent(fake).commandId;
    // 旧命令（不匹配命令 ID）的错误不展示。
    fake.emit({ type: 'match-error', code: 'stale-choice', message: '旧', commandId: 'other-command' });
    expect(controller.state.error).toBeNull();
    // 当前命令的错误带服务端最新视图：同步内容并展示错误。
    fake.emit({
      type: 'match-error',
      code: 'stale-version',
      message: '版本已更新',
      commandId,
      view: matchView({ version: 8 }),
    });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.error).toMatchObject({ code: 'stale-version' });
    expect(controller.state.view?.version).toBe(8);
    controller.clearError();
    expect(controller.state.error).toBeNull();
  });

  it('没有待决选择或断线时拒绝提交并给出可理解状态', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: matchView() });
    controller.chooseTurnOrder(true);
    expect(fake.sent).toHaveLength(0);
    expect(controller.state.error).toMatchObject({ code: 'choice-pending' });

    fake.emitClosed();
    expect(controller.state.pending).toBe(false);
    expect(controller.state.error).toMatchObject({ code: 'disconnected' });
  });
});

describe('对局控制器：回合命令（#9）', () => {
  function playingView(): ReturnType<typeof matchView> {
    return matchView({
      phase: 'playing',
      turn: 3,
      activeSeat: 0,
      you: {
        ...matchSide(0),
        hand: [],
        handCount: 0,
        active: {
          card: matchCard(),
          damageCounters: 0,
          statuses: [],
          energies: [{ energyIndex: 0, card: matchCard({ cardId: 'cbb1c-1803', nameZh: '基本水能量', kind: 'energy' }) }],
          attacks: [{ index: 0, name: '水枪', cost: ['水'], damageText: '10', effectTextZh: null, supported: true }],
          retreatCost: 1,
          weakness: '雷×2',
          resistance: null,
        },
        bench: [],
      },
    });
  }

  it('回合命令携带当前会话与版本；成功后等待直接结果，重复提交被忽略', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: playingView() });

    controller.attachEnergy(2, { slot: 'active' });
    const attach = lastSent(fake) as Extract<MatchCommand, { type: 'attach-energy' }>;
    expect(attach).toMatchObject({
      type: 'attach-energy',
      sessionId: 'session-1',
      expectedVersion: 3,
      handIndex: 2,
      target: { slot: 'active' },
    });
    expect(controller.state.pending).toBe(true);
    const count = fake.sent.length;
    controller.attachEnergy(2, { slot: 'bench', index: 0 });
    expect(fake.sent).toHaveLength(count);

    // 匹配的直接结果结束等待并采纳新版本。
    fake.emit({ type: 'match', commandId: attach.commandId, view: matchView({ ...playingView(), version: 4 }) });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.view?.version).toBe(4);

    controller.endTurn();
    const endTurn = lastSent(fake) as Extract<MatchCommand, { type: 'end-turn' }>;
    expect(endTurn).toMatchObject({ type: 'end-turn', expectedVersion: 4 });
  });

  it('招式、撤退与放基础的命令载荷按视图生成', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: playingView() });
    controller.attack(0, { slot: 'active' });
    expect(lastSent(fake)).toMatchObject({ type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    fake.emit({ type: 'match', commandId: lastSent(fake).commandId, view: matchView({ ...playingView(), version: 4 }) });
    controller.retreat([0], 1);
    expect(lastSent(fake)).toMatchObject({ type: 'retreat', energyIndices: [0], benchIndex: 1 });
    fake.emit({ type: 'match', commandId: lastSent(fake).commandId, view: matchView({ ...playingView(), version: 5 }) });
    controller.playBasic(1);
    expect(lastSent(fake)).toMatchObject({ type: 'play-basic', handIndex: 1 });
  });

  it('尚未进入 playing、无视图或断线时回合命令不发出', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: matchView({ phase: 'setup' }) });
    controller.endTurn();
    expect(fake.sent).toHaveLength(0);
    expect(controller.state.error).toMatchObject({ code: 'action-not-allowed' });

    fake.emitClosed();
    controller.endTurn();
    expect(fake.sent).toHaveLength(0);
  });

  it('回合命令的服务端错误带当前视图时同步最新状态并保留错误生命周期', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: playingView() });
    controller.attack(0, { slot: 'active' });
    const commandId = lastSent(fake).commandId;
    // 对手广播先到：只刷新视图，不结束等待也不清除错误。
    fake.emit({ type: 'match', view: matchView({ ...playingView(), version: 4 }) });
    expect(controller.state.pending).toBe(true);
    fake.emit({
      type: 'match-error',
      code: 'insufficient-energy',
      message: '能量不足。',
      commandId,
      view: matchView({ ...playingView(), version: 4 }),
    });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.error).toMatchObject({ code: 'insufficient-energy' });
    expect(controller.state.view?.version).toBe(4);
    // 后续对手广播不重置错误。
    fake.emit({ type: 'match', view: matchView({ ...playingView(), version: 5 }) });
    expect(controller.state.error).toMatchObject({ code: 'insufficient-energy' });
    expect(controller.state.view?.version).toBe(5);
  });
});

describe('对局控制器：昏厥结算与认输（#10）', () => {
  function prizeView(overrides: Parameters<typeof matchView>[0] = {}) {
    return matchView({
      phase: 'playing',
      turn: 5,
      activeSeat: 0,
      pendingChoice: { choiceId: 'choice-7', seat: 0, kind: 'take-prizes', min: 1, max: 1, benchMin: 0, benchMax: 0, candidates: [0, 1, 2],
        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
      you: { ...matchSide(0), prizeCount: 3 },
      ...overrides,
    });
  }

  it('取奖赏卡与补充战斗宝可梦携带当前 choiceId；直接结果结束等待', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: prizeView() });
    controller.takePrizes([2]);
    const take = lastSent(fake) as Extract<MatchCommand, { type: 'take-prizes' }>;
    expect(take).toMatchObject({
      type: 'take-prizes',
      sessionId: 'session-1',
      expectedVersion: 3,
      choiceId: 'choice-7',
      prizes: [2],
    });
    expect(controller.state.pending).toBe(true);
    fake.emit({ type: 'match', commandId: take.commandId, view: matchView({ ...prizeView(), version: 4, pendingChoice: null }) });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.view?.version).toBe(4);

    const replacement = matchView({
      version: 5,
      phase: 'playing',
      turn: 5,
      activeSeat: 0,
      pendingChoice: { choiceId: 'choice-8', seat: 0, kind: 'choose-replacement', min: 1, max: 1, benchMin: 0, benchMax: 0, candidates: [0],
        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
      you: { ...matchSide(0), bench: [matchPokemon()] },
    });
    fake.emit({ type: 'match', view: replacement });
    controller.chooseReplacement(0);
    expect(lastSent(fake)).toMatchObject({ type: 'choose-replacement', choiceId: 'choice-8', benchIndex: 0 });
  });

  it('无待决选择时取奖赏/换位不发出；旧选择错误保持错误生命周期', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: matchView({ phase: 'playing' }) });
    controller.takePrizes([0]);
    controller.chooseReplacement(0);
    expect(fake.sent).toHaveLength(0);
    expect(controller.state.error).toMatchObject({ code: 'choice-pending' });
    // 服务端 stale-choice 错误带当前视图：错误保留，视图同步到最新版本。
    fake.emit({ type: 'match', view: prizeView() });
    controller.takePrizes([0]);
    const commandId = lastSent(fake).commandId;
    fake.emit({
      type: 'match-error',
      code: 'stale-choice',
      message: '旧选择。',
      commandId,
      view: prizeView({ version: 6, pendingChoice: { choiceId: 'choice-9', seat: 0, kind: 'take-prizes', min: 1, max: 1, benchMin: 0, benchMax: 0, candidates: [0],
        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      } }),
    });
    expect(controller.state.error).toMatchObject({ code: 'stale-choice' });
    expect(controller.state.view?.pendingChoice?.choiceId).toBe('choice-9');
  });

  it('认输在开局阶段也可发送；终态视图下不再发送任何命令', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: matchView({ phase: 'setup' }) });
    controller.concede();
    const concede = lastSent(fake) as Extract<MatchCommand, { type: 'concede' }>;
    expect(concede).toMatchObject({ type: 'concede', sessionId: 'session-1', expectedVersion: 3 });
    fake.emit({
      type: 'match',
      commandId: concede.commandId,
      view: matchView({ phase: 'setup', version: 4, result: { winner: 1, reason: 'concede', conditions: [] } }),
    });
    expect(controller.state.pending).toBe(false);
    controller.concede();
    controller.endTurn();
    expect(fake.sent).toHaveLength(1);
    expect(controller.state.error).toMatchObject({ code: 'match-finished' });
  });
});

describe('训练家命令与通用选择控制器（T10 / #11）', () => {
  function clearPending(fake: FakeConnection): void {
    const command = lastSent(fake);
    fake.emit({ type: 'match', commandId: command.commandId, view: matchView({ version: 4, phase: 'playing' }) });
  }

  it('发送训练家出牌与竞技场使用命令，并由服务端视图决定是否可用', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: matchView({ phase: 'playing', turn: 2, activeSeat: 0 }) });
    controller.playTrainer(3);
    expect(lastSent(fake)).toMatchObject({ type: 'play-trainer', handIndex: 3, expectedVersion: 3 });
    clearPending(fake);
    controller.useStadium();
    expect(lastSent(fake)).toMatchObject({ type: 'use-stadium', expectedVersion: 4 });
  });

  it('发送弃牌、检索、模式与互换四类通用选择命令', () => {
    const baseChoice = {
      seat: 0 as const,
      min: 1,
      max: 2,
      benchMin: 0,
      benchMax: 0,
      candidates: [0, 2],
      step: 1,
      stepCount: 1,
      source: 'hand' as const,
      descriptionZh: '测试选择',
      cardCandidates: [{ candidateId: 'c1', card: matchCard() }],
      modes: [
        { modeId: 'discard-draw-five', labelZh: '弃牌抽牌', available: true, unavailableReasonZh: null },
      ],
    };
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: matchView({ phase: 'playing', pendingChoice: { ...baseChoice, choiceId: 'choice-9', kind: 'discard-hand' } }) });
    controller.discardHand([0, 2]);
    expect(lastSent(fake)).toMatchObject({ type: 'discard-hand', choiceId: 'choice-9', handIndices: [0, 2] });

    clearPending(fake);
    fake.emit({ type: 'match', view: matchView({ version: 5, phase: 'playing', pendingChoice: { ...baseChoice, choiceId: 'choice-10', kind: 'search-deck', source: 'deck' } }) });
    controller.searchDeck(['c1']);
    expect(lastSent(fake)).toMatchObject({ type: 'search-deck', choiceId: 'choice-10', candidateIds: ['c1'] });

    clearPending(fake);
    fake.emit({ type: 'match', view: matchView({ version: 6, phase: 'playing', pendingChoice: { ...baseChoice, choiceId: 'choice-11', kind: 'choose-mode' } }) });
    controller.chooseMode('discard-draw-five');
    expect(lastSent(fake)).toMatchObject({ type: 'choose-mode', choiceId: 'choice-11', modeId: 'discard-draw-five' });

    clearPending(fake);
    fake.emit({ type: 'match', view: matchView({ version: 7, phase: 'playing', pendingChoice: { ...baseChoice, choiceId: 'choice-12', kind: 'switch-opponent', source: 'opponent-bench' } }) });
    controller.switchOpponent(1);
    expect(lastSent(fake)).toMatchObject({ type: 'switch-opponent', choiceId: 'choice-12', benchIndex: 1 });
  });

  it('没有待决选择时不发送通用选择命令，并给出可理解说明', () => {
    const fake = createFakeConnection();
    const controller = createMatchController(fake.connection, () => undefined);
    fake.emit({ type: 'match', view: matchView({ phase: 'playing' }) });
    controller.discardHand([0]);
    expect(fake.sent.filter((message) => 'sessionId' in message && message.type === 'discard-hand')).toHaveLength(0);
    expect(controller.state.error?.code).toBe('choice-pending');
  });
});
