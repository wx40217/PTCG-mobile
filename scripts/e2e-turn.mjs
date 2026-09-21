#!/usr/bin/env node
/**
 * 真实回合端到端验收脚本（T08 / #9）。
 *
 * 真实服务进程 + 两个真实 WebSocket 客户端跑通：
 *   准备完成 → 开局（含可能的自适应重抽/补抽）→ 双方各完成真实回合：
 *   回合开始抽 1 张、基础宝可梦进备战区、每回合限 1 张附能（精确重传不重复）、
 *   先攻首回合禁止招式、后攻方使用「水枪」造成伤害、伤害指示物与弱点/抵抗顺序、
 *   旧版本与非法目标被拒绝、回合结束切换玩家。
 *
 * 同时覆盖：公开附能与伤害两个客户端一致；B 的原始载荷不含 A 的隐藏手牌身份；
 * 客户端不能夹带种子/牌序；发行目录保持“全部效果未接入”。
 *
 * 用法: node scripts/e2e-turn.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const serviceEntry = join(root, 'packages', 'service', 'dist', 'main.js');
const protocolEntry = join(root, 'packages', 'protocol', 'dist', 'index.js');
const catalogPath = join(root, 'data', 'catalog', 'zh-cn-standard-2025-06-05-catalog.json');

const { computeCatalogVersion, connectToService, createDeviceIdentity, parseServerMessage } = await import(
  new URL(`file://${protocolEntry.replace(/\\/gu, '/')}`)
);

const directory = mkdtempSync(join(tmpdir(), 'ptcg-e2e-turn-'));
const port = 18790;

const failures = [];
const passes = [];

function check(name, condition, detail = '') {
  if (condition) {
    passes.push(name);
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询所有已收消息里是否存在满足条件的消息；返回该消息。 */
function waitForMessage(client, predicate, timeoutMs = 10_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      const found = client.messages.find(predicate);
      if (found !== undefined) {
        return found;
      }
      await sleep(20);
    }
    const recent = client.messages.slice(-4).map((message) => message.type === 'match' ? `match v${message.view.version} turn${message.view.turn} dmg=${message.view.you.active?.damageCounters}` : message.type === 'match-error' ? `error ${message.code}: ${message.message}` : message.type).join(' | ');
    throw new Error(`等待 ${label} 超时；最近消息: ${recent}`);
  })();
}

async function writeFixtureCatalog() {
  const release = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const { catalogVersion: _version, runtime: _runtime, ...content } = release;
  const fixture = {
    ...content,
    supportPolicy: {
      engineIntegration: 'integrated',
      playable: true,
      noteZh: '端到端测试夹具：效果支持只在测试环境模拟，不进入发行目录。',
    },
    cards: release.cards.map((card) => ({
      ...card,
      flags: { ...card.flags, effectSupported: true, effectNoteZh: '端到端测试夹具。' },
    })),
  };
  const version = await computeCatalogVersion(fixture);
  const path = join(directory, 'fixture-catalog.json');
  writeFileSync(path, JSON.stringify({ ...fixture, catalogVersion: version }), 'utf8');
  return { path, release, version, content: fixture };
}

const fixture = await writeFixtureCatalog();
const service = spawn(
  process.execPath,
  [serviceEntry, '--host', '127.0.0.1', '--port', String(port), '--db', join(directory, 'e2e-turn.sqlite'), '--catalog', fixture.path],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
const serviceLogs = [];
service.stdout.on('data', (chunk) => serviceLogs.push(chunk.toString('utf8')));
service.stderr.on('data', (chunk) => serviceLogs.push(chunk.toString('utf8')));

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return response.json();
      }
    } catch {
      /* 服务尚未就绪 */
    }
    await sleep(200);
  }
  throw new Error('服务未在超时时间内就绪');
}

let commandSeq = 0;
const commandId = () => `e2e-turn-${(commandSeq += 1)}`;

async function connectClient(nickname, rawLog) {
  const identity = await createDeviceIdentity();
  const result = await connectToService(
    { httpUrl: new URL(`http://127.0.0.1:${port}/`), wsUrl: new URL(`ws://127.0.0.1:${port}/`), identity, nickname },
    rawLog === undefined
      ? {}
      : {
          openSocket: (url) => {
            const socket = new WebSocket(url);
            socket.addEventListener('message', (event) => {
              if (typeof event.data === 'string') {
                rawLog.push(event.data);
              }
            });
            return socket;
          },
        },
  );
  if (!result.ok) {
    throw new Error(`客户端 ${nickname} 连接失败: ${result.failure.message}`);
  }
  const connection = result.connection;
  const messages = [];
  connection.onMessage((message) => messages.push(message));
  const room = () => [...messages].reverse().find((message) => message.type === 'room')?.room;
  const match = () => [...messages].reverse().find((message) => message.type === 'match')?.view;
  const lastMatchError = () => [...messages].reverse().find((message) => message.type === 'match-error');
  const lastError = () => [...messages].reverse().find((message) => message.type === 'room-error');
  return { identity, connection, messages, room, match, lastMatchError, lastError, send: (message) => connection.send(message) };
}

function buildDeck(content, cards) {
  const byId = new Map(content.cards.map((card) => [card.id, card]));
  return {
    formatVersion: 1,
    environmentId: content.environment.id,
    cards: cards.map(([cardId, count]) => {
      const card = byId.get(cardId);
      if (card === undefined) {
        throw new Error(`夹具目录缺少卡牌 ${cardId}`);
      }
      return { cardId, printIdentity: card.identities.printIdentity, effectIdentity: card.identities.effectIdentity, count };
    }),
  };
}

const routedTarget = (client) => ({ roomId: client.room().roomId, expectedVersion: client.room().version });

try {
  console.log('== 真实回合端到端：真实服务 + 两客户端 + 真实随机 ==');
  const health = await waitForHealth();
  check('服务健康检查可用', health.status === 'ok');

  // 座位 0 使用带唯一探针（珠贝）的卡组；隐藏身份不得进入座位 1 的载荷。
  const probeCardId = 'csve1-138';
  const deckA = buildDeck(fixture.content, [
    ['csve1-035', 4],
    [probeCardId, 4],
    ['cbb1c-1803', 52],
  ]);
  const deckB = buildDeck(fixture.content, [
    ['csve1-035', 4],
    ['cbb1c-1803', 56],
  ]);

  const rawB = [];
  const a = await connectClient('小智');
  const b = await connectClient('小茂', rawB);
  a.send({ type: 'create-room', commandId: commandId() });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.host, 10_000, '建房快照');
  b.send({ type: 'join-room', commandId: commandId(), code: a.room().code });
  await waitForMessage(b, (message) => message.type === 'room' && message.room.you.seat === 1, 10_000, '来宾加入');
  await waitForMessage(a, (message) => message.type === 'room' && message.room.opponent.occupied, 10_000, '房主看到来宾');

  a.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(a), deck: deckA });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.deck?.validation.ready === true, 10_000, 'A 卡组就绪');
  b.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(b), deck: deckB });
  await waitForMessage(b, (message) => message.type === 'room' && message.room.you.deck?.validation.ready === true, 10_000, 'B 卡组就绪');
  await waitForMessage(a, (message) => message.type === 'room' && message.room.opponent.deckSelected, 10_000, 'A 看到 B 选卡组');
  a.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(a), ready: true });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.ready === true, 10_000, 'A 准备');
  b.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(b), ready: true });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.status === 'started', 10_000, '开局建立');
  check('双方准备只建立同一会话', a.room().match.sessionId === b.room().match.sessionId);

  await waitForMessage(a, (message) => message.type === 'match', 10_000, 'A 开局视图');
  await waitForMessage(b, (message) => message.type === 'match', 10_000, 'B 开局视图');
  const winnerClient = a.match().pendingChoice?.kind === 'turn-order' ? a : b;
  const winnerIsA = winnerClient === a;
  check('只有获选方收到先后攻选择权', a.match().pendingChoice?.kind === 'turn-order' || b.match().pendingChoice?.kind === 'turn-order');
  winnerClient.send({
    type: 'choose-turn-order',
    commandId: commandId(),
    sessionId: winnerClient.match().sessionId,
    expectedVersion: winnerClient.match().version,
    choiceId: winnerClient.match().pendingChoice?.choiceId,
    goFirst: true,
  });

  // 自适应完成开局：盖放/补抽/最终备战。
  const sentChoices = new Map();
  const openingDeadline = Date.now() + 30_000;
  while (Date.now() < openingDeadline) {
    if (a.match()?.phase === 'playing' && b.match()?.phase === 'playing') {
      break;
    }
    for (const client of [a, b]) {
      const view = client.match();
      const choice = view?.pendingChoice;
      if (view === undefined || choice === null || choice === undefined || sentChoices.get(client) === choice.choiceId) {
        continue;
      }
      sentChoices.set(client, choice.choiceId);
      if (choice.kind === 'place-setup') {
        client.send({
          type: 'place-setup',
          commandId: commandId(),
          sessionId: view.sessionId,
          expectedVersion: view.version,
          choiceId: choice.choiceId,
          active: view.you.hand.findIndex((card) => card.isBasicPokemon),
          bench: [],
        });
      } else if (choice.kind === 'compensation-draw') {
        client.send({
          type: 'resolve-compensation',
          commandId: commandId(),
          sessionId: view.sessionId,
          expectedVersion: view.version,
          choiceId: choice.choiceId,
          draw: 0,
        });
      } else if (choice.kind === 'place-bench') {
        client.send({
          type: 'place-bench',
          commandId: commandId(),
          sessionId: view.sessionId,
          expectedVersion: view.version,
          choiceId: choice.choiceId,
          bench: [],
        });
      }
    }
    await sleep(25);
  }
  check('双方进入 playing', a.match()?.phase === 'playing' && b.match()?.phase === 'playing');
  const firstSeat = a.match().firstSeat;
  const firstClient = firstSeat === 0 ? a : b;
  const secondClient = firstSeat === 0 ? b : a;
  const firstSeatIndex = firstSeat;
  const secondSeatIndex = firstSeat === 0 ? 1 : 0;
  check('唯一首回合与先攻归属一致', a.match().turn === 1 && a.match().activeSeat === firstSeat && b.match().activeSeat === firstSeat);
  check('回合开始抽 1 张（首攻手牌 7）', firstClient.match().you.handCount === 7, `hand=${firstClient.match().you.handCount}`);

  const energyIndex = (view) => view.you.hand.findIndex((card) => card.kind === 'energy');
  const basicIndex = (view) => view.you.hand.findIndex((card) => card.isBasicPokemon);

  // ── 回合 1（先攻）：放基础、附能、重复附能被拒绝/重传不重复、首回合攻击被拒绝 ──
  const t1 = firstClient.match();
  const basic = basicIndex(t1);
  if (basic >= 0) {
    firstClient.send({
      type: 'play-basic',
      commandId: commandId(),
      sessionId: t1.sessionId,
      expectedVersion: t1.version,
      handIndex: basic,
    });
    await waitForMessage(firstClient, (message) => message.type === 'match' && message.view.you.bench.length === 1, 10_000, '先攻放基础');
    await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.opponent.bench.length === 1, 10_000, '对手可见基础');
    check('基础宝可梦经网络进入备战区且对手可见', secondClient.match().opponent.bench.length === 1);
  }
  const afterBasic = firstClient.match();
  const attachCommand = {
    type: 'attach-energy',
    commandId: commandId(),
    sessionId: afterBasic.sessionId,
    expectedVersion: afterBasic.version,
    handIndex: energyIndex(afterBasic),
    target: { slot: 'active' },
  };
  firstClient.send(attachCommand);
  await waitForMessage(firstClient, (message) => message.type === 'match' && message.view.you.active?.energies.length === 1, 10_000, '先攻附能');
  await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.opponent.active?.energies.length === 1, 10_000, '对手可见附能');
  check('每回合附能后对手可见公开能量', secondClient.match().opponent.active?.energies.length === 1);
  firstClient.send(attachCommand);
  await sleep(200);
  check('精确重传不重复附着能量', firstClient.match().you.active?.energies.length === 1);
  firstClient.send({
    type: 'attach-energy',
    commandId: commandId(),
    sessionId: firstClient.match().sessionId,
    expectedVersion: firstClient.match().version,
    handIndex: energyIndex(firstClient.match()),
    target: { slot: 'active' },
  });
  const secondAttachError = await waitForMessage(
    firstClient,
    (message) => message.type === 'match-error' && message.code === 'action-not-allowed',
    10_000,
    '第二次附能拒绝',
  );
  check('同一回合第二次附能被服务端拒绝', secondAttachError !== undefined);

  firstClient.send({
    type: 'attack',
    commandId: commandId(),
    sessionId: firstClient.match().sessionId,
    expectedVersion: firstClient.match().version,
    attackIndex: 0,
    target: { slot: 'active' },
  });
  const firstTurnAttack = await waitForMessage(
    firstClient,
    (message) => message.type === 'match-error' && message.code === 'action-not-allowed' && message.message.includes('最初回合'),
    10_000,
    '先攻首回合攻击拒绝',
  );
  check('先攻玩家最初回合不能使用招式', firstTurnAttack.message.includes('最初回合'));

  firstClient.send({
    type: 'end-turn',
    commandId: commandId(),
    sessionId: firstClient.match().sessionId,
    expectedVersion: firstClient.match().version,
  });
  await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.turn === 2, 10_000, '进入回合 2');
  check('先攻结束回合后轮到后攻方并完成回合开始抽牌', secondClient.match().turn === 2 && secondClient.match().activeSeat === secondSeatIndex);
  check('回合结束公开记录只在服务端生成一次', secondClient.match().events.filter((event) => event.type === 'turn-ended').length === 1);

  // ── 回合 2（后攻）：附能并用水枪造成伤害；旧版本命令被拒绝 ──
  const t2 = secondClient.match();
  const staleVersion = t2.version;
  secondClient.send({
    type: 'attach-energy',
    commandId: commandId(),
    sessionId: t2.sessionId,
    expectedVersion: t2.version + 50,
    handIndex: energyIndex(t2),
    target: { slot: 'active' },
  });
  const stale = await waitForMessage(secondClient, (message) => message.type === 'match-error' && message.code === 'stale-version', 10_000, '旧版本拒绝');
  check('旧版本附能被拒绝且状态不变', stale !== undefined && secondClient.match().activeSeat === secondSeatIndex);

  secondClient.send({
    type: 'attach-energy',
    commandId: commandId(),
    sessionId: secondClient.match().sessionId,
    expectedVersion: secondClient.match().version,
    handIndex: energyIndex(secondClient.match()),
    target: { slot: 'active' },
  });
  await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.you.active?.energies.length === 1, 10_000, '后攻附能');
  // 非法目标：客户端可以伪造目标，但服务端拒绝且不影响后续合法攻击。
  secondClient.send({
    type: 'attack',
    commandId: commandId(),
    sessionId: secondClient.match().sessionId,
    expectedVersion: secondClient.match().version,
    attackIndex: 0,
    target: { slot: 'bench', index: 0 },
  });
  const illegalTarget = await waitForMessage(
    secondClient,
    (message) => message.type === 'match-error' && message.code === 'illegal-target',
    10_000,
    '非法目标拒绝',
  );
  check('非法招式目标被服务端拒绝', illegalTarget !== undefined);
  secondClient.send({
    type: 'attack',
    commandId: commandId(),
    sessionId: secondClient.match().sessionId,
    expectedVersion: secondClient.match().version,
    attackIndex: 0,
    target: { slot: 'active' },
  });
  const victimClient = firstClient;
  await waitForMessage(victimClient, (message) => message.type === 'match' && message.view.you.active?.damageCounters === 1, 10_000, '伤害指示物');
  const attackerView = secondClient.match();
  const defenderView = firstClient.match();
  check('后攻方招式造成 10 点伤害（1 个伤害指示物）', defenderView.you.active?.damageCounters === 1 && attackerView.opponent.active?.damageCounters === 1);
  const attackEvent = defenderView.events.find((event) => event.type === 'attack-used');
  check('公开记录区分基础伤害与最终伤害', attackEvent?.baseDamage === 10 && attackEvent?.damage === 10);
  check(
    '公开记录区分伤害与伤害指示物',
    defenderView.events.some((event) => event.type === 'damage-counters-placed' && event.count === 1 && event.targetSeat === firstSeatIndex),
  );
  check('使用招式后回合结束并轮到先攻方', firstClient.match().turn === 3 && firstClient.match().activeSeat === firstSeatIndex);

  // 回合 3：先攻方附第二张能量并攻击，验证伤害再次生效（也验证能量不因招式消耗）。
  const t3 = firstClient.match();
  firstClient.send({
    type: 'attach-energy',
    commandId: commandId(),
    sessionId: t3.sessionId,
    expectedVersion: t3.version,
    handIndex: energyIndex(t3),
    target: { slot: 'active' },
  });
  const afterAttach3 = await waitForMessage(
    firstClient,
    (message) => message.type === 'match' && message.view.you.active?.energies.length === 2,
    10_000,
    '第三回合附能',
  );
  firstClient.send({
    type: 'attack',
    commandId: commandId(),
    sessionId: afterAttach3.view.sessionId,
    expectedVersion: afterAttach3.view.version,
    attackIndex: 0,
    target: { slot: 'active' },
  });
  await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.you.active?.damageCounters === 1, 10_000, '第二击');
  check('招式不消耗能量（攻击后仍保留 2 张）', firstClient.match().you.active?.energies.length === 2);
  check('双方每个回合都真实完成并推进到回合 4', secondClient.match().turn === 4);

  // ── 隐私与协议 ──
  const bMatchViews = b.messages.filter((message) => message.type === 'match').map((message) => message.view);
  check('对手载荷的手牌区始终没有身份', bMatchViews.every((view) => view.opponent.hand.length === 0));
  const bText = rawB.join('\n');
  // 规则允许的公开展示（重抽展示/公开翻面）不算泄露；其余出现探针卡即为泄露。
  const publiclyRevealed = new Set();
  for (const view of bMatchViews) {
    for (const event of view.events) {
      if (event.type === 'mulligan' && event.seat === 0) {
        for (const card of event.cards) {
          publiclyRevealed.add(card.cardId);
        }
      }
      if (event.type === 'setup-revealed' && event.seat === 0) {
        publiclyRevealed.add(event.active.cardId);
        for (const card of event.bench) {
          publiclyRevealed.add(card.cardId);
        }
      }
    }
  }
  check(
    'B 的原始载荷不含 A 未公开的隐藏探针卡（珠贝）',
    !bText.includes(probeCardId) || publiclyRevealed.has(probeCardId),
    'probe leak',
  );
  check('B 的原始载荷不含内部实例 ID 或牌序', !bText.includes('"instanceId"') && !bText.includes('deckOrder'));
  check('B 收到的所有原始载荷都能被协议解析器严格接受', rawB.every((raw) => parseServerMessage(raw).ok));
  check(
    'B 的每一份对局载荷都来自同一会话',
    bMatchViews.every((view) => view.sessionId === a.room().match?.sessionId || view.sessionId === b.match().sessionId),
  );

  // 发行目录仍不可开局：另起一个不带夹具的发布目录服务。
  const releaseService = spawn(
    process.execPath,
    [serviceEntry, '--host', '127.0.0.1', '--port', String(port + 1), '--db', join(directory, 'e2e-turn-release.sqlite')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const releaseLogs = [];
  releaseService.stdout.on('data', (chunk) => releaseLogs.push(chunk.toString('utf8')));
  releaseService.stderr.on('data', (chunk) => releaseLogs.push(chunk.toString('utf8')));
  const releaseDeadline = Date.now() + 15_000;
  while (Date.now() < releaseDeadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port + 1}/health`)).ok) {
        break;
      }
    } catch {
      /* 尚未就绪 */
    }
    await sleep(200);
  }
  const releaseIdentity = await createDeviceIdentity();
  const releaseConnectionResult = await connectToService({
    httpUrl: new URL(`http://127.0.0.1:${port + 1}/`),
    wsUrl: new URL(`ws://127.0.0.1:${port + 1}/`),
    identity: releaseIdentity,
    nickname: '发行检查',
  });
  if (!releaseConnectionResult.ok) {
    throw new Error(`发行检查连接失败: ${releaseConnectionResult.failure.message}`);
  }
  const releaseConnection = releaseConnectionResult.connection;
  const releaseMessages = [];
  releaseConnection.onMessage((message) => releaseMessages.push(message));
  const releaseClient = {
    connection: releaseConnection,
    messages: releaseMessages,
    room: () => [...releaseMessages].reverse().find((message) => message.type === 'room')?.room,
    send: (message) => releaseConnection.send(message),
  };
  try {
    releaseClient.send({ type: 'create-room', commandId: commandId() });
    await waitForMessage(releaseClient, (message) => message.type === 'room' && message.room.you.host, 10_000, '发行建房');
    const presetA = fixture.release.decks.find((deck) => deck.code === 'A');
    const presetC = fixture.release.decks.find((deck) => deck.code === 'C');
    const identityOf = (cardId) => {
      const card = fixture.release.cards.find((entry) => entry.id === cardId);
      if (card === undefined) {
        throw new Error(`发行目录缺少 ${cardId}`);
      }
      return { cardId, printIdentity: card.identities.printIdentity, effectIdentity: card.identities.effectIdentity };
    };
    const deckOf = (preset) => ({
      formatVersion: 1,
      environmentId: fixture.release.environment.id,
      cards: preset.cards.map((entry) => ({ ...identityOf(entry.id), count: entry.count })),
    });
    releaseClient.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(releaseClient), deck: deckOf(presetA) });
    await waitForMessage(releaseClient, (message) => message.type === 'room' && message.room.you.deckSelected, 10_000, '发行选卡组');
    check('T12 / #13：发行预设 A 已就绪', releaseClient.room().you.deck?.validation.ready === true);
    const selectCCommandId = commandId();
    releaseClient.send({ type: 'select-deck', commandId: selectCCommandId, ...routedTarget(releaseClient), deck: deckOf(presetC) });
    // T13/#14 已把 C/D 预设效果接入发行目录：C 现在必须判定为可正式对战，准备也必须被接受。
    await waitForMessage(releaseClient, (message) => message.type === 'room' && message.commandId === selectCCommandId, 10_000, '发行 C 选卡组');
    check('T13 / #14：发行预设 C 已就绪', releaseClient.room().you.deck?.validation.ready === true);
    releaseClient.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(releaseClient), ready: true });
    await waitForMessage(releaseClient, (message) => message.type === 'room' && message.room.you.ready === true, 10_000, '发行 C 准备');

    // 未接入效果仍不能在发行目录中准备：把预设 A 的一张训练家换成未接入的合法卡，必须被拒绝。
    const unsupportedCard = fixture.release.cards.find((card) => card.flags.effectSupported === false && card.flags.environmentLegal === true);
    if (unsupportedCard === undefined) {
      throw new Error('发行目录缺少未接入的合法卡，无法验证拒绝路径。');
    }
    const blockedDeck = deckOf(presetA);
    const trainerIndex = blockedDeck.cards.findIndex((entry) => fixture.release.cards.find((card) => card.id === entry.cardId)?.cardClass === 'trainer');
    if (trainerIndex < 0) {
      throw new Error('发行预设 A 缺少训练家卡，无法验证未接入效果拒绝路径。');
    }
    const blockedCards = blockedDeck.cards.map((entry, index) => (index === trainerIndex ? { ...identityOf(unsupportedCard.id), count: entry.count } : entry));
    const blockedCommandId = commandId();
    releaseClient.send({ type: 'select-deck', commandId: blockedCommandId, ...routedTarget(releaseClient), deck: { ...blockedDeck, cards: blockedCards } });
    await waitForMessage(releaseClient, (message) => message.type === 'room' && message.commandId === blockedCommandId, 10_000, '未接入效果卡组选择');
    check(
      '发行目录把含未接入效果的卡组标为不可准备并给出原因',
      releaseClient.room().you.deck?.validation.ready === false &&
        (releaseClient.room().you.deck?.validation.problems ?? []).some(
          (problem) => problem.code === 'effect-unsupported' || problem.code === 'engine-not-integrated',
        ),
    );
    releaseClient.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(releaseClient), ready: true });
    await waitForMessage(releaseClient, (message) => message.type === 'room-error' && message.code === 'deck-not-ready', 10_000, '发行拒绝准备');
    check('发行目录对含未接入效果的卡组：准备被拒绝', true);
  } finally {
    releaseClient.connection.close();
    releaseService.kill();
  }

  const matchCreatedCount = serviceLogs.join('').split('room.match_created').length - 1;
  check('服务端只记录一次 room.match_created', matchCreatedCount === 1, `count=${matchCreatedCount}`);
  check('获选方由测试推进的先攻座位正确执行', firstSeat === (winnerIsA ? 0 : 1));

  for (const client of [a, b]) {
    client.connection.close();
  }
} catch (error) {
  failures.push(`执行异常: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  service.kill();
  await sleep(300);
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n通过 ${passes.length} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
