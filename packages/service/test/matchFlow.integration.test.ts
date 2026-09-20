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
import {
  OpeningHandScript,
  SequenceRandomSource,
  countBasicPokemon,
  deckDocumentFromCards,
} from './support/matchTestKit.ts';

const BASIC0 = 'csve1-035'; // 荧光鱼
const BASIC1 = 'csve1-057'; // 月石
const TRAINER_A = 'csve1-138'; // 珠贝
const TRAINER_A2 = 'csve1-143'; // 营火专家
const TRAINER_B = 'csve1-127'; // 一击卷轴 愤怒之卷
const ENERGY = 'cbb1c-1803'; // 基本水能量

function energyDeck(basicId: string, trainerIds: readonly string[] = []): string[] {
  const basics = [...Array(4).fill(basicId)];
  const trainers = trainerIds.flatMap((id) => [...Array(4).fill(id)]);
  return [...basics, ...trainers, ...Array(60 - basics.length - trainers.length).fill(ENERGY)];
}

interface Harness {
  readonly temp: TempDirectory;
  readonly fixture: PlayableFixture;
  readonly harness: TestService;
  readonly script: OpeningHandScript;
  readonly clients: TestClient[];
  close(): Promise<void>;
}

async function startOpeningHarness(
  deck0Cards: readonly string[],
  deck1Cards: readonly string[],
  winner: 0 | 1,
  plan: (script: OpeningHandScript) => void,
): Promise<Harness> {
  const temp = createTempDirectory('ptcg-opening-');
  const fixture = await writePlayableFixture(temp.path);
  const script = new OpeningHandScript([deck0Cards, deck1Cards]);
  plan(script);
  const outputs = [winner, ...script.outputs];
  const harness = await startTestService({
    catalog: { catalogPath: fixture.path },
    rooms: {
      matchRandom: new SequenceRandomSource(outputs),
      generateCode: () => '424242',
      newRoomId: () => 'room-opening',
      newSessionId: () => 'session-opening',
    },
  });
  const clients: TestClient[] = [];
  return {
    temp,
    fixture,
    harness,
    script,
    clients,
    async close() {
      for (const client of clients.splice(0)) {
        client.close();
      }
      await harness.close();
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

async function givenStated(harness: Harness, deck0: string[], deck1: string[]): Promise<{ a: TestClient; b: TestClient; room: RoomView }> {
  const a = await connectTestClient(harness.harness.service, '小智');
  const b = await connectTestClient(harness.harness.service, '小茂');
  harness.clients.push(a, b);
  a.send({ type: 'create-room', commandId: nextCommandId() });
  const created = await a.waitForRoom((room) => room.you.host, '建房快照');
  b.send({ type: 'join-room', commandId: nextCommandId(), code: created.code });
  await b.waitForRoom((room) => room.you.seat === 1, '来宾加入');
  await a.waitForRoom((room) => room.opponent.occupied, '房主看到来宾');

  const aDeckCommand: SelectDeckCommand = {
    type: 'select-deck',
    commandId: nextCommandId(),
    ...routed(currentRoom(a)),
    deck: deckDocumentFromCards(deck0),
  };
  a.send(aDeckCommand);
  await a.waitForRoom((room) => room.you.deckSelected, 'A 选卡组');
  const bDeckCommand: SelectDeckCommand = {
    type: 'select-deck',
    commandId: nextCommandId(),
    ...routed(currentRoom(b)),
    deck: deckDocumentFromCards(deck1),
  };
  b.send(bDeckCommand);
  await b.waitForRoom((room) => room.you.deckSelected, 'B 选卡组');
  await a.waitForRoom((room) => room.opponent.deckSelected, 'A 看到 B 选卡组');

  const aReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true };
  a.send(aReady);
  await a.waitForRoom((room) => room.you.ready, 'A 准备');
  const bReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(b)), ready: true };
  b.send(bReady);
  const started = await b.waitForRoom((room) => room.status === 'started', '唯一对局建立');
  await a.waitForRoom((room) => room.status === 'started', 'A 看到开局');
  return { a, b, room: started };
}

describe('真实服务双客户端开局（#8）', () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.close();
    }
  });

  it('正常开局：双方看到同一会话、唯一首回合与合法公开记录；对手载荷不含手牌/奖牌身份', async () => {
    const deck0 = energyDeck(BASIC0, [TRAINER_A, TRAINER_A2]);
    const deck1 = energyDeck(BASIC1, [TRAINER_B]);
    const harness = await startOpeningHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [BASIC0, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [TRAINER_A, TRAINER_A, TRAINER_A2, TRAINER_A2, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC1, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [TRAINER_B, TRAINER_B, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    harnesses.push(harness);

    const { a, b } = await givenStated(harness, deck0, deck1);
    const aTurn = await waitForMatchView(a, (view) => view.phase === 'turn-order', 'A 收到开局');
    const bTurn = await waitForMatchView(b, (view) => view.phase === 'turn-order', 'B 收到开局');
    expect(aTurn.sessionId).toBe('session-opening');
    expect(bTurn.sessionId).toBe('session-opening');
    expect(aTurn.you.seat).toBe(0);
    expect(bTurn.you.seat).toBe(1);
    expect(aTurn.pendingChoice?.kind).toBe('turn-order');
    expect(bTurn.pendingChoice).toBeNull();
    expect(bTurn.waitingForOpponentChoice).toBe(true);
    // 选择先后攻发生在发牌之前：此时双方手牌都还没有内容。
    expect(aTurn.opponent.hand).toHaveLength(0);
    expect(aTurn.opponent.handCount).toBe(0);

    a.send({
      type: 'choose-turn-order',
      commandId: nextCommandId(),
      sessionId: aTurn.sessionId,
      expectedVersion: aTurn.version,
      choiceId: aTurn.pendingChoice?.choiceId ?? '',
      goFirst: true,
    });
    const aSetup = await waitForMatchView(a, (view) => view.phase === 'setup' && view.pendingChoice !== null, 'A 进入盖放');
    const bSetup = await waitForMatchView(b, (view) => view.phase === 'setup', 'B 等待盖放');
    // 发牌后对手手牌只有张数，没有任何身份。
    expect(aSetup.you.hand).toHaveLength(7);
    expect(bSetup.opponent.hand).toHaveLength(0);
    expect(bSetup.opponent.handCount).toBe(7);

    // 双方盖放：A 先，B 后。
    a.send({
      type: 'place-setup',
      commandId: nextCommandId(),
      sessionId: aSetup.sessionId,
      expectedVersion: aSetup.version,
      choiceId: aSetup.pendingChoice?.choiceId ?? '',
      active: 0,
      bench: [],
    });
    const bPlace = await waitForMatchView(b, (view) => view.pendingChoice?.kind === 'place-setup', 'B 可以盖放');
    b.send({
      type: 'place-setup',
      commandId: nextCommandId(),
      sessionId: bPlace.sessionId,
      expectedVersion: bPlace.version,
      choiceId: bPlace.pendingChoice?.choiceId ?? '',
      active: 0,
      bench: [],
    });

    const aPlaying = await waitForMatchView(a, (view) => view.phase === 'playing', 'A 进入首回合');
    const bPlaying = await waitForMatchView(b, (view) => view.phase === 'playing', 'B 进入首回合');
    for (const view of [aPlaying, bPlaying]) {
      expect(view.turn).toBe(1);
      expect(view.activeSeat).toBe(0);
      expect(view.you.prizeCount).toBe(6);
      expect(view.opponent.prizeCount).toBe(6);
      expect(view.events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
      expect(view.pendingChoice).toBeNull();
      expect(view.you.active).not.toBeNull();
    }
    // 双方各盖放 1 张；首回合玩家回合开始再抽 1 张。
    expect(aPlaying.you.handCount).toBe(7);
    expect(bPlaying.you.handCount).toBe(6);
    expect(aPlaying.you.deckCount).toBe(60 - 7 - 6 - 1);
    expect(bPlaying.you.deckCount).toBe(60 - 7 - 6);
    expect(aPlaying.you.prizeCount).toBe(6);
    const bPayload = b.rawPayloads.join('\n');
    expect(bPayload).not.toContain(TRAINER_A);
    expect(bPayload).not.toContain(TRAINER_A2);
    expect(bPayload).not.toContain('deckOrder');
    expect(bPlaying.opponent.prizeCount).toBe(6);
  });

  it('单方重抽后对手获得可选补抽：0 张放弃与上限补抽都通过网络契约生效', async () => {
    const deck0 = energyDeck(BASIC0);
    const deck1 = energyDeck(BASIC1);
    const harness = await startOpeningHarness(deck0, deck1, 0, (script) => {
      // 座位 1 第一次没有基础宝可梦，重抽后成功；补抽顶牌为基础宝可梦。
      script.planHand(0, [BASIC0, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(1);
      script.planHand(1, [BASIC1, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    harnesses.push(harness);

    const { a, b } = await givenStated(harness, deck0, deck1);
    const aTurn = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'turn-order', 'A 获选');
    a.send({
      type: 'choose-turn-order',
      commandId: nextCommandId(),
      sessionId: aTurn.sessionId,
      expectedVersion: aTurn.version,
      choiceId: aTurn.pendingChoice?.choiceId ?? '',
      goFirst: true,
    });
    const aSetup = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'place-setup', 'A 盖放');
    expect(await waitForMatchView(a, (view) => view.phase === 'setup', 'A 已发牌')).toMatchObject({});
    a.send({
      type: 'place-setup',
      commandId: nextCommandId(),
      sessionId: aSetup.sessionId,
      expectedVersion: aSetup.version,
      choiceId: aSetup.pendingChoice?.choiceId ?? '',
      active: 0,
      bench: [],
    });
    const bPlace = await waitForMatchView(b, (view) => view.pendingChoice?.kind === 'place-setup', 'B 盖放');
    b.send({
      type: 'place-setup',
      commandId: nextCommandId(),
      sessionId: bPlace.sessionId,
      expectedVersion: bPlace.version,
      choiceId: bPlace.pendingChoice?.choiceId ?? '',
      active: 0,
      bench: [],
    });

    // 座位 0 获得补抽选择：对手（座位 1）重抽了 1 次。
    const aComp = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'compensation-draw', 'A 补抽选择');
    expect(aComp.pendingChoice).toMatchObject({ kind: 'compensation-draw', min: 0, max: 1, seat: 0 });
    expect(aComp.you.mulligans).toBe(0);
    expect(aComp.opponent.mulligans).toBe(1);
    // 选择 0 张放弃：直接进入 playing，且没有补抽备战选择。
    a.send({
      type: 'resolve-compensation',
      commandId: nextCommandId(),
      sessionId: aComp.sessionId,
      expectedVersion: aComp.version,
      choiceId: aComp.pendingChoice?.choiceId ?? '',
      draw: 0,
    });
    const aPlaying = await waitForMatchView(a, (view) => view.phase === 'playing', 'A 放弃后进入首回合');
    expect(aPlaying.events.some((event) => event.type === 'compensation-declared' && event.count === 0)).toBe(true);
    expect(aPlaying.events.some((event) => event.type === 'bench-placed')).toBe(false);
  });

  it('单方重抽（5.b.）：无基础方的手牌在对手完成到 7. 后才公开；补抽到的基础宝可梦可通过网络盖放', async () => {
    const deck0 = energyDeck(BASIC0);
    const deck1 = energyDeck(BASIC1);
    const harness = await startOpeningHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC1, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [BASIC0, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
    });
    harnesses.push(harness);

    const { a, b } = await givenStated(harness, deck0, deck1);
    const aTurn = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'turn-order', 'A 获选');
    a.send({
      type: 'choose-turn-order',
      commandId: nextCommandId(),
      sessionId: aTurn.sessionId,
      expectedVersion: aTurn.version,
      choiceId: aTurn.pendingChoice?.choiceId ?? '',
      goFirst: true,
    });
    // 5.b.：先由有基础宝可梦的座位 1 盖放；此时座位 0 的手牌尚未展示。
    const bPlace = await waitForMatchView(b, (view) => view.pendingChoice?.kind === 'place-setup', 'B 先盖放（5.b.）');
    expect(bPlace.events.some((event) => event.type === 'mulligan')).toBe(false);
    expect(bPlace.opponent.setupPlaced).toBe(false);
    b.send({
      type: 'place-setup',
      commandId: nextCommandId(),
      sessionId: bPlace.sessionId,
      expectedVersion: bPlace.version,
      choiceId: bPlace.pendingChoice?.choiceId ?? '',
      active: 0,
      bench: [],
    });

    // 座位 1 已到 7.（奖赏卡已放）；现在才公开座位 0 手牌并重抽。
    const aSetup = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'place-setup', 'A 重抽后盖放');
    expect(aSetup.events.filter((event) => event.type === 'mulligan')).toHaveLength(1);
    expect(aSetup.you.mulligans).toBe(1);
    expect(aSetup.you.soloMulligans).toBe(1);
    expect(b.rawPayloads.join('\n')).not.toContain('csve1-035');
    a.send({
      type: 'place-setup',
      commandId: nextCommandId(),
      sessionId: aSetup.sessionId,
      expectedVersion: aSetup.version,
      choiceId: aSetup.pendingChoice?.choiceId ?? '',
      active: 0,
      bench: [],
    });

    // 座位 1 因对手单独重抽获得补抽，抽到基础宝可梦并可放入备战区。
    const bComp = await waitForMatchView(b, (view) => view.pendingChoice?.kind === 'compensation-draw', 'B 补抽选择');
    expect(bComp.pendingChoice).toMatchObject({ max: 1 });
    // 奖赏卡已经放置；补抽顶牌为基础宝可梦。
    harness.script.prizes(0);
    harness.script.prizes(1);
    expect(harness.script.topOfDeck(1)).toBe(BASIC1);
    b.send({
      type: 'resolve-compensation',
      commandId: nextCommandId(),
      sessionId: bComp.sessionId,
      expectedVersion: bComp.version,
      choiceId: bComp.pendingChoice?.choiceId ?? '',
      draw: 1,
    });
    harness.script.drawTop(1);
    const bBench = await waitForMatchView(b, (view) => view.pendingChoice?.kind === 'place-bench', 'B 备战选择');
    // 翻面前 A 看不到 B 的盖放身份。
    const aDuring = await waitForMatchView(a, (view) => view.phase === 'compensation', 'A 等待补抽');
    expect(aDuring.opponent.active).toBeNull();
    expect(aDuring.opponent.bench).toHaveLength(0);
    expect(aDuring.opponent.setupPlaced).toBe(true);

    b.send({
      type: 'place-bench',
      commandId: nextCommandId(),
      sessionId: bBench.sessionId,
      expectedVersion: bBench.version,
      choiceId: bBench.pendingChoice?.choiceId ?? '',
      bench: bBench.pendingChoice?.candidates ?? [],
    });
    const aPlaying = await waitForMatchView(a, (view) => view.phase === 'playing', 'A 看到公开翻面');
    expect(aPlaying.opponent.bench.map((entry) => entry.card.cardId)).toContain(BASIC1);
    expect(aPlaying.events.some((event) => event.type === 'bench-placed' && event.count === 1)).toBe(true);
  });

  it('越权、过期版本、旧选择与重复命令在网络层保持状态不变', async () => {
    const deck0 = energyDeck(BASIC0);
    const deck1 = energyDeck(BASIC1);
    const harness = await startOpeningHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [BASIC0, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [BASIC1, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    harnesses.push(harness);

    const { a, b } = await givenStated(harness, deck0, deck1);
    const aTurn = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'turn-order', 'A 获选');
    const bTurn = await waitForMatchView(b, (view) => view.phase === 'turn-order', 'B 等待');

    // B 不能替 A 选择先后攻。
    b.send({
      type: 'choose-turn-order',
      commandId: nextCommandId(),
      sessionId: bTurn.sessionId,
      expectedVersion: bTurn.version,
      choiceId: aTurn.pendingChoice?.choiceId ?? '',
      goFirst: true,
    });
    const notYours = await b.waitFor((message) => message.type === 'match-error', '越权错误');
    expect(notYours).toMatchObject({ type: 'match-error', code: 'not-your-choice' });

    // A 用过期版本提交被拒绝，且状态不变。
    a.send({
      type: 'choose-turn-order',
      commandId: nextCommandId(),
      sessionId: aTurn.sessionId,
      expectedVersion: aTurn.version + 99,
      choiceId: aTurn.pendingChoice?.choiceId ?? '',
      goFirst: true,
    });
    const stale = await a.waitFor((message) => message.type === 'match-error', '过期版本错误');
    expect(stale).toMatchObject({ type: 'match-error', code: 'stale-version' });
    if (stale.type === 'match-error' && stale.view !== undefined) {
      expect(stale.view.phase).toBe('turn-order');
      expect(stale.view.pendingChoice?.kind).toBe('turn-order');
    }

    // 正确提交；随后精确重传返回同一结果（重复不生效）。
    const command: MatchClientMessage = {
      type: 'choose-turn-order',
      commandId: 'a-choose-final',
      sessionId: aTurn.sessionId,
      expectedVersion: aTurn.version,
      choiceId: aTurn.pendingChoice?.choiceId ?? '',
      goFirst: true,
    };
    a.send(command);
    const accepted = await waitForMatchView(a, (view) => view.phase === 'setup', 'A 选择成功');
    a.send(command);
    const replay = await waitForMatchView(a, (view) => view.phase === 'setup' && view.version === accepted.version, '重传返回原结果');
    expect(replay.version).toBe(accepted.version);
    // 同一命令 ID 换载荷被识别为 ID 复用。
    a.send({ ...command, goFirst: false });
    const reused = await a.waitFor((message) => message.type === 'match-error' && message.code === 'command-id-reused', 'ID 复用错误');
    expect(reused).toMatchObject({ type: 'match-error', code: 'command-id-reused' });
    expect(harness.harness.logs.filter((line) => line.includes('room.match_created'))).toHaveLength(1);
  });

  it('双方共同重抽：共同重洗不计 5.d.，补抽上限为 0，最后唯一进入首回合', async () => {
    const deck0 = energyDeck(BASIC0);
    const deck1 = energyDeck(BASIC1);
    const harness = await startOpeningHarness(deck0, deck1, 1, (script) => {
      script.planHand(0, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.planHand(1, [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
      script.returnHand(0);
      script.planHand(0, [BASIC0, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(0);
      script.returnHand(1);
      script.planHand(1, [BASIC1, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY], [ENERGY, ENERGY, ENERGY, ENERGY, ENERGY, ENERGY]);
      script.deal(1);
    });
    harnesses.push(harness);

    const { a, b } = await givenStated(harness, deck0, deck1);
    const bTurn = await waitForMatchView(b, (view) => view.pendingChoice?.kind === 'turn-order', 'B 获选');
    b.send({
      type: 'choose-turn-order',
      commandId: nextCommandId(),
      sessionId: bTurn.sessionId,
      expectedVersion: bTurn.version,
      choiceId: bTurn.pendingChoice?.choiceId ?? '',
      goFirst: true,
    });
    const bSetup = await waitForMatchView(b, (view) => view.pendingChoice?.kind === 'place-setup', 'B 先盖放');
    // 共同重洗是公开记录（shared=true），但不是 5.d.：单独重抽计数为 0。
    expect(bSetup.you.mulligans).toBe(1);
    expect(bSetup.you.soloMulligans).toBe(0);
    expect(bSetup.opponent.soloMulligans).toBe(0);
    expect(bSetup.events.filter((event) => event.type === 'mulligan').every((event) => event.type === 'mulligan' && event.shared)).toBe(true);
    b.send({
      type: 'place-setup',
      commandId: nextCommandId(),
      sessionId: bSetup.sessionId,
      expectedVersion: bSetup.version,
      choiceId: bSetup.pendingChoice?.choiceId ?? '',
      active: 0,
      bench: [],
    });
    const aSetup = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'place-setup', 'A 后盖放');
    expect(aSetup.you.mulligans).toBe(1);
    expect(aSetup.you.soloMulligans).toBe(0);
    a.send({
      type: 'place-setup',
      commandId: nextCommandId(),
      sessionId: aSetup.sessionId,
      expectedVersion: aSetup.version,
      choiceId: aSetup.pendingChoice?.choiceId ?? '',
      active: 0,
      bench: [],
    });

    // 双方都没有执行 5.d.：没有任何补抽选择，直接公开翻面。
    const aPlaying = await waitForMatchView(a, (view) => view.phase === 'playing', 'A 首回合');
    const bPlaying = await waitForMatchView(b, (view) => view.phase === 'playing', 'B 首回合');
    expect(aPlaying.turn).toBe(1);
    expect(aPlaying.activeSeat).toBe(1);
    expect(bPlaying.turn).toBe(1);
    expect(aPlaying.events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
    expect(aPlaying.events.filter((event) => event.type === 'mulligan')).toHaveLength(2);
    expect(aPlaying.events.some((event) => event.type === 'compensation-declared')).toBe(false);
  });

  it('发行目录下的效果未接入卡组无法开局（与 #8 的测试夹具隔离）', async () => {
    const temp = createTempDirectory('ptcg-opening-release-');
    const harness = await startTestService({ port: 0 });
    try {
      const a = await connectTestClient(harness.service, '小智');
      a.send({ type: 'create-room', commandId: nextCommandId() });
      const created = await a.waitForRoom((room) => room.you.host, '建房');
      a.send({
        type: 'select-deck',
        commandId: nextCommandId(),
        roomId: created.roomId,
        expectedVersion: created.version,
        deck: releasePreset('A'),
      });
      const selected = await a.waitForRoom((room) => room.you.deckSelected, '发行选卡组');
      a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(selected), ready: true });
      const refusal = await a.waitFor((message) => message.type === 'room-error' && message.code === 'deck-not-ready', '发行拒绝准备');
      expect(refusal).toMatchObject({ type: 'room-error', code: 'deck-not-ready' });
      a.close();
    } finally {
      await harness.close();
      temp.cleanup();
    }
  });
});

describe('开局公开信息与计数（单元辅助）', () => {
  it('测试夹具的补抽上限统计与基础标记一致', () => {
    expect(countBasicPokemon([BASIC0, ENERGY, ENERGY])).toBe(1);
    expect(countBasicPokemon([BASIC1, BASIC0])).toBe(2);
    expect(countBasicPokemon([ENERGY])).toBe(0);
  });
});
