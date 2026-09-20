import { afterEach, describe, expect, it } from 'vitest';
import type { MatchView, RoomView, SelectDeckCommand, ServerMessage, SetReadyCommand } from '@ptcg/protocol';
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

async function startHarness(serviceInstanceId: string): Promise<Harness> {
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
});
