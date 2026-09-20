import { describe, expect, it } from 'vitest';
import type { ClientMessage, ConnectionClosedEvent, LiveConnection, ServerMessage } from '@ptcg/protocol';
import { createMatchController } from '../src/rooms/matchController.ts';
import { matchView } from './matchHelpers.ts';

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
        },
      }),
    });
    controller.placeSetup(0, []);
    const commandId = lastSent(fake).commandId;
    // 先到一条更新的广播（对手动作）。
    fake.emit({ type: 'match', view: matchView({ version: 7 }) });
    expect(controller.state.view?.version).toBe(7);
    // 自己的直接结果版本较旧：保留新内容，只结束等待。
    fake.emit({ type: 'match', commandId, view: matchView({ version: 6 }) });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.view?.version).toBe(7);
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
