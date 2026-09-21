import { afterEach, describe, expect, it } from 'vitest';
import type { MatchPendingChoiceView, MatchView, RoomView, SelectDeckCommand, SetReadyCommand } from '@ptcg/protocol';
import {
  connectTestClient,
  createTempDirectory,
  nextCommandId,
  releasePreset,
  routed,
  startTestService,
  type ServerMessage,
  type TempDirectory,
  type TestClient,
  type TestService,
} from './support/roomTestKit.ts';
import { OpeningHandScript, SequenceRandomSource, deckDocumentFromCards } from './support/matchTestKit.ts';

/**
 * T12 / #13 新增效果待决流程的真实 WebSocket 公共边界回归。
 *
 * 本票复用既有命令类型（search-deck / choose-mode / switch-opponent /
 * discard-hand），但新增了对手手牌候选、复制对手招式、攻击后的备战目标、
 * 攻击发起的弃牌与分步检索等流程；这里用真实服务 + 两个真实 WebSocket
 * 客户端逐条走通，确认 `rooms.ts` 分发不落入 room-error 且双方视图一致。
 *
 * 同步策略：每条命令等待携带同一 `commandId` 的直接结果（成功为 match、
 * 失败为 match-error），对手侧只等待全局对局版本追平，避免历史视图误命中。
 */

const MEW = 'csve1-056';
const MOON = 'csve1-057';
const WORM = 'csv3c-095';
const FISH = 'csve1-035';
const CHIEN_PAO = 'csv3c-043';
const KLAARA = 'csv2c-118';
const SERENA = 'csve1-152';
const IRIDA = 'csve1-138';
const POKE_BALL = 'cbb1c-1701';
const COURAGE_CHARM = 'csv1c-118';
const PSY = 'cbb2c-1102';
const WATER = 'cbb1c-1803';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  readonly temp: TempDirectory;
  readonly harness: TestService;
  readonly clients: TestClient[];
  close(): Promise<void>;
}

async function startHarness(
  deck0Cards: readonly string[],
  deck1Cards: readonly string[],
  winner: 0 | 1,
  plan: (script: OpeningHandScript) => void,
): Promise<Harness> {
  const temp = createTempDirectory('ptcg-ab-flow-');
  const script = new OpeningHandScript([deck0Cards, deck1Cards]);
  plan(script);
  const outputs = [winner, ...script.outputs, ...Array.from({ length: 800 }, () => 0)];
  const harness = await startTestService({
    rooms: {
      matchRandom: new SequenceRandomSource(outputs),
      generateCode: () => '626262',
      newRoomId: () => 'room-ab-flow',
      newSessionId: () => 'session-ab-flow',
    },
  });
  const clients: TestClient[] = [];
  return {
    temp,
    harness,
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

function latestView(client: TestClient): MatchView | undefined {
  return client.messages.filter((entry) => entry.type === 'match').at(-1)?.view;
}

async function sendCommand(client: TestClient, view: MatchView, command: Record<string, unknown>): Promise<MatchView> {
  const commandId = nextCommandId();
  client.send({ commandId, sessionId: view.sessionId, expectedVersion: view.version, ...command });
  const message = await client.waitFor(
    (entry) => (entry.type === 'match' || entry.type === 'match-error') && entry.commandId === commandId,
    `命令 ${String(command.type)}`,
  );
  if (message.type === 'match-error') {
    throw new Error(`命令 ${String(command.type)} 失败：${message.code} ${message.message}`);
  }
  return message.view;
}

/** 等待对手视图追平指定全局版本，保证后续对手操作基于最新状态。 */
async function syncOpponent(client: TestClient, version: number): Promise<MatchView> {
  const message = await client.waitFor((entry) => entry.type === 'match' && entry.view.version >= version, '对手同步');
  return (message as Extract<typeof message, { type: 'match' }>).view;
}

async function givenStarted(harness: Harness, deck0: string[], deck1: string[]): Promise<{ a: TestClient; b: TestClient }> {
  const a = await connectTestClient(harness.harness.service, '小智');
  const b = await connectTestClient(harness.harness.service, '小茂');
  harness.clients.push(a, b);
  a.send({ type: 'create-room', commandId: nextCommandId() });
  const created = await a.waitForRoom((room) => room.you.host, '建房快照');
  b.send({ type: 'join-room', commandId: nextCommandId(), code: created.code });
  await b.waitForRoom((room) => room.you.seat === 1, '来宾加入');
  await a.waitForRoom((room) => room.opponent.occupied, '房主看到来宾');

  const aDeck: SelectDeckCommand = { type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(a)), deck: deckDocumentFromCards(deck0) };
  a.send(aDeck);
  await a.waitForRoom((room) => room.you.deckSelected, 'A 选卡组');
  const bDeck: SelectDeckCommand = { type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(b)), deck: deckDocumentFromCards(deck1) };
  b.send(bDeck);
  await b.waitForRoom((room) => room.you.deckSelected, 'B 选卡组');
  await a.waitForRoom((room) => room.opponent.deckSelected, 'A 看到 B 选卡组');

  const aReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true };
  a.send(aReady);
  await a.waitForRoom((room) => room.you.ready, 'A 准备');
  const bReady: SetReadyCommand = { type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(b)), ready: true };
  b.send(bReady);
  await b.waitForRoom((room) => room.status === 'started', '唯一对局建立');
  await a.waitForRoom((room) => room.status === 'started', 'A 看到开局');
  return { a, b };
}

async function completeOpening(a: TestClient, b: TestClient, winnerSeat: 0 | 1, wantFirst: boolean): Promise<{ a: TestClient; b: TestClient }> {
  const clients: readonly [TestClient, TestClient] = [a, b];
  for (let step = 0; step < 120; step += 1) {
    let acted = false;
    for (const seat of [0, 1] as const) {
      const view = latestView(clients[seat]);
      if (view === undefined || view.result !== null || view.phase === 'playing') {
        if (view?.phase === 'playing') {
          return { a, b };
        }
        continue;
      }
      const choice = view.pendingChoice;
      if (choice === null) {
        continue;
      }
      if (choice.kind === 'turn-order') {
        if (seat !== winnerSeat) {
          continue;
        }
        await sendCommand(clients[seat], view, { type: 'choose-turn-order', choiceId: choice.choiceId, goFirst: wantFirst });
      } else if (choice.kind === 'place-setup') {
        const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
        await sendCommand(clients[seat], view, { type: 'place-setup', choiceId: choice.choiceId, active: basics[0] as number, bench: [] });
      } else if (choice.kind === 'compensation-draw') {
        await sendCommand(clients[seat], view, { type: 'resolve-compensation', choiceId: choice.choiceId, draw: 0 });
      } else if (choice.kind === 'place-bench') {
        await sendCommand(clients[seat], view, { type: 'place-bench', choiceId: choice.choiceId, bench: [] });
      } else {
        throw new Error(`未知开局选择 ${choice.kind}`);
      }
      acted = true;
      break;
    }
    if (!acted && (latestView(a)?.phase === 'playing' || latestView(b)?.phase === 'playing')) {
      return { a, b };
    }
    await sleep(10);
  }
  throw new Error('开局流程未完成');
}

async function attachAndMaybeAttack(
  client: TestClient,
  view: MatchView,
  cardId: string,
  options: { readonly attack?: boolean },
): Promise<MatchView> {
  const attached = await sendCommand(client, view, {
    type: 'attach-energy',
    handIndex: view.you.hand.findIndex((card) => card.cardId === cardId),
    target: { slot: 'active' },
  });
  if (options.attack === true) {
    return sendCommand(client, attached, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
  }
  return sendCommand(client, attached, { type: 'end-turn' });
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

describe('#13 新增效果的真实 WebSocket 公共边界', () => {
  it('莉佳的邀请：对手手牌候选只发给使用者，选中后经服务端放置与互换', async () => {
    const deck0 = [...Array(4).fill(FISH), ...Array(4).fill(KLAARA), ...Array(52).fill(PSY)];
    const deck1 = [...Array(4).fill(WORM), ...Array(4).fill(CHIEN_PAO), ...Array(52).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 1, (script) => {
      script.planHand(0, [FISH, KLAARA, PSY, PSY, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [WORM, CHIEN_PAO, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 1, true);
    // 座位 1 先攻第 1 回合直接结束，轮到座位 0 使用支援者。
    const bTurn = await syncOpponent(b, latestView(b)?.version ?? 0);
    await sendCommand(b, bTurn, { type: 'end-turn' });

    const aTurn = await syncOpponent(a, (latestView(b)?.version ?? 0));
    const pendingView = await sendCommand(a, aTurn, {
      type: 'play-trainer',
      handIndex: aTurn.you.hand.findIndex((card) => card.cardId === KLAARA),
    });
    const opponentDuring = await syncOpponent(b, pendingView.version);
    expect(opponentDuring.pendingChoice).toBeNull();
    expect(opponentDuring.waitingForOpponentChoice).toBe(true);
    // 对手载荷不含候选的私人详情字段（候选只出现在选择者视图）。
    expect(JSON.stringify(opponentDuring)).not.toContain('"candidateId"');

    const pending = pendingView.pendingChoice as MatchPendingChoiceView;
    expect(pending.kind).toBe('search-deck');
    expect(pending.source).toBe('opponent-hand');
    const probe = pending.cardCandidates.find((candidate) => candidate.card.cardId === CHIEN_PAO);
    expect(probe).toMatchObject({ selectable: true });
    expect(pending.cardCandidates.find((candidate) => candidate.card.cardId === WATER)).toMatchObject({ selectable: false });
    const after = await sendCommand(a, pendingView, {
      type: 'search-deck',
      choiceId: pending.choiceId,
      candidateIds: [probe?.candidateId as string],
    });
    expect(after.opponent.active?.card.cardId).toBe(CHIEN_PAO);
    expect(after.events.some((event) => event.type === 'bench-switched' && event.targetSeat === 1)).toBe(true);
    const bAfter = await syncOpponent(b, after.version);
    expect(bAfter.you.active?.card.cardId).toBe(CHIEN_PAO);
    expect(bAfter.you.bench.map((pokemon) => pokemon.card.cardId)).toContain(WORM);
  }, 30_000);

  it('基因侵入：choose-mode 列出对手招式并复制水枪，伤害与事件经真实服务', async () => {
    const deck0 = [...Array(4).fill(MEW), ...Array(56).fill(PSY)];
    const deck1 = [...Array(4).fill(FISH), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [MEW, PSY, PSY, PSY, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [FISH, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true);

    // T1/T3/T5 给梦幻ex 附 3 张基本超能量（基因侵入费用[无无无]）。
    let aView = await syncOpponent(a, latestView(a)?.version ?? 0);
    let bView = await syncOpponent(b, aView.version);
    for (let index = 0; index < 2; index += 1) {
      aView = await attachAndMaybeAttack(a, aView, PSY, {});
      bView = await syncOpponent(b, aView.version);
      bView = await sendCommand(b, bView, { type: 'end-turn' });
      aView = await syncOpponent(a, bView.version);
    }
    const chooseView = await attachAndMaybeAttack(a, aView, PSY, { attack: true });
    const choose = chooseView.pendingChoice as MatchPendingChoiceView;
    expect(choose.kind).toBe('choose-mode');
    expect(choose.modes.map((mode) => mode.modeId)).toContain('attack-0');
    expect(choose.modes.find((mode) => mode.modeId === 'attack-0')).toMatchObject({ available: true });
    // 旧 copy-attack 兼容别名（有界）：错误序号被拒绝且视图不变，随后同一别名
    // 成功完成复制——覆盖真实公开命令路径的别名回归。
    a.send({
      type: 'copy-attack',
      commandId: nextCommandId(),
      sessionId: chooseView.sessionId,
      expectedVersion: chooseView.version,
      choiceId: choose.choiceId,
      attackIndex: 5,
    });
    const refused = (await a.waitFor(
      (entry) => entry.type === 'match-error' && entry.code === 'illegal-choice',
      '别名错误序号被拒绝',
    )) as Extract<ServerMessage, { type: 'match-error' }>;
    expect(refused.view?.pendingChoice?.choiceId).toBe(choose.choiceId);
    expect(refused.view?.version).toBe(chooseView.version);
    const after = await sendCommand(a, chooseView, { type: 'copy-attack', choiceId: choose.choiceId, attackIndex: 0 });
    expect(after.opponent.active?.damageCounters).toBe(1);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '水枪',
      baseDamage: 10,
      damage: 10,
    });
    expect(after.activeSeat).toBe(1);
    const bAfter = await syncOpponent(b, after.version);
    expect(bAfter.you.active?.damageCounters).toBe(1);
  }, 45_000);

  it('刺穿：攻击后的备战目标选择经真实服务结算 200+30', async () => {
    const deck0 = [...Array(4).fill(WORM), ...Array(56).fill(PSY)];
    const deck1 = [...Array(4).fill(CHIEN_PAO), ...Array(4).fill(FISH), ...Array(52).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 1, (script) => {
      script.planHand(0, [WORM, PSY, PSY, PSY, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [CHIEN_PAO, FISH, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 1, true);
    // 座位 1 先攻：把荧光鱼放进备战区，作为刺穿的备战目标。
    let bView = await syncOpponent(b, latestView(b)?.version ?? 0);
    bView = await sendCommand(b, bView, {
      type: 'play-basic',
      handIndex: bView.you.hand.findIndex((card) => card.cardId === FISH),
    });
    bView = await sendCommand(b, bView, { type: 'end-turn' });

    let aView = await syncOpponent(a, bView.version);
    for (let index = 0; index < 3; index += 1) {
      aView = await attachAndMaybeAttack(a, aView, PSY, {});
      bView = await syncOpponent(b, aView.version);
      bView = await sendCommand(b, bView, { type: 'end-turn' });
      aView = await syncOpponent(a, bView.version);
    }
    const benchChoiceView = await attachAndMaybeAttack(a, aView, PSY, { attack: true });
    const benchChoice = benchChoiceView.pendingChoice as MatchPendingChoiceView;
    expect(benchChoice.kind).toBe('switch-opponent');
    expect(benchChoice.candidates).toEqual([0]);
    const after = await sendCommand(a, benchChoiceView, {
      type: 'switch-opponent',
      choiceId: benchChoice.choiceId,
      benchIndex: 0,
    });
    expect(after.opponent.active?.damageCounters).toBe(20);
    expect(after.opponent.bench[0]?.damageCounters).toBe(3);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '刺穿',
      baseDamage: 100,
      damage: 200,
    });
    const bAfter = await syncOpponent(b, after.version);
    expect(bAfter.you.active?.damageCounters).toBe(20);
    expect(bAfter.you.bench[0]?.damageCounters).toBe(3);
  }, 45_000);

  it('基因侵入复制立即结算招式后，下一回合莎莉娜弃抽经真实服务不提前结束回合', async () => {
    const deck0 = [...Array(4).fill(MEW), ...Array(4).fill(SERENA), ...Array(52).fill(PSY)];
    const deck1 = [...Array(4).fill(FISH), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [MEW, PSY, PSY, PSY, SERENA, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [FISH, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true);

    // T1/T3 各附 1 能，双方交替结束回合。
    let aView = await syncOpponent(a, latestView(a)?.version ?? 0);
    let bView = await syncOpponent(b, aView.version);
    for (let index = 0; index < 2; index += 1) {
      aView = await sendCommand(a, aView, {
        type: 'attach-energy',
        handIndex: aView.you.hand.findIndex((card) => card.cardId === PSY),
        target: { slot: 'active' },
      });
      aView = await sendCommand(a, aView, { type: 'end-turn' });
      bView = await syncOpponent(b, aView.version);
      bView = await sendCommand(b, bView, { type: 'end-turn' });
      aView = await syncOpponent(a, bView.version);
    }
    // T5：第 3 能后复制水枪（立即结算），回合正常结束。
    aView = await sendCommand(a, aView, {
      type: 'attach-energy',
      handIndex: aView.you.hand.findIndex((card) => card.cardId === PSY),
      target: { slot: 'active' },
    });
    aView = await sendCommand(a, aView, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const copyChoice = aView.pendingChoice as MatchPendingChoiceView;
    expect(copyChoice.kind).toBe('choose-mode');
    aView = await sendCommand(a, aView, { type: 'choose-mode', choiceId: copyChoice.choiceId, modeId: 'attack-0' });
    expect(aView.opponent.active?.damageCounters).toBe(1);
    expect(aView.activeSeat).toBe(1);
    // T6 对手结束回合。
    bView = await syncOpponent(b, aView.version);
    bView = await sendCommand(b, bView, { type: 'end-turn' });
    aView = await syncOpponent(a, bView.version);

    // T7：莎莉娜弃抽；若复制上下文残留，服务端会追加旧 attack-used 并提前换手。
    aView = await sendCommand(a, aView, {
      type: 'play-trainer',
      handIndex: aView.you.hand.findIndex((card) => card.cardId === SERENA),
    });
    const modeChoice = aView.pendingChoice as MatchPendingChoiceView;
    expect(modeChoice.kind).toBe('choose-mode');
    // 非复制 choose-mode（茹莉娜）不接受 copy-attack 别名：拒绝且状态不变，
    // 防止旧命令被泛化到其他卡牌的模式选择。
    a.send({
      type: 'copy-attack',
      commandId: nextCommandId(),
      sessionId: aView.sessionId,
      expectedVersion: aView.version,
      choiceId: modeChoice.choiceId,
      attackIndex: 0,
    });
    const aliasRefused = (await a.waitFor(
      (entry) => entry.type === 'match-error' && entry.code === 'choice-pending',
      '非复制模式拒绝别名',
    )) as Extract<ServerMessage, { type: 'match-error' }>;
    expect(aliasRefused.view?.pendingChoice?.choiceId).toBe(modeChoice.choiceId);
    expect(aliasRefused.view?.version).toBe(aView.version);
    aView = await sendCommand(a, aView, { type: 'choose-mode', choiceId: modeChoice.choiceId, modeId: 'discard-draw-five' });
    const discard = aView.pendingChoice as MatchPendingChoiceView;
    expect(discard.kind).toBe('discard-hand');
    aView = await sendCommand(a, aView, {
      type: 'discard-hand',
      choiceId: discard.choiceId,
      handIndices: [discard.candidates[0] as number],
    });
    expect(aView.activeSeat).toBe(0);
    expect(aView.turn).toBe(7);
    expect(aView.events.filter((event) => event.type === 'attack-used')).toHaveLength(1);
    expect(aView.events.some((event) => event.type === 'attack-used' && event.attackName === '基因侵入')).toBe(false);
    const bAfter = await syncOpponent(b, aView.version);
    expect(bAfter.activeSeat).toBe(0);
  }, 30_000);

  it('基因侵入镜像经真实服务以无效果收招，不产生无法完成的待决选择（封闭镜像裁定未核实）', async () => {
    const deck0 = [...Array(4).fill(MEW), ...Array(56).fill(PSY)];
    const deck1 = [...Array(4).fill(MEW), ...Array(56).fill(PSY)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [MEW, PSY, PSY, PSY, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [MEW, PSY, PSY, PSY, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true);
    let aView = await syncOpponent(a, latestView(a)?.version ?? 0);
    let bView = await syncOpponent(b, aView.version);
    for (let index = 0; index < 2; index += 1) {
      aView = await sendCommand(a, aView, {
        type: 'attach-energy',
        handIndex: aView.you.hand.findIndex((card) => card.cardId === PSY),
        target: { slot: 'active' },
      });
      aView = await sendCommand(a, aView, { type: 'end-turn' });
      bView = await syncOpponent(b, aView.version);
      bView = await sendCommand(b, bView, { type: 'end-turn' });
      aView = await syncOpponent(a, bView.version);
    }
    aView = await sendCommand(a, aView, {
      type: 'attach-energy',
      handIndex: aView.you.hand.findIndex((card) => card.cardId === PSY),
      target: { slot: 'active' },
    });
    // 双方战斗宝可梦都是只有「基因侵入」的梦幻ex；实现以无效果收招避免永久
    // 待决（封闭镜像的官方裁定未核实）。
    aView = await sendCommand(a, aView, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    expect(aView.pendingChoice).toBeNull();
    expect(aView.activeSeat).toBe(1);
    expect(aView.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '基因侵入',
      baseDamage: 0,
      damage: 0,
    });
    const bAfter = await syncOpponent(b, aView.version);
    expect(bAfter.pendingChoice).toBeNull();
    expect(bAfter.activeSeat).toBe(1);
  }, 30_000);

  it('循环抽取：攻击发起的 discard-hand 与随后抽 3 张经真实服务', async () => {
    const deck0 = [...Array(4).fill(MOON), ...Array(56).fill(PSY)];
    const deck1 = [...Array(4).fill(FISH), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 1, (script) => {
      script.planHand(0, [MOON, PSY, PSY, PSY, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [FISH, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 1, true);
    let bView = await syncOpponent(b, latestView(b)?.version ?? 0);
    bView = await sendCommand(b, bView, { type: 'end-turn' });
    let aView = await syncOpponent(a, bView.version);
    aView = await sendCommand(a, aView, {
      type: 'attach-energy',
      handIndex: aView.you.hand.findIndex((card) => card.cardId === PSY),
      target: { slot: 'active' },
    });
    const handBefore = aView.you.handCount;
    const discardView = await sendCommand(a, aView, { type: 'attack', attackIndex: 0, target: { slot: 'active' } });
    const discard = discardView.pendingChoice as MatchPendingChoiceView;
    expect(discard.kind).toBe('discard-hand');
    const after = await sendCommand(a, discardView, {
      type: 'discard-hand',
      choiceId: discard.choiceId,
      handIndices: [discard.candidates[0] as number],
    });
    expect(after.you.handCount).toBe(handBefore - 1 + 3);
    expect(after.you.discard.length).toBeGreaterThan(0);
    expect(after.events.filter((event) => event.type === 'attack-used').at(-1)).toMatchObject({
      attackName: '循环抽取',
      baseDamage: 0,
    });
    expect(after.activeSeat).toBe(1);
    const bAfter = await syncOpponent(b, after.version);
    expect(bAfter.you.active?.damageCounters).toBe(0);
  }, 30_000);

  it('珠贝：分步检索两次经真实服务，只在最后重洗一次', async () => {
    const deck0 = [...Array(4).fill(FISH), ...Array(4).fill(IRIDA), ...Array(4).fill(POKE_BALL), ...Array(4).fill(COURAGE_CHARM), ...Array(44).fill(PSY)];
    const deck1 = [...Array(4).fill(FISH), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 1, (script) => {
      script.planHand(0, [FISH, IRIDA, PSY, PSY, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [FISH, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 1, true);
    let bView = await syncOpponent(b, latestView(b)?.version ?? 0);
    bView = await sendCommand(b, bView, { type: 'end-turn' });
    let aView = await syncOpponent(a, bView.version);
    const waterStepView = await sendCommand(a, aView, {
      type: 'play-trainer',
      handIndex: aView.you.hand.findIndex((card) => card.cardId === IRIDA),
    });
    const waterStep = waterStepView.pendingChoice as MatchPendingChoiceView;
    expect(waterStep.kind).toBe('search-deck');
    expect(waterStep.step).toBe(1);
    expect(waterStep.stepCount).toBe(2);
    expect(waterStep.cardCandidates.some((candidate) => candidate.card.cardId === FISH)).toBe(true);
    expect(waterStep.cardCandidates.some((candidate) => candidate.card.cardId === POKE_BALL)).toBe(false);
    const itemStepView = await sendCommand(a, waterStepView, {
      type: 'search-deck',
      choiceId: waterStep.choiceId,
      candidateIds: [waterStep.cardCandidates[0]?.candidateId as string],
    });
    const itemStep = itemStepView.pendingChoice as MatchPendingChoiceView;
    expect(itemStep.kind).toBe('search-deck');
    expect(itemStep.step).toBe(2);
    expect(itemStep.cardCandidates.some((candidate) => candidate.card.cardId === POKE_BALL)).toBe(true);
    expect(itemStep.cardCandidates.some((candidate) => candidate.card.cardId === COURAGE_CHARM)).toBe(false);
    const after = await sendCommand(a, itemStepView, {
      type: 'search-deck',
      choiceId: itemStep.choiceId,
      candidateIds: [itemStep.cardCandidates[0]?.candidateId as string],
    });
    expect(after.pendingChoice).toBeNull();
    expect(after.you.hand.some((card) => card.cardId === POKE_BALL)).toBe(true);
    expect(after.events.filter((event) => event.type === 'deck-shuffled')).toHaveLength(1);
    expect(after.events.filter((event) => event.type === 'cards-searched')).toHaveLength(2);
  }, 30_000);

  it('A/B 预设经真实服务可准备并开局（发行目录不再拒绝）', async () => {
    const harness = await startTestService();
    try {
      const a = await connectTestClient(harness.service, '小智');
      const b = await connectTestClient(harness.service, '小茂');
      a.send({ type: 'create-room', commandId: nextCommandId() });
      const created = await a.waitForRoom((room) => room.you.host, '建房');
      b.send({ type: 'join-room', commandId: nextCommandId(), code: created.code });
      await b.waitForRoom((room) => room.you.seat === 1, '加入');
      a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(a)), deck: releasePreset('A') });
      const aSelected = await a.waitForRoom((room) => room.you.deckSelected, 'A 选预设');
      expect(aSelected.you.deck?.validation.ready).toBe(true);
      b.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(b)), deck: releasePreset('B') });
      const bSelected = await b.waitForRoom((room) => room.you.deckSelected, 'B 选预设');
      expect(bSelected.you.deck?.validation.ready).toBe(true);
      a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true });
      await a.waitForRoom((room) => room.you.ready, 'A 准备');
      b.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(b)), ready: true });
      const started = await b.waitForRoom((room) => room.status === 'started', 'A/B 开局');
      expect(started.match?.sessionId).toBeDefined();
      a.close();
      b.close();
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('跨线预设 A vs C 经真实服务可准备并开局（#13/#14 合并回归）', async () => {
    const harness = await startTestService();
    try {
      const a = await connectTestClient(harness.service, '小智');
      const b = await connectTestClient(harness.service, '小茂');
      a.send({ type: 'create-room', commandId: nextCommandId() });
      const created = await a.waitForRoom((room) => room.you.host, '建房');
      b.send({ type: 'join-room', commandId: nextCommandId(), code: created.code });
      await b.waitForRoom((room) => room.you.seat === 1, '加入');
      a.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(a)), deck: releasePreset('A') });
      const aSelected = await a.waitForRoom((room) => room.you.deckSelected, 'A 选预设');
      expect(aSelected.you.deck?.validation.ready).toBe(true);
      b.send({ type: 'select-deck', commandId: nextCommandId(), ...routed(currentRoom(b)), deck: releasePreset('C') });
      const bSelected = await b.waitForRoom((room) => room.you.deckSelected, 'C 选预设');
      expect(bSelected.you.deck?.validation.ready).toBe(true);
      a.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(a)), ready: true });
      await a.waitForRoom((room) => room.you.ready, 'A 准备');
      b.send({ type: 'set-ready', commandId: nextCommandId(), ...routed(currentRoom(b)), ready: true });
      const started = await b.waitForRoom((room) => room.status === 'started', 'A/C 开局');
      expect(started.match?.sessionId).toBeDefined();
      a.close();
      b.close();
    } finally {
      await harness.close();
    }
  }, 30_000);
});
