import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';
import type { MatchView, RoomView, SelectDeckCommand, ServerMessage, SetReadyCommand, WebSocketLike } from '@ptcg/protocol';
import {
  connectTestClient,
  createTempDirectory,
  nextCommandId,
  releasePreset,
  routed,
  startTestService,
  writePlayableFixture,
  type TempDirectory,
  type TestClient,
  type TestService,
} from './support/roomTestKit.ts';
import type { RandomSource } from '../src/match.ts';

/**
 * 真实服务端到端（同进程）：断线进入等待、预算内重连恢复、超限判负/无胜负中止、
 * 以及服务重启后的实例身份变化与不可假恢复。时钟与定时器全部受控，边界判定
 * 不依赖真实等待。
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

class ZeroRandomSource implements RandomSource {
  public nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt 需要正整数，收到 ${maxExclusive}`);
    }
    return 0;
  }
}

interface Harness {
  readonly temp: TempDirectory;
  readonly service: TestService;
  readonly clock: ManualClock;
  readonly clients: TestClient[];
  close(): Promise<void>;
}

async function startHarness(
  serviceInstanceId: string,
  heartbeat?: { readonly intervalMs: number; readonly pongTimeoutMs: number },
): Promise<Harness> {
  const temp = createTempDirectory('ptcg-recovery-int-');
  const fixture = await writePlayableFixture(temp.path);
  const clock = new ManualClock();
  let sessionSeq = 0;
  const service = await startTestService({
    serviceInstanceId,
    now: clock.now,
    catalog: { catalogPath: fixture.path },
    rooms: {
      matchRandom: new ZeroRandomSource(),
      generateCode: () => '515151',
      newRoomId: () => 'room-recovery-int',
      newSessionId: () => `session-recovery-int-${(sessionSeq += 1)}`,
      timers: clock,
    },
    ...(heartbeat === undefined
      ? {}
      : { heartbeat: { intervalMs: heartbeat.intervalMs, pongTimeoutMs: heartbeat.pongTimeoutMs, timers: clock } }),
  });
  const clients: TestClient[] = [];
  return {
    temp,
    service,
    clock,
    clients,
    async close() {
      for (const client of clients.splice(0)) {
        client.close();
      }
      await service.close();
      temp.cleanup();
    },
  };
}

function currentRoom(client: TestClient): RoomView {
  const room = client.latestRoom();
  if (room === undefined) {
    throw new Error('客户端还没有收到房间快照');
  }
  return room;
}

async function waitForMatchView(client: TestClient, predicate: (view: MatchView) => boolean, label = '对局视图'): Promise<MatchView> {
  const message = await client.waitFor((entry) => entry.type === 'match' && predicate(entry.view), label);
  return (message as Extract<ServerMessage, { type: 'match' }>).view;
}

/** 等待服务端登记指定次数的断线（关闭事件是异步的，时钟推进前必须同步）。 */
async function waitForDisconnects(harness: Harness, count: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (harness.service.logText().split('room.disconnected').length - 1 >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待 ${count} 次断线登记超时`);
}

/** 最近一条对局视图（不等新消息），用于断言“没有新的离线事件”。 */
function latestMatchView(client: TestClient): MatchView | undefined {
  const message = [...client.messages].reverse().find((entry) => entry.type === 'match');
  return message?.type === 'match' ? message.view : undefined;
}

/** 只完成升级与协议握手、从不回 pong 的半开连接；ws 默认自动回 pong，这里显式关闭。 */
function silentSocket(url: string): WebSocketLike {
  return new WsWebSocket(url, { autoPong: false }) as unknown as WebSocketLike;
}

/** 让真实 I/O（pong/关闭事件）有机会在受控时钟推进之间结算。 */
function settleIsoEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * 按小块推进受控时钟并让健康连接的 pong 落地；直接一次跳过多个心跳周期会把
 * 正常连接误判为超时（pong 尚未被事件循环处理）。总量保持精确。
 */
async function advanceWithSettles(harness: Harness, totalMs: number, stepMs = 1_000): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining);
    harness.clock.advance(step);
    remaining -= step;
    await settleIsoEvents();
  }
}

async function pairedRoom(harness: Harness): Promise<{ a: TestClient; b: TestClient }> {
  const deck = releasePreset('A');
  const a = await connectTestClient(harness.service.service, '小智');
  const b = await connectTestClient(harness.service.service, '小茂');
  harness.clients.push(a, b);
  a.send({ type: 'create-room', commandId: nextCommandId() });
  const created = await a.waitForRoom((room) => room.you.host, '建房');
  b.send({ type: 'join-room', commandId: nextCommandId(), code: created.code });
  await b.waitForRoom((room) => room.you.seat === 1, '加入');
  await a.waitForRoom((room) => room.opponent.occupied, '房主看到来宾');
  for (const [client, peer] of [
    [a, b],
    [b, a],
  ] as const) {
    const select: SelectDeckCommand = { type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(client)), deck };
    client.send(select);
    await client.waitForRoom((room) => room.you.deckSelected, '选卡组');
    await peer.waitForRoom((room) => room.opponent.deckSelected, '看到对手选卡组');
  }
  const aReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true };
  a.send(aReady);
  await a.waitForRoom((room) => room.you.ready, 'A 准备');
  await b.waitForRoom((room) => room.opponent.ready, 'B 看到 A 准备');
  const bReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(b)), ready: true };
  b.send(bReady);
  await a.waitForRoom((room) => room.status === 'started', 'A 看到开局');
  await b.waitForRoom((room) => room.status === 'started', 'B 看到开局');
  return { a, b };
}

async function reconnect(harness: Harness, original: TestClient, nickname: string): Promise<TestClient> {
  const connection = await connectTestClient(harness.service.service, nickname, original.identity);
  harness.clients.push(connection);
  const room = currentRoom(original);
  connection.send({ type: 'join-room', commandId: nextCommandId(), code: room.code, roomId: room.roomId });
  await connection.waitForRoom((entry) => entry.you.occupied && entry.roomId === room.roomId, '重连回到原房间');
  return connection;
}

describe('真实服务：断线与进程内恢复（#15）', () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.close();
    }
  });

  it('断线后对手进入等待；预算内重连恢复同一会话、版本与待决选择', async () => {
    const harness = await startHarness('instance-recovery-1');
    harnesses.push(harness);
    const { a, b } = await pairedRoom(harness);
    const initialA = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'turn-order');
    expect(initialA.connection).toMatchObject({ youOnline: true, opponentOnline: true });
    const initialB = await waitForMatchView(b, (view) => view.sessionId === initialA.sessionId);

    // A 断线：B 立刻看到对手离线等待。
    a.close();
    const waiting = await waitForMatchView(b, (view) => view.connection?.opponentOnline === false, 'B 看到等待重连');
    expect(waiting.sessionId).toBe(initialA.sessionId);
    expect(waiting.connection?.disconnectBudgetMs).toBe(180_000);

    // 60 秒后重连：同一座位、同一版本、同一待决选择，累计断线如实呈现。
    harness.clock.advance(60_000);
    const a2 = await reconnect(harness, a, '小智');
    const resumed = await waitForMatchView(a2, (view) => view.connection?.youOnline === true, 'A 重连恢复');
    expect(resumed.sessionId).toBe(initialA.sessionId);
    expect(resumed.version).toBe(initialA.version);
    expect(resumed.pendingChoice).toEqual(initialA.pendingChoice);
    expect(resumed.you.hand).toEqual(initialA.you.hand);
    expect(resumed.connection).toMatchObject({ youOnline: true, opponentOnline: true, yourDisconnectMs: 60_000 });
    await waitForMatchView(b, (view) => view.connection?.opponentOnline === true, 'B 看到对手已重连');

    // 同一命令 ID 重发（例如确认丢失）不产生第二个动作：直接结果与服务端版本一致。
    const command = {
      type: 'choose-turn-order' as const,
      commandId: 'recovery-int-cmd-1',
      sessionId: initialA.sessionId,
      expectedVersion: initialA.version,
      choiceId: initialA.pendingChoice?.choiceId ?? '',
      goFirst: true,
    };
    a2.send(command);
    const applied = await waitForMatchView(a2, (view) => view.events.some((event) => event.type === 'turn-order-chosen'), '先后攻生效');
    a2.send(command);
    const duplicate = await waitForMatchView(a2, (view) => view.version === applied.version && view.events.filter((event) => event.type === 'turn-order-chosen').length === 1);
    expect(duplicate.version).toBe(applied.version);
  });

  it('超限后对手在线判负；双方离线则无胜负中止，结果只产生一次', async () => {
    const harness = await startHarness('instance-recovery-2');
    harnesses.push(harness);
    const { a, b } = await pairedRoom(harness);

    // A 单独断线并耗尽预算：B 在线 → A 判负。
    a.close();
    await waitForDisconnects(harness, 1);
    harness.clock.advance(180_000);
    const lossForA = await waitForMatchView(b, (view) => view.result !== null, 'B 收到断线判负');
    expect(lossForA.result).toEqual({ winner: 1, reason: 'disconnect-timeout', conditions: [] });
    expect(lossForA.events.filter((event) => event.type === 'match-finished')).toHaveLength(1);
    await b.waitForRoom((room) => room.status === 'finished', '房间进入 finished');
    expect(harness.service.logText().split('room.match_finished').length - 1).toBe(1);

    // 双方离线且任一超限：无胜负中止。
    const harness2 = await startHarness('instance-recovery-3');
    harnesses.push(harness2);
    const pair2 = await pairedRoom(harness2);
    pair2.a.close();
    pair2.b.close();
    await waitForDisconnects(harness2, 2);
    harness2.clock.advance(180_000);
    const a2 = await reconnect(harness2, pair2.a, '小智');
    const abortView = await waitForMatchView(a2, (view) => view.result !== null, 'A 收到无胜负中止');
    expect(abortView.result).toEqual({ winner: null, reason: 'disconnect-timeout', conditions: [] });
    const b2 = await reconnect(harness2, pair2.b, '小茂');
    const abortViewB = await waitForMatchView(b2, (view) => view.result !== null, 'B 收到同一中止结果');
    expect(abortViewB.result).toEqual(abortView.result);
    expect(harness2.service.logText().split('room.match_finished').length - 1).toBe(1);
  });

  it('服务重启：实例身份变化，旧房间/旧会话无法被静默恢复', async () => {
    const first = await startHarness('instance-restart-one');
    harnesses.push(first);
    const { a, b } = await pairedRoom(first);
    expect(a.connection.session.serviceInstanceId).toBe('instance-restart-one');
    expect(b.connection.session.serviceInstanceId).toBe('instance-restart-one');
    const room = currentRoom(a);

    await first.close();
    const second = await startHarness('instance-restart-two');
    harnesses.push(second);
    const a2 = await connectTestClient(second.service.service, '小智', a.identity);
    second.clients.push(a2);
    expect(a2.connection.session.serviceInstanceId).toBe('instance-restart-two');

    // 旧房间不存在，不按旧会话伪造视图；也不会因为“同一设备/昵称”而重建对局。
    a2.send({ type: 'join-room', commandId: nextCommandId(), code: room.code, roomId: room.roomId });
    const failure = await a2.waitFor((entry) => entry.type === 'room-error', '旧房间被拒');
    expect(failure).toMatchObject({ type: 'room-error', code: 'room-not-found' });
    expect(a2.messages.some((entry) => entry.type === 'match')).toBe(false);
  });

  describe('半开连接心跳看门狗（#15）', () => {
    it('无 close、无 pong 的半开连接在检测上界内被判离线，预算从判定时刻开始', async () => {
      const harness = await startHarness('instance-heartbeat-1', { intervalMs: 1_000, pongTimeoutMs: 2_000 });
      harnesses.push(harness);
      const { a, b } = await pairedRoom(harness);
      const initial = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'turn-order');

      // 先用正常连接建立对局，再换上一只从不回 pong 的静默连接占用 A 座位。
      a.close();
      await waitForDisconnects(harness, 1);
      const silent = await connectTestClient(harness.service.service, '小智', a.identity, silentSocket);
      harness.clients.push(silent);
      const room = currentRoom(a);
      silent.send({ type: 'join-room', commandId: nextCommandId(), code: room.code, roomId: room.roomId });
      await silent.waitForRoom((entry) => entry.you.occupied && entry.roomId === room.roomId, '静默连接重入');
      const online = await waitForMatchView(silent, (view) => view.connection?.youOnline === true, '静默连接在线');
      expect(online.connection).toMatchObject({ opponentOnline: true, yourDisconnectMs: 0 });

      // 上界前不误判：ping 发出但没有 pong，对手视图仍是在线。
      harness.clock.advance(1_000);
      await settleIsoEvents();
      expect(latestMatchView(b)?.connection?.opponentOnline).toBe(true);
      harness.clock.advance(1_999);
      await settleIsoEvents();
      expect(latestMatchView(b)?.connection?.opponentOnline).toBe(true);
      expect(harness.service.logText()).not.toContain('connection.liveness_timeout');

      // 到达 interval + pongTimeout：服务端在没有 close、没有业务消息的情况下登记离线。
      harness.clock.advance(1);
      const waiting = await waitForMatchView(b, (view) => view.connection?.opponentOnline === false, 'B 看到半开连接被判离线');
      expect(waiting.sessionId).toBe(initial.sessionId);
      await waitForDisconnects(harness, 2);
      expect(harness.service.logText()).toContain('connection.liveness_timeout');

      // 预算从判定时刻开始：再经过 45 秒重连，累计正好 45 秒；检测延迟不计入。
      await advanceWithSettles(harness, 45_000);
      const reconnected = await connectTestClient(harness.service.service, '小智', a.identity);
      harness.clients.push(reconnected);
      reconnected.send({ type: 'join-room', commandId: nextCommandId(), code: room.code, roomId: room.roomId });
      await reconnected.waitForRoom((entry) => entry.you.occupied && entry.roomId === room.roomId, '重连');
      const resumed = await waitForMatchView(reconnected, (view) => view.connection?.youOnline === true, '重连恢复');
      expect(resumed.sessionId).toBe(initial.sessionId);
      expect(resumed.connection).toMatchObject({
        youOnline: true,
        opponentOnline: true,
        yourDisconnectMs: 45_000,
        disconnectBudgetMs: 180_000,
      });
    });

    it('健康空闲连接跨多个心跳周期保持在线，正常关闭后看门狗不再触发', async () => {
      const harness = await startHarness('instance-heartbeat-2', { intervalMs: 1_000, pongTimeoutMs: 2_000 });
      harnesses.push(harness);
      const { a, b } = await pairedRoom(harness);
      await waitForMatchView(a, (view) => view.connection?.youOnline === true, '对局视图');

      for (let cycle = 0; cycle < 4; cycle += 1) {
        harness.clock.advance(1_000);
        await settleIsoEvents();
      }
      expect(harness.service.logText()).not.toContain('connection.liveness_timeout');
      expect(harness.service.logText()).not.toContain('room.disconnected');
      expect(latestMatchView(b)?.connection).toMatchObject({ opponentOnline: true });

      // 正常关闭后定时器必须清理：越过上界也不再产生迟到事件。
      a.close();
      await waitForDisconnects(harness, 1);
      await advanceWithSettles(harness, 10_000);
      expect(harness.service.logText().split('room.disconnected').length - 1).toBe(1);
      expect(harness.service.logText()).not.toContain('connection.liveness_timeout');
    });

    it('连接替换竞态：旧半开套接字超时不得把新连接判为离线', async () => {
      const harness = await startHarness('instance-heartbeat-race', { intervalMs: 1_000, pongTimeoutMs: 2_000 });
      harnesses.push(harness);
      const { a, b } = await pairedRoom(harness);
      a.close();
      await waitForDisconnects(harness, 1);

      let silentRaw: WsWebSocket | undefined;
      const silent = await connectTestClient(harness.service.service, '小智', a.identity, (url) => {
        silentRaw = new WsWebSocket(url, { autoPong: false });
        return silentRaw as unknown as WebSocketLike;
      });
      harness.clients.push(silent);
      const room = currentRoom(a);
      silent.send({ type: 'join-room', commandId: nextCommandId(), code: room.code, roomId: room.roomId });
      await silent.waitForRoom((entry) => entry.you.occupied && entry.roomId === room.roomId, '静默连接重入');

      // 先让 ping 发出、pong 超时定时器挂起；随后冻结旧套接字的读取，
      // 使它既看不到服务端的关闭帧也不会回 pong（真实半开态）。
      harness.clock.advance(1_000);
      await settleIsoEvents();
      const rawSocket = silentRaw as unknown as { _socket?: { pause(): void; resume(): void } } | undefined;
      rawSocket?._socket?.pause();

      // 同身份新连接接管座位；服务端已撤销旧连接。
      const replacement = await connectTestClient(harness.service.service, '小智', a.identity);
      harness.clients.push(replacement);
      replacement.send({ type: 'join-room', commandId: nextCommandId(), code: room.code, roomId: room.roomId });
      await replacement.waitForRoom((entry) => entry.you.occupied && entry.roomId === room.roomId, '新连接接管');
      const replaced = await waitForMatchView(replacement, (view) => view.connection?.youOnline === true, '新连接视图');
      expect(replaced.connection).toMatchObject({ youOnline: true, opponentOnline: true, yourDisconnectMs: 0 });

      // 旧连接的看门狗到点：只能走幂等 detach，不能把座位上的新连接判离线。
      harness.clock.advance(2_000);
      await settleIsoEvents();
      expect(harness.service.logText()).toContain('connection.liveness_timeout');
      expect(latestMatchView(b)?.connection).toMatchObject({ opponentOnline: true });
      expect(latestMatchView(replacement)?.connection).toMatchObject({ youOnline: true, yourDisconnectMs: 0 });
      expect(harness.service.logText().split('room.disconnected').length - 1).toBe(1);

      // 解除冻结并让迟到事件结算，避免测试进程被半开套接字拖住。
      rawSocket?._socket?.resume();
    });
  });
});
