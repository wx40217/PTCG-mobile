#!/usr/bin/env node
/**
 * 真实结算端到端验收脚本（T09 / #10）。
 *
 * 真实服务进程 + 两个真实 WebSocket 客户端，使用临时派生的测试夹具目录
 * （发行目录仍全部“效果未接入”）：
 *   准备完成 → 开局 → 后攻方附能并用基础伤害招式昏厥对手战斗宝可梦 →
 *   取奖赏卡（只公开张数，身份不泄露）→ 对手无后备补充 → 唯一终态
 *   （winner=攻击方，reason=no-pokemon）→ 双方房间进入 finished →
 *   返回原房间重新准备 → 新会话与旧会话分离（同一房间实例）。
 *
 * 同时覆盖：两个客户端看到同一结果；终态后继续出牌被 match-finished 拒绝；
 * 重复认输/重复终态只产生一次；原始载荷不含奖赏身份、内部实例 ID 或牌序；
 * 终局后换人加入的新设备看不到旧对局视图、拿不到旧会话命令；发行目录仍无法
 * 准备（效果支持没有被夹具“点亮”）。
 *
 * 用法: node scripts/e2e-settlement.mjs
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

const directory = mkdtempSync(join(tmpdir(), 'ptcg-e2e-settlement-'));
const port = 18792;

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
    const recent = client.messages
      .slice(-4)
      .map((message) =>
        message.type === 'match'
          ? `match v${message.view.version} phase=${message.view.phase} result=${JSON.stringify(message.view.result)}`
          : message.type === 'match-error'
            ? `error ${message.code}: ${message.message}`
            : message.type === 'room'
              ? `room v${message.room.version} ${message.room.status}`
              : message.type,
      )
      .join(' | ');
    throw new Error(`等待 ${label} 超时；最近消息: ${recent}`);
  })();
}

function waitForNextMessage(client, predicate, timeoutMs = 10_000, label = 'condition') {
  const since = client.messages.length;
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      for (let index = since; index < client.messages.length; index += 1) {
        const message = client.messages[index];
        if (predicate(message)) {
          return message;
        }
      }
      await sleep(20);
    }
    throw new Error(`等待 ${label} 超时`);
  })();
}

/** 发行目录副本 + 两个 E2E 夹具宝可梦（10 HP 靶子与 100 伤害攻击手）。 */
async function writeFixtureCatalog() {
  const release = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const { catalogVersion: _version, runtime: _runtime, ...content } = release;
  const template = release.cards.find((card) => card.id === 'csve1-035');
  if (template === undefined) {
    throw new Error('发行目录缺少模板卡 csve1-035');
  }
  const fixtureCard = (overrides) => ({
    ...template,
    abilities: [],
    ruleLabels: [],
    specialRuleTextZh: null,
    fullTextZh: overrides.nameZh,
    effectSummaryZh: '',
    mechanics: [],
    imageSource: null,
    decks: [],
    flags: { environmentLegal: true, legalityNoteZh: 'E2E 夹具', effectSupported: true, effectNoteZh: 'E2E 夹具' },
    ...overrides,
    identities: { effectIdentity: `fx:e2e:${overrides.id}`, printIdentity: `print:E2E:${overrides.id}`, nameGroupKey: `name:${overrides.nameZh}` },
    print: { ...template.print, printCode: 'E2E', number: overrides.id, total: '002', displayNumber: `E2E ${overrides.id}` },
  });
  const weak = fixtureCard({ id: 'e2e-weak', nameZh: 'E2E 弱小宝可梦', hp: 10, retreat: 0, attacks: [] });
  const attacker = fixtureCard({
    id: 'e2e-attacker',
    nameZh: 'E2E 攻击手',
    hp: 100,
    retreat: 1,
    attacks: [{ name: '终结', cost: ['水'], damage: '100', text: null, attackKind: null }],
  });
  const attackerB = fixtureCard({
    id: 'e2e-attacker-b',
    nameZh: 'E2E 攻击手二',
    hp: 100,
    retreat: 1,
    attacks: [{ name: '终结', cost: ['水'], damage: '100', text: null, attackKind: null }],
  });
  const fixture = {
    ...content,
    supportPolicy: {
      engineIntegration: 'integrated',
      playable: true,
      noteZh: '端到端测试夹具：效果支持只在测试环境模拟，不进入发行目录。',
    },
    cards: [
      ...content.cards.map((card) => ({
        ...card,
        flags: { ...card.flags, effectSupported: true, effectNoteZh: '端到端测试夹具。' },
      })),
      weak,
      attacker,
      attackerB,
    ],
  };
  const version = await computeCatalogVersion(fixture);
  const path = join(directory, 'fixture-catalog.json');
  writeFileSync(path, JSON.stringify({ ...fixture, catalogVersion: version }), 'utf8');
  return { path, release, version, content: fixture };
}

const fixture = await writeFixtureCatalog();
const service = spawn(
  process.execPath,
  [serviceEntry, '--host', '127.0.0.1', '--port', String(port), '--db', join(directory, 'e2e-settlement.sqlite'), '--catalog', fixture.path],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
const serviceLogs = [];
service.stdout.on('data', (chunk) => serviceLogs.push(chunk.toString('utf8')));
service.stderr.on('data', (chunk) => serviceLogs.push(chunk.toString('utf8')));

async function waitForHealth(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
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
const commandId = () => `e2e-settlement-${(commandSeq += 1)}`;

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
  return { identity, connection, messages, room, match, send: (message) => connection.send(message) };
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
  console.log('== 真实结算端到端：真实服务 + 两客户端 + 真实随机 ==');
  const health = await waitForHealth(`http://127.0.0.1:${port}/health`);
  check('服务健康检查可用', health.status === 'ok');

  const deck = buildDeck(fixture.content, [
    ['e2e-attacker', 4],
    ['e2e-attacker-b', 4],
    ['cbb1c-1803', 52],
  ]);

  const rawA = [];
  const rawB = [];
  const a = await connectClient('小智', rawA);
  const b = await connectClient('小茂', rawB);
  a.send({ type: 'create-room', commandId: commandId() });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.host, 10_000, '建房快照');
  b.send({ type: 'join-room', commandId: commandId(), code: a.room().code });
  await waitForMessage(b, (message) => message.type === 'room' && message.room.you.seat === 1, 10_000, '来宾加入');
  await waitForMessage(a, (message) => message.type === 'room' && message.room.opponent.occupied, 10_000, '房主看到来宾');

  for (const client of [a, b]) {
    client.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(client), deck });
    await waitForMessage(client, (message) => message.type === 'room' && message.room.you.deck?.validation.ready === true, 10_000, '卡组就绪');
  }
  a.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(a), ready: true });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.ready === true, 10_000, 'A 准备');
  await waitForMessage(b, (message) => message.type === 'room' && message.room.opponent.ready === true, 10_000, 'B 看到 A 准备');
  b.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(b), ready: true });
  const startedA = await waitForMessage(a, (message) => message.type === 'room' && message.room.status === 'started', 10_000, '开局建立');
  await waitForMessage(b, (message) => message.type === 'room' && message.room.status === 'started', 10_000, 'B 看到开局');
  const oldSession = startedA.room.match.sessionId;
  check('双方准备只建立同一会话', b.room().match.sessionId === oldSession);

  // ── 开局：先后攻、盖放（不放备战）、补抽与最终备战都选择最小动作 ──
  await waitForMessage(a, (message) => message.type === 'match', 10_000, 'A 开局视图');
  await waitForMessage(b, (message) => message.type === 'match', 10_000, 'B 开局视图');
  const winnerClient = a.match().pendingChoice?.kind === 'turn-order' ? a : b;
  await waitForMessage(winnerClient, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'turn-order', 10_000, '获选方选择先后攻');
  const winnerView = winnerClient.match();
  winnerClient.send({
    type: 'choose-turn-order',
    commandId: commandId(),
    sessionId: winnerView.sessionId,
    expectedVersion: winnerView.version,
    choiceId: winnerView.pendingChoice.choiceId,
    goFirst: true,
  });

  const submitted = new Map();
  const openingDeadline = Date.now() + 30_000;
  while (Date.now() < openingDeadline) {
    if (a.match()?.phase === 'playing' && b.match()?.phase === 'playing') {
      break;
    }
    for (const client of [a, b]) {
      const view = client.match();
      const choice = view?.pendingChoice;
      if (view === undefined || choice === null || choice === undefined || submitted.get(client) === choice.choiceId) {
        continue;
      }
      submitted.set(client, choice.choiceId);
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
        client.send({ type: 'resolve-compensation', commandId: commandId(), sessionId: view.sessionId, expectedVersion: view.version, choiceId: choice.choiceId, draw: 0 });
      } else if (choice.kind === 'place-bench') {
        client.send({ type: 'place-bench', commandId: commandId(), sessionId: view.sessionId, expectedVersion: view.version, choiceId: choice.choiceId, bench: [] });
      }
    }
    await sleep(25);
  }
  check('双方进入 playing', a.match()?.phase === 'playing' && b.match()?.phase === 'playing');
  const firstSeat = a.match().firstSeat;
  const firstClient = firstSeat === 0 ? a : b;
  const secondClient = firstSeat === 0 ? b : a;
  check('双方均未放备战：攻击后对手无法补充', firstClient.match().you.bench.length === 0 && secondClient.match().you.bench.length === 0);

  // 先攻方结束；后攻方附能并使用「终结」（100 伤害，基础伤害路径）。
  firstClient.send({ type: 'end-turn', commandId: commandId(), sessionId: firstClient.match().sessionId, expectedVersion: firstClient.match().version });
  await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.activeSeat === (firstSeat === 0 ? 1 : 0), 10_000, '轮到后攻方');
  const t2 = secondClient.match();
  const energyIndex = t2.you.hand.findIndex((card) => card.kind === 'energy');
  check('后攻方手牌有能量', energyIndex >= 0);
  secondClient.send({
    type: 'attach-energy',
    commandId: commandId(),
    sessionId: t2.sessionId,
    expectedVersion: t2.version,
    handIndex: energyIndex,
    target: { slot: 'active' },
  });
  const afterAttach = await waitForMessage(
    secondClient,
    (message) => message.type === 'match' && message.view.you.active?.energies.length === 1,
    10_000,
    '附能成功',
  );
  secondClient.send({
    type: 'attack',
    commandId: commandId(),
    sessionId: afterAttach.view.sessionId,
    expectedVersion: afterAttach.view.version,
    attackIndex: 0,
    target: { slot: 'active' },
  });

  // 昏厥后取奖赏卡：选择属于攻击方，身份不公开；之后因无后备判定终态。
  const prizeView = await waitForMessage(
    secondClient,
    (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'take-prizes',
    10_000,
    '取奖赏卡选择',
  );
  check('昏厥公开记录与取奖赏张数正确', firstClient.match().events.some((event) => event.type === 'pokemon-knocked-out' && event.prizeCount === 1));
  check('取奖赏选择属于攻击方', prizeView.view.pendingChoice.min === 1 && prizeView.view.pendingChoice.candidates.length === 6);
  secondClient.send({
    type: 'take-prizes',
    commandId: commandId(),
    sessionId: prizeView.view.sessionId,
    expectedVersion: prizeView.view.version,
    choiceId: prizeView.view.pendingChoice.choiceId,
    prizes: [0],
  });

  const finishedView = await waitForMessage(
    secondClient,
    (message) => message.type === 'match' && message.view.result !== null,
    10_000,
    '唯一终态',
  );
  const winnerSeat = firstSeat === 0 ? 1 : 0;
  check('终态为无后备败北且胜者是攻击方', finishedView.view.result?.winner === winnerSeat && finishedView.view.result?.reason === 'no-pokemon');
  check('攻击方拿取奖赏后剩余 5 张', finishedView.view.you.prizeCount === 5);
  check('公开记录只公开奖赏张数', finishedView.view.events.some((event) => event.type === 'prizes-taken' && event.count === 1 && event.remaining === 5));
  const prizeEvent = finishedView.view.events.find((event) => event.type === 'prizes-taken');
  check('公开记录不含奖赏身份字段', prizeEvent !== undefined && !('card' in prizeEvent) && !('cards' in prizeEvent));

  const loserView = await waitForMessage(firstClient, (message) => message.type === 'match' && message.view.result !== null, 10_000, '对手结果');
  check('双方结果视图一致', JSON.stringify(loserView.view.result) === JSON.stringify(finishedView.view.result));

  // 终态后继续出牌被拒绝，且不产生第二个终态。
  secondClient.send({ type: 'end-turn', commandId: commandId(), sessionId: finishedView.view.sessionId, expectedVersion: finishedView.view.version });
  await waitForMessage(secondClient, (message) => message.type === 'match-error' && message.code === 'match-finished', 10_000, '终态后拒绝出牌');
  check('终态后继续出牌被 match-finished 拒绝', true);
  check('match-finished 只出现一次', finishedView.view.events.filter((event) => event.type === 'match-finished').length === 1);

  // 房间进入 finished，保留旧会话；双方重新准备创建新会话。
  const finishedA = await waitForMessage(a, (message) => message.type === 'room' && message.room.status === 'finished', 10_000, 'A 看到 finished');
  await waitForMessage(b, (message) => message.type === 'room' && message.room.status === 'finished', 10_000, 'B 看到 finished');
  check('finished 房间保留原实例与旧会话', finishedA.room.roomId === a.room().roomId && finishedA.room.match.sessionId === oldSession);
  check('finished 后双方准备被撤销', finishedA.room.you.ready === false && a.room().opponent.ready === false);

  const roomIdBefore = finishedA.room.roomId;
  a.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(a), ready: true });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.ready === true, 10_000, 'A 重新准备');
  await waitForMessage(b, (message) => message.type === 'room' && message.room.status === 'finished' && message.room.opponent.ready === true, 10_000, 'B 看到 A 重新准备');
  b.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(b), ready: true });
  const restarted = await waitForMessage(
    a,
    (message) => message.type === 'room' && message.room.status === 'started' && message.room.match.sessionId !== oldSession,
    10_000,
    '重新开局',
  );
  await waitForMessage(b, (message) => message.type === 'room' && message.room.status === 'started' && message.room.match.sessionId !== oldSession, 10_000, 'B 重新开局');
  check('重新开局仍在原房间实例', restarted.room.roomId === roomIdBefore);
  check('新会话与旧会话不同', restarted.room.match.sessionId !== oldSession);
  await waitForMessage(a, (message) => message.type === 'match' && message.view.sessionId === restarted.room.match.sessionId, 10_000, 'A 新对局视图');
  await waitForMessage(b, (message) => message.type === 'match' && message.view.sessionId === restarted.room.match.sessionId, 10_000, 'B 新对局视图');
  check('新会话双方视图一致', a.match().sessionId === b.match().sessionId);

  const matchCreatedCount = serviceLogs.join('').split('room.match_created').length - 1;
  const matchFinishedCount = serviceLogs.join('').split('room.match_finished').length - 1;
  check('服务端记录两次开局、一次终局', matchCreatedCount === 2 && matchFinishedCount === 1, `created=${matchCreatedCount} finished=${matchFinishedCount}`);

  // ── 隐私与协议 ──
  const aViews = a.messages.filter((message) => message.type === 'match').map((message) => message.view);
  const bViews = b.messages.filter((message) => message.type === 'match').map((message) => message.view);
  check('对手载荷的手牌区始终没有身份', aViews.every((view) => view.opponent.hand.length === 0) && bViews.every((view) => view.opponent.hand.length === 0));
  const rawText = [...rawA, ...rawB].join('\n');
  check('原始载荷不含内部实例 ID、牌序或奖赏身份数组', !rawText.includes('"instanceId"') && !rawText.includes('deckOrder') && !rawText.includes('"prizes":['));
  check('全部原始载荷都能被协议解析器严格接受', [...rawA, ...rawB].every((raw) => parseServerMessage(raw).ok));

  // ── 终局后换人隐私：新座位设备不得继承旧对局视图（P1 回归）──
  const secondSession = restarted.room.match.sessionId;
  b.send({ type: 'concede', commandId: commandId(), sessionId: secondSession, expectedVersion: b.match().version });
  await waitForMessage(
    a,
    (message) => message.type === 'room' && message.room.status === 'finished' && message.room.version > restarted.room.version,
    10_000,
    'A 看到第二终局',
  );
  await waitForMessage(
    b,
    (message) => message.type === 'room' && message.room.status === 'finished' && message.room.version > restarted.room.version,
    10_000,
    'B 看到第二终局',
  );
  const bFinishedRoom = b.room();
  b.send({ type: 'leave-room', commandId: commandId(), roomId: bFinishedRoom.roomId, expectedVersion: bFinishedRoom.version });
  await waitForMessage(b, (message) => message.type === 'room-left', 10_000, 'B 离开释放座位');
  await waitForMessage(a, (message) => message.type === 'room' && message.room.opponent.occupied === false, 10_000, '座位释放');

  const rawC = [];
  const c = await connectClient('小刚', rawC);
  c.send({ type: 'join-room', commandId: commandId(), code: bFinishedRoom.code });
  const cJoined = await waitForMessage(c, (message) => message.type === 'room' && message.room.you.seat === 1, 10_000, 'C 首次加入');
  c.send({ type: 'join-room', commandId: commandId(), code: cJoined.room.code, roomId: cJoined.room.roomId });
  await waitForNextMessage(c, (message) => message.type === 'room' && message.room.you.seat === 1, 10_000, 'C 重入');
  c.send({ type: 'create-room', commandId: commandId() });
  await waitForNextMessage(c, (message) => message.type === 'room' && message.room.roomId === cJoined.room.roomId, 10_000, 'C 重复建房回到原房间');
  check('换人加入/重入/重复建房从未收到任何旧对局视图', c.messages.every((message) => message.type !== 'match'));
  check('换人载荷不含旧昵称', !rawC.join('\n').includes('小茂'));
  c.send({ type: 'end-turn', commandId: commandId(), sessionId: secondSession, expectedVersion: 1 });
  const cRejected = await waitForMessage(c, (message) => message.type === 'match-error', 10_000, 'C 旧会话命令被拒');
  check(
    '换人旧会话命令被拒为 not-in-match 且错误不带私人视图',
    cRejected.code === 'not-in-match' && cRejected.view === undefined && c.messages.every((message) => message.type !== 'match'),
  );
  check('原座位 A 仍能看到第二局终态', a.messages.some((message) => message.type === 'match' && message.view.sessionId === secondSession && message.view.result !== null));
  c.connection.close();

  // 发行目录仍不可开局：另起一个不带夹具的发布目录服务。
  const releaseService = spawn(
    process.execPath,
    [serviceEntry, '--host', '127.0.0.1', '--port', String(port + 1), '--db', join(directory, 'e2e-settlement-release.sqlite')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await waitForHealth(`http://127.0.0.1:${port + 1}/health`);
    const releaseIdentity = await createDeviceIdentity();
    const releaseResult = await connectToService({
      httpUrl: new URL(`http://127.0.0.1:${port + 1}/`),
      wsUrl: new URL(`ws://127.0.0.1:${port + 1}/`),
      identity: releaseIdentity,
      nickname: '发行检查',
    });
    if (!releaseResult.ok) {
      throw new Error(`发行检查连接失败: ${releaseResult.failure.message}`);
    }
    const releaseConnection = releaseResult.connection;
    const releaseMessages = [];
    releaseConnection.onMessage((message) => releaseMessages.push(message));
    const releaseClient = {
      connection: releaseConnection,
      messages: releaseMessages,
      room: () => [...releaseMessages].reverse().find((message) => message.type === 'room')?.room,
      send: (message) => releaseConnection.send(message),
    };
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
    releaseClient.send({
      type: 'select-deck',
      commandId: commandId(),
      ...routedTarget(releaseClient),
      deck: deckOf(presetA),
    });
    await waitForMessage(releaseClient, (message) => message.type === 'room' && message.room.you.deckSelected, 10_000, '发行选卡组');
    check('T12 / #13：发行预设 A 已就绪', releaseClient.room().you.deck?.validation.ready === true);
    const selectCCommandId = commandId();
    releaseClient.send({
      type: 'select-deck',
      commandId: selectCCommandId,
      ...routedTarget(releaseClient),
      deck: deckOf(presetC),
    });
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
    check('发行目录对含未接入效果的卡组：预设准备被拒绝', true);
    releaseClient.connection.close();
  } finally {
    releaseService.kill();
  }

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
