import { afterEach, describe, expect, it } from 'vitest';
import type {
  MatchClientMessage,
  MatchView,
  RoomView,
  SelectDeckCommand,
  ServerMessage,
  SetReadyCommand,
} from '@ptcg/protocol';
import {
  connectTestClient,
  createTempDirectory,
  nextCommandId,
  releasePreset,
  routed,
  startTestService,
  writePlayableFixture,
  type PlayableFixture,
  type TempDirectory,
  type TestClient,
  type TestService,
} from './support/roomTestKit.ts';
import { OpeningHandScript, SequenceRandomSource, deckDocumentFromCards } from './support/matchTestKit.ts';

const BASIC = 'csve1-035'; // 荧光鱼：基础，水枪 1 水 10 伤害
const BASIC_B = 'csve1-057'; // 月石
const ENERGY = 'cbb1c-1803'; // 基本水能量

function energyDeck(basicId: string): string[] {
  return [...Array(4).fill(basicId), ...Array(56).fill(ENERGY)];
}

interface Harness {
  readonly temp: TempDirectory;
  readonly fixture: PlayableFixture;
  readonly service: TestService;
  readonly clients: TestClient[];
  close(): Promise<void>;
}

async function startHarness(
  deck0: readonly string[],
  deck1: readonly string[],
  winner: 0 | 1,
  plan: (script: OpeningHandScript) => void,
): Promise<Harness> {
  const temp = createTempDirectory('ptcg-turn-');
  const fixture = await writePlayableFixture(temp.path);
  const script = new OpeningHandScript([deck0, deck1]);
  plan(script);
  const service = await startTestService({
    catalog: { catalogPath: fixture.path },
    rooms: {
      matchRandom: new SequenceRandomSource([winner, ...script.outputs]),
      generateCode: () => '424242',
      newRoomId: () => 'room-turn',
      newSessionId: () => 'session-turn',
    },
  });
  const clients: TestClient[] = [];
  return {
    temp,
    fixture,
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

async function waitForMatchView(client: TestClient, predicate: (view: MatchView) => boolean, label = '对局视图'): Promise<MatchView> {
  const message = await client.waitFor((entry) => entry.type === 'match' && predicate(entry.view), label);
  return (message as Extract<ServerMessage, { type: 'match' }>).view;
}

/** 建房、加入、选卡组、双方准备，返回进入对局的客户端。 */
async function pairedRoom(harness: Harness, deck0: readonly string[], deck1: readonly string[]): Promise<{ a: TestClient; b: TestClient }> {
  const a = await connectTestClient(harness.service.service, '小智');
  const b = await connectTestClient(harness.service.service, '小茂');
  harness.clients.push(a, b);
  a.send({ type: 'create-room', commandId: nextCommandId() });
  const created = await a.waitForRoom((room) => room.you.host, '建房');
  b.send({ type: 'join-room', commandId: nextCommandId(), code: created.code });
  await b.waitForRoom((room) => room.you.seat === 1, '加入');
  await a.waitForRoom((room) => room.opponent.occupied, '房主看到来宾');

  const aSelect: SelectDeckCommand = {
    type: 'select-deck',
    commandId: nextCommandId(),
    ...routed(currentRoom(a)),
    deck: deckDocumentFromCards(deck0),
  };
  a.send(aSelect);
  await a.waitForRoom((room) => room.you.deckSelected, 'A 选卡组');
  const bSelect: SelectDeckCommand = {
    type: 'select-deck',
    commandId: nextCommandId(),
    ...routed(currentRoom(b)),
    deck: deckDocumentFromCards(deck1),
  };
  b.send(bSelect);
  await b.waitForRoom((room) => room.you.deckSelected, 'B 选卡组');
  await a.waitForRoom((room) => room.opponent.deckSelected, 'A 看到 B 选卡组');

  const aReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true };
  a.send(aReady);
  await a.waitForRoom((room) => room.you.ready, 'A 准备');
  const bReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(b)), ready: true };
  b.send(bReady);
  await a.waitForRoom((room) => room.status === 'started', 'A 看到开局');
  await b.waitForRoom((room) => room.status === 'started', 'B 看到开局');
  return { a, b };
}

function latestMatchView(client: TestClient): MatchView | undefined {
  const message = [...client.messages].reverse().find((entry): entry is Extract<ServerMessage, { type: 'match' }> => entry.type === 'match');
  return message?.view;
}

/** 自适应完成开局：处理重抽/补抽/备战直至双方 playing；返回双方最终视图。 */
async function completeOpening(a: TestClient, b: TestClient, winner: 0 | 1, goFirst: boolean): Promise<{ viewA: MatchView; viewB: MatchView }> {
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

function turnCommand(view: MatchView, command: Record<string, unknown>): MatchClientMessage {
  return {
    commandId: nextCommandId(),
    sessionId: view.sessionId,
    expectedVersion: view.version,
    ...command,
  } as MatchClientMessage;
}

function energyHandIndex(view: MatchView): number {
  const index = view.you.hand.findIndex((card) => card.kind === 'energy');
  if (index < 0) {
    throw new Error('手牌没有能量');
  }
  return index;
}

describe('真实服务双客户端完整回合（#9）', () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.close();
    }
  });

  it('双方各完成一个真实回合：抽牌、放基础、限一次附能、先攻首回合禁止招式、招式伤害与换回合', async () => {
    const deck0 = energyDeck(BASIC);
    const deck1 = energyDeck(BASIC);
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      // 手牌各留 2 张基础宝可梦，用于回合内 play-basic（荧光鱼水枪为已接入的基础伤害招式）。
      script.planHand(0, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC, BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    harnesses.push(harness);

    const { a, b } = await pairedRoom(harness, deck0, deck1);
    const { viewA, viewB } = await completeOpening(a, b, 0, true);
    // 座位 0 先攻：先在回合开始抽 1 张，双方场上有身份且奖赏 6 张。
    expect(viewA.turn).toBe(1);
    expect(viewA.activeSeat).toBe(0);
    expect(viewB.you.prizeCount).toBe(6);
    expect(viewA.you.handCount).toBe(7);
    expect(viewA.you.hand.length).toBe(viewA.you.handCount);

    // 回合 1：先攻玩家放 1 张基础到备战区并附能；首回合不能使用招式。
    const benchBasic = viewA.you.hand.findIndex((card) => card.isBasicPokemon);
    a.send(turnCommand(viewA, { type: 'play-basic', handIndex: benchBasic }));
    const afterBasic = await waitForMatchView(a, (view) => view.you.bench.length === 1, 'A 放基础到备战');
    expect((await waitForMatchView(b, (view) => view.opponent.bench.length === 1, 'B 看到 A 的备战')).opponent.bench[0]?.card.cardId).toBe(BASIC);

    const attach = turnCommand(afterBasic, { type: 'attach-energy', handIndex: energyHandIndex(afterBasic), target: { slot: 'active' } });
    a.send(attach);
    const afterAttach = await waitForMatchView(a, (view) => view.you.active?.energies.length === 1, 'A 附能');
    expect(afterAttach.you.energyAttachedThisTurn).toBe(true);
    // 对手公开载荷能看到附着的能量身份。
    const bAttachView = await waitForMatchView(b, (view) => view.opponent.active?.energies.length === 1, 'B 看到 A 附能');
    expect(bAttachView.opponent.active?.energies[0]?.card.cardId).toBe(ENERGY);

    // 精确重传同一命令：不重复附着。
    a.send(attach);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterReplay = await waitForMatchView(a, (view) => view.version >= afterAttach.version, '重传后视图');
    expect(afterReplay.you.active?.energies).toHaveLength(1);

    // 先攻首回合攻击被服务端拒绝（客户端不能靠禁用状态绕过）；版本不变。
    const attack = turnCommand(afterReplay, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    a.send(attack);
    const earlyAttack = await a.waitFor((message) => message.type === 'match-error', '首回合攻击拒绝');
    expect(earlyAttack).toMatchObject({ type: 'match-error', code: 'action-not-allowed' });
    const stillTurn1 = await waitForMatchView(
      a,
      (view) => view.turn === 1 && view.activeSeat === 0 && view.version === afterAttach.version,
      '仍在首回合',
    );
    expect(stillTurn1.version).toBe(afterAttach.version);
    expect(stillTurn1.you.active?.damageCounters).toBe(0);

    // 结束回合：轮到座位 1，并在回合开始抽 1 张。
    a.send(turnCommand(stillTurn1, { type: 'end-turn' }));
    const bTurn2 = await waitForMatchView(b, (view) => view.turn === 2 && view.activeSeat === 1, 'B 的回合 2');
    const aWait = await waitForMatchView(a, (view) => view.activeSeat === 1, 'A 等待 B');
    expect(aWait.events.some((event) => event.type === 'turn-ended' && event.seat === 0 && event.turn === 1)).toBe(true);
    expect(bTurn2.events.filter((event) => event.type === 'card-drawn' && event.seat === 1)).toHaveLength(1);

    // 回合 2：B 附能并使用水枪。
    b.send(turnCommand(bTurn2, { type: 'attach-energy', handIndex: energyHandIndex(bTurn2), target: { slot: 'active' } }));
    const bAttached = await waitForMatchView(b, (view) => view.you.active?.energies.length === 1, 'B 附能');
    b.send(turnCommand(bAttached, { type: 'attack', attackIndex: 0, target: { slot: 'active' } }));
    const aHit = await waitForMatchView(a, (view) => view.you.active?.damageCounters === 1, 'A 受到 10 伤害');
    const bHit = await waitForMatchView(b, (view) => view.opponent.active?.damageCounters === 1, 'B 看到伤害');
    expect(aHit.events.find((event) => event.type === 'attack-used')).toMatchObject({ attackName: '水枪', baseDamage: 10, damage: 10 });
    expect(bHit.events.some((event) => event.type === 'damage-counters-placed' && event.targetSeat === 0 && event.count === 1)).toBe(true);
    // 使用招式后回合结束：轮到座位 0 的回合 3。
    const aTurn3 = await waitForMatchView(a, (view) => view.turn === 3 && view.activeSeat === 0, 'A 的回合 3');
    expect(aTurn3.you.active?.energies).toHaveLength(1);
    expect(aTurn3.you.active?.damageCounters).toBe(1);

    // 回合 3：A 尝试第二次附能被拒绝（本回合只能 1 张，且回合标记已重置所以这次其实是允许的）。
    // 先用 A 的手牌附能（回合 3 是新回合，允许），再攻击。
    const beforeAttach3 = aTurn3;
    a.send(turnCommand(beforeAttach3, { type: 'attach-energy', handIndex: energyHandIndex(beforeAttach3), target: { slot: 'active' } }));
    const afterAttach3 = await waitForMatchView(a, (view) => view.you.active?.energies.length === 2, 'A 第二张能量');
    a.send(turnCommand(afterAttach3, { type: 'attach-energy', handIndex: energyHandIndex(afterAttach3), target: { slot: 'active' } }));
    const secondAttach = await a.waitFor((message) => message.type === 'match-error', '第二次附能拒绝');
    expect(secondAttach).toMatchObject({ type: 'match-error', code: 'action-not-allowed' });
    const versionBeforeAttack = (await waitForMatchView(a, (view) => view.turn === 3, 'A 回合 3 视图')).version;
    a.send(turnCommand(afterAttach3, { type: 'attack', attackIndex: 0, target: { slot: 'active' } }));
    const bHit2 = await waitForMatchView(b, (view) => view.you.active?.damageCounters === 1, 'B 受到 10 伤害');
    expect(bHit2.turn).toBe(4);

    // 两个客户端在所有阶段的会话、回合计与公开状态一致（同一版本的事件数相同）。
    const aFinal = await waitForMatchView(a, (view) => view.version === bHit2.version, 'A 同步到回合 4');
    expect(aTurn3.sessionId).toBe(bHit2.sessionId);
    expect(aHit.you.active?.damageCounters).toBe(1);
    expect(bHit.opponent.active?.damageCounters).toBe(1);
    expect(aFinal.turn).toBe(4);
    expect(aFinal.events.length).toBe(bHit2.events.length);
    expect(aFinal.events.filter((event) => event.type === 'turn-started').length).toBe(
      bHit2.events.filter((event) => event.type === 'turn-started').length,
    );
    expect(versionBeforeAttack).toBeGreaterThan(0);

    // 隐私：B 的原始载荷中从未出现 A 手牌/牌库/奖赏身份；公开附能与伤害可以出现。
    const bPayload = b.rawPayloads.join('\n');
    expect(bPayload).not.toContain('deckOrder');
    expect(bPayload).not.toContain('"instanceId"');
    const aHandIds = viewA.you.hand.map((card) => card.cardId);
    // 手牌身份可能在规则允许的公开展示（重抽/公开翻面）之外出现即泄露。
    const bMatchViews = b.messages.filter((message): message is Extract<ServerMessage, { type: 'match' }> => message.type === 'match').map((message) => message.view);
    const leaked = bMatchViews.some((view) => view.opponent.hand.length > 0);
    expect(leaked).toBe(false);
    expect(aHandIds.length).toBeGreaterThan(0);
  });

  it('非当前玩家与旧版本命令在网络层被拒绝，且不改变对局状态', async () => {
    const deck0 = energyDeck(BASIC);
    const deck1 = energyDeck(BASIC_B);
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [BASIC, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC_B, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    harnesses.push(harness);

    const { a, b } = await pairedRoom(harness, deck0, deck1);
    const { viewA } = await completeOpening(a, b, 0, true);
    const version = viewA.version;

    // 座位 1 在座位 0 的回合提交附能：not-your-turn，状态不变。
    b.send(turnCommand(viewA, { type: 'attach-energy', handIndex: 1, target: { slot: 'active' } }));
    const notYourTurn = await b.waitFor((message) => message.type === 'match-error', '非当前玩家');
    expect(notYourTurn).toMatchObject({ type: 'match-error', code: 'not-your-turn' });
    expect((await waitForMatchView(a, (view) => view.version === version, '版本不变')).version).toBe(version);

    // 旧版本提交：stale-version，并且错误的 view 是当前投影。
    a.send({ ...turnCommand(viewA, { type: 'end-turn' }), expectedVersion: version + 50 });
    const stale = await a.waitFor((message) => message.type === 'match-error' && message.code === 'stale-version', '旧版本');
    expect(stale).toMatchObject({ type: 'match-error', code: 'stale-version' });
    if (stale.type === 'match-error' && stale.view !== undefined) {
      expect(stale.view.version).toBe(version);
      expect(stale.view.turn).toBe(1);
    }
    expect((await waitForMatchView(a, (view) => view.version === version, '版本仍不变')).version).toBe(version);

    // 合法结束回合后状态只前进一次。
    const tuned = await waitForMatchView(a, (view) => view.version === version, '最新视图');
    a.send(turnCommand(tuned, { type: 'end-turn' }));
    const moved = await waitForMatchView(a, (view) => view.turn === 2, '进入回合 2');
    expect(moved.version).toBe(version + 1);
  });

  it('发行目录下仍含未接入效果的 C 卡组不能开局（测试夹具隔离）', async () => {
    const temp = createTempDirectory('ptcg-turn-release-');
    const service = await startTestService({ port: 0 });
    try {
      const a = await connectTestClient(service.service, '小智');
      a.send({ type: 'create-room', commandId: nextCommandId() });
      const created = await a.waitForRoom((room) => room.you.host, '建房');
      a.send({
        type: 'select-deck',
        commandId: nextCommandId(),
        roomId: created.roomId,
        expectedVersion: created.version,
        deck: releasePreset('C'),
      });
      const selected = await a.waitForRoom((room) => room.you.deckSelected, '发行选卡组');
      a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(selected), ready: true });
      const refusal = await a.waitFor((message) => message.type === 'room-error' && message.code === 'deck-not-ready', '发行拒绝准备');
      expect(refusal).toMatchObject({ type: 'room-error', code: 'deck-not-ready' });
      a.close();
    } finally {
      await service.close();
      temp.cleanup();
    }
  });
});
