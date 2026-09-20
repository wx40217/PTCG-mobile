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

async function waitForMatchView(client: TestClient, predicate: (view: MatchView) => boolean, label = '对局视图'): Promise<MatchView> {
  const message = await client.waitFor((entry) => entry.type === 'match' && predicate(entry.view), label);
  return (message as Extract<ServerMessage, { type: 'match' }>).view;
}

function latestMatchView(client: TestClient): MatchView | undefined {
  const message = [...client.messages]
    .reverse()
    .find((entry): entry is Extract<ServerMessage, { type: 'match' }> => entry.type === 'match');
  return message?.view;
}

/** 自适应完成开局：处理重抽/补抽/备战直至双方 playing；返回双方最终视图。 */
async function completeOpening(
  a: TestClient,
  b: TestClient,
  winner: 0 | 1,
  goFirst: boolean,
): Promise<{ viewA: MatchView; viewB: MatchView }> {
  const winnerClient = winner === 0 ? a : b;
  const turnView = await waitForMatchView(winnerClient, (view) => view.pendingChoice?.kind === 'turn-order', '先后攻选择');
  winnerClient.send({
    type: 'choose-turn-order',
    commandId: nextCommandId(),
    sessionId: turnView.sessionId,
    expectedVersion: turnView.version,
    choiceId: turnView.pendingChoice?.choiceId ?? '',
    goFirst,
  });

  const submitted = new Map<TestClient, string>();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const viewA = latestMatchView(a);
    const viewB = latestMatchView(b);
    if (viewA?.phase === 'playing' && viewB?.phase === 'playing') {
      return { viewA, viewB };
    }
    for (const client of [a, b]) {
      const view = latestMatchView(client);
      const choice = view?.pendingChoice;
      if (view === undefined || choice === null || choice === undefined) {
        continue;
      }
      if (submitted.get(client) === choice.choiceId) {
        continue;
      }
      submitted.set(client, choice.choiceId);
      if (choice.kind === 'place-setup') {
        const active = view.you.hand.findIndex((card) => card.isBasicPokemon);
        client.send({
          type: 'place-setup',
          commandId: nextCommandId(),
          sessionId: view.sessionId,
          expectedVersion: view.version,
          choiceId: choice.choiceId,
          active,
          bench: [],
        });
      } else if (choice.kind === 'compensation-draw') {
        client.send({
          type: 'resolve-compensation',
          commandId: nextCommandId(),
          sessionId: view.sessionId,
          expectedVersion: view.version,
          choiceId: choice.choiceId,
          draw: 0,
        });
      } else if (choice.kind === 'place-bench') {
        client.send({
          type: 'place-bench',
          commandId: nextCommandId(),
          sessionId: view.sessionId,
          expectedVersion: view.version,
          choiceId: choice.choiceId,
          bench: [],
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('开局未在限定时间内进入 playing');
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

  it('终局后新座位设备看不到旧对局视图/旧手牌/旧昵称；旧会话命令被拒，原座位仍可查看终态并重新开局', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const { a, b } = await pairedRoom(harness);
    const opened = await completeOpening(a, b, 0, true);
    const oldSession = opened.viewA.sessionId;
    expect(opened.viewB.you.handCount).toBeGreaterThan(0);
    expect(opened.viewB.you.prizeCount).toBe(6);
    const bHand = opened.viewB.you.hand.map((card) => card.cardId);
    expect(bHand).toHaveLength(opened.viewB.you.handCount);

    // B 认输：终态只生成一次，房间 finished 保留旧会话供原座位查看。
    b.send({ type: 'concede', commandId: nextCommandId(), sessionId: oldSession, expectedVersion: opened.viewB.version });
    const finishedA = await a.waitForRoom((room) => room.status === 'finished', 'A 看到终局');
    await b.waitForRoom((room) => room.status === 'finished', 'B 看到终局');
    expect(finishedA.match?.sessionId).toBe(oldSession);

    // B 显式离开释放座位；C 首次加入、二次重入、重复建房都必须走现存房间路径。
    const bRoom = currentRoom(b);
    b.send({ type: 'leave-room', commandId: nextCommandId(), ...routed(bRoom) });
    expect(await b.waitFor((entry) => entry.type === 'room-left', 'B 离开')).toMatchObject({
      type: 'room-left',
      reason: 'left',
    });
    await a.waitForRoom((room) => room.opponent.occupied === false, '座位释放');

    const c = await connectTestClient(harness.service.service, '小刚');
    harness.clients.push(c);
    c.send({ type: 'join-room', commandId: nextCommandId(), code: bRoom.code });
    const cJoined = await c.waitForRoom((room) => room.you.seat === 1, 'C 首次加入');
    c.send({ type: 'join-room', commandId: nextCommandId(), code: cJoined.code, roomId: cJoined.roomId });
    await c.waitForNextRoom((room) => room.roomId === cJoined.roomId && room.you.seat === 1, 'C 重入');
    c.send({ type: 'create-room', commandId: nextCommandId() });
    await c.waitForNextRoom((room) => room.roomId === cJoined.roomId, 'C 重复建房回到原房间');

    // 新座位从未收到任何对局视图：旧手牌、奖赏、牌库、事件与旧昵称都不会出现。
    expect(c.messages.some((entry) => entry.type === 'match')).toBe(false);
    const payloadText = c.rawPayloads.join('\n');
    expect(payloadText).not.toContain('小茂');
    for (const cardId of bHand) {
      expect(payloadText).not.toContain(cardId);
    }

    // C 用旧会话 ID 提交动作：拒绝为 not-in-match，错误载荷不带任何私人视图。
    c.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: oldSession, expectedVersion: 1 });
    const rejected = await c.waitFor((entry) => entry.type === 'match-error', 'C 旧会话命令被拒');
    expect(rejected).toMatchObject({ type: 'match-error', code: 'not-in-match' });
    expect((rejected as { view?: unknown }).view).toBeUndefined();
    expect(c.messages.some((entry) => entry.type === 'match')).toBe(false);

    // 同一设备的新连接接管座位后，旧连接也不能借“连接已接管”错误拿到旧对局视图。
    const c2 = await connectTestClient(harness.service.service, '小刚', c.identity);
    harness.clients.push(c2);
    c2.send({ type: 'join-room', commandId: nextCommandId(), code: cJoined.code, roomId: cJoined.roomId });
    await c2.waitForRoom((room) => room.you.seat === 1 && room.opponent.online, 'C 新连接接管');
    c.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: oldSession, expectedVersion: 1 });
    const stale = await c.waitFor((entry) => entry.type === 'match-error', '旧连接被接管');
    expect(stale).toMatchObject({ type: 'match-error', code: 'not-in-match' });
    expect((stale as { view?: unknown }).view).toBeUndefined();
    expect(c.messages.some((entry) => entry.type === 'match')).toBe(false);

    // 原座位 A 仍能查看同一终态。
    const terminal = await a.waitFor((entry) => entry.type === 'match' && entry.view.result?.reason === 'concede', 'A 终态');
    expect((terminal as Extract<ServerMessage, { type: 'match' }>).view.result).toEqual({ winner: 0, reason: 'concede', conditions: [] });

    // A + C 重新准备：同一房间实例创建新会话；C 收到属于自己的新对局。
    const aReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true };
    a.send(aReady);
    await a.waitForNextRoom((room) => room.you.ready, 'A 重新准备');
    await c2.waitForRoom((room) => room.opponent.ready, 'C 看到 A 重新准备');
    const cSelect: SelectDeckCommand = {
      type: 'select-deck',
      commandId: nextCommandId(),
      ...routed(currentRoom(c2)),
      deck: releasePreset('B'),
    };
    c2.send(cSelect);
    await c2.waitForRoom((room) => room.you.deckSelected, 'C 选卡组');
    const cReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(c2)), ready: true };
    c2.send(cReady);
    const restarted = await c2.waitForRoom(
      (room) => room.status === 'started' && room.match?.sessionId !== oldSession,
      'C 重新开局',
    );
    expect(restarted.roomId).toBe(cJoined.roomId);
    const newSession = restarted.match?.sessionId as string;
    expect(newSession).not.toBe(oldSession);
    const newView = await waitForMatchView(c2, (view) => view.sessionId === newSession, 'C 新对局');
    expect(newView.you.nickname).toBe('小刚');
    expect(newView.opponent.nickname).toBe('小智');
    await a.waitFor((entry) => entry.type === 'match' && entry.view.sessionId === newSession, 'A 新对局');
  });
});
