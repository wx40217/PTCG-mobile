import { afterEach, describe, expect, it } from 'vitest';
import type {
  MatchPendingChoiceView,
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
  routed,
  startTestService,
  writePlayableFixture,
  type PlayableFixture,
  type TempDirectory,
  type TestClient,
  type TestService,
} from './support/roomTestKit.ts';
import { OpeningHandScript, SequenceRandomSource, deckDocumentFromCards } from './support/matchTestKit.ts';

/**
 * #12 新对局命令的真实 WebSocket 公共边界回归。
 *
 * 之前的 MatchSession 单元测试无法发现 `rooms.ts` 的网络分发遗漏：命令会被当作
 * 房间命令拒绝，客户端 pending 永远不结束。这里通过真实服务 + 两个真实
 * WebSocket 客户端逐条走 evolve / use-ability / attach-tool /
 * choose-own-bench / attach-hand-energy / discard-energy，并断言服务端视图、
 * 公开事件与候选的附着归属标签。
 */

const SYLVEON_V = 'csve1-062';
const SYLVEON_VMAX = 'csve1-063';
const COURAGE_CHARM = 'csv1c-118';
const POKE_BALL = 'cbb1c-1701';
const CHIEN_PAO = 'csv3c-043';
const FISH = 'csve1-035';
const PSY = 'cbb2c-1102';
const WATER = 'cbb1c-1803';
const FIRE = 'cbb1c-1802';
const DRAGON = 'csv3c-095';
const MEW = 'csve1-056';
const LILLIE = 'csv2c-118';
const MAGMA = 'csve1-169';
const FIRE_FISH = 'csv3c-031';
const ULTRA_BALL = 'cbb1c-1703';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  readonly temp: TempDirectory;
  readonly fixture: PlayableFixture;
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
  const temp = createTempDirectory('ptcg-pokemon-flow-');
  const fixture = await writePlayableFixture(temp.path);
  const script = new OpeningHandScript([deck0Cards, deck1Cards]);
  plan(script);
  // 初始洗牌与检索洗牌都会消耗随机；追加的 0 保证脚本随机源不会耗尽。
  const outputs = [winner, ...script.outputs, ...Array.from({ length: 800 }, () => 0)];
  const harness = await startTestService({
    catalog: { catalogPath: fixture.path },
    rooms: {
      matchRandom: new SequenceRandomSource(outputs),
      generateCode: () => '515151',
      newRoomId: () => 'room-pokemon',
      newSessionId: () => 'session-pokemon',
    },
  });
  const clients: TestClient[] = [];
  return {
    temp,
    fixture,
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

async function waitForMatchView(client: TestClient, predicate: (view: MatchView) => boolean, label = '对局视图'): Promise<MatchView> {
  const message = await client.waitFor((entry) => entry.type === 'match' && predicate(entry.view), label);
  return (message as Extract<ServerMessage, { type: 'match' }>).view;
}

async function waitForMatchError(
  client: TestClient,
  code: string,
  label = `match-error ${code}`,
): Promise<Extract<ServerMessage, { type: 'match-error' }>> {
  const message = await client.waitFor((entry) => entry.type === 'match-error' && entry.code === code, label);
  return message as Extract<ServerMessage, { type: 'match-error' }>;
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

/** 完成开局：winner 决定先后攻，双方按手牌第一张基础宝可梦盖放。 */
async function completeOpening(a: TestClient, b: TestClient, winnerSeat: 0 | 1, wantFirst: boolean, benchSecond = false): Promise<void> {
  const clients: readonly [TestClient, TestClient] = [a, b];
  for (let step = 0; step < 120; step += 1) {
    let acted = false;
    for (const seat of [0, 1] as const) {
      const view = latestView(clients[seat]);
      if (view === undefined || view.result !== null) {
        continue;
      }
      if (view.phase === 'playing') {
        return;
      }
      const choice = view.pendingChoice;
      if (choice === null) {
        continue;
      }
      const base = { commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version, choiceId: choice.choiceId };
      if (choice.kind === 'turn-order') {
        if (seat !== winnerSeat) {
          continue;
        }
        clients[seat].send({ type: 'choose-turn-order', ...base, goFirst: wantFirst });
      } else if (choice.kind === 'place-setup') {
        const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
        clients[seat].send({ type: 'place-setup', ...base, active: basics[0] as number, bench: benchSecond && seat === 0 ? basics.slice(1, 2) : [] });
      } else if (choice.kind === 'compensation-draw') {
        clients[seat].send({ type: 'resolve-compensation', ...base, draw: 0 });
      } else if (choice.kind === 'place-bench') {
        clients[seat].send({ type: 'place-bench', ...base, bench: [] });
      } else {
        throw new Error(`未知开局选择 ${choice.kind}`);
      }
      acted = true;
      break;
    }
    if (!acted && (latestView(a)?.phase === 'playing' || latestView(b)?.phase === 'playing')) {
      return;
    }
    await sleep(30);
  }
  throw new Error('开局流程未完成');
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

describe('#12 新对局命令的真实 WebSocket 公共边界', () => {
  it('evolve / attach-tool / use-ability / choose-own-bench / attach-hand-energy 全程走真实服务', async () => {
    // 牌序先把 PSY 放在池顶：开局后手牌与回合开始抽牌都能拿到足够能量，
    // 特性检索带来的重洗不会影响后续步骤所需的能量（已在手中）。
    const deck0 = [...Array(44).fill(PSY), ...Array(4).fill(SYLVEON_V), ...Array(4).fill(SYLVEON_VMAX), ...Array(4).fill(COURAGE_CHARM), ...Array(4).fill(POKE_BALL)];
    const deck1 = [...Array(4).fill(FISH), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [SYLVEON_V, SYLVEON_V, SYLVEON_VMAX, COURAGE_CHARM, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [FISH, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true, true);

    const playing = await waitForMatchView(a, (view) => view.phase === 'playing', 'A playing');
    const vRef = { slot: 'active' as const };

    // 最初回合：evolve 必须作为对局命令被分发，返回 match-error action-not-allowed，
    // 而不是房间层 room-error；客户端 pending 在此结束。
    const evolveReject = {
      type: 'evolve' as const,
      commandId: nextCommandId(),
      sessionId: playing.sessionId,
      expectedVersion: playing.version,
      handIndex: playing.you.hand.findIndex((card) => card.cardId === SYLVEON_VMAX),
      target: vRef,
    };
    a.send(evolveReject);
    const reject = await waitForMatchError(a, 'action-not-allowed', '第一回合进化拒绝');
    expect(reject.commandId).toBe(evolveReject.commandId);

    // attach-tool：道具在本人与对手视图都公开，基础宝可梦最大 HP +50。
    const toolIndex = playing.you.hand.findIndex((card) => card.cardId === COURAGE_CHARM);
    a.send({ type: 'attach-tool', commandId: nextCommandId(), sessionId: playing.sessionId, expectedVersion: playing.version, handIndex: toolIndex, target: vRef });
    const withTool = await waitForMatchView(a, (view) => view.you.active?.tools.some((tool) => tool.cardId === COURAGE_CHARM) === true, '道具附着');
    expect(withTool.you.active?.maxHp).toBe(250);
    await waitForMatchView(b, (view) => view.opponent.active?.tools.some((tool) => tool.cardId === COURAGE_CHARM) === true, '对手看到道具');

    // use-ability：战斗宝可梦「梦中赠礼」检索真正的物品（不含宝可梦道具）并结束回合。
    a.send({ type: 'use-ability', commandId: nextCommandId(), sessionId: withTool.sessionId, expectedVersion: withTool.version, abilityIndex: 0, target: vRef });
    const searchView = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'search-deck', '特性检索选择');
    await waitForMatchView(b, (view) => view.pendingChoice === null && view.waitingForOpponentChoice, '对手等待检索');
    const searchChoice = searchView.pendingChoice as MatchPendingChoiceView;
    const itemCandidate = searchChoice.cardCandidates.find((candidate) => candidate.card.cardId === POKE_BALL);
    expect(itemCandidate).toBeDefined();
    expect(searchChoice.cardCandidates.some((candidate) => candidate.card.cardId === COURAGE_CHARM)).toBe(false);
    a.send({
      type: 'search-deck',
      commandId: nextCommandId(),
      sessionId: searchView.sessionId,
      expectedVersion: searchView.version,
      choiceId: searchChoice.choiceId,
      candidateIds: [itemCandidate?.candidateId as string],
    });
    const afterAbility = await waitForMatchView(a, (view) => view.you.hand.some((card) => card.cardId === POKE_BALL) && view.activeSeat === 1, '特性检索完成并结束回合');
    expect(afterAbility.events.some((event) => event.type === 'ability-used' && event.abilityName === '梦中赠礼')).toBe(true);
    expect(afterAbility.events.some((event) => event.type === 'cards-searched')).toBe(true);

    // 第 2 回合由 B 结束。
    const bTurn2 = await waitForMatchView(b, (view) => view.activeSeat === 1 && view.turn === 2, 'B 第 2 回合');
    b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: bTurn2.sessionId, expectedVersion: bTurn2.version });

    // 第 3 回合：evolve → attach-energy → 珍贵一触（choose-own-bench + attach-hand-energy）。
    const aTurn3 = await waitForMatchView(a, (view) => view.activeSeat === 0 && view.turn === 3, 'A 第 3 回合');
    const vmaxIndex = aTurn3.you.hand.findIndex((card) => card.cardId === SYLVEON_VMAX);
    a.send({ type: 'evolve', commandId: nextCommandId(), sessionId: aTurn3.sessionId, expectedVersion: aTurn3.version, handIndex: vmaxIndex, target: vRef });
    const evolved = await waitForMatchView(a, (view) => view.you.active?.card.cardId === SYLVEON_VMAX, '进化完成');
    expect(evolved.events.some((event) => event.type === 'evolved' && event.toNameZh === '仙子伊布VMAX')).toBe(true);
    expect(evolved.you.active?.tools.map((tool) => tool.cardId)).toEqual([COURAGE_CHARM]);
    expect(evolved.you.active?.maxHp).toBe(310);
    a.send({
      type: 'attach-energy',
      commandId: nextCommandId(),
      sessionId: evolved.sessionId,
      expectedVersion: evolved.version,
      handIndex: evolved.you.hand.findIndex((card) => card.cardId === PSY),
      target: vRef,
    });
    const withEnergy = await waitForMatchView(a, (view) => (view.you.active?.energies.length ?? 0) === 1, '第 3 回合附能');
    a.send({ type: 'attack', commandId: nextCommandId(), sessionId: withEnergy.sessionId, expectedVersion: withEnergy.version, attackIndex: 0, target: vRef });
    const benchChoiceView = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'choose-own-bench', '珍贵一触目标选择');
    await waitForMatchView(b, (view) => view.pendingChoice === null && view.waitingForOpponentChoice, '对手等待珍贵一触');
    const choose = benchChoiceView.pendingChoice as MatchPendingChoiceView;
    a.send({
      type: 'choose-own-bench',
      commandId: nextCommandId(),
      sessionId: benchChoiceView.sessionId,
      expectedVersion: benchChoiceView.version,
      choiceId: choose.choiceId,
      benchIndex: choose.candidates[0] as number,
    });
    const energyChoiceView = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'attach-hand-energy', '手中能量选择');
    const energyChoice = energyChoiceView.pendingChoice as MatchPendingChoiceView;
    const psyCandidate = energyChoice.cardCandidates.find((candidate) => candidate.card.cardId === PSY);
    expect(psyCandidate).toBeDefined();
    a.send({
      type: 'attach-hand-energy',
      commandId: nextCommandId(),
      sessionId: energyChoiceView.sessionId,
      expectedVersion: energyChoiceView.version,
      choiceId: energyChoice.choiceId,
      candidateId: psyCandidate?.candidateId as string,
    });
    const afterTouch = await waitForMatchView(a, (view) => view.you.bench.some((pokemon) => pokemon.energies.length === 1) && view.activeSeat === 1, '珍贵一触完成');
    expect(afterTouch.events.some((event) => event.type === 'attack-used' && event.attackName === '珍贵一触')).toBe(true);

    // 第 4 回合由 B 结束；第 5 回合再附 1 能；第 6 回合由 B 结束；
    // 第 7 回合附满 3 能后极巨和弦终止对局。
    const bTurn4 = await waitForMatchView(b, (view) => view.activeSeat === 1 && view.turn === 4, 'B 第 4 回合');
    b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: bTurn4.sessionId, expectedVersion: bTurn4.version });
    const aTurn5 = await waitForMatchView(a, (view) => view.activeSeat === 0 && view.turn === 5, 'A 第 5 回合');
    a.send({
      type: 'attach-energy',
      commandId: nextCommandId(),
      sessionId: aTurn5.sessionId,
      expectedVersion: aTurn5.version,
      handIndex: aTurn5.you.hand.findIndex((card) => card.cardId === PSY),
      target: vRef,
    });
    const withTwo = await waitForMatchView(a, (view) => (view.you.active?.energies.length ?? 0) === 2, '第 5 回合附能');
    a.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: withTwo.sessionId, expectedVersion: withTwo.version });
    const bTurn6 = await waitForMatchView(b, (view) => view.activeSeat === 1 && view.turn === 6, 'B 第 6 回合');
    b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: bTurn6.sessionId, expectedVersion: bTurn6.version });
    const aTurn7 = await waitForMatchView(a, (view) => view.activeSeat === 0 && view.turn === 7, 'A 第 7 回合');
    a.send({
      type: 'attach-energy',
      commandId: nextCommandId(),
      sessionId: aTurn7.sessionId,
      expectedVersion: aTurn7.version,
      handIndex: aTurn7.you.hand.findIndex((card) => card.cardId === PSY),
      target: vRef,
    });
    const readyToAttack = await waitForMatchView(a, (view) => (view.you.active?.energies.length ?? 0) >= 3, '第 3 张能量');
    a.send({ type: 'attack', commandId: nextCommandId(), sessionId: readyToAttack.sessionId, expectedVersion: readyToAttack.version, attackIndex: 1, target: vRef });
    const prizeView = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'take-prizes', '取奖赏选择');
    const prizeChoice = prizeView.pendingChoice as MatchPendingChoiceView;
    a.send({ type: 'take-prizes', commandId: nextCommandId(), sessionId: prizeView.sessionId, expectedVersion: prizeView.version, choiceId: prizeChoice.choiceId, prizes: [prizeChoice.candidates[0] as number] });
    const finished = await waitForMatchView(a, (view) => view.result !== null, '终局');
    expect(finished.result).toMatchObject({ winner: 0, reason: 'no-pokemon' });
    expect(finished.events.some((event) => event.type === 'attack-used' && event.attackName === '极巨和弦')).toBe(true);
  }, 45_000);

  it('discard-energy 候选保留附着归属标签；重名基本能量可区分', async () => {
    const deck0 = [...Array(56).fill(WATER), ...Array(4).fill(CHIEN_PAO)];
    const deck1 = [...Array(4).fill(FISH), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [CHIEN_PAO, CHIEN_PAO, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(0);
      script.planHand(1, [FISH, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true, true);
    const start = await waitForMatchView(a, (view) => view.phase === 'playing', 'A playing');

    // T1：给战斗宝可梦附 1 张水能量。
    a.send({
      type: 'attach-energy',
      commandId: nextCommandId(),
      sessionId: start.sessionId,
      expectedVersion: start.version,
      handIndex: start.you.hand.findIndex((card) => card.cardId === WATER),
      target: { slot: 'active' },
    });
    let view = await waitForMatchView(a, (entry) => entry.you.active?.energies.length === 1, 'active energy 1');
    a.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version });
    view = await waitForMatchView(b, (entry) => entry.activeSeat === 1 && entry.turn === 2, 'B turn 2');
    b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version });

    // T3：给备战宝可梦附 1 张同名水能量。
    view = await waitForMatchView(a, (entry) => entry.activeSeat === 0 && entry.turn === 3, 'A turn 3');
    a.send({
      type: 'attach-energy',
      commandId: nextCommandId(),
      sessionId: view.sessionId,
      expectedVersion: view.version,
      handIndex: view.you.hand.findIndex((card) => card.cardId === WATER),
      target: { slot: 'bench', index: 0 },
    });
    view = await waitForMatchView(a, (entry) => (entry.you.bench[0]?.energies.length ?? 0) === 1, 'bench energy');
    a.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version });
    view = await waitForMatchView(b, (entry) => entry.activeSeat === 1 && entry.turn === 4, 'B turn 4');
    b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version });

    // T5：战斗宝可梦再附 1 张后使用「冰雹利刃」；候选跨两只宝可梦且标签不同。
    view = await waitForMatchView(a, (entry) => entry.activeSeat === 0 && entry.turn === 5, 'A turn 5');
    a.send({
      type: 'attach-energy',
      commandId: nextCommandId(),
      sessionId: view.sessionId,
      expectedVersion: view.version,
      handIndex: view.you.hand.findIndex((card) => card.cardId === WATER),
      target: { slot: 'active' },
    });
    view = await waitForMatchView(a, (entry) => (entry.you.active?.energies.length ?? 0) === 2, 'active energy 2');
    a.send({ type: 'attack', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version, attackIndex: 0, target: { slot: 'active' } });
    const discardView = await waitForMatchView(a, (entry) => entry.pendingChoice?.kind === 'discard-energy', 'discard-energy 选择');
    const choice = discardView.pendingChoice as MatchPendingChoiceView;
    const labels = choice.cardCandidates.map((candidate) => candidate.targetLabelZh);
    const cardIds = new Set(choice.cardCandidates.map((candidate) => candidate.card.cardId));
    expect(cardIds).toEqual(new Set([WATER]));
    expect(new Set(labels).size).toBeGreaterThanOrEqual(2);
    expect(labels).toContain('战斗宝可梦');
    expect(labels).toContain('备战区 1');
    const benchCandidate = choice.cardCandidates.find((candidate) => candidate.targetLabelZh === '备战区 1');
    expect(benchCandidate).toBeDefined();
    a.send({
      type: 'discard-energy',
      commandId: nextCommandId(),
      sessionId: discardView.sessionId,
      expectedVersion: discardView.version,
      choiceId: choice.choiceId,
      candidateIds: [benchCandidate?.candidateId as string],
    });
    const afterBlade = await waitForMatchView(a, (entry) => entry.pendingChoice?.kind === 'take-prizes', '冰雹利刃 KO 取奖赏');
    expect(afterBlade.events.some((event) => event.type === 'energy-discarded' && event.cards.some((card) => card.cardId === WATER))).toBe(true);
    expect(afterBlade.you.discard.some((card) => card.cardId === WATER)).toBe(true);
    const prize = afterBlade.pendingChoice as MatchPendingChoiceView;
    a.send({
      type: 'take-prizes',
      commandId: nextCommandId(),
      sessionId: afterBlade.sessionId,
      expectedVersion: afterBlade.version,
      choiceId: prize.choiceId,
      prizes: [prize.candidates[0] as number],
    });
    const finished = await waitForMatchView(a, (entry) => entry.result !== null, '终局');
    expect(finished.result?.winner).toBe(0);
  }, 45_000);

  it('对局命令不再落入 room-error：越界目标返回 match-error', async () => {
    const deck0 = [...Array(4).fill(SYLVEON_V), ...Array(56).fill(PSY)];
    const deck1 = [...Array(4).fill(FISH), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [SYLVEON_V, PSY, PSY, PSY, PSY, PSY, PSY], [PSY, PSY, PSY, PSY, PSY, PSY]);
      script.deal(0);
      script.planHand(1, [FISH, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true, false);
    const view = await waitForMatchView(a, (entry) => entry.phase === 'playing', 'A playing');
    a.send({ type: 'attach-tool', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version, handIndex: 99, target: { slot: 'active' } });
    const error = await waitForMatchError(a, 'illegal-target', '越界手牌序号');
    expect(error.commandId).toBeDefined();
    expect(a.messages.some((entry) => entry.type === 'room-error')).toBe(false);
  }, 45_000);
});

describe('#14 C/D 新命令的真实 WebSocket 公共边界', () => {
  it('莉佳的邀请：select-card 走真实服务，私人候选只发给选择者并互换对手战斗宝可梦', async () => {
    const deck0 = [...Array(4).fill(DRAGON), ...Array(4).fill(LILLIE), ...Array(52).fill(WATER)];
    const deck1 = [...Array(4).fill(DRAGON), ...Array(4).fill(MEW), ...Array(52).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [DRAGON, LILLIE, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(0);
      script.planHand(1, [DRAGON, MEW, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, false);
    // 座位 1 先攻：结束回合后轮到座位 0。
    const bTurn1 = await waitForMatchView(b, (view) => view.activeSeat === 1, 'B 第 1 回合');
    b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: bTurn1.sessionId, expectedVersion: bTurn1.version });
    const aTurn2 = await waitForMatchView(a, (view) => view.activeSeat === 0 && view.turn === 2, 'A 第 2 回合');
    a.send({
      type: 'play-trainer',
      commandId: nextCommandId(),
      sessionId: aTurn2.sessionId,
      expectedVersion: aTurn2.version,
      handIndex: aTurn2.you.hand.findIndex((card) => card.cardId === LILLIE),
    });
    const selectView = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'select-card', 'select-card 选择');
    await waitForMatchView(b, (view) => view.pendingChoice === null && view.waitingForOpponentChoice, '对手等待 select-card');
    const select = selectView.pendingChoice as MatchPendingChoiceView;
    expect(select.source).toBe('opponent-hand');
    // 对手手牌里有基础宝可梦：必须选 1 张（官方同卡 FAQ），不能提交 0 张。
    expect(select.min).toBe(1);
    expect(select.cardCandidates.some((candidate) => candidate.card.cardId === MEW && candidate.selectable !== false)).toBe(true);
    expect(select.cardCandidates.every((candidate) => candidate.card.cardId !== LILLIE)).toBe(true);
    const mewCandidate = select.cardCandidates.find((candidate) => candidate.card.cardId === MEW);
    a.send({
      type: 'select-card',
      commandId: nextCommandId(),
      sessionId: selectView.sessionId,
      expectedVersion: selectView.version,
      choiceId: select.choiceId,
      candidateIds: [],
    });
    const zeroRejected = await waitForMatchError(a, 'illegal-choice', '零张选择被拒绝');
    expect(zeroRejected.view?.pendingChoice?.kind).toBe('select-card');
    a.send({
      type: 'select-card',
      commandId: nextCommandId(),
      sessionId: zeroRejected.view?.sessionId as string,
      expectedVersion: zeroRejected.view?.version as number,
      choiceId: select.choiceId,
      candidateIds: [mewCandidate?.candidateId as string],
    });
    const swapped = await waitForMatchView(a, (view) => view.opponent.active?.card.cardId === MEW, '互换完成');
    expect(swapped.events.some((event) => event.type === 'bench-switched' && event.targetSeat === 1)).toBe(true);
    expect(a.messages.some((entry) => entry.type === 'room-error')).toBe(false);
  }, 45_000);

  it('熔岩瀑布之渊：use-stadium → select-card → select-target 全程走真实服务并附着/放置指示物', async () => {
    const deck0 = [...Array(4).fill(FIRE_FISH), ...Array(4).fill(MAGMA), ...Array(4).fill(ULTRA_BALL), ...Array(48).fill(FIRE)];
    const deck1 = [...Array(4).fill(DRAGON), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [FIRE_FISH, FIRE_FISH, MAGMA, ULTRA_BALL, FIRE, FIRE, FIRE], [FIRE, FIRE, FIRE, FIRE, FIRE, FIRE]);
      script.deal(0);
      script.planHand(1, [DRAGON, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true, true);
    const playing = await waitForMatchView(a, (view) => view.phase === 'playing', 'A playing');
    a.send({
      type: 'play-trainer',
      commandId: nextCommandId(),
      sessionId: playing.sessionId,
      expectedVersion: playing.version,
      handIndex: playing.you.hand.findIndex((card) => card.cardId === MAGMA),
    });
    const stadium = await waitForMatchView(a, (view) => view.stadium?.cardId === MAGMA, '竞技场放置');
    a.send({
      type: 'play-trainer',
      commandId: nextCommandId(),
      sessionId: stadium.sessionId,
      expectedVersion: stadium.version,
      handIndex: stadium.you.hand.findIndex((card) => card.cardId === ULTRA_BALL),
    });
    const discardView = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'discard-hand', '高级球代价选择');
    const discard = discardView.pendingChoice as MatchPendingChoiceView;
    const fireIndex = discardView.you.hand.findIndex((card) => card.cardId === FIRE);
    const secondFireIndex = discardView.you.hand.findIndex((card, index) => index !== fireIndex && card.cardId === FIRE);
    a.send({
      type: 'discard-hand',
      commandId: nextCommandId(),
      sessionId: discardView.sessionId,
      expectedVersion: discardView.version,
      choiceId: discard.choiceId,
      handIndices: [fireIndex, secondFireIndex],
    });
    const searchView = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'search-deck', '高级球检索选择');
    const search = searchView.pendingChoice as MatchPendingChoiceView;
    a.send({
      type: 'search-deck',
      commandId: nextCommandId(),
      sessionId: searchView.sessionId,
      expectedVersion: searchView.version,
      choiceId: search.choiceId,
      candidateIds: [],
    });
    const ready = await waitForMatchView(
      a,
      (view) => view.pendingChoice === null && view.you.discard.some((card) => card.cardId === FIRE),
      '火能量进弃牌区且检索已结算',
    );
    a.send({ type: 'use-stadium', commandId: nextCommandId(), sessionId: ready.sessionId, expectedVersion: ready.version });
    const energySelect = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'select-card', '竞技场 select-card');
    const energyChoice = energySelect.pendingChoice as MatchPendingChoiceView;
    expect(energyChoice.source).toBe('discard');
    const fireCandidate = energyChoice.cardCandidates.find((candidate) => candidate.card.cardId === FIRE && candidate.selectable !== false);
    a.send({
      type: 'select-card',
      commandId: nextCommandId(),
      sessionId: energySelect.sessionId,
      expectedVersion: energySelect.version,
      choiceId: energyChoice.choiceId,
      candidateIds: [fireCandidate?.candidateId as string],
    });
    const targetSelect = await waitForMatchView(a, (view) => view.pendingChoice?.kind === 'select-target', '竞技场 select-target');
    const targetChoice = targetSelect.pendingChoice as MatchPendingChoiceView;
    expect(targetChoice.source).toBe('own-bench');
    a.send({
      type: 'select-target',
      commandId: nextCommandId(),
      sessionId: targetSelect.sessionId,
      expectedVersion: targetSelect.version,
      choiceId: targetChoice.choiceId,
      candidateIds: ['bench-0'],
    });
    const resolved = await waitForMatchView(
      a,
      (view) => view.you.bench[0]?.energies.some((energy) => energy.card.cardId === FIRE) === true && view.you.bench[0]?.damageCounters === 2,
      '竞技场效果完成',
    );
    expect(resolved.you.stadiumUsedThisTurn).toBe(true);
    expect(b.messages.some((entry) => entry.type === 'room-error')).toBe(false);
  }, 45_000);

  it('基因侵入：copy-attack 走真实服务并复制对手战斗宝可梦的招式', async () => {
    const deck0 = [...Array(4).fill(MEW), ...Array(56).fill(WATER)];
    const deck1 = [...Array(4).fill(SYLVEON_V), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [MEW, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(0);
      script.planHand(1, [SYLVEON_V, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true);
    let view = await waitForMatchView(a, (entry) => entry.phase === 'playing', 'A playing');
    // 三个自己的回合各附 1 张能量。
    for (let ownTurn = 1; ownTurn <= 3; ownTurn += 1) {
      if (ownTurn > 1) {
        view = await waitForMatchView(b, (entry) => entry.activeSeat === 1 && entry.turn === ownTurn * 2 - 2, `B 第 ${ownTurn * 2 - 2} 回合`);
        b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version });
        view = await waitForMatchView(a, (entry) => entry.activeSeat === 0 && entry.turn === ownTurn * 2 - 1, `A 第 ${ownTurn * 2 - 1} 回合`);
      }
      a.send({
        type: 'attach-energy',
        commandId: nextCommandId(),
        sessionId: view.sessionId,
        expectedVersion: view.version,
        handIndex: view.you.hand.findIndex((card) => card.cardId === WATER),
        target: { slot: 'active' },
      });
      view = await waitForMatchView(a, (entry) => (entry.you.active?.energies.length ?? 0) === ownTurn, `第 ${ownTurn} 张能量`);
      if (ownTurn < 3) {
        a.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version });
      }
    }
    a.send({ type: 'attack', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version, attackIndex: 0, target: { slot: 'active' } });
    const copyView = await waitForMatchView(a, (entry) => entry.pendingChoice?.kind === 'copy-attack', 'copy-attack 选择');
    const copy = copyView.pendingChoice as MatchPendingChoiceView;
    expect(copy.source).toBe('opponent-active');
    expect(copy.candidates.length).toBeGreaterThan(0);
    a.send({
      type: 'copy-attack',
      commandId: nextCommandId(),
      sessionId: copyView.sessionId,
      expectedVersion: copyView.version,
      choiceId: copy.choiceId,
      attackIndex: copy.candidates[0] as number,
    });
    const resolved = await waitForMatchView(a, (entry) => entry.events.some((event) => event.type === 'attack-used' && event.attackName === '魔法射击'), '复制招式结算');
    const copied = resolved.events.filter((event) => event.type === 'attack-used' && event.attackName === '魔法射击').at(-1);
    expect(copied).toMatchObject({ attackName: '魔法射击', baseDamage: 60 });
    expect(a.messages.some((entry) => entry.type === 'room-error')).toBe(false);
  }, 60_000);

  it('基因侵入镜像：copy-attack 选中同名复制招式走真实服务后正常收招，不锁死待决选择', async () => {
    const deck0 = [...Array(4).fill(MEW), ...Array(56).fill(WATER)];
    const deck1 = [...Array(4).fill(MEW), ...Array(56).fill(WATER)];
    const harness = await startHarness(deck0, deck1, 0, (script) => {
      script.planHand(0, [MEW, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(0);
      script.planHand(1, [MEW, WATER, WATER, WATER, WATER, WATER, WATER], [WATER, WATER, WATER, WATER, WATER, WATER]);
      script.deal(1);
    });
    harnesses.push(harness);
    const { a, b } = await givenStarted(harness, deck0, deck1);
    await completeOpening(a, b, 0, true);
    let view = await waitForMatchView(a, (entry) => entry.phase === 'playing', 'A playing');
    for (let ownTurn = 1; ownTurn <= 3; ownTurn += 1) {
      if (ownTurn > 1) {
        view = await waitForMatchView(b, (entry) => entry.activeSeat === 1 && entry.turn === ownTurn * 2 - 2, `B 第 ${ownTurn * 2 - 2} 回合`);
        b.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version });
        view = await waitForMatchView(a, (entry) => entry.activeSeat === 0 && entry.turn === ownTurn * 2 - 1, `A 第 ${ownTurn * 2 - 1} 回合`);
      }
      a.send({
        type: 'attach-energy',
        commandId: nextCommandId(),
        sessionId: view.sessionId,
        expectedVersion: view.version,
        handIndex: view.you.hand.findIndex((card) => card.cardId === WATER),
        target: { slot: 'active' },
      });
      view = await waitForMatchView(a, (entry) => (entry.you.active?.energies.length ?? 0) === ownTurn, `第 ${ownTurn} 张能量`);
      if (ownTurn < 3) {
        a.send({ type: 'end-turn', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version });
      }
    }
    a.send({ type: 'attack', commandId: nextCommandId(), sessionId: view.sessionId, expectedVersion: view.version, attackIndex: 0, target: { slot: 'active' } });
    // 对手战斗宝可梦只有「基因侵入」：真正闭合的自引用复制环由服务端在同一
    // 命令内收招（以原招式名公开记录），不创建无法完成的待决选择。复制类招式的
    // 网络选择命令已由上一个测试（对仙子伊布V 复制魔法射击）覆盖。
    const resolved = await waitForMatchView(
      a,
      (entry) =>
        entry.pendingChoice === null &&
        entry.activeSeat === 1 &&
        entry.events.some((event) => event.type === 'attack-used' && event.attackName === '基因侵入'),
      '镜像闭环收招',
    );
    expect(resolved.opponent.active?.damageCounters).toBe(0);
    expect(a.messages.some((entry) => entry.type === 'room-error')).toBe(false);
  }, 90_000);
});
