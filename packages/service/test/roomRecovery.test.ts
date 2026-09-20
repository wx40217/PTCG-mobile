import { afterEach, describe, expect, it } from 'vitest';
import type {
  MatchClientMessage,
  MatchServerMessage,
  MatchView,
  RoomClientMessage,
  RoomServerMessage,
  RoomView,
} from '@ptcg/protocol';
import { createRoomRegistry, type RoomChannel, type RoomConnection, type RoomRegistry } from '../src/rooms.ts';
import { createTempDirectory, nextCommandId, releasePreset, writePlayableFixture, type TempDirectory } from './support/roomTestKit.ts';

/**
 * 断线恢复的注册表级测试（#15）。
 *
 * 用受控时钟 + 可注入定时器精确覆盖 180 秒边界；用记录型 channel 模拟
 * 「确认丢失」的重传，用假连接模拟「旧连接仍能发消息」的攻击面。
 * 真实 socket 与 Android 行为另有集成/E2E/设备验收。
 */

class ManualClock {
  private current = 0;
  private readonly timers = new Map<object, { readonly at: number; readonly callback: () => void }>();

  public now = (): number => this.current;

  public setTimer = (callback: () => void, delayMs: number): object => {
    const handle: object = {};
    this.timers.set(handle, { at: this.current + delayMs, callback });
    return handle;
  };

  public clearTimer = (handle: unknown): void => {
    if (handle !== null && typeof handle === 'object') {
      this.timers.delete(handle);
    }
  };

  /** 推进时钟并同步执行所有到期定时器（按到期先后）。 */
  public advance(ms: number): void {
    this.current += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) {
        return;
      }
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

interface SentRecord {
  readonly connectionId: string;
  readonly message: RoomServerMessage | MatchServerMessage;
}

interface Harness {
  readonly temp: TempDirectory;
  readonly registry: RoomRegistry;
  readonly clock: ManualClock;
  readonly records: SentRecord[];
  readonly revoked: { readonly connectionId: string; readonly message: string }[];
  readonly a: RoomConnection;
  readonly b: RoomConnection;
  readonly code: string;
  readonly roomId: string;
  readonly match: MatchView;
  close(): void;
}

let sessionSeq = 0;

function latestRoom(records: readonly SentRecord[], connectionId: string): RoomView | undefined {
  const found = [...records].reverse().find((entry) => entry.connectionId === connectionId && entry.message.type === 'room');
  return found?.message.type === 'room' ? found.message.room : undefined;
}

function latestMatch(records: readonly SentRecord[], connectionId: string): MatchView | undefined {
  const found = [...records].reverse().find((entry) => entry.connectionId === connectionId && entry.message.type === 'match');
  return found?.message.type === 'match' ? found.message.view : undefined;
}

function lastError(records: readonly SentRecord[], connectionId: string): { readonly type: string; readonly code: string } | undefined {
  const found = [...records].reverse().find((entry) => entry.connectionId === connectionId && entry.message.type.endsWith('-error'));
  return found === undefined ? undefined : { type: found.message.type, code: found.message.type === 'match-error' ? found.message.code : found.message.code };
}

/** 建房 → 加入 → 双方选同一预设并准备 → 对局会话建立（随机源固定座位 0 获选）。 */
async function startStartedMatch(): Promise<Harness> {
  const temp = createTempDirectory('ptcg-recovery-registry-');
  const fixture = await writePlayableFixture(temp.path);
  const clock = new ManualClock();
  const records: SentRecord[] = [];
  const revoked: { connectionId: string; message: string }[] = [];
  const channel: RoomChannel = {
    send(connectionId, message) {
      records.push({ connectionId, message });
    },
    revoke(connectionId, message) {
      revoked.push({ connectionId, message });
      // 与真实服务端一致：先给旧连接明确拒绝，再关闭套接字。
      records.push({ connectionId, message: { type: 'room-error', code: 'seat-taken-over', message } });
    },
  };
  const registry = createRoomRegistry({
    now: clock.now,
    timers: clock,
    limits: { disconnectBudgetMs: 180_000 },
    matchRandom: { nextInt: () => 0 },
    generateCode: () => '242424',
    newRoomId: () => 'room-recovery',
    newSessionId: () => `session-recovery-${(sessionSeq += 1)}`,
    catalog: () => ({ content: fixture.content, catalogVersion: fixture.catalogVersion }),
    channel,
  });
  const a: RoomConnection = { connectionId: 'conn-a1', deviceId: 'dev-a', nickname: '小智' };
  const b: RoomConnection = { connectionId: 'conn-b1', deviceId: 'dev-b', nickname: '小茂' };
  const dispatch = (connection: RoomConnection, message: RoomClientMessage | MatchClientMessage): void => {
    registry.handleCommand(connection, message);
  };
  dispatch(a, { type: 'create-room', commandId: nextCommandId() });
  const created = latestRoom(records, a.connectionId);
  if (created === undefined) {
    throw new Error('建房未产生房间快照');
  }
  dispatch(b, { type: 'join-room', commandId: nextCommandId(), code: created.code });
  const deck = releasePreset('A');
  for (const connection of [a, b]) {
    const room = latestRoom(records, connection.connectionId);
    if (room === undefined) {
      throw new Error('缺少房间快照');
    }
    dispatch(connection, {
      type: 'select-deck',
      commandId: nextCommandId(),
      roomId: room.roomId,
      expectedVersion: room.version,
      deck,
    });
  }
  for (const connection of [a, b]) {
    const room = latestRoom(records, connection.connectionId);
    if (room === undefined) {
      throw new Error('缺少房间快照');
    }
    dispatch(connection, { type: 'set-ready', commandId: nextCommandId(), roomId: room.roomId, expectedVersion: room.version, ready: true });
  }
  const match = latestMatch(records, a.connectionId);
  if (match === undefined) {
    throw new Error('准备完成未建立对局');
  }
  if (latestRoom(records, a.connectionId)?.status !== 'started') {
    throw new Error('房间未进入 started');
  }
  return {
    temp,
    registry,
    clock,
    records,
    revoked,
    a,
    b,
    code: created.code,
    roomId: created.roomId,
    match,
    close() {
      temp.cleanup();
    },
  };
}

function rejoin(harness: Harness, connectionId: string, deviceId: string, nickname: string): RoomConnection {
  const connection: RoomConnection = { connectionId, deviceId, nickname };
  harness.registry.handleCommand(connection, {
    type: 'join-room',
    commandId: nextCommandId(),
    code: harness.code,
    roomId: harness.roomId,
  });
  return connection;
}

function dispatch(harness: Harness, connection: RoomConnection, message: RoomClientMessage | MatchClientMessage): void {
  harness.registry.handleCommand(connection, message);
}

/** 从服务端最新视图自适应完成开局，直到双方进入 playing。 */
function completeOpening(harness: Harness, connections: readonly RoomConnection[]): void {
  for (let step = 0; step < 200; step += 1) {
    if (connections.every((connection) => latestMatch(harness.records, connection.connectionId)?.phase === 'playing')) {
      return;
    }
    let progressed = false;
    for (const connection of connections) {
      const view = latestMatch(harness.records, connection.connectionId);
      const choice = view?.pendingChoice;
      if (view === undefined || choice === null || choice === undefined) {
        continue;
      }
      const base = {
        commandId: nextCommandId(),
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: choice.choiceId,
      };
      if (choice.kind === 'turn-order') {
        dispatch(harness, connection, { type: 'choose-turn-order', ...base, goFirst: true });
      } else if (choice.kind === 'place-setup') {
        const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
        dispatch(harness, connection, { type: 'place-setup', ...base, active: basics[0] ?? 0, bench: basics.slice(1, 2) });
      } else if (choice.kind === 'compensation-draw') {
        dispatch(harness, connection, { type: 'resolve-compensation', ...base, draw: 0 });
      } else if (choice.kind === 'place-bench') {
        const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
        dispatch(harness, connection, { type: 'place-bench', ...base, bench: basics.slice(0, 1) });
      } else {
        throw new Error(`测试未覆盖的待决选择：${choice.kind}`);
      }
      progressed = true;
    }
    if (!progressed) {
      throw new Error('开局推进停滞');
    }
  }
  throw new Error('开局未在限定步数内进入 playing');
}

/** 在已结束的房间中重新选卡组并双方准备，创建新一局。 */
function startRematch(harness: Harness, connections: readonly RoomConnection[]): void {
  for (const connection of connections) {
    const room = latestRoom(harness.records, connection.connectionId);
    if (room === undefined) {
      throw new Error('缺少房间快照');
    }
    dispatch(harness, connection, {
      type: 'select-deck',
      commandId: nextCommandId(),
      roomId: room.roomId,
      expectedVersion: room.version,
      deck: releasePreset('A'),
    });
  }
  for (const connection of connections) {
    const room = latestRoom(harness.records, connection.connectionId);
    if (room === undefined) {
      throw new Error('缺少房间快照');
    }
    dispatch(harness, connection, {
      type: 'set-ready',
      commandId: nextCommandId(),
      roomId: room.roomId,
      expectedVersion: room.version,
      ready: true,
    });
  }
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe('断线预算与重连（#15 注册表级）', () => {
  it('对手看到离线等待；预算内重连恢复同一座位、最新版本与待决选择，累计断线不重置', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, clock, records } = harness;
    expect(harness.match.pendingChoice?.kind).toBe('turn-order');
    expect(latestMatch(records, 'conn-b1')?.connection).toMatchObject({ youOnline: true, opponentOnline: true });

    // A 断线：B 立刻在最新对局视图里看到等待重连，而不是等下一次操作。
    registry.detachConnection('conn-a1');
    const waiting = latestMatch(records, 'conn-b1');
    expect(waiting?.connection).toMatchObject({ youOnline: true, opponentOnline: false });
    expect(waiting?.connection?.disconnectBudgetMs).toBe(180_000);

    // 100 秒后重连：同一会话、同一版本、同一待决选择，断线时长如实累计。
    clock.advance(100_000);
    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    const resumed = latestMatch(records, 'conn-a2');
    expect(resumed?.sessionId).toBe(harness.match.sessionId);
    expect(resumed?.version).toBe(harness.match.version);
    expect(resumed?.pendingChoice).toEqual(harness.match.pendingChoice);
    expect(resumed?.connection).toMatchObject({
      youOnline: true,
      opponentOnline: true,
      yourDisconnectMs: 100_000,
      disconnectBudgetMs: 180_000,
    });
    expect(latestMatch(records, 'conn-b1')?.connection).toMatchObject({ opponentOnline: true });

    // 再次断线 70 秒后重连：累计 170 秒，仍可继续，预算没有重置。
    registry.detachConnection(a2.connectionId);
    clock.advance(70_000);
    const a3 = rejoin(harness, 'conn-a3', 'dev-a', '小智');
    expect(latestMatch(records, 'conn-a3')?.connection?.yourDisconnectMs).toBe(170_000);

    // 第三次断线只剩余 10 秒：到期后对手在线 → A 判负，结果只产生一次。
    registry.detachConnection(a3.connectionId);
    clock.advance(10_001);
    const finishedB = latestMatch(records, 'conn-b1');
    expect(finishedB?.result).toEqual({ winner: 1, reason: 'disconnect-timeout', conditions: [] });
    expect(latestRoom(records, 'conn-b1')?.status).toBe('finished');
    expect(finishedB?.events.filter((event) => event.type === 'match-finished')).toHaveLength(1);
    expect(finishedB?.events.filter((event) => event.type === 'turn-order-chosen')).toHaveLength(0);

    // 超限后重连：拿到同一终态，不能继续操作，也不是“假恢复”。
    const a4 = rejoin(harness, 'conn-a4', 'dev-a', '小智');
    const resumedTerminal = latestMatch(records, 'conn-a4');
    expect(resumedTerminal?.result).toEqual(finishedB?.result);
    registry.handleCommand(a4, {
      type: 'end-turn',
      commandId: nextCommandId(),
      sessionId: harness.match.sessionId,
      expectedVersion: resumedTerminal?.version ?? 1,
    });
    expect(lastError(records, 'conn-a4')).toMatchObject({ type: 'match-error', code: 'match-finished' });
    expect(latestMatch(records, 'conn-a4')?.events.filter((event) => event.type === 'match-finished')).toHaveLength(1);

    // 同一房间重新准备：创建新会话，允许继续打牌。
    const beforeRematch = latestRoom(records, 'conn-a4');
    if (beforeRematch === undefined) {
      throw new Error('缺少房间快照');
    }
    registry.handleCommand(a4, {
      type: 'select-deck',
      commandId: nextCommandId(),
      roomId: beforeRematch.roomId,
      expectedVersion: beforeRematch.version,
      deck: releasePreset('A'),
    });
    for (const connection of [a4, harness.b]) {
      const room = latestRoom(records, connection.connectionId);
      if (room === undefined) {
        throw new Error('缺少房间快照');
      }
      registry.handleCommand(connection, {
        type: 'set-ready',
        commandId: nextCommandId(),
        roomId: room.roomId,
        expectedVersion: room.version,
        ready: true,
      });
    }
    const rematch = latestMatch(records, 'conn-a4');
    expect(rematch?.sessionId).not.toBe(harness.match.sessionId);
    expect(rematch?.result).toBeNull();
  });

  it('预算边界：179999ms 内可恢复，达到 180000ms 即超限判负', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, clock, records } = harness;

    registry.detachConnection('conn-a1');
    clock.advance(179_999);
    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    expect(latestMatch(records, 'conn-a2')?.connection?.yourDisconnectMs).toBe(179_999);
    expect(latestMatch(records, 'conn-a2')?.result).toBeNull();

    // 只剩 1ms：恰好到达 180000ms 时到期判负。
    registry.detachConnection(a2.connectionId);
    clock.advance(1);
    expect(latestMatch(records, 'conn-b1')?.result).toEqual({ winner: 1, reason: 'disconnect-timeout', conditions: [] });
    const a3 = rejoin(harness, 'conn-a3', 'dev-a', '小智');
    expect(latestMatch(records, 'conn-a3')?.result).toEqual({ winner: 1, reason: 'disconnect-timeout', conditions: [] });
  });

  it('双方离线且任一超限：无胜负中止，双方重连看到同一无胜者结果', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, clock, records } = harness;

    registry.detachConnection('conn-a1');
    registry.detachConnection('conn-b1');
    clock.advance(180_000);

    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    const terminalA = latestMatch(records, 'conn-a2');
    expect(terminalA?.result).toEqual({ winner: null, reason: 'disconnect-timeout', conditions: [] });
    expect(terminalA?.events.filter((event) => event.type === 'match-finished')).toHaveLength(1);

    const b2 = rejoin(harness, 'conn-b2', 'dev-b', '小茂');
    const terminalB = latestMatch(records, 'conn-b2');
    expect(terminalB?.result).toEqual(terminalA?.result);
    expect(latestRoom(records, 'conn-b2')?.status).toBe('finished');
  });

  it('旧连接被新连接取代：撤销旧连接，旧连接命令不能改变任何状态', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, records, revoked } = harness;

    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ connectionId: 'conn-a1' });
    expect(lastError(records, 'conn-a1')).toMatchObject({ type: 'room-error', code: 'seat-taken-over' });
    expect(latestMatch(records, 'conn-a2')?.version).toBe(harness.match.version);

    // 旧连接用对局命令与房间命令同时攻击：都得到 seat-taken-over，状态不变。
    registry.handleCommand(harness.a, {
      type: 'choose-turn-order',
      commandId: nextCommandId(),
      sessionId: harness.match.sessionId,
      expectedVersion: harness.match.version,
      choiceId: harness.match.pendingChoice?.choiceId ?? '',
      goFirst: true,
    });
    expect(lastError(records, 'conn-a1')).toMatchObject({ type: 'match-error', code: 'seat-taken-over' });
    const roomNow = latestRoom(records, 'conn-a1');
    if (roomNow === undefined) {
      throw new Error('缺少房间快照');
    }
    registry.handleCommand(harness.a, {
      type: 'set-ready',
      commandId: nextCommandId(),
      roomId: roomNow.roomId,
      expectedVersion: roomNow.version,
      ready: false,
    });
    expect(lastError(records, 'conn-a1')).toMatchObject({ type: 'room-error', code: 'seat-taken-over' });
    expect(latestMatch(records, 'conn-b1')?.version).toBe(harness.match.version);
    expect(latestMatch(records, 'conn-b1')?.events.filter((event) => event.type === 'turn-order-chosen')).toHaveLength(0);

    // 新连接仍持有操作权：可以完成先后攻选择。
    registry.handleCommand(a2, {
      type: 'choose-turn-order',
      commandId: nextCommandId(),
      sessionId: harness.match.sessionId,
      expectedVersion: harness.match.version,
      choiceId: harness.match.pendingChoice?.choiceId ?? '',
      goFirst: true,
    });
    const afterChoice = latestMatch(records, 'conn-a2');
    expect(afterChoice?.events.some((event) => event.type === 'turn-order-chosen')).toBe(true);
    expect(afterChoice?.version).toBe(harness.match.version + 1);
  });

  it('提交已生效但确认丢失：同 commandId 重试得到同一结果，不重复生效', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, records } = harness;

    const choiceId = harness.match.pendingChoice?.choiceId ?? '';
    const first: MatchClientMessage = {
      type: 'choose-turn-order',
      commandId: 'lost-ack-1',
      sessionId: harness.match.sessionId,
      expectedVersion: harness.match.version,
      choiceId,
      goFirst: true,
    };
    registry.handleCommand(harness.a, first);
    const appliedView = latestMatch(records, 'conn-a1');
    expect(appliedView?.version).toBe(harness.match.version + 1);
    const appliedVersion = appliedView?.version ?? 0;

    // 模拟确认丢失并断线，再以同一 commandId 原样重试（expectedVersion 保持原值）。
    registry.detachConnection('conn-a1');
    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    registry.handleCommand(a2, first);
    const replayed = [...records]
      .reverse()
      .find((entry) => entry.connectionId === 'conn-a2' && entry.message.type === 'match' && entry.message.commandId === 'lost-ack-1');
    expect(replayed?.message.type).toBe('match');
    if (replayed?.message.type === 'match') {
      expect(replayed.message.view.sessionId).toBe(harness.match.sessionId);
      expect(replayed.message.view.version).toBe(appliedVersion);
      expect(replayed.message.view.events.filter((event) => event.type === 'turn-order-chosen')).toHaveLength(1);
      expect(replayed.message.view.you.handCount).toBe(7);
    }
    // 状态没有第二次推进：对手看到的最新版本仍是首次应用后的版本。
    expect(latestMatch(records, 'conn-b1')?.version).toBe(appliedVersion);

    // 同一 commandId 改内容会被识别为 ID 复用，而不是再次生效。
    registry.handleCommand(a2, { ...first, goFirst: false });
    expect(lastError(records, 'conn-a2')).toMatchObject({ type: 'match-error', code: 'command-id-reused' });
    expect(latestMatch(records, 'conn-b1')?.version).toBe(appliedVersion);
  });

  it('不同设备不能凭昵称或房间码接管对局座位', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, records } = harness;

    // 攻击者使用同一昵称、同一房间码，但不同设备身份。
    const attacker: RoomConnection = { connectionId: 'conn-attacker', deviceId: 'dev-attacker', nickname: '小智' };
    registry.handleCommand(attacker, { type: 'join-room', commandId: nextCommandId(), code: harness.code, roomId: harness.roomId });
    expect(lastError(records, 'conn-attacker')).toMatchObject({ type: 'room-error', code: 'room-full' });
    expect(latestMatch(records, 'conn-attacker')).toBeUndefined();
    expect(records.filter((entry) => entry.connectionId === 'conn-attacker' && entry.message.type === 'match')).toHaveLength(0);

    // 开局后即使原座位离线，也不因“座位空着”被接管。
    registry.detachConnection('conn-a1');
    registry.handleCommand(attacker, { type: 'join-room', commandId: nextCommandId(), code: harness.code, roomId: harness.roomId });
    expect(lastError(records, 'conn-attacker')).toMatchObject({ type: 'room-error', code: 'room-full' });
    expect(records.filter((entry) => entry.connectionId === 'conn-attacker' && entry.message.type === 'match')).toHaveLength(0);
    // 原设备仍能恢复同一座位与待决选择。
    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    expect(latestMatch(records, 'conn-a2')?.pendingChoice).toEqual(harness.match.pendingChoice);
    expect(a2.connectionId).toBe('conn-a2');
  });

  it('对手离线时服务端权威暂停：新操作被拒且不改状态，确认丢失的重传仍返回第一次结果', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, records } = harness;
    completeOpening(harness, [harness.a, harness.b]);
    const playing = latestMatch(records, 'conn-a1') as MatchView;
    expect(playing.phase).toBe('playing');
    expect(playing.activeSeat).toBe(0);
    const versionBefore = playing.version;
    const endTurn = (commandId: string, expectedVersion: number): MatchClientMessage => ({
      type: 'end-turn',
      commandId,
      sessionId: playing.sessionId,
      expectedVersion,
    });

    // B 断线：A 的新操作被服务端拒绝，版本与公开事件都不变。
    registry.detachConnection('conn-b1');
    registry.handleCommand(harness.a, endTurn('pause-1', versionBefore));
    expect(lastError(records, 'conn-a1')).toMatchObject({ type: 'match-error', code: 'opponent-offline' });
    expect(latestMatch(records, 'conn-a1')?.version).toBe(versionBefore);
    expect(latestMatch(records, 'conn-a1')?.events.filter((event) => event.type === 'turn-ended')).toHaveLength(0);

    // B 重连后同一命令生效；B 再断线时精确重传仍拿到第一次结果，不重复执行。
    const b2 = rejoin(harness, 'conn-b2', 'dev-b', '小茂');
    registry.handleCommand(harness.a, endTurn('pause-1', versionBefore));
    const applied = latestMatch(records, 'conn-a1') as MatchView;
    expect(applied.version).toBe(versionBefore + 1);
    expect(applied.events.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
    registry.detachConnection(b2.connectionId);
    registry.handleCommand(harness.a, endTurn('pause-1', versionBefore));
    const replayed = [...records]
      .reverse()
      .find((entry) => entry.connectionId === 'conn-a1' && entry.message.type === 'match' && entry.message.commandId === 'pause-1');
    expect(replayed?.message.type).toBe('match');
    if (replayed?.message.type === 'match') {
      expect(replayed.message.view.version).toBe(versionBefore + 1);
      expect(replayed.message.view.events.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
    }
    // 新的对局命令仍被暂停拒绝，版本不变。
    registry.handleCommand(harness.a, endTurn('pause-2', versionBefore + 1));
    expect(lastError(records, 'conn-a1')).toMatchObject({ type: 'match-error', code: 'opponent-offline' });
    expect(latestMatch(records, 'conn-a1')?.version).toBe(versionBefore + 1);
    expect(latestMatch(records, 'conn-a1')?.events.filter((event) => event.type === 'turn-ended')).toHaveLength(1);

    // 对手重连后轮到 B 的回合可正常继续，待人重连的等待没有损坏对局状态。
    const b3 = rejoin(harness, 'conn-b3', 'dev-b', '小茂');
    const forB = latestMatch(records, b3.connectionId) as MatchView;
    expect(forB.activeSeat).toBe(1);
    registry.handleCommand(b3, { type: 'end-turn', commandId: nextCommandId(), sessionId: forB.sessionId, expectedVersion: forB.version });
    expect(latestMatch(records, 'conn-a1')?.version).toBe(forB.version + 1);
    expect(latestMatch(records, 'conn-a1')?.activeSeat).toBe(0);
  });

  it('重赛创建新局才重置断线预算：旧局已用 100 秒不带入新局，新局从完整 180 秒开始', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, clock, records } = harness;

    // 第一局 A 离线 100 秒后恢复：预算已用 100 秒，重连（以及终局）不重置。
    registry.detachConnection('conn-a1');
    clock.advance(100_000);
    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    expect(latestMatch(records, a2.connectionId)?.connection?.yourDisconnectMs).toBe(100_000);
    const bView = latestMatch(records, 'conn-b1') as MatchView;
    registry.handleCommand(harness.b, {
      type: 'concede',
      commandId: nextCommandId(),
      sessionId: bView.sessionId,
      expectedVersion: bView.version,
    });
    expect(latestMatch(records, 'conn-b1')?.result).toMatchObject({ winner: 0, reason: 'concede' });
    expect(latestMatch(records, a2.connectionId)?.connection?.yourDisconnectMs).toBe(100_000);

    // 双方重新准备建立新会话：预算从零开始。
    startRematch(harness, [a2, harness.b]);
    const rematch = latestMatch(records, a2.connectionId) as MatchView;
    expect(rematch.sessionId).not.toBe(harness.match.sessionId);
    expect(rematch.connection?.yourDisconnectMs).toBe(0);

    // 新局中 A 离线 179999ms 仍在完整预算内（旧局 100 秒不叠加、也不被重置）。
    registry.detachConnection(a2.connectionId);
    clock.advance(179_999);
    const a3 = rejoin(harness, 'conn-a3', 'dev-a', '小智');
    expect(latestMatch(records, a3.connectionId)?.connection?.yourDisconnectMs).toBe(179_999);
    expect(latestMatch(records, a3.connectionId)?.result).toBeNull();
  });

  it('显式离开与传输层断开共用 180 秒记账：不重复计时，超限按同一截止结算', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, clock, records } = harness;

    const roomBefore = latestRoom(records, 'conn-a1') as RoomView;
    registry.handleCommand(harness.a, {
      type: 'leave-room',
      commandId: nextCommandId(),
      roomId: roomBefore.roomId,
      expectedVersion: roomBefore.version,
    });
    const left = [...records].reverse().find((entry) => entry.connectionId === 'conn-a1' && entry.message.type === 'room-left');
    expect(left?.message).toMatchObject({ type: 'room-left', reason: 'left' });
    // 对手的对局视图立即反映离线等待，而不是等下一次操作。
    expect(latestMatch(records, 'conn-b1')?.connection).toMatchObject({ opponentOnline: false });

    // 离开后套接字关闭：同一段离线不能重复计价。
    registry.detachConnection('conn-a1');
    clock.advance(60_000);
    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    expect(latestMatch(records, a2.connectionId)?.connection?.yourDisconnectMs).toBe(60_000);
    expect(latestMatch(records, a2.connectionId)?.result).toBeNull();

    // 再次断线：累计 179999ms 仍可继续，达到 180000ms 且对手在线则判负。
    registry.detachConnection(a2.connectionId);
    clock.advance(119_999);
    expect(latestMatch(records, 'conn-b1')?.result).toBeNull();
    clock.advance(1);
    expect(latestMatch(records, 'conn-b1')?.result).toMatchObject({ winner: 1, reason: 'disconnect-timeout' });
    expect(latestRoom(records, 'conn-b1')?.status).toBe('finished');
  });

  it('新局建立时仍离线的一方从新局起点开始计时，不能白蹭跨局等待', async () => {
    const harness = await startStartedMatch();
    cleanups.push(harness.close);
    const { registry, clock, records } = harness;

    // 第一局结束：B 认输。
    const bView = latestMatch(records, 'conn-b1') as MatchView;
    registry.handleCommand(harness.b, {
      type: 'concede',
      commandId: nextCommandId(),
      sessionId: bView.sessionId,
      expectedVersion: bView.version,
    });

    // A 选卡组并准备；B 选卡组；随后 A 的套接字非预期断开（房间已结束，不消耗预算）。
    const roomA = latestRoom(records, 'conn-a1') as RoomView;
    registry.handleCommand(harness.a, {
      type: 'select-deck',
      commandId: nextCommandId(),
      roomId: roomA.roomId,
      expectedVersion: roomA.version,
      deck: releasePreset('A'),
    });
    const roomAReady = latestRoom(records, 'conn-a1') as RoomView;
    registry.handleCommand(harness.a, {
      type: 'set-ready',
      commandId: nextCommandId(),
      roomId: roomAReady.roomId,
      expectedVersion: roomAReady.version,
      ready: true,
    });
    const roomB = latestRoom(records, 'conn-b1') as RoomView;
    registry.handleCommand(harness.b, {
      type: 'select-deck',
      commandId: nextCommandId(),
      roomId: roomB.roomId,
      expectedVersion: roomB.version,
      deck: releasePreset('A'),
    });
    registry.detachConnection('conn-a1');

    // B 单独准备：新局在 A 离线时建立，A 的预算从建立时刻起算。
    const roomBReady = latestRoom(records, 'conn-b1') as RoomView;
    registry.handleCommand(harness.b, {
      type: 'set-ready',
      commandId: nextCommandId(),
      roomId: roomBReady.roomId,
      expectedVersion: roomBReady.version,
      ready: true,
    });
    const created = latestMatch(records, 'conn-b1') as MatchView;
    expect(created.sessionId).not.toBe(harness.match.sessionId);
    expect(created.connection).toMatchObject({ opponentOnline: false });

    // 离线 100 秒后重入按 100 秒计入；再离线 80001ms 即超限判负。
    clock.advance(100_000);
    const a2 = rejoin(harness, 'conn-a2', 'dev-a', '小智');
    expect(latestMatch(records, a2.connectionId)?.connection?.yourDisconnectMs).toBe(100_000);
    registry.detachConnection(a2.connectionId);
    clock.advance(80_001);
    expect(latestMatch(records, 'conn-b1')?.result).toMatchObject({ winner: 1, reason: 'disconnect-timeout' });
  });
});
