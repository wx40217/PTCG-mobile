import { describe, expect, it } from 'vitest';
import type {
  ClientMessage,
  ConnectionClosedEvent,
  LiveConnection,
  RoomView,
  ServerMessage,
} from '@ptcg/protocol';
import { createRoomController } from '../src/rooms/roomController.ts';

type RoomCommand = Extract<ClientMessage, { commandId: string }>;

function roomView(overrides: Partial<RoomView> = {}): RoomView {
  return {
    roomId: 'room-instance-1',
    code: '042000',
    version: 1,
    status: 'waiting',
    you: {
      seat: 0,
      occupied: true,
      host: true,
      nickname: '小智',
      ready: false,
      online: true,
      deckSelected: false,
      deck: null,
    },
    opponent: {
      seat: 1,
      occupied: false,
      host: false,
      nickname: null,
      ready: false,
      online: false,
      deckSelected: false,
      deck: null,
    },
    match: null,
    ...overrides,
  };
}

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
      sessionId: 'session-room',
      deviceId: 'dev_room_client',
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

function createHarness() {
  const fake = createFakeConnection();
  const controller = createRoomController(fake.connection, () => undefined);
  return { fake, controller };
}

/** 最近一条指定类型的房间命令；没有发送过则直接失败，避免把测试写漏。 */
function lastSent(fake: FakeConnection, type: RoomCommand['type']): RoomCommand {
  const command = [...fake.sent].reverse().find((message): message is RoomCommand => message.type === type);
  if (command === undefined) {
    throw new Error(`测试没有发送 ${type} 命令`);
  }
  return command;
}

describe('房间控制器：跨房间缓存重放防护', () => {
  it('等待新房响应期间，旧实例缓存快照（命令不匹配）不能抢占界面', () => {
    const { fake, controller } = createHarness();
    controller.createRoom();

    // 旧命令的缓存快照：commandId 不属于当前等待的建房命令。
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-old', code: '111111', version: 9 }), commandId: 'old-select-command' });
    expect(controller.state.room).toBeNull();
    expect(controller.state.phase).toBe('joining');
    expect(controller.state.pending).toBe(true);

    // 当前建房命令的直接结果携带匹配的 commandId，正常采纳。
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-new', code: '222222', version: 1 }), commandId: lastSent(fake, 'create-room').commandId });
    expect(controller.state.phase).toBe('in-room');
    expect(controller.state.room?.roomId).toBe('room-new');
    expect(controller.state.pending).toBe(false);
  });

  it('离开 A 加入 B 后，A 的缓存快照与缓存错误都不会切回 A', () => {
    const { fake, controller } = createHarness();

    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 5 }), commandId: lastSent(fake, 'create-room').commandId });
    expect(controller.state.room?.roomId).toBe('room-A');

    controller.leaveRoom();
    const leaveA = lastSent(fake, 'leave-room');
    fake.emit({ type: 'room-left', roomId: 'room-A', code: '111111', version: 6, reason: 'left', commandId: leaveA.commandId });
    expect(controller.state.phase).toBe('left');
    expect(controller.state.room).toBeNull();

    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-B', code: '333333', version: 1 }), commandId: lastSent(fake, 'create-room').commandId });
    expect(controller.state.room?.roomId).toBe('room-B');

    // 重放 A 的旧选卡组/建房缓存快照：命令 ID 不匹配当前等待（无等待），且实例不同，必须丢弃。
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 7 }), commandId: 'old-select-command' });
    // 无命令关联的旧式快照同样不能切换实例。
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 8 }) });
    expect(controller.state.room?.roomId).toBe('room-B');
    expect(controller.state.phase).toBe('in-room');

    // 重放 A 的旧 version-conflict 缓存错误：不展示陈旧错误，也不借机切回 A。
    fake.emit({
      type: 'room-error',
      code: 'version-conflict',
      message: '房间状态已更新到版本 7，这条命令未生效。',
      commandId: leaveA.commandId,
      room: roomView({ roomId: 'room-A', code: '111111', version: 7 }),
    });
    expect(controller.state.error).toBeNull();
    expect(controller.state.room?.roomId).toBe('room-B');
    expect(controller.state.phase).toBe('in-room');
  });

  it('旧实例墓碑阻止无命令关联的快照；显式重入同一实例仍然可用', () => {
    const { fake, controller } = createHarness();

    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 2 }), commandId: lastSent(fake, 'create-room').commandId });
    controller.leaveRoom();
    fake.emit({
      type: 'room-left',
      roomId: 'room-A',
      code: '111111',
      version: 3,
      reason: 'left',
      commandId: lastSent(fake, 'leave-room').commandId,
    });

    // 加入同码：携带已知实例，避免房间码复用后误入新实例。
    controller.joinRoom('111111');
    const join = lastSent(fake, 'join-room');
    expect(join).toMatchObject({ type: 'join-room', code: '111111', roomId: 'room-A' });

    // 显式重入同一实例：无命令关联的旧式快照也可以采纳。
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 4 }) });
    expect(controller.state.room?.roomId).toBe('room-A');

    // 再次离开后新建房间：A 的墓碑阻止其无命令关联的旧快照抢占新房窗口。
    controller.leaveRoom();
    fake.emit({
      type: 'room-left',
      roomId: 'room-A',
      code: '111111',
      version: 5,
      reason: 'left',
      commandId: lastSent(fake, 'leave-room').commandId,
    });
    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 6 }) });
    expect(controller.state.room).toBeNull();
    expect(controller.state.pending).toBe(true);
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-B', code: '222222', version: 1 }), commandId: lastSent(fake, 'create-room').commandId });
    expect(controller.state.room?.roomId).toBe('room-B');
  });

  it('开局后离开再建房：带匹配命令的直接结果可以回到同一实例（墓碑不阻止真实重新入座）', () => {
    const { fake, controller } = createHarness();

    controller.createRoom();
    fake.emit({
      type: 'room',
      room: roomView({ roomId: 'room-A', code: '111111', version: 4, status: 'started', match: { sessionId: 'match-1', version: 1 } }),
      commandId: lastSent(fake, 'create-room').commandId,
    });
    controller.leaveRoom();
    fake.emit({
      type: 'room-left',
      roomId: 'room-A',
      code: '111111',
      version: 5,
      reason: 'left',
      commandId: lastSent(fake, 'leave-room').commandId,
    });

    controller.createRoom();
    fake.emit({
      type: 'room',
      room: roomView({ roomId: 'room-A', code: '111111', version: 6, status: 'started', match: { sessionId: 'match-1', version: 1 } }),
      commandId: lastSent(fake, 'create-room').commandId,
    });
    expect(controller.state.room?.roomId).toBe('room-A');
    expect(controller.state.room?.status).toBe('started');
  });

  it('同实例按版本去重：更旧的快照被忽略，相同版本仍被采纳', () => {
    const { fake, controller } = createHarness();
    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 5 }), commandId: lastSent(fake, 'create-room').commandId });

    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 4, you: { ...roomView().you, nickname: '旧昵称' } }) });
    expect(controller.state.room?.you.nickname).toBe('小智');

    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 5, you: { ...roomView().you, nickname: '同版本昵称' } }) });
    expect(controller.state.room?.you.nickname).toBe('同版本昵称');
  });

  it('带当前命令关联的冲突错误仍同步最新快照并展示错误', () => {
    const { fake, controller } = createHarness();
    controller.createRoom();
    fake.emit({
      type: 'room-error',
      code: 'version-conflict',
      message: '房间状态已更新，请按最新状态重新确认。',
      commandId: lastSent(fake, 'create-room').commandId,
      room: roomView({ roomId: 'room-A', code: '111111', version: 3 }),
    });
    expect(controller.state.room?.roomId).toBe('room-A');
    expect(controller.state.room?.version).toBe(3);
    expect(controller.state.error?.code).toBe('version-conflict');
    expect(controller.state.pending).toBe(false);
  });

  it('等待自己的命令时对手广播先到：匹配的版本冲突仍然展示且不卡等待', () => {
    const { fake, controller } = createHarness();
    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 1 }), commandId: lastSent(fake, 'create-room').commandId });

    controller.setReady(true);
    const ready = lastSent(fake, 'set-ready');
    expect(controller.state.pending).toBe(true);

    // 对手动作先把房间推进到 v2；这是无命令关联的广播，不得结束本机等待。
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 2 }) });
    expect(controller.state.room?.version).toBe(2);
    expect(controller.state.pending).toBe(true);
    expect(controller.state.error).toBeNull();

    // 自己的 set-ready 基于 v1，服务端以 version-conflict 拒绝并回传 v2。
    fake.emit({
      type: 'room-error',
      code: 'version-conflict',
      message: '房间状态已更新到版本 2，这条命令未生效。',
      commandId: ready.commandId,
      room: roomView({ roomId: 'room-A', code: '111111', version: 2 }),
    });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.error?.code).toBe('version-conflict');
    expect(controller.state.room?.version).toBe(2);
    expect(controller.state.phase).toBe('in-room');
  });

  it('对手广播先到后，匹配的成功结果以更新版本采纳并结束等待', () => {
    const { fake, controller } = createHarness();
    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 1 }), commandId: lastSent(fake, 'create-room').commandId });

    controller.setReady(true);
    const ready = lastSent(fake, 'set-ready');
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 2 }) });
    expect(controller.state.pending).toBe(true);

    fake.emit({
      type: 'room',
      room: roomView({
        roomId: 'room-A',
        code: '111111',
        version: 3,
        you: { ...roomView().you, ready: true },
      }),
      commandId: ready.commandId,
    });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.error).toBeNull();
    expect(controller.state.room?.version).toBe(3);
    expect(controller.state.room?.you.ready).toBe(true);
  });

  it('等待加入结果时同实例广播先到：只更新房间，匹配结果即使更旧也结束等待', () => {
    const { fake, controller } = createHarness();
    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 2 }), commandId: lastSent(fake, 'create-room').commandId });

    // 已在房间内再次加入（重连/重复加入走显式 roomId）：等待结果期间收到对手广播。
    controller.joinRoom('111111');
    const join = lastSent(fake, 'join-room');
    expect(join).toMatchObject({ type: 'join-room', code: '111111', roomId: 'room-A' });

    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 3 }) });
    expect(controller.state.room?.version).toBe(3);
    expect(controller.state.pending).toBe(true);

    // 匹配的加入结果比先到的广播旧（乱序）：保留 v3，仅结束等待，不卡 pending。
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 2 }), commandId: join.commandId });
    expect(controller.state.pending).toBe(false);
    expect(controller.state.phase).toBe('in-room');
    expect(controller.state.room?.version).toBe(3);
  });

  it('没有等待命令时，无命令关联的陌生快照与离开结果都不会创建房间', () => {
    const { fake, controller } = createHarness();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-x', code: '999999', version: 3 }) });
    fake.emit({ type: 'room-left', roomId: 'room-x', code: '999999', version: 3, reason: 'left' });
    fake.emit({ type: 'room-closed', roomId: 'room-x', code: '999999', version: 3, reason: 'host-left' });
    expect(controller.state.phase).toBe('idle');
    expect(controller.state.room).toBeNull();
    expect(controller.state.lastCode).toBeNull();
  });

  it('对局结束后 finished 房间允许重新准备新局，started 房间仍禁止换卡组/准备', () => {
    const { fake, controller } = createHarness();
    controller.createRoom();
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', code: '111111', version: 1 }), commandId: lastSent(fake, 'create-room').commandId });
    fake.emit({
      type: 'room',
      room: roomView({
        roomId: 'room-A',
        code: '111111',
        version: 9,
        status: 'finished',
        match: { sessionId: 'match-1', version: 7 },
        you: { ...roomView().you, ready: false },
      }),
    });
    controller.setReady(true);
    expect(lastSent(fake, 'set-ready')).toMatchObject({ type: 'set-ready', roomId: 'room-A', expectedVersion: 9, ready: true });
    fake.emit({
      type: 'room',
      room: roomView({ roomId: 'room-A', code: '111111', version: 10, status: 'finished', match: { sessionId: 'match-1', version: 7 } }),
      commandId: lastSent(fake, 'set-ready').commandId,
    });
    fake.emit({
      type: 'room',
      room: roomView({ roomId: 'room-A', code: '111111', version: 11, status: 'finished', match: { sessionId: 'match-1', version: 7 } }),
    });
    controller.selectDeck({ formatVersion: 1, environmentId: 'env', cards: [] });
    expect(lastSent(fake, 'select-deck')).toMatchObject({ type: 'select-deck', roomId: 'room-A', expectedVersion: 11 });

    // started（新一局进行中）仍然禁止换卡组与重新准备。
    fake.emit({
      type: 'room',
      room: roomView({ roomId: 'room-A', code: '111111', version: 12, status: 'started', match: { sessionId: 'match-2', version: 1 } }),
      commandId: lastSent(fake, 'select-deck').commandId,
    });
    const before = fake.sent.length;
    controller.setReady(true);
    expect(fake.sent).toHaveLength(before);
  });
});
