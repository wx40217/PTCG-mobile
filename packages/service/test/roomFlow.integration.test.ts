import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  computeCatalogVersion,
  type ClientMessage,
  type LeaveRoomCommand,
  type RoomView,
  type ServerMessage,
  type SetReadyCommand,
} from '@ptcg/protocol';
import { createRoomController, type RoomController } from '../../client/src/rooms/roomController.ts';
import { createRoomRegistry, type RoomCatalogView, type RoomConnection } from '../src/rooms.ts';
import {
  connectTestClient,
  createTempDirectory,
  loadReleaseCatalog,
  nextCommandId,
  releasePreset,
  routed,
  startTestService,
  writePlayableFixture,
  type PlayableFixture,
  type TestClient,
  type TempDirectory,
  type TestService,
} from './support/roomTestKit.ts';

/** 最近一次收到的房间快照；测试中的路由命令都以它为目标。 */
function currentRoom(client: TestClient): RoomView {
  const room = client.latestRoom();
  if (room === undefined) {
    throw new Error('客户端还没有收到房间快照');
  }
  return room;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('房间注册表（单元）', () => {
  function setup(options: { codes: string[]; now?: () => number }) {
    const outbox: Array<{ connectionId: string; message: unknown }> = [];
    let index = 0;
    let roomIdSeq = 0;
    const registry = createRoomRegistry({
      now: options.now ?? (() => 1_000),
      generateCode: () => options.codes[Math.min(index++, options.codes.length - 1)] as string,
      newRoomId: () => `room-${(roomIdSeq += 1)}`,
      newSessionId: () => 'session-fixed',
      catalog: () => null,
      channel: {
        send(connectionId, message) {
          outbox.push({ connectionId, message });
        },
      },
    });
    const connection = (id: string): RoomConnection => ({ connectionId: id, deviceId: `dev_${id}`, nickname: id });
    return { registry, outbox, connection };
  }

  it('房间码冲突时自动重试直到无冲突', () => {
    const { registry, outbox, connection } = setup({ codes: ['123456', '123456', '654321'] });
    registry.createRoom(connection('a'));
    registry.createRoom(connection('b'));
    const codes = outbox
      .filter((entry) => (entry.message as { type?: string }).type === 'room')
      .map((entry) => (entry.message as { room: { code: string } }).room.code);
    expect(codes).toEqual(['123456', '654321']);
  });

  it('默认生成器产生 6 位数字房间码', () => {
    const outbox: unknown[] = [];
    const registry = createRoomRegistry({
      now: () => 1_000,
      newRoomId: () => 'room-default',
      catalog: () => null,
      channel: { send: (_id, message) => outbox.push(message) },
    });
    registry.createRoom({ connectionId: 'a', deviceId: 'dev_a', nickname: '小智' });
    const room = outbox.find((message) => (message as { type?: string }).type === 'room') as { room: { code: string } };
    expect(room.room.code).toMatch(/^[0-9]{6}$/u);
  });

  it('双方准备之间目录修订变化时不建立混合修订对局，撤销旧准备并要求重新确认', async () => {
    const temp = createTempDirectory('ptcg-rooms-unit-catalog-');
    try {
      const fixture = await writePlayableFixture(temp.path);
      const revisedContent = {
        ...fixture.content,
        supportPolicy: { ...fixture.content.supportPolicy, noteZh: '单元测试：目录在两次准备之间变化。' },
      };
      const revisedVersion = await computeCatalogVersion(revisedContent);
      let catalog: RoomCatalogView = { content: fixture.content, catalogVersion: fixture.catalogVersion };
      const outbox: Array<{ connectionId: string; message: ServerMessage }> = [];
      const logEvents: string[] = [];
      const registry = createRoomRegistry({
        now: () => 1_000,
        generateCode: () => '121212',
        newRoomId: () => 'room-catalog',
        newSessionId: () => 'session-catalog',
        catalog: () => catalog,
        channel: { send: (connectionId, message) => outbox.push({ connectionId, message }) },
        logger: (event) => logEvents.push(event),
      });
      const latestRoom = (connectionId: string): RoomView => {
        for (let index = outbox.length - 1; index >= 0; index -= 1) {
          const entry = outbox[index] as { connectionId: string; message: ServerMessage };
          if (entry.connectionId !== connectionId) {
            continue;
          }
          if (entry.message.type === 'room') {
            return entry.message.room;
          }
          if (entry.message.type === 'room-error' && entry.message.room !== undefined) {
            return entry.message.room;
          }
        }
        throw new Error(`连接 ${connectionId} 没有房间视图`);
      };
      const a: RoomConnection = { connectionId: 'a', deviceId: 'dev_a', nickname: '小智' };
      const b: RoomConnection = { connectionId: 'b', deviceId: 'dev_b', nickname: '小茂' };
      registry.handleCommand(a, { type: 'create-room', commandId: 'c-create' });
      const created = latestRoom('a');
      registry.handleCommand(b, { type: 'join-room', commandId: 'c-join', code: created.code });

      registry.handleCommand(a, { type: 'select-deck', commandId: 'c-a-deck', ...routed(latestRoom('a')), deck: releasePreset('A') });
      const aDeck = latestRoom('a');
      registry.handleCommand(a, { type: 'set-ready', commandId: 'c-a-ready', ...routed(aDeck), ready: true });
      const aReady = latestRoom('a');
      expect(aReady.you.ready).toBe(true);

      // 目录在 A 准备之后、B 准备之前被替换。
      catalog = { content: revisedContent, catalogVersion: revisedVersion };
      registry.handleCommand(b, { type: 'select-deck', commandId: 'c-b-deck', ...routed(latestRoom('b')), deck: releasePreset('B') });
      const bDeck = latestRoom('b');
      registry.handleCommand(b, { type: 'set-ready', commandId: 'c-b-ready', ...routed(bDeck), ready: true });

      const bResult = outbox[outbox.length - 1] as { connectionId: string; message: ServerMessage };
      expect(bResult.connectionId).toBe('b');
      expect(bResult.message).toMatchObject({ type: 'room-error', code: 'catalog-changed' });
      const revoked = latestRoom('a');
      expect(revoked.you.ready).toBe(false);
      expect(revoked.version).toBeGreaterThan(aReady.version);
      expect(revoked.opponent.ready).toBe(true);
      expect(logEvents.filter((event) => event === 'room.match_created')).toHaveLength(0);

      // 被撤销的一方基于当前目录重新明确确认，才建立唯一的对局。
      registry.handleCommand(a, { type: 'set-ready', commandId: 'c-a-ready-2', ...routed(revoked), ready: true });
      const started = latestRoom('a');
      expect(started.status).toBe('started');
      expect(started.you.deck?.validation.catalogVersion).toBe(revisedVersion);
      expect(started.you.deck?.validation.ready).toBe(true);
      expect(logEvents.filter((event) => event === 'room.match_created')).toHaveLength(1);
    } finally {
      temp.cleanup();
    }
  });
});

describe('房间建立、座位与离开（真实服务 + 测试夹具）', () => {
  let temp: TempDirectory;
  let fixture: PlayableFixture;
  let harness: TestService;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    temp = createTempDirectory('ptcg-rooms-');
    fixture = await writePlayableFixture(temp.path);
    harness = await startTestService({ catalog: { catalogPath: fixture.path } });
  });

  afterAll(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await harness.close();
    temp.cleanup();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  async function client(nickname: string, identity?: TestClient['identity']): Promise<TestClient> {
    const connected = await connectTestClient(harness.service, nickname, identity);
    clients.push(connected);
    return connected;
  }

  async function givenWaitingRoom(): Promise<{ a: TestClient; b: TestClient; code: string }> {
    const a = await client('小智');
    const b = await client('小茂');
    a.send({ type: 'create-room', commandId: nextCommandId() });
    const created = await a.waitForRoom((room) => room.status === 'waiting' && room.you.host, '建房快照');
    b.send({ type: 'join-room', commandId: nextCommandId(), code: created.code });
    await b.waitForRoom((room) => room.code === created.code && room.you.seat === 1, '来宾加入快照');
    await a.waitForRoom(
      (room) => room.code === created.code && room.opponent.occupied && room.opponent.nickname === '小茂',
      '房主看到来宾',
    );
    return { a, b, code: created.code };
  }

  it('建房返回 6 位房间码与稳定实例 ID；重复建房回到同一房间而不是再建一间', async () => {
    const a = await client('小智');
    a.send({ type: 'create-room', commandId: nextCommandId() });
    const first = await a.waitForRoom((room) => room.status === 'waiting', '建房快照');
    expect(first.code).toMatch(/^[0-9]{6}$/u);
    expect(first.roomId.length).toBeGreaterThan(0);
    expect(first.you).toMatchObject({ seat: 0, host: true, occupied: true, ready: false, deck: null });
    expect(first.opponent).toMatchObject({ seat: 1, occupied: false, deck: null });
    expect(first.match).toBeNull();

    a.send({ type: 'create-room', commandId: nextCommandId() });
    const repeated = await a.waitForNextRoom((room) => room.code === first.code, '重复建房快照');
    expect(repeated.roomId).toBe(first.roomId);
    expect(repeated.version).toBe(first.version);
    const createdLogs = harness.logs.filter((line) => line.includes('room.created'));
    expect(createdLogs).toHaveLength(1);
  });

  it('第二人加入占座；第三人被明确拒绝且载荷中没有房间/对手状态', async () => {
    const { a, b, code } = await givenWaitingRoom();
    const aView = currentRoom(a);
    expect(aView.opponent).toMatchObject({ seat: 1, occupied: true, nickname: '小茂', ready: false, deck: null });

    const c = await client('小刚');
    c.send({ type: 'join-room', commandId: nextCommandId(), code });
    const rejected = await c.waitFor((message) => message.type === 'room-error', '第三人被拒绝');
    expect(rejected).toMatchObject({ type: 'room-error', code: 'room-full' });
    expect(c.messages.some((message) => message.type === 'room')).toBe(false);
    const text = c.rawPayloads.join('\n');
    expect(text).not.toContain('小智');
    expect(text).not.toContain('小茂');
    expect(text).not.toContain('"type":"room"');
    void b;
  });

  it('同一设备重复加入回到原座位；其他设备重名不能占座', async () => {
    const { a, b, code } = await givenWaitingRoom();
    b.send({ type: 'join-room', commandId: nextCommandId(), code });
    const rejoined = await b.waitForNextRoom((room) => room.code === code && room.you.seat === 1, '重复加入快照');
    expect(rejoined.you.nickname).toBe('小茂');

    // 昵称不是身份：另一个设备即使重名也占不到座位。
    const impostor = await client('小茂');
    impostor.send({ type: 'join-room', commandId: nextCommandId(), code });
    const rejected = await impostor.waitFor((message) => message.type === 'room-error', '重名第三人');
    expect(rejected).toMatchObject({ code: 'room-full' });
    void a;
  });

  it('错误服务地址之外：未知房间码与非法房间码都有明确结果', async () => {
    const a = await client('小智');
    a.send({ type: 'join-room', commandId: nextCommandId(), code: '000001' });
    expect(await a.waitFor((message) => message.type === 'room-error', '未知房间')).toMatchObject({
      code: 'room-not-found',
    });

    a.send({ type: 'join-room', commandId: nextCommandId(), code: '12ab56' } as never);
    expect(await a.waitFor((message) => message.type === 'room-error' && message.code === 'invalid-message', '非法房间码')).toMatchObject({
      code: 'invalid-message',
    });
    expect(a.messages.some((message) => message.type === 'room')).toBe(false);
  });

  it('房主开局前离开关闭房间：来宾收到明确通知且该码不能再加入', async () => {
    const { a, b, code } = await givenWaitingRoom();
    const room = currentRoom(a);
    a.send({ type: 'leave-room', commandId: nextCommandId(), ...routed(room) });
    expect(await a.waitFor((message) => message.type === 'room-left', '房主离开结果')).toMatchObject({
      type: 'room-left',
      roomId: room.roomId,
      code,
      reason: 'host-left',
    });
    expect(await b.waitFor((message) => message.type === 'room-closed', '来宾收到关闭')).toMatchObject({
      type: 'room-closed',
      roomId: room.roomId,
      code,
      reason: 'host-left',
    });

    const late = await client('小刚');
    late.send({ type: 'join-room', commandId: nextCommandId(), code });
    expect(await late.waitFor((message) => message.type === 'room-error', '关闭后加入')).toMatchObject({
      code: 'room-closed',
    });
  });

  it('来宾离开释放座位并可重新加入；房主保留房间', async () => {
    const { a, b, code } = await givenWaitingRoom();
    const bRoom = currentRoom(b);
    b.send({ type: 'leave-room', commandId: nextCommandId(), ...routed(bRoom) });
    expect(await b.waitFor((message) => message.type === 'room-left', '来宾离开结果')).toMatchObject({
      type: 'room-left',
      roomId: bRoom.roomId,
      code,
      reason: 'left',
    });
    await a.waitForRoom((room) => room.code === code && room.opponent.occupied === false, '座位释放');

    b.send({ type: 'join-room', commandId: nextCommandId(), code, roomId: bRoom.roomId });
    const rejoined = await b.waitForNextRoom((room) => room.code === code && room.you.seat === 1, '重新加入');
    expect(rejoined.opponent.host).toBe(true);
  });

  it('重连/昵称更新递增房间版本、广播给对手，且同一版本不会出现两种内容', async () => {
    const { a, b, code } = await givenWaitingRoom();
    const before = currentRoom(a);
    const bRoomId = currentRoom(b).roomId;

    // 同一设备以新连接、新昵称重入：对手必须收到新版本快照，而不是静默改状态。
    const b2 = await client('小茂（新昵称）', b.identity);
    b2.send({ type: 'join-room', commandId: nextCommandId(), code, roomId: bRoomId });
    const updated = await a.waitForRoom((room) => room.opponent.nickname === '小茂（新昵称）', '昵称更新广播');
    expect(updated.version).toBeGreaterThan(before.version);
    expect(updated.opponent.online).toBe(true);

    // 重复建房（同设备已入座）走同一重入路径：换连接+昵称同样递增并广播。
    const a2 = await client('小智（新昵称）', a.identity);
    a2.send({ type: 'create-room', commandId: nextCommandId() });
    const renamed = await b2.waitForRoom((room) => room.opponent.nickname === '小智（新昵称）', '房主昵称更新广播');
    expect(renamed.version).toBeGreaterThan(updated.version);

    // 相同版本的房间快照内容必须一致：不同内容不能共享同一个版本号。
    const seen = new Map<number, string>();
    for (const message of a.messages) {
      if (message.type !== 'room') {
        continue;
      }
      const content = JSON.stringify(message.room);
      const existing = seen.get(message.room.version);
      if (existing !== undefined) {
        expect(content).toBe(existing);
      } else {
        seen.set(message.room.version, content);
      }
    }
  });

  it('切换房间后，指向旧实例的延迟离开不会影响新房间（错目标不修改状态）', async () => {
    const { a, b, code } = await givenWaitingRoom();
    const bOldRoom = currentRoom(b);
    b.send({ type: 'leave-room', commandId: nextCommandId(), ...routed(bOldRoom) });
    await b.waitFor((message) => message.type === 'room-left', 'b 离开旧房间');
    await a.waitForRoom((room) => room.opponent.occupied === false, '旧房间释放座位');

    b.send({ type: 'create-room', commandId: nextCommandId() });
    const bNewRoom = await b.waitForRoom((room) => room.you.host && room.code !== code, 'b 的新房间');
    expect(bNewRoom.roomId).not.toBe(bOldRoom.roomId);

    // 延迟到达的旧实例离开：只被拒绝，新房间版本与座位不变。
    b.send({ type: 'leave-room', commandId: nextCommandId(), ...routed(bOldRoom) });
    const rejected = await b.waitFor(
      (message) => message.type === 'room-error' && (message.code === 'not-in-room' || message.code === 'stale-room'),
      '旧房间离开被拒',
    );
    expect(rejected).toMatchObject({ code: 'not-in-room' });
    const after = currentRoom(b);
    expect(after.roomId).toBe(bNewRoom.roomId);
    expect(after.version).toBe(bNewRoom.version);
    expect(after.you.host).toBe(true);
  });

  it('离开/重入后相同命令 ID 的重传仍返回第一次结果且不重复生效', async () => {
    const { a, b, code } = await givenWaitingRoom();
    const bRoom = currentRoom(b);
    const leavePayload: LeaveRoomCommand = { type: 'leave-room', commandId: nextCommandId(), ...routed(bRoom) };
    b.send(leavePayload);
    const left = await b.waitFor((message) => message.type === 'room-left', '离开结果');

    b.send({ type: 'join-room', commandId: nextCommandId(), code, roomId: bRoom.roomId });
    const rejoined = await b.waitForNextRoom((room) => room.code === code && room.you.seat === 1, '重新加入');
    expect(rejoined.version).toBe(bRoom.version + 2);

    // 合法重传：返回同一结果，不会把重入后的座位再次释放。
    const leftCountBeforeReplay = b.messages.filter((message) => message.type === 'room-left').length;
    b.send(leavePayload);
    const replayDeadline = Date.now() + 8_000;
    while (Date.now() < replayDeadline && b.messages.filter((message) => message.type === 'room-left').length <= leftCountBeforeReplay) {
      await sleep(10);
    }
    const leftMessages = b.messages.filter((message) => message.type === 'room-left');
    expect(leftMessages).toHaveLength(leftCountBeforeReplay + 1);
    expect(leftMessages.at(-1)).toEqual(left);
    expect(currentRoom(b).you.seat).toBe(1);
    expect(currentRoom(b).version).toBe(rejoined.version);
    expect(a.latestRoom()?.opponent.occupied).toBe(true);
  });

  it('控制器接真实服务：离开 A 加入 B 后，A 的缓存快照与缓存错误不会把界面切回 A', async () => {
    const test = await client('小智');
    // 记录控制器发出的命令，便于随后精确重放旧命令（同一 commandId）。
    const sent: ClientMessage[] = [];
    const originalSend = test.connection.send.bind(test.connection);
    test.connection.send = (message) => {
      sent.push(message);
      originalSend(message);
    };
    const controller: RoomController = createRoomController(test.connection, () => undefined);
    const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await sleep(10);
      }
      throw new Error(`等待 ${label} 超时：${JSON.stringify(controller.state)}`);
    };
    const waitForRoom = async (): Promise<RoomView> => {
      await waitFor(() => controller.state.room !== null && controller.state.phase === 'in-room', '控制器房间');
      return controller.state.room as RoomView;
    };

    controller.createRoom();
    const roomA = await waitForRoom();
    expect(roomA.code).toMatch(/^[0-9]{6}$/u);

    // 先制造一条属于 A 的缓存错误结果（版本冲突带当前快照）。
    const staleCommandId = nextCommandId();
    const staleCommand: ClientMessage = {
      type: 'select-deck',
      commandId: staleCommandId,
      roomId: roomA.roomId,
      expectedVersion: 999,
      deck: releasePreset('A'),
    };
    test.connection.send(staleCommand);
    expect(await test.waitFor((message) => message.type === 'room-error' && message.commandId === staleCommandId, '旧版本错误')).toMatchObject({
      code: 'version-conflict',
      room: { roomId: roomA.roomId },
    });

    // 正常选卡组并记录那条命令，随后离开 A、创建 B。
    controller.selectDeck(releasePreset('A'));
    await waitFor(() => controller.state.room?.you.deckSelected === true, '选卡组确认');
    const oldSelect = sent.filter((message) => message.type === 'select-deck').at(-1) as ClientMessage;
    expect(oldSelect.type).toBe('select-deck');
    const roomASelected = controller.state.room as RoomView;

    controller.leaveRoom();
    await waitFor(() => controller.state.room === null && (controller.state.phase === 'left' || controller.state.phase === 'closed'), '离开 A');
    controller.createRoom();
    const roomB = await waitForRoom();
    expect(roomB.roomId).not.toBe(roomASelected.roomId);

    // 重放 A 的旧选卡组缓存快照与旧版本冲突缓存错误：都必须被丢弃。
    test.connection.send(oldSelect);
    test.connection.send(staleCommand);
    await sleep(400);
    expect(controller.state.room?.roomId).toBe(roomB.roomId);
    expect(controller.state.room?.code).toBe(roomB.code);
    expect(controller.state.phase).toBe('in-room');
    expect(controller.state.error).toBeNull();

    controller.dispose();
  });
});

describe('卡组校验、准备与唯一对局（真实服务 + 测试夹具）', () => {
  let temp: TempDirectory;
  let fixture: PlayableFixture;
  let harness: TestService;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    temp = createTempDirectory('ptcg-rooms-ready-');
    fixture = await writePlayableFixture(temp.path);
    harness = await startTestService({ catalog: { catalogPath: fixture.path } });
  });

  afterAll(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await harness.close();
    temp.cleanup();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  async function client(nickname: string): Promise<TestClient> {
    const connected = await connectTestClient(harness.service, nickname);
    clients.push(connected);
    return connected;
  }

  async function givenWaitingRoom(): Promise<{ a: TestClient; b: TestClient; code: string }> {
    const a = await client('小智');
    const b = await client('小茂');
    a.send({ type: 'create-room', commandId: nextCommandId() });
    const created = await a.waitForRoom((room) => room.you.host, '建房快照');
    b.send({ type: 'join-room', commandId: nextCommandId(), code: created.code });
    await b.waitForRoom((room) => room.you.seat === 1, '来宾加入快照');
    await a.waitForRoom((room) => room.opponent.occupied, '房主看到来宾');
    return { a, b, code: created.code };
  }

  it('选卡组由服务端独立校验并固定修订；换卡组撤销准备', async () => {
    const { a, b, code } = await givenWaitingRoom();

    a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(a)), deck: releasePreset('A') });
    const selected = await a.waitForRoom((room) => room.you.deckSelected && room.you.deck !== null, '选卡组快照');
    expect(selected.you.deck?.totalCards).toBe(60);
    expect(selected.you.deck?.validation.legal).toBe(true);
    // 测试夹具里效果已接入，因此就绪；发行目录不会走到这里。
    expect(selected.you.deck?.validation.ready).toBe(true);
    expect(selected.you.deck?.validation.catalogVersion).toBe(fixture.catalogVersion);
    expect(selected.you.ready).toBe(false);

    // 对手看得到“已选卡组”，但载荷里没有任何卡牌条目。
    const bView = await b.waitForRoom((room) => room.code === code && room.opponent.deckSelected, '对手看到已选卡组');
    expect(bView.opponent.deck).toBeNull();
    expect(bView.opponent.ready).toBe(false);

    a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(selected), ready: true });
    const ready = await a.waitForRoom((room) => room.you.ready, '准备成功');
    expect(ready.you.ready).toBe(true);
    expect(ready.you.deck?.validation.dataRevision).toBe(fixture.content.dataRevision.sourceDigest);
    await b.waitForRoom((room) => room.opponent.ready, '对手看到已准备');

    // 换一副卡组：立即撤销准备，对手看到 ready=false。
    a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(ready), deck: releasePreset('B') });
    const changed = await a.waitForNextRoom((room) => room.you.ready === false && room.you.deckSelected, '换卡组撤销准备');
    expect(changed.you.ready).toBe(false);
    await b.waitForRoom((room) => room.opponent.ready === false && room.opponent.deckSelected, '对手看到准备被撤销');

    const readyLogs = harness.logs.filter((line) => line.includes('room.ready'));
    expect(readyLogs.some((line) => line.includes(fixture.catalogVersion))).toBe(true);
  });

  it('换卡组后延迟到达的旧准备命令被拒绝，不会确认未批准的卡组', async () => {
    const { a } = await givenWaitingRoom();
    a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(a)), deck: releasePreset('A') });
    const afterDeckA = await a.waitForRoom((room) => room.you.deckSelected, 'A 已选卡组');
    const staleTarget = routed(afterDeckA);

    a.send({ type: 'set-ready', commandId: nextCommandId(), ...staleTarget, ready: true });
    const readyA = await a.waitForRoom((room) => room.you.ready, '基于 A 的准备已生效');

    a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(readyA), deck: releasePreset('B') });
    const afterDeckB = await a.waitForNextRoom((room) => room.you.ready === false && room.you.deckSelected, '换卡组撤销准备');
    expect(afterDeckB.version).toBeGreaterThan(afterDeckA.version);

    // 延迟/乱序到达的旧版本准备：版本护栏必须拒绝且不修改房间。
    a.send({ type: 'set-ready', commandId: nextCommandId(), ...staleTarget, ready: true });
    const conflict = await a.waitFor(
      (message) => message.type === 'room-error' && message.code === 'version-conflict',
      '旧准备被拒绝',
    );
    if (conflict.type !== 'room-error' || conflict.room === undefined) {
      throw new Error('版本冲突必须回传当前房间快照');
    }
    expect(conflict.room.version).toBe(afterDeckB.version);
    expect(conflict.room.you.ready).toBe(false);
    expect(conflict.room.status).toBe('waiting');

    // 基于最新版本的显式确认才生效。
    a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(afterDeckB), ready: true });
    expect(await a.waitForRoom((room) => room.you.ready, '重新准备')).toMatchObject({ you: { ready: true } });
  });

  it('未准备完整卡组不能开局；非法构筑由服务端给出具体问题', async () => {
    const { a } = await givenWaitingRoom();
    a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true });
    expect(await a.waitFor((message) => message.type === 'room-error', '未选卡组错误')).toMatchObject({
      code: 'deck-required',
    });

    a.send({
      type: 'select-deck',
      commandId: nextCommandId(),
      ...routed(currentRoom(a)),
      deck: { formatVersion: 1, environmentId: fixture.content.environment.id, cards: [] },
    });
    const selected = await a.waitForRoom((room) => room.you.deckSelected, '空卡组快照');
    expect(selected.you.deck?.validation.legal).toBe(false);
    expect(selected.you.deck?.validation.problems.some((problem) => problem.code === 'deck-size')).toBe(true);

    a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(selected), ready: true });
    const refusal = await a.waitFor((message) => message.type === 'room-error' && message.code === 'deck-not-ready', '未就绪拒绝');
    expect(refusal).toMatchObject({ type: 'room-error', code: 'deck-not-ready' });
  });

  it('并发准备与命令重传只建立一次对局；过期准备被拒绝后重试仍得到唯一会话', async () => {
    const { a, b } = await givenWaitingRoom();

    a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(a)), deck: releasePreset('A') });
    await a.waitForRoom((room) => room.you.deckSelected, 'A 已选卡组');
    b.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(b)), deck: releasePreset('C') });
    await b.waitForRoom((room) => room.you.deckSelected, 'B 已选卡组');
    await a.waitForRoom((room) => room.opponent.deckSelected, 'A 看到 B 已选卡组');

    // 等到双方快照收敛到同一版本，再在同一时刻发出准备。
    const shared = await (async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const aView = currentRoom(a);
        const bView = currentRoom(b);
        if (aView.version === bView.version) {
          return aView;
        }
        await sleep(10);
      }
      throw new Error('双方未收敛到同一房间版本');
    })();
    const aReadyPayload: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(shared), ready: true };
    const bReadyPayload: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(shared), ready: true };
    a.send(aReadyPayload);
    b.send(bReadyPayload);

    async function readyOutcome(
      client: TestClient,
    ): Promise<{ readonly kind: 'accepted' } | { readonly kind: 'conflict'; readonly room: RoomView }> {
      const message = await client.waitFor(
        (entry) =>
          (entry.type === 'room-error' && entry.code === 'version-conflict') ||
          (entry.type === 'room' && entry.room.you.ready),
        '准备结果',
      );
      if (message.type === 'room-error') {
        if (message.room === undefined) {
          throw new Error('版本冲突必须回传当前房间快照');
        }
        return { kind: 'conflict', room: message.room };
      }
      return { kind: 'accepted' };
    }

    const [aOutcome, bOutcome] = await Promise.all([readyOutcome(a), readyOutcome(b)]);
    const outcomes = [aOutcome.kind, bOutcome.kind].sort();
    expect(outcomes).toEqual(['accepted', 'conflict']);

    // 被版本护栏拒绝的一方基于服务端当前快照重新确认；这条版本匹配的命令
    // 才是真正触发开局的那一条。
    const conflictSide = aOutcome.kind === 'conflict' ? 'a' : 'b';
    const conflictRoom = (aOutcome.kind === 'conflict' ? aOutcome.room : (bOutcome as { room: RoomView }).room);
    const retryPayload: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(conflictRoom), ready: true };
    if (conflictSide === 'a') {
      a.send(retryPayload);
    } else {
      b.send(retryPayload);
    }
    const aStarted = await a.waitForRoom((room) => room.status === 'started', 'A 开局');
    const bStarted = await b.waitForRoom((room) => room.status === 'started', 'B 开局');
    expect(aStarted.match).not.toBeNull();
    expect(bStarted.match).not.toBeNull();
    expect(aStarted.match?.sessionId).toBe(bStarted.match?.sessionId);
    expect(aStarted.match?.version).toBe(1);
    expect(bStarted.match?.version).toBe(1);
    expect(harness.logs.filter((line) => line.includes('room.match_created'))).toHaveLength(1);

    // 重传真正触发开局的命令（载荷逐字段相同）：返回第一次的已开局快照，
    // 不建立第二场对局。
    const starter = conflictSide === 'a' ? a : b;
    const starterNickname = conflictSide === 'a' ? '小智' : '小茂';
    starter.send(retryPayload);
    const replay = await starter.waitForNextRoom(
      (room) => room.status === 'started' && room.match?.sessionId === aStarted.match?.sessionId,
      '重传返回原会话',
    );
    expect(replay.match?.version).toBe(1);
    expect(harness.logs.filter((line) => line.includes('room.match_created'))).toHaveLength(1);

    // 对局建立后不能换卡组或取消准备。
    a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(aStarted), deck: releasePreset('D') });
    expect(await a.waitFor((message) => message.type === 'room-error' && message.code === 'match-started', '开局后换卡组')).toMatchObject(
      { code: 'match-started' },
    );
    a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(aStarted), ready: false });
    expect(await a.waitFor((message) => message.type === 'room-error' && message.code === 'match-started', '开局后取消准备')).toMatchObject(
      { code: 'match-started' },
    );

    // 连接重传：触发开局的同一设备断开后重连，重放同一命令 ID，仍返回原会话。
    starter.close();
    const starter2 = await connectTestClient(harness.service, starterNickname, starter.identity);
    clients.push(starter2);
    starter2.send({ type: 'join-room', commandId: nextCommandId(), code: aStarted.code, roomId: aStarted.roomId });
    await starter2.waitForRoom((room) => room.status === 'started' && room.match?.sessionId === aStarted.match?.sessionId, '重连恢复');
    starter2.send(retryPayload);
    const replayedAfterReconnect = await starter2.waitForNextRoom(
      (room) => room.status === 'started' && room.match?.sessionId === aStarted.match?.sessionId,
      '重连后重放',
    );
    expect(replayedAfterReconnect.match?.sessionId).toBe(aStarted.match?.sessionId);
    expect(harness.logs.filter((line) => line.includes('room.match_created'))).toHaveLength(1);
  });

  it('对手完整卡表不进入其收到的任何载荷（含开局前后）', async () => {
    const { a, b } = await givenWaitingRoom();
    const deckA = releasePreset('A');
    const cardIds = deckA.cards.map((entry) => entry.cardId);

    // 先提交一份带唯一“探针卡号”的问题卡组：这份载荷只在 A 的载荷里出现，
    // 用它证明检查确实在看真实载荷，而不是两边都恰好没有卡号。
    const probeId = 'leak-probe-9999';
    a.send({
      type: 'select-deck',
      commandId: nextCommandId(),
      ...routed(currentRoom(a)),
      deck: { ...deckA, cards: [...deckA.cards, { cardId: probeId, printIdentity: 'print:X:0', effectIdentity: 'fx:x', count: 1 }] },
    });
    const probeView = await a.waitForRoom((room) => room.you.deckSelected && room.you.deck !== null, '探针卡组快照');
    expect(probeView.you.deck?.validation.problems.some((problem) => problem.cardIds.includes(probeId))).toBe(true);
    expect(a.rawPayloads.join('\n')).toContain(probeId);
    await b.waitForRoom((room) => room.opponent.deckSelected, '对手看到已选卡组');
    expect(b.rawPayloads.join('\n')).not.toContain(probeId);

    // 正式准备与开局：B 的载荷仍然没有任何 A 的卡号。
    a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(probeView), deck: deckA });
    const aDeck = await a.waitForRoom((room) => room.you.deck?.validation.ready === true, 'A 卡组就绪');
    a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(aDeck), ready: true });
    await a.waitForRoom((room) => room.you.ready, 'A 已准备');

    b.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(b)), deck: releasePreset('B') });
    const bDeck = await b.waitForRoom((room) => room.you.deckSelected, 'B 已选卡组');
    b.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(bDeck), ready: true });
    await b.waitForRoom((room) => room.status === 'started', '对局建立');

    const bText = b.rawPayloads.join('\n');
    for (const cardId of cardIds) {
      expect(bText).not.toContain(cardId);
    }
    expect(bText).not.toContain('fx:pokemon:');
    expect(bText).not.toContain('fx:trainer:');
  });

  it('开局后离开只标记离线：保留座位与会话、不关闭房间、可重入', async () => {
    const { a, b, code } = await givenWaitingRoom();
    a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(a)), deck: releasePreset('A') });
    await a.waitForRoom((room) => room.you.deckSelected, 'A 已选卡组');
    b.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(b)), deck: releasePreset('B') });
    await b.waitForRoom((room) => room.you.deckSelected, 'B 已选卡组');
    await a.waitForRoom((room) => room.opponent.deckSelected, 'A 看到 B 已选卡组');
    a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true });
    await a.waitForRoom((room) => room.you.ready, 'A 已准备');
    b.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(b)), ready: true });
    const started = await b.waitForRoom((room) => room.status === 'started', '对局建立');

    const aStarted = currentRoom(a);
    a.send({ type: 'leave-room', commandId: nextCommandId(), ...routed(aStarted) });
    expect(await a.waitFor((message) => message.type === 'room-left', '开局后离开结果')).toMatchObject({
      type: 'room-left',
      roomId: aStarted.roomId,
      code,
      reason: 'left',
    });

    const bAfterLeave = await b.waitForRoom(
      (room) => room.status === 'started' && room.opponent.occupied && room.opponent.online === false,
      '对手离线但仍在座',
    );
    expect(bAfterLeave.match?.sessionId).toBe(started.match?.sessionId);
    expect(bAfterLeave.match?.version).toBe(1);

    // 同一身份重新加入：回到原座位，会话不变。
    a.send({ type: 'join-room', commandId: nextCommandId(), code, roomId: aStarted.roomId });
    const rejoined = await a.waitForNextRoom(
      (room) => room.status === 'started' && room.match?.sessionId === started.match?.sessionId,
      '重入原会话',
    );
    expect(rejoined.you.seat).toBe(0);
    expect(rejoined.match?.version).toBe(1);
    const opponentOnline = await b.waitForRoom(
      (room) => room.version > bAfterLeave.version && room.opponent.online,
      '对手恢复在线',
    );
    expect(opponentOnline.opponent.online).toBe(true);
  });
});

describe('房间实例身份与房间码复用（真实服务，可推进时钟）', () => {
  let temp: TempDirectory;
  let fixture: PlayableFixture;
  let harness: TestService;
  const clients: TestClient[] = [];
  let clock = 1_700_000_000_000;

  beforeAll(async () => {
    temp = createTempDirectory('ptcg-rooms-reuse-');
    fixture = await writePlayableFixture(temp.path);
    harness = await startTestService({
      catalog: { catalogPath: fixture.path },
      rooms: { generateCode: () => '246810' },
      now: () => clock,
    });
  });

  afterAll(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await harness.close();
    temp.cleanup();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  async function client(nickname: string): Promise<TestClient> {
    const connected = await connectTestClient(harness.service, nickname);
    clients.push(connected);
    return connected;
  }

  it('房间码复用后旧实例的命令与重连不会落到新房间；精确重传返回第一次结果', async () => {
    const host = await client('旧房主');
    host.send({ type: 'create-room', commandId: nextCommandId() });
    const oldRoom = await host.waitForRoom((room) => room.you.host, '旧房间');
    expect(oldRoom.code).toBe('246810');

    const leaveOldPayload: LeaveRoomCommand = { type: 'leave-room', commandId: nextCommandId(), ...routed(oldRoom) };
    host.send(leaveOldPayload);
    const left = await host.waitFor((message) => message.type === 'room-left', '关闭旧房间');
    expect(left).toMatchObject({ type: 'room-left', roomId: oldRoom.roomId, reason: 'host-left' });

    // 关闭墓碑过期后，同一 6 位房间码被分配给新的房间实例。
    clock += 61_000;
    const other = await client('新房主');
    other.send({ type: 'create-room', commandId: nextCommandId() });
    const newRoom = await other.waitForRoom((room) => room.code === '246810', '复用同一房间码的新房间');
    expect(newRoom.roomId).not.toBe(oldRoom.roomId);

    // 旧设备带旧 roomId 重连同一房间码：被拒绝，不会变成新房间的成员。
    host.send({ type: 'join-room', commandId: nextCommandId(), code: '246810', roomId: oldRoom.roomId });
    expect(await host.waitFor((message) => message.type === 'room-error', '旧实例重连')).toMatchObject({
      code: 'stale-room',
    });
    expect(other.latestRoom()?.opponent.occupied).toBe(false);

    // 精确重传旧的离开命令：返回第一次结果，新房间版本不变。
    host.send(leaveOldPayload);
    const replayed = await host.waitFor(
      (message) => message.type === 'room-left' && message.commandId === leaveOldPayload.commandId,
      '重放旧离开',
    );
    expect(replayed).toEqual(left);
    expect(other.latestRoom()?.version).toBe(newRoom.version);
    expect(other.latestRoom()?.you.host).toBe(true);
  });
});

describe('加入限速（真实服务，独立配置窗口）', () => {
  let temp: TempDirectory;
  let fixture: PlayableFixture;
  let harness: TestService;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    temp = createTempDirectory('ptcg-rooms-limit-');
    fixture = await writePlayableFixture(temp.path);
    harness = await startTestService({
      catalog: { catalogPath: fixture.path },
      rooms: { limits: { joinAttempts: 2, joinWindowMs: 60_000 } },
    });
  });

  afterAll(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await harness.close();
    temp.cleanup();
  });

  it('同一设备的过频加入尝试得到 rate-limited 与重试等待', async () => {
    const a = await connectTestClient(harness.service, '小智');
    clients.push(a);
    a.send({ type: 'join-room', commandId: nextCommandId(), code: '000001' });
    expect(await a.waitFor((message) => message.type === 'room-error', '第一次')).toMatchObject({ code: 'room-not-found' });
    a.send({ type: 'join-room', commandId: nextCommandId(), code: '000002' });
    expect(await a.waitFor((message) => message.type === 'room-error' && message.code === 'room-not-found', '第二次')).toMatchObject({
      code: 'room-not-found',
    });
    a.send({ type: 'join-room', commandId: nextCommandId(), code: '000003' });
    const limited = await a.waitFor((message) => message.type === 'room-error' && message.code === 'rate-limited', '第三次');
    expect(limited).toMatchObject({ code: 'rate-limited' });
    if (limited.type === 'room-error') {
      expect(limited.retryAfterMs).toBeGreaterThan(0);
    }
  });
});

describe('发行目录保持未整体就绪', () => {
  it('发行目录只标记已逐张验证的效果，预设仍不能准备', () => {
    const release = loadReleaseCatalog();
    expect(release.content.supportPolicy.playable).toBe(false);
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../data/effects/zh-cn-standard-2025-06-05-supported-effects.json', import.meta.url)), 'utf8'),
    ) as { readonly effects: readonly unknown[] };
    const supported = release.content.cards.filter((card) => card.flags.effectSupported);
    // 注册表条目与目录标记同源：每个已支持效果身份恰好对应一张印刷版本。
    expect(supported).toHaveLength(manifest.effects.length);
    expect(supported.some((card) => card.cardClass === 'pokemon')).toBe(true);
    expect(
      supported.some((card) => card.cardClass === 'trainer' && card.effectiveCategory === '宝可梦道具'),
    ).toBe(true);
    expect(
      supported.every(
        (card) =>
          card.cardClass === 'pokemon' ||
          ['物品', '支援者', '竞技场', '宝可梦道具'].includes(card.effectiveCategory ?? ''),
      ),
    ).toBe(true);
    // 预设 A 仍使用未接入的宝可梦效果，因此不能正式对战。
    const deck = releasePreset('A');
    expect(deck.cards.length).toBeGreaterThan(0);
    expect(release.content.cards.some((card) => !card.flags.effectSupported)).toBe(true);
  });
});
