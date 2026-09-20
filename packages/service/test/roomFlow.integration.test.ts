import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@ptcg/protocol';
import { createRoomRegistry, type RoomConnection } from '../src/rooms.ts';
import {
  connectTestClient,
  createTempDirectory,
  loadReleaseCatalog,
  nextCommandId,
  releasePreset,
  startTestService,
  writePlayableFixture,
  type PlayableFixture,
  type TempDirectory,
  type TestClient,
  type TestService,
} from './support/roomTestKit.ts';

describe('房间注册表（单元）', () => {
  function setup(options: { codes: string[]; now?: () => number }) {
    const outbox: Array<{ connectionId: string; message: unknown }> = [];
    let index = 0;
    const registry = createRoomRegistry({
      now: options.now ?? (() => 1_000),
      generateCode: () => options.codes[Math.min(index++, options.codes.length - 1)] as string,
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
      catalog: () => null,
      channel: { send: (_id, message) => outbox.push(message) },
    });
    registry.createRoom({ connectionId: 'a', deviceId: 'dev_a', nickname: '小智' });
    const room = outbox.find((message) => (message as { type?: string }).type === 'room') as { room: { code: string } };
    expect(room.room.code).toMatch(/^[0-9]{6}$/u);
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

  async function client(nickname: string): Promise<TestClient> {
    const connected = await connectTestClient(harness.service, nickname);
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

  it('建房返回 6 位房间码；重复建房回到同一房间而不是再建一间', async () => {
    const a = await client('小智');
    a.send({ type: 'create-room', commandId: nextCommandId() });
    const first = await a.waitForRoom((room) => room.status === 'waiting', '建房快照');
    expect(first.code).toMatch(/^[0-9]{6}$/u);
    expect(first.you).toMatchObject({ seat: 0, host: true, occupied: true, ready: false, deck: null });
    expect(first.opponent).toMatchObject({ seat: 1, occupied: false, deck: null });
    expect(first.match).toBeNull();

    a.send({ type: 'create-room', commandId: nextCommandId() });
    await a.waitForNextRoom((room) => room.code === first.code, '重复建房快照');
    const createdLogs = harness.logs.filter((line) => line.includes('room.created'));
    expect(createdLogs).toHaveLength(1);
  });

  it('第二人加入占座；第三人被明确拒绝且载荷中没有房间/对手状态', async () => {
    const { a, b, code } = await givenWaitingRoom();
    const aView = a.messages.filter((message) => message.type === 'room').at(-1) as Extract<ServerMessage, { type: 'room' }>;
    expect(aView.room.opponent).toMatchObject({ seat: 1, occupied: true, nickname: '小茂', ready: false, deck: null });

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
    a.send({ type: 'leave-room', commandId: nextCommandId() });
    expect(await a.waitFor((message) => message.type === 'room-left', '房主离开结果')).toMatchObject({
      type: 'room-left',
      code,
      reason: 'host-left',
    });
    expect(await b.waitFor((message) => message.type === 'room-closed', '来宾收到关闭')).toMatchObject({
      type: 'room-closed',
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
    b.send({ type: 'leave-room', commandId: nextCommandId() });
    expect(await b.waitFor((message) => message.type === 'room-left', '来宾离开结果')).toMatchObject({
      type: 'room-left',
      code,
      reason: 'left',
    });
    await a.waitForRoom((room) => room.code === code && room.opponent.occupied === false, '座位释放');

    b.send({ type: 'join-room', commandId: nextCommandId(), code });
    const rejoined = await b.waitForRoom((room) => room.code === code && room.you.seat === 1, '重新加入');
    expect(rejoined.opponent.host).toBe(true);
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

    a.send({ type: 'select-deck', commandId: nextCommandId(), deck: releasePreset('A') });
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

    a.send({ type: 'set-ready', commandId: nextCommandId(), ready: true });
    const ready = await a.waitForRoom((room) => room.you.ready, '准备成功');
    expect(ready.you.ready).toBe(true);
    expect(ready.you.deck?.validation.dataRevision).toBe(fixture.content.dataRevision.sourceDigest);
    await b.waitForRoom((room) => room.opponent.ready, '对手看到已准备');

    // 换一副卡组：立即撤销准备，对手看到 ready=false。
    a.send({ type: 'select-deck', commandId: nextCommandId(), deck: releasePreset('B') });
    const changed = await a.waitForRoom((room) => room.you.ready === false && room.you.deckSelected, '换卡组撤销准备');
    expect(changed.you.ready).toBe(false);
    await b.waitForRoom((room) => room.opponent.ready === false && room.opponent.deckSelected, '对手看到准备被撤销');

    const readyLogs = harness.logs.filter((line) => line.includes('room.ready'));
    expect(readyLogs.some((line) => line.includes(fixture.catalogVersion))).toBe(true);
  });

  it('未准备完整卡组不能开局；非法构筑由服务端给出具体问题', async () => {
    const { a } = await givenWaitingRoom();
    a.send({ type: 'set-ready', commandId: nextCommandId(), ready: true });
    expect(await a.waitFor((message) => message.type === 'room-error', '未选卡组错误')).toMatchObject({
      code: 'deck-required',
    });

    a.send({
      type: 'select-deck',
      commandId: nextCommandId(),
      deck: { formatVersion: 1, environmentId: fixture.content.environment.id, cards: [] },
    });
    const selected = await a.waitForRoom((room) => room.you.deckSelected, '空卡组快照');
    expect(selected.you.deck?.validation.legal).toBe(false);
    expect(selected.you.deck?.validation.problems.some((problem) => problem.code === 'deck-size')).toBe(true);

    a.send({ type: 'set-ready', commandId: nextCommandId(), ready: true });
    const refusal = await a.waitFor((message) => message.type === 'room-error' && message.code === 'deck-not-ready', '未就绪拒绝');
    expect(refusal).toMatchObject({ type: 'room-error', code: 'deck-not-ready' });
  });

  it('双方准备只建立一次对局：并发准备与命令重传得到同一会话与初始版本', async () => {
    const { a, b } = await givenWaitingRoom();

    a.send({ type: 'select-deck', commandId: nextCommandId(), deck: releasePreset('A') });
    b.send({ type: 'select-deck', commandId: nextCommandId(), deck: releasePreset('C') });
    await a.waitForRoom((room) => room.you.deckSelected, 'A 已选卡组');
    await b.waitForRoom((room) => room.you.deckSelected, 'B 已选卡组');

    // “并发”准备：两条命令不等待对方结果直接发出，服务端按对局顺序串行处理。
    const aReadyCommand = nextCommandId();
    const bReadyCommand = nextCommandId();
    a.send({ type: 'set-ready', commandId: aReadyCommand, ready: true });
    b.send({ type: 'set-ready', commandId: bReadyCommand, ready: true });

    const aStarted = await a.waitForRoom((room) => room.status === 'started', 'A 开局');
    const bStarted = await b.waitForRoom((room) => room.status === 'started', 'B 开局');
    expect(aStarted.match).not.toBeNull();
    expect(bStarted.match).not.toBeNull();
    expect(aStarted.match?.sessionId).toBe(bStarted.match?.sessionId);
    expect(aStarted.match?.version).toBe(1);
    expect(bStarted.match?.version).toBe(1);

    // 重传同一命令 ID：返回同一会话与版本，不建立第二场对局。
    b.send({ type: 'set-ready', commandId: bReadyCommand, ready: true });
    const replay = await b.waitForRoom(
      (room) => room.status === 'started' && room.match?.sessionId === bStarted.match?.sessionId,
      '重传返回原会话',
    );
    expect(replay.match?.version).toBe(1);
    expect(harness.logs.filter((line) => line.includes('room.match_created'))).toHaveLength(1);

    // 对局建立后不能换卡组或取消准备。
    a.send({ type: 'select-deck', commandId: nextCommandId(), deck: releasePreset('D') });
    expect(await a.waitFor((message) => message.type === 'room-error' && message.code === 'match-started', '开局后换卡组')).toMatchObject(
      { code: 'match-started' },
    );
    a.send({ type: 'set-ready', commandId: nextCommandId(), ready: false });
    expect(await a.waitFor((message) => message.type === 'room-error' && message.code === 'match-started', '开局后取消准备')).toMatchObject(
      { code: 'match-started' },
    );

    // 连接重传：A 断开后以同一身份重连，重放同一命令 ID，仍返回原会话。
    a.close();
    const a2 = await connectTestClient(harness.service, '小智', a.identity);
    clients.push(a2);
    a2.send({ type: 'join-room', commandId: nextCommandId(), code: aStarted.code });
    await a2.waitForRoom((room) => room.status === 'started' && room.match?.sessionId === aStarted.match?.sessionId, '重连恢复');
    a2.send({ type: 'set-ready', commandId: aReadyCommand, ready: true });
    const replayedAfterReconnect = await a2.waitForRoom(
      (room) => room.match?.sessionId === aStarted.match?.sessionId && room.version >= aStarted.version,
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
      deck: { ...deckA, cards: [...deckA.cards, { cardId: probeId, printIdentity: 'print:X:0', effectIdentity: 'fx:x', count: 1 }] },
    });
    const probeView = await a.waitForRoom((room) => room.you.deckSelected && room.you.deck !== null, '探针卡组快照');
    expect(probeView.you.deck?.validation.problems.some((problem) => problem.cardIds.includes(probeId))).toBe(true);
    expect(a.rawPayloads.join('\n')).toContain(probeId);
    await b.waitForRoom((room) => room.opponent.deckSelected, '对手看到已选卡组');
    expect(b.rawPayloads.join('\n')).not.toContain(probeId);

    // 正式准备与开局：B 的载荷仍然没有任何 A 的卡号。
    a.send({ type: 'select-deck', commandId: nextCommandId(), deck: deckA });
    await a.waitForRoom((room) => room.you.deck?.validation.ready === true, 'A 卡组就绪');
    a.send({ type: 'set-ready', commandId: nextCommandId(), ready: true });
    await a.waitForRoom((room) => room.you.ready, 'A 已准备');

    b.send({ type: 'select-deck', commandId: nextCommandId(), deck: releasePreset('B') });
    await b.waitForRoom((room) => room.you.deckSelected, 'B 已选卡组');
    b.send({ type: 'set-ready', commandId: nextCommandId(), ready: true });
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
    a.send({ type: 'select-deck', commandId: nextCommandId(), deck: releasePreset('A') });
    b.send({ type: 'select-deck', commandId: nextCommandId(), deck: releasePreset('B') });
    await a.waitForRoom((room) => room.you.deckSelected, 'A 已选卡组');
    await b.waitForRoom((room) => room.you.deckSelected, 'B 已选卡组');
    a.send({ type: 'set-ready', commandId: nextCommandId(), ready: true });
    await a.waitForRoom((room) => room.you.ready, 'A 已准备');
    b.send({ type: 'set-ready', commandId: nextCommandId(), ready: true });
    const started = await b.waitForRoom((room) => room.status === 'started', '对局建立');

    a.send({ type: 'leave-room', commandId: nextCommandId() });
    expect(await a.waitFor((message) => message.type === 'room-left', '开局后离开结果')).toMatchObject({
      type: 'room-left',
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
    a.send({ type: 'join-room', commandId: nextCommandId(), code });
    const rejoined = await a.waitForRoom(
      (room) => room.status === 'started' && room.match?.sessionId === started.match?.sessionId,
      '重入原会话',
    );
    expect(rejoined.you.seat).toBe(0);
    expect(rejoined.match?.version).toBe(1);
    await b.waitForRoom((room) => room.opponent.online === true, '对手恢复在线');
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

describe('发行目录保持全部未就绪', () => {
  it('发行目录没有一张牌标记为效果已接入，预设仍不能准备', () => {
    const release = loadReleaseCatalog();
    expect(release.content.supportPolicy.playable).toBe(false);
    expect(release.content.cards.every((card) => card.flags.effectSupported === false)).toBe(true);
    const deck = releasePreset('A');
    expect(deck.cards.length).toBeGreaterThan(0);
  });
});
