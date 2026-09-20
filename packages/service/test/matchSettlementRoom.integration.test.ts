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

/** 固定返回 0 的测试随机源：洗牌确定、先后攻选择权固定座位 0。 */
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
  readonly clients: TestClient[];
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const temp = createTempDirectory('ptcg-settle-room-');
  const fixture = await writePlayableFixture(temp.path);
  let sessionSeq = 0;
  const service = await startTestService({
    catalog: { catalogPath: fixture.path },
    rooms: {
      matchRandom: new ZeroRandomSource(),
      generateCode: () => '737373',
      newRoomId: () => 'room-settlement',
      newSessionId: () => `session-settlement-${(sessionSeq += 1)}`,
    },
  });
  const clients: TestClient[] = [];
  return {
    temp,
    service,
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

async function waitMatchView(client: TestClient): Promise<MatchView> {
  const message = await client.waitFor((entry) => entry.type === 'match', '对局视图');
  return (message as Extract<ServerMessage, { type: 'match' }>).view;
}

/** 建房、加入、双方选同一预设卡组并准备，返回进入对局的双方。 */
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

describe('真实服务：终局后返回原房间并重新开局（#10）', () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.close();
    }
  });

  it('确认认输后双方看到同一结果与 finished 房间，重新准备创建新会话', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const { a, b } = await pairedRoom(harness);
    const viewA = await waitMatchView(a);
    const viewB = await waitMatchView(b);
    const oldSession = viewA.sessionId;
    expect(viewB.sessionId).toBe(oldSession);
    expect(currentRoom(a).roomId).toBe(currentRoom(b).roomId);

    // 座位 1 确认认输（开局阶段即可）。
    b.send({ type: 'concede', commandId: nextCommandId(), sessionId: viewB.sessionId, expectedVersion: viewB.version });
    const finishedA = await a.waitForRoom((room) => room.status === 'finished', 'A 看到对局结束');
    const finishedB = await b.waitForRoom((room) => room.status === 'finished', 'B 看到对局结束');
    expect(finishedA.roomId).toBe(currentRoom(a).roomId);
    expect(finishedA.match?.sessionId).toBe(oldSession);
    expect(finishedA.you.ready).toBe(false);
    expect(finishedB.opponent.ready).toBe(false);

    // 双方收到同一结果视图：座位 0（对手）因座位 1 认输获胜。
    const resultA = await a.waitFor((entry) => entry.type === 'match' && entry.view.result !== null, 'A 结果');
    const resultB = await b.waitFor((entry) => entry.type === 'match' && entry.view.result !== null, 'B 结果');
    const resultViewA = (resultA as Extract<ServerMessage, { type: 'match' }>).view;
    const resultViewB = (resultB as Extract<ServerMessage, { type: 'match' }>).view;
    expect(resultViewA.result).toEqual({ winner: 0, reason: 'concede', conditions: [] });
    expect(resultViewB.result).toEqual(resultViewA.result);

    // 结束后继续操作被拒绝，且不产生第二个终态。
    b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: oldSession, expectedVersion: resultViewB.version });
    const rejected = await b.waitFor(
      (entry) => entry.type === 'match-error' && entry.code === 'match-finished',
      '终态后出牌被拒',
    );
    expect(rejected.type).toBe('match-error');
    expect(harness.service.logText().split('room.match_finished').length - 1).toBe(1);

    // 双方重新准备：原房间实例、新会话。
    const aReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true };
    a.send(aReady);
    await a.waitForRoom((room) => room.you.ready, 'A 重新准备');
    await b.waitForRoom((room) => room.status === 'finished' && room.opponent.ready, 'B 看到 A 重新准备');
    const bReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(b)), ready: true };
    b.send(bReady);
    const restartedA = await a.waitForRoom((room) => room.status === 'started' && room.match?.sessionId !== oldSession, 'A 重新开局');
    const restartedB = await b.waitForRoom((room) => room.status === 'started' && room.match?.sessionId !== oldSession, 'B 重新开局');
    expect(restartedA.roomId).toBe(finishedA.roomId);
    expect(restartedB.match?.sessionId).toBe(restartedA.match?.sessionId);
    expect(restartedA.match?.sessionId).not.toBe(oldSession);

    // 旧会话命令在房间已指向新会话后得到 match-not-found，不会落到新对局。
    b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: oldSession, expectedVersion: restartedB.match?.version ?? 1 });
    const notFound = await b.waitFor((entry) => entry.type === 'match-error' && entry.code === 'match-not-found', '旧会话被拒');
    expect(notFound.type).toBe('match-error');

    // 新会话可以继续正常操作（先后攻选择在座位 0）。
    const newA = await a.waitFor((entry) => entry.type === 'match' && entry.view.sessionId === restartedA.match?.sessionId, '新会话 A');
    const newB = await b.waitFor((entry) => entry.type === 'match' && entry.view.sessionId === restartedB.match?.sessionId, '新会话 B');
    const newViewA = (newA as Extract<ServerMessage, { type: 'match' }>).view;
    const newViewB = (newB as Extract<ServerMessage, { type: 'match' }>).view;
    expect(newViewA.phase).toBe('turn-order');
    expect(newViewA.sessionId).toBe(restartedA.match?.sessionId);
    expect(newViewB.sessionId).toBe(newViewA.sessionId);
  });
});
