#!/usr/bin/env node
/**
 * 真实服务端到端：断线恢复（#15 / T14）。
 *
 * 真实服务进程 + 真实 WebSocket 客户端 + 测试夹具目录，覆盖：
 *   - 断线进入等待、预算内重连恢复同一会话/版本/待决选择；
 *   - 「提交已生效但确认丢失」：相同 commandId 重发得到同一结果、不重复生效；
 *   - 奖赏选择与换位选择的通用恢复路径（同一恢复机制，不为每种效果写特殊路径）；
 *   - 检索待决选择在真实传输中断期间恢复同一 choiceId/候选/手牌，恢复后完成检索，
 *     且断线前后对手载荷都不含仍隐藏的私人候选；
 *   - 单方超限且对手在线判负、双方离线无胜负中止（短预算服务，真实定时器）；
 *   - 服务重启：实例身份变化、旧房间/旧会话不可静默恢复。
 *
 * 用法: node scripts/e2e-recovery.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCandidatePrivacy, publicIdsFor } from './trainer-privacy-oracle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const serviceEntry = join(root, 'packages', 'service', 'dist', 'main.js');
const protocolEntry = join(root, 'packages', 'protocol', 'dist', 'index.js');
const catalogPath = join(root, 'data', 'catalog', 'zh-cn-standard-2025-06-05-catalog.json');

const { computeCatalogVersion, connectToService, createDeviceIdentity, parseServerMessage } = await import(
  new URL(`file://${protocolEntry.replace(/\\/gu, '/')}`)
);

const directory = mkdtempSync(join(tmpdir(), 'ptcg-e2e-recovery-'));
const PORT_LONG = 18803;
const PORT_SHORT = 18804;
const PORT_RESTART = 18805;

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
      .slice(-5)
      .map((message) =>
        message.type === 'match'
          ? `match v${message.view.version} phase=${message.view.phase} result=${JSON.stringify(message.view.result)}`
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
        if (predicate(client.messages[index])) {
          return client.messages[index];
        }
      }
      await sleep(20);
    }
    throw new Error(`等待 ${label} 超时`);
  })();
}

/** 从指定消息下标开始等待第一条匹配消息；用于跨 WS 回调的屏障等待。 */
function waitForMessageFrom(client, from, predicate, timeoutMs = 10_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      for (let index = from; index < client.messages.length; index += 1) {
        if (predicate(client.messages[index])) {
          return client.messages[index];
        }
      }
      await sleep(20);
    }
    throw new Error(`等待 ${label} 超时`);
  })();
}

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

/** 生成夹具目录：全部效果已接入 + 可昏厥的弱小宝可梦与 100 伤害攻击手。 */
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
    flags: { environmentLegal: true, legalityNoteZh: 'E2E 恢复夹具', effectSupported: true, effectNoteZh: 'E2E 恢复夹具' },
    ...overrides,
    identities: {
      effectIdentity: `fx:e2e-recovery:${overrides.id}`,
      printIdentity: `print:E2E-RECOVERY:${overrides.id}`,
      nameGroupKey: `name:${overrides.nameZh}`,
    },
    print: { ...template.print, printCode: 'E2E-REC', number: overrides.id, total: '002', displayNumber: `E2E-REC ${overrides.id}` },
  });
  const attacker = fixtureCard({
    id: 'e2e-rec-attacker',
    nameZh: '恢复攻击手',
    hp: 100,
    retreat: 1,
    attacks: [{ name: '终结', cost: ['水'], damage: '100', text: null, attackKind: null }],
  });
  const attackerB = fixtureCard({
    id: 'e2e-rec-attacker-b',
    nameZh: '恢复攻击手二',
    hp: 100,
    retreat: 1,
    attacks: [{ name: '终结', cost: ['水'], damage: '100', text: null, attackKind: null }],
  });
  const weak = Array.from({ length: 6 }, (_entry, index) =>
    fixtureCard({
      id: `e2e-rec-weak-${index + 1}`,
      nameZh: `恢复弱小${index + 1}`,
      hp: 10,
      retreat: 0,
      // 所有基础都能被 100 伤害招呼；谁当战斗宝可梦都能推进到昏厥。
      attacks: [{ name: '终结', cost: ['水'], damage: '100', text: null, attackKind: null }],
    }),
  );
  const searchTemplate = release.cards.find((card) => card.id === 'cbb1c-1703');
  if (searchTemplate === undefined) {
    throw new Error('发行目录缺少模板卡 cbb1c-1703');
  }
  // 高级球别名：同一效果身份、各自独立印刷身份，保证检索方手牌必有机会拿到检索牌。
  const searchAliases = Array.from({ length: 20 }, (_entry, index) => ({
    ...searchTemplate,
    id: `e2e-rec-search-${index + 1}`,
    nameZh: `恢复高级球${index + 1}`,
    decks: [],
    imageSource: null,
    flags: { ...searchTemplate.flags, effectSupported: true, effectNoteZh: '断线检索恢复夹具别名。' },
    identities: {
      effectIdentity: 'fx:trainer:高级球:d8722e9e5903',
      printIdentity: `print:E2E-RECOVERY:search-${index + 1}`,
      nameGroupKey: `name:恢复高级球${index + 1}`,
    },
    print: { ...searchTemplate.print, printCode: 'E2E-REC', number: `search-${index + 1}`, total: '060', displayNumber: `E2E-REC 恢复高级球${index + 1}` },
  }));
  // 非基础探针宝可梦：每个座位一套独立身份，只用于验证「检索私人候选在公开前
  // 不进入对手载荷」；如果两边共用同名身份，对手自己的手牌会构成假阳性。
  const probes = ['a', 'b'].flatMap((side) =>
    Array.from({ length: 8 }, (_entry, index) =>
      fixtureCard({
        id: `e2e-rec-probe-${side}-${index + 1}`,
        nameZh: `恢复检索探针${side.toUpperCase()}${index + 1}`,
        hp: 100,
        subtypes: ['1阶进化'],
        retreat: 1,
        attacks: [{ name: '试探', cost: ['水'], damage: '10', text: null, attackKind: null }],
      }),
    ),
  );
  const fixture = {
    ...content,
    supportPolicy: {
      engineIntegration: 'integrated',
      playable: true,
      noteZh: '断线恢复端到端夹具：只在本机临时目录生成，不进入发行目录。',
    },
    cards: [
      ...content.cards.map((card) => ({
        ...card,
        flags: { ...card.flags, effectSupported: true, effectNoteZh: '断线恢复端到端夹具。' },
      })),
      attacker,
      attackerB,
      ...weak,
      ...searchAliases,
      ...probes,
    ],
  };
  const version = await computeCatalogVersion(fixture);
  const path = join(directory, 'fixture-catalog.json');
  writeFileSync(path, JSON.stringify({ ...fixture, catalogVersion: version }), 'utf8');
  return { path, release, content: fixture };
}

const fixture = await writeFixtureCatalog();

let commandSeq = 0;
const commandId = (label) => `e2e-recovery-${label ?? 'cmd'}-${(commandSeq += 1)}`;

const liveServices = [];

function spawnService(port, extraArgs, logSink) {
  const child = spawn(
    process.execPath,
    [serviceEntry, '--host', '127.0.0.1', '--port', String(port), '--db', join(directory, `e2e-recovery-${port}.sqlite`), '--catalog', fixture.path, ...extraArgs],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => logSink.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => logSink.push(chunk.toString('utf8')));
  liveServices.push({ child, port });
  console.log(`  INFO  启动临时服务 pid=${child.pid} 监听 127.0.0.1:${port}`);
  return child;
}

async function stopService(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleep(50);
  }
}

process.once('SIGINT', () => {
  void (async () => {
    for (const { child } of liveServices) {
      await stopService(child);
    }
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* 中断清理失败不改变退出码 */
    }
    process.exit(130);
  })();
});

async function connectClient(port, nickname, options = {}) {
  const identity = options.identity ?? (await createDeviceIdentity());
  const rawLog = options.rawLog ?? [];
  const result = await connectToService(
    {
      httpUrl: new URL(`http://127.0.0.1:${port}/`),
      wsUrl: new URL(`ws://127.0.0.1:${port}/`),
      identity,
      nickname,
    },
    options.recordRaw === true
      ? {
          openSocket: (url) => {
            const socket = new WebSocket(url);
            socket.addEventListener('message', (event) => {
              if (typeof event.data === 'string') {
                rawLog.push(event.data);
              }
            });
            return socket;
          },
        }
      : {},
  );
  if (!result.ok) {
    throw new Error(`客户端 ${nickname} 连接失败: ${result.failure.message}`);
  }
  const connection = result.connection;
  const messages = [];
  connection.onMessage((message) => messages.push(message));
  const room = () => [...messages].reverse().find((message) => message.type === 'room')?.room;
  const match = () => [...messages].reverse().find((message) => message.type === 'match')?.view;
  return {
    identity,
    connection,
    messages,
    rawLog,
    room,
    match,
    send: (message) => connection.send(message),
    close: () => connection.close(),
  };
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

/** 既有断线场景使用的 60 张夹具卡组。 */
const RECOVERY_DECK_CARDS = [
  ['e2e-rec-attacker', 4],
  ['e2e-rec-attacker-b', 4],
  ['e2e-rec-weak-1', 4],
  ['e2e-rec-weak-2', 4],
  ['e2e-rec-weak-3', 4],
  ['e2e-rec-weak-4', 4],
  ['e2e-rec-weak-5', 4],
  ['e2e-rec-weak-6', 4],
  ['cbb1c-1803', 28],
];

/** 检索恢复场景卡组：32 张基础宝可梦 + 16 个高级球别名 + 8 个隐藏探针 + 4 张能量。 */
function searchRecoveryDeckCards(side) {
  const cards = [];
  for (let index = 1; index <= 16; index += 1) {
    cards.push([`e2e-rec-search-${index}`, 1]);
  }
  for (let index = 1; index <= 8; index += 1) {
    cards.push([`e2e-rec-probe-${side}-${index}`, 1]);
  }
  cards.push(['e2e-rec-attacker', 4], ['e2e-rec-attacker-b', 4]);
  for (let index = 1; index <= 6; index += 1) {
    cards.push([`e2e-rec-weak-${index}`, 4]);
  }
  cards.push(['cbb1c-1803', 4]);
  return cards;
}

/** 建房、加入、选卡组、准备；返回开局会话。 */
async function startMatch(port, nicknameA, nicknameB, deckCardsA = RECOVERY_DECK_CARDS, deckCardsB = deckCardsA) {
  const deckA = buildDeck(fixture.content, deckCardsA);
  const deckB = buildDeck(fixture.content, deckCardsB);
  const a = await connectClient(port, nicknameA, { recordRaw: true });
  const b = await connectClient(port, nicknameB, { recordRaw: true });
  a.send({ type: 'create-room', commandId: commandId('create') });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.host, 10_000, '建房');
  b.send({ type: 'join-room', commandId: commandId('join'), code: a.room().code });
  await waitForMessage(b, (message) => message.type === 'room' && message.room.you.seat === 1, 10_000, '加入');
  await waitForMessage(a, (message) => message.type === 'room' && message.room.opponent.occupied, 10_000, '房主看到来宾');
  for (const [client, deck] of [
    [a, deckA],
    [b, deckB],
  ]) {
    client.send({ type: 'select-deck', commandId: commandId('deck'), ...routedTarget(client), deck });
    await waitForMessage(client, (message) => message.type === 'room' && message.room.you.deck?.validation.ready === true, 10_000, '卡组就绪');
  }
  a.send({ type: 'set-ready', commandId: commandId('ready'), ...routedTarget(a), ready: true });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.ready === true, 10_000, 'A 准备');
  await waitForMessage(b, (message) => message.type === 'room' && message.room.opponent.ready === true, 10_000, 'B 看到 A 准备');
  b.send({ type: 'set-ready', commandId: commandId('ready'), ...routedTarget(b), ready: true });
  const started = await waitForMessage(a, (message) => message.type === 'room' && message.room.status === 'started', 10_000, '开局');
  await waitForMessage(b, (message) => message.type === 'room' && message.room.status === 'started', 10_000, 'B 看到开局');
  return { a, b, sessionId: started.room.match.sessionId, roomId: started.room.roomId, code: started.room.code };
}

/** 重连同一设备身份并重入稳定房间实例。 */
async function rejoin(port, original, nickname) {
  const client = await connectClient(port, nickname, { identity: original.identity, recordRaw: true });
  const room = original.room();
  client.send({ type: 'join-room', commandId: commandId('rejoin'), code: room.code, roomId: room.roomId });
  await waitForMessage(client, (message) => message.type === 'room' && message.room.you.occupied && message.room.roomId === room.roomId, 10_000, '重入快照');
  return client;
}

/** 自适应完成剩余开局：盖放、补抽、备战，直到双方 playing。 */
async function completeSetupUntilPlaying(a, b) {
  const submitted = new Map();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (a.match()?.phase === 'playing' && b.match()?.phase === 'playing') {
      return;
    }
    for (const client of [a, b]) {
      const view = client.match();
      const choice = view?.pendingChoice;
      if (view === undefined || choice === null || choice === undefined || submitted.get(client) === choice.choiceId) {
        continue;
      }
      submitted.set(client, choice.choiceId);
      if (choice.kind === 'place-setup') {
        const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
        client.send({
          type: 'place-setup',
          commandId: commandId('setup'),
          sessionId: view.sessionId,
          expectedVersion: view.version,
          choiceId: choice.choiceId,
          active: basics[0] ?? 0,
          bench: basics.slice(1, 2),
        });
      } else if (choice.kind === 'compensation-draw') {
        client.send({ type: 'resolve-compensation', commandId: commandId('comp'), sessionId: view.sessionId, expectedVersion: view.version, choiceId: choice.choiceId, draw: 0 });
      } else if (choice.kind === 'place-bench') {
        const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
        client.send({ type: 'place-bench', commandId: commandId('bench'), sessionId: view.sessionId, expectedVersion: view.version, choiceId: choice.choiceId, bench: basics.slice(0, 1) });
      }
    }
    await sleep(25);
  }
  throw new Error('开局未在限定时间内进入 playing');
}

/** 获选方选择先后攻，然后自适应完成剩余开局。 */
async function completeOpening(a, b) {
  const winnerClient = a.match()?.pendingChoice?.kind === 'turn-order' ? a : b;
  await waitForMessage(winnerClient, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'turn-order', 10_000, '先后攻选择');
  const turnView = winnerClient.match();
  winnerClient.send({
    type: 'choose-turn-order',
    commandId: commandId('order'),
    sessionId: turnView.sessionId,
    expectedVersion: turnView.version,
    choiceId: turnView.pendingChoice.choiceId,
    goFirst: true,
  });
  await completeSetupUntilPlaying(a, b);
}

/** 结束指定客户端的回合并等待目标回合编号。 */
async function endTurnAndWait(client, nextTurn) {
  const view = client.match();
  const command = commandId('end');
  client.send({ type: 'end-turn', commandId: command, sessionId: view.sessionId, expectedVersion: view.version });
  await waitForMessage(client, (message) => message.type === 'match' && message.commandId === command, 10_000, '结束回合结果');
  await waitForMessage(client, (message) => message.type === 'match' && message.view.turn === nextTurn, 10_000, `回合 ${nextTurn}`);
}

/** 确保检索方手牌出现「恢复高级球」别名；必要时交替结束回合继续抽牌。 */
async function ensureSearchCard(searchPlayer, otherPlayer, maxRounds = 12) {
  const hasSearchCard = () => searchPlayer.match().you.hand.some((card) => card.nameZh.startsWith('恢复高级球'));
  for (let round = 0; round <= maxRounds; round += 1) {
    if (hasSearchCard()) {
      return;
    }
    if (round === maxRounds) {
      throw new Error('等待恢复高级球别名进入手牌超时');
    }
    const turn = searchPlayer.match().turn;
    await endTurnAndWait(searchPlayer, turn + 1);
    await waitForMessage(otherPlayer, (message) => message.type === 'match' && message.view.turn === turn + 1 && message.view.activeSeat === otherPlayer.room().you.seat, 10_000, `对手回合 ${turn + 1}`);
    await endTurnAndWait(otherPlayer, turn + 2);
    await waitForMessage(searchPlayer, (message) => message.type === 'match' && message.view.turn === turn + 2 && message.view.activeSeat === searchPlayer.room().you.seat, 10_000, `检索方回合 ${turn + 2}`);
  }
}

const longLogs = [];
const shortLogs = [];
const restartLogs = [];
let serviceLong;
let serviceShort;
let serviceRestart;
const openClients = [];

try {
  console.log('== #15 真实服务断线恢复端到端 ==');

  // ── 服务 1：长预算，覆盖开局/奖赏/换位恢复与丢确认重发 ──
  serviceLong = spawnService(PORT_LONG, [], longLogs);
  const health = await waitForHealth(`http://127.0.0.1:${PORT_LONG}/health`);
  check('长预算服务健康检查可用', health.status === 'ok');

  const { a, b, sessionId } = await startMatch(PORT_LONG, '小智', '小茂');
  openClients.push(a, b);
  check('对局建立且双方进入开局', a.room().status === 'started' && b.room().status === 'started');
  const initialA = await waitForMessage(a, (message) => message.type === 'match', 10_000, 'A 开局视图').then((message) => message.view);
  const initialB = await waitForMessage(b, (message) => message.type === 'match', 10_000, 'B 开局视图').then((message) => message.view);
  check('开局待决选择属于获选座位', initialA.pendingChoice?.kind === 'turn-order' || initialB.pendingChoice?.kind === 'turn-order');

  const chooser = initialA.pendingChoice?.kind === 'turn-order' ? a : b;
  const other = chooser === a ? b : a;
  const chooserName = chooser === a ? '小智' : '小茂';
  const chooserView = chooser.match();

  // 断线：对手立刻看到等待重连。
  chooser.close();
  const waiting = await waitForMessage(other, (message) => message.type === 'match' && message.view.connection?.opponentOnline === false, 10_000, '对手看到等待重连');
  check('断线后对手进入等待并看到离线状态', waiting.view.connection.opponentOnline === false);

  // 预算内重连：同一会话、版本与待决选择。
  const chooser2 = await rejoin(PORT_LONG, chooser, chooserName);
  openClients.push(chooser2);
  const resumed = await waitForMessage(chooser2, (message) => message.type === 'match' && message.view.connection?.youOnline === true, 10_000, '重连恢复');
  check('重连恢复同一会话', resumed.view.sessionId === sessionId);
  check('重连恢复同一版本', resumed.view.version === chooserView.version);
  check('重连恢复同一待决选择', resumed.view.pendingChoice?.choiceId === chooserView.pendingChoice?.choiceId);
  check('重连后本人手牌一致', JSON.stringify(resumed.view.you.hand) === JSON.stringify(chooserView.you.hand));

  // 确认丢失：命令已生效但连接立刻断开，重连后同 commandId 原样重发。
  const orderCommand = {
    type: 'choose-turn-order',
    commandId: commandId('lost-ack'),
    sessionId: resumed.view.sessionId,
    expectedVersion: resumed.view.version,
    choiceId: resumed.view.pendingChoice.choiceId,
    goFirst: true,
  };
  chooser2.send(orderCommand);
  const applied = await waitForMessage(other, (message) => message.type === 'match' && message.view.events.some((event) => event.type === 'turn-order-chosen'), 10_000, '先后攻已生效');
  const appliedVersion = applied.view.version;
  chooser2.close();
  const chooser3 = await rejoin(PORT_LONG, chooser2, chooserName);
  openClients.push(chooser3);
  chooser3.send(orderCommand);
  const duplicate = await waitForNextMessage(
    chooser3,
    (message) => message.type === 'match' && message.commandId === orderCommand.commandId,
    10_000,
    '同 commandId 重发结果',
  );
  check('同 commandId 重发得到同一版本结果', duplicate.view.version === appliedVersion);
  check('重发没有重复执行先后攻', duplicate.view.events.filter((event) => event.type === 'turn-order-chosen').length === 1);
  check('重发后服务端版本未再次推进', other.match().version === appliedVersion);
  await completeSetupUntilPlaying(chooser3, other);
  check('双方完成开局进入 playing', chooser3.match().phase === 'playing' && other.match().phase === 'playing');

  // 推进到昏厥：先攻方结束回合，后攻方附能并使用 100 伤害招式。
  const seat0 = chooser3.room().you.seat === 0 ? chooser3 : other;
  const seat1 = seat0 === chooser3 ? other : chooser3;
  const firstSeat = chooser3.match().firstSeat;
  const firstClient = firstSeat === 0 ? seat0 : seat1;
  const secondClient = firstSeat === 0 ? seat1 : seat0;
  firstClient.send({ type: 'end-turn', commandId: commandId('end'), sessionId: firstClient.match().sessionId, expectedVersion: firstClient.match().version });
  await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.activeSeat === secondClient.match().you.seat, 10_000, '轮到后攻方');
  const turn = secondClient.match();
  const energyIndex = turn.you.hand.findIndex((card) => card.kind === 'energy');
  check('后攻方手牌有能量', energyIndex >= 0);
  secondClient.send({
    type: 'attach-energy',
    commandId: commandId('attach'),
    sessionId: turn.sessionId,
    expectedVersion: turn.version,
    handIndex: energyIndex,
    target: { slot: 'active' },
  });
  const afterAttach = await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.you.active?.energies.length === 1, 10_000, '附能');
  secondClient.send({
    type: 'attack',
    commandId: commandId('attack'),
    sessionId: afterAttach.view.sessionId,
    expectedVersion: afterAttach.view.version,
    attackIndex: 0,
    target: { slot: 'active' },
  });

  // 奖赏选择属于攻击方：先断线再重连，恢复同一 choiceId 与版本。
  const prizePending = await waitForMessage(secondClient, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'take-prizes', 10_000, '取奖赏选择').then((message) => message.view);
  secondClient.close();
  const second2 = await rejoin(PORT_LONG, secondClient, secondClient === a ? '小智' : '小茂');
  openClients.push(second2);
  const prizeResumed = await waitForMessage(second2, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'take-prizes', 10_000, '重连后取奖赏选择');
  check('重连恢复奖赏选择的同一 choiceId', prizeResumed.view.pendingChoice?.choiceId === prizePending.pendingChoice.choiceId);
  check('重连恢复奖赏选择的同一版本', prizeResumed.view.version === prizePending.version);
  check('重连恢复本人完整手牌', JSON.stringify(prizeResumed.view.you.hand) === JSON.stringify(prizePending.you.hand));
  second2.send({
    type: 'take-prizes',
    commandId: commandId('prizes'),
    sessionId: prizeResumed.view.sessionId,
    expectedVersion: prizeResumed.view.version,
    choiceId: prizeResumed.view.pendingChoice.choiceId,
    prizes: [0],
  });

  // 换位选择属于被昏厥方：再次断线重连，恢复同一 choiceId 后完成换位。
  const replacementPending = await waitForMessage(
    firstClient,
    (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'choose-replacement',
    10_000,
    '换位选择',
  ).then((message) => message.view);
  firstClient.close();
  const first2 = await rejoin(PORT_LONG, firstClient, firstClient === a ? '小智' : '小茂');
  openClients.push(first2);
  const replacementResumed = await waitForMessage(first2, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'choose-replacement', 10_000, '重连后换位选择');
  check('重连恢复换位选择的同一 choiceId', replacementResumed.view.pendingChoice?.choiceId === replacementPending.pendingChoice.choiceId);
  check('重连恢复换位选择的同一版本', replacementResumed.view.version === replacementPending.version);
  first2.send({
    type: 'choose-replacement',
    commandId: commandId('replace'),
    sessionId: replacementResumed.view.sessionId,
    expectedVersion: replacementResumed.view.version,
    choiceId: replacementResumed.view.pendingChoice.choiceId,
    benchIndex: 0,
  });
  const continued = await waitForMessage(first2, (message) => message.type === 'match' && message.view.pendingChoice === null && message.view.result === null, 10_000, '换位后继续');
  check('换位后对局继续且无重复终态', continued.view.result === null);

  // 隐私：重连载荷仍只按座位投影。
  const allRaw = openClients.flatMap((client) => client.rawLog);
  const rawText = allRaw.join('\n');
  check('原始载荷不含内部实例 ID 或牌序', !rawText.includes('"instanceId"') && !rawText.includes('deckOrder'));
  check('全部原始载荷都能被协议严格解析', allRaw.every((raw) => parseServerMessage(raw).ok));
  check(
    '对手载荷从未携带手牌身份',
    openClients.every((client) => client.messages.every((message) => message.type !== 'match' || message.view.opponent.hand.length === 0)),
  );

  // ── 检索待决选择：真实传输中断后恢复同一 choiceId/候选/手牌并完成检索 ──
  const searchMatch = await startMatch(PORT_LONG, '检索甲', '检索乙', searchRecoveryDeckCards('a'), searchRecoveryDeckCards('b'));
  openClients.push(searchMatch.a, searchMatch.b);
  await waitForMessage(searchMatch.a, (message) => message.type === 'match', 10_000, '检索对局 A 视图');
  await waitForMessage(searchMatch.b, (message) => message.type === 'match', 10_000, '检索对局 B 视图');
  await completeOpening(searchMatch.a, searchMatch.b);
  const searchPlayer = searchMatch.a.match().firstSeat === 0 ? searchMatch.a : searchMatch.b;
  const otherPlayer = searchPlayer === searchMatch.a ? searchMatch.b : searchMatch.a;
  const searchPlayerName = searchPlayer === searchMatch.a ? '检索甲' : '检索乙';
  const searchSide = searchPlayer === searchMatch.a ? 'a' : 'b';
  const probePrefix = `e2e-rec-probe-${searchSide}-`;
  check('检索对局完成开局', searchPlayer.match().phase === 'playing' && otherPlayer.match().phase === 'playing');
  if (searchPlayer.match().activeSeat !== searchPlayer.room().you.seat) {
    // 先手方结束首回合，让检索方在无先攻限制的第 2 回合行动。
    const turn = otherPlayer.match().turn;
    await endTurnAndWait(otherPlayer, turn + 1);
    await waitForMessage(searchPlayer, (message) => message.type === 'match' && message.view.turn === turn + 1 && message.view.activeSeat === searchPlayer.room().you.seat, 10_000, '检索方行动回合');
  }
  await ensureSearchCard(searchPlayer, otherPlayer);
  check('检索方手牌出现高级球别名', searchPlayer.match().you.hand.some((card) => card.nameZh.startsWith('恢复高级球')));

  // 动作前冻结接收方已合法公开的身份，并记录原始载荷位置；隐私判定只使用
  // 冻结集合与动作后新收到的载荷，避免新泄露事件把自己的身份洗白。
  const frozenPublicIds = publicIdsFor(otherPlayer);
  const rawFrom = otherPlayer.rawLog.length;
  const playView = searchPlayer.match();
  const playIndex = playView.you.hand.findIndex((card) => card.nameZh.startsWith('恢复高级球'));
  const playCommand = commandId('search-play');
  searchPlayer.send({
    type: 'play-trainer',
    commandId: playCommand,
    sessionId: playView.sessionId,
    expectedVersion: playView.version,
    handIndex: playIndex,
  });
  await waitForNextMessage(searchPlayer, (message) => message.type === 'match' && message.commandId === playCommand, 10_000, '高级球出牌结果');
  const discardPending = await waitForMessage(searchPlayer, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'discard-hand', 10_000, '高级球弃牌代价');
  const discardView = discardPending.view;
  check('高级球先要求弃 2 张手牌', discardView.pendingChoice.min === 2 && discardView.pendingChoice.max === 2);
  // 弃掉非探针卡，保证探针身份在公开前保持隐藏。
  const discardIndices = discardView.you.hand
    .map((card, index) => ({ card, index }))
    .filter((entry) => !entry.card.cardId.includes('-probe-'))
    .slice(0, 2)
    .map((entry) => entry.index);
  check('弃牌代价有足够的非探针手牌', discardIndices.length === 2, `hand=${discardView.you.hand.map((card) => card.cardId).join('|')}`);
  if (discardIndices.length !== 2) {
    throw new Error(`高级球弃牌需要 2 张非探针手牌，实际 ${discardIndices.length}：${discardView.you.hand.map((card) => card.cardId).join('|')}`);
  }
  searchPlayer.send({
    type: 'discard-hand',
    commandId: commandId('search-discard'),
    sessionId: discardView.sessionId,
    expectedVersion: discardView.version,
    choiceId: discardView.pendingChoice.choiceId,
    handIndices: discardIndices,
  });
  const pendingMessage = await waitForMessage(searchPlayer, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'search-deck', 10_000, '高级球检索待决选择');
  const pendingView = pendingMessage.view;
  const pendingChoice = pendingView.pendingChoice;
  const hiddenCandidates = pendingChoice.cardCandidates
    .map((candidate) => candidate.card.cardId)
    .filter((cardId) => cardId.startsWith(probePrefix));
  check('检索候选包含隐藏探针宝可梦', hiddenCandidates.length > 0, `hidden=${hiddenCandidates.length}`);
  check('检索待决选择只发给检索方', otherPlayer.match().pendingChoice === null);
  const privacyPending = evaluateCandidatePrivacy({ candidateIds: hiddenCandidates, frozenPublicIds, payloads: otherPlayer.rawLog.slice(rawFrom) });
  check('检索候选在动作前仍未公开', privacyPending.stillHidden.length > 0, `stillHidden=${privacyPending.stillHidden.length}`);
  check('断线前对手载荷不含仍隐藏的候选身份', privacyPending.leaked.length === 0, `leaked=${privacyPending.leaked.join(',')}`);

  // 真实传输中断：断开检索方连接并重连，待决选择必须原样恢复。
  const candidateProjection = (choice) => choice.cardCandidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    cardId: candidate.card.cardId,
    selectable: candidate.selectable ?? true,
  }));
  const candidatesBefore = JSON.stringify(candidateProjection(pendingChoice));
  const handBefore = JSON.stringify(pendingView.you.hand);
  searchPlayer.close();
  const searchWaiting = await waitForMessage(otherPlayer, (message) => message.type === 'match' && message.view.connection?.opponentOnline === false, 10_000, '对手看到检索方离线');
  check('检索待决期间断线，对手看到等待重连', searchWaiting.view.connection.opponentOnline === false);
  // 两条 WS 回调顺序不保证：先记下对手已收到的消息下标，重连后必须等对手收到
  // 本次重连产生的新连接状态快照，再扫描它的原始载荷。
  const opponentFrom = otherPlayer.messages.length;
  const searchResumed = await rejoin(PORT_LONG, searchPlayer, searchPlayerName);
  openClients.push(searchResumed);
  const resumedMessage = await waitForMessage(searchResumed, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'search-deck', 10_000, '重连后检索待决选择');
  check('重连恢复检索选择的同一 choiceId', resumedMessage.view.pendingChoice.choiceId === pendingChoice.choiceId);
  check('重连恢复检索选择的同一版本', resumedMessage.view.version === pendingView.version);
  check('重连恢复检索候选的同一集合与顺序', JSON.stringify(candidateProjection(resumedMessage.view.pendingChoice)) === candidatesBefore);
  check('重连恢复检索方完整手牌', JSON.stringify(resumedMessage.view.you.hand) === handBefore);
  const reconnectedView = await waitForMessageFrom(
    otherPlayer,
    opponentFrom,
    (message) => message.type === 'match' && message.view.connection?.opponentOnline === true,
    10_000,
    '对手看到检索方恢复在线',
  );
  check('对手收到重连后的新连接状态快照', reconnectedView.view.connection.opponentOnline === true);
  const privacyResumed = evaluateCandidatePrivacy({ candidateIds: hiddenCandidates, frozenPublicIds, payloads: otherPlayer.rawLog.slice(rawFrom) });
  check('断线重连期间对手载荷不含仍隐藏的候选身份', privacyResumed.leaked.length === 0, `leaked=${privacyResumed.leaked.join(',')}`);

  // 恢复后用重连连接完成检索：所选卡公开、加入手牌、牌库重洗。
  const chosenCandidate = resumedMessage.view.pendingChoice.cardCandidates.find((candidate) => candidate.card.cardId.startsWith(probePrefix)) ?? resumedMessage.view.pendingChoice.cardCandidates[0];
  const chosenCardId = chosenCandidate.card.cardId;
  searchResumed.send({
    type: 'search-deck',
    commandId: commandId('search-pick'),
    sessionId: resumedMessage.view.sessionId,
    expectedVersion: resumedMessage.view.version,
    choiceId: resumedMessage.view.pendingChoice.choiceId,
    candidateIds: [chosenCandidate.candidateId],
  });
  const searchedMessage = await waitForMessage(searchResumed, (message) => message.type === 'match' && message.view.events.some((event) => event.type === 'cards-searched'), 10_000, '重连后完成检索');
  const reveal = searchedMessage.view.events.filter((event) => event.type === 'cards-searched').at(-1);
  check('重连后完成检索并加入手牌', searchedMessage.view.you.hand.some((card) => card.cardId === chosenCardId));
  check('检索结果只公开所选的 1 张卡', reveal.cards.length === 1 && reveal.cards[0].cardId === chosenCardId);
  check('检索完成后重洗牌库', searchedMessage.view.events.some((event) => event.type === 'deck-shuffled'));
  const opponentReveal = await waitForMessage(
    otherPlayer,
    (message) => message.type === 'match' && message.view.events.some((event) => event.type === 'cards-searched' && event.cards.length === 1 && event.cards[0].cardId === chosenCardId),
    10_000,
    '对手看到检索公开结果',
  );
  check('对手看到检索公开的同一张卡', opponentReveal.view.events.some((event) => event.type === 'cards-searched' && event.cards[0]?.cardId === chosenCardId));
  // 迟到泄漏复检：恢复同步或检索完成响应可能晚于所选卡公开到达。从动作前冻结
  // 的候选里排除服务端已确认公开的 chosenCardId，其余仍隐藏的探针必须非空，
  // 并对 rawFrom 以来的全部对手载荷重扫；不把已泄漏载荷并入公开 oracle。
  const remainingHiddenProbes = hiddenCandidates.filter((cardId) => cardId !== chosenCardId);
  const privacyAfterReveal = evaluateCandidatePrivacy({
    candidateIds: remainingHiddenProbes,
    frozenPublicIds,
    payloads: otherPlayer.rawLog.slice(rawFrom),
  });
  check('检索公开后仍有仍隐藏的未选探针', privacyAfterReveal.stillHidden.length > 0, `remaining=${remainingHiddenProbes.length}/${hiddenCandidates.length}`);
  check('检索完成后对手载荷不含迟到泄露的未选候选身份', privacyAfterReveal.leaked.length === 0, `leaked=${privacyAfterReveal.leaked.join(',')}`);
  const searchRawLogs = [...searchMatch.a.rawLog, ...searchMatch.b.rawLog, ...searchResumed.rawLog];
  check('检索对局原始载荷不含内部实例 ID 或牌序', searchRawLogs.every((raw) => !raw.includes('"instanceId"') && !raw.includes('deckOrder')));
  check('检索对局原始载荷都能被协议严格解析', searchRawLogs.every((raw) => parseServerMessage(raw).ok));

  // ── 服务 2：短预算（900ms），覆盖判负与无胜负中止的真实定时器边界 ──
  serviceShort = spawnService(PORT_SHORT, ['--disconnect-budget-ms', '900'], shortLogs);
  await waitForHealth(`http://127.0.0.1:${PORT_SHORT}/health`);
  const first = await startMatch(PORT_SHORT, '短一', '短二');
  openClients.push(first.a, first.b);
  await waitForMessage(first.a, (message) => message.type === 'match', 10_000, '短预算对局视图');
  await waitForMessage(first.b, (message) => message.type === 'match', 10_000, '短预算对局视图 B');

  // 边界内恢复：断线 400ms 后重连仍然有效。
  first.a.close();
  await waitForMessage(first.b, (message) => message.type === 'match' && message.view.connection?.opponentOnline === false, 10_000, '短预算离线');
  await sleep(400);
  const firstA2 = await rejoin(PORT_SHORT, first.a, '短一');
  openClients.push(firstA2);
  const resumedShort = await waitForMessage(firstA2, (message) => message.type === 'match' && message.view.connection?.youOnline === true, 10_000, '短预算内恢复');
  check('短预算内重连仍可恢复且未产生终态', resumedShort.view.result === null && resumedShort.view.connection.yourDisconnectMs < 900);

  // 超限且对手在线：断线方判负。
  firstA2.close();
  await waitForMessage(first.b, (message) => message.type === 'match' && message.view.connection?.opponentOnline === false, 10_000, '超限前离线');
  const lossView = await waitForMessage(first.b, (message) => message.type === 'match' && message.view.result !== null, 10_000, '断线判负');
  check('单方超限且对手在线判负', lossView.view.result?.winner === 1 && lossView.view.result?.reason === 'disconnect-timeout');
  check('断线判负只有一个终态事件', lossView.view.events.filter((event) => event.type === 'match-finished').length === 1);
  const firstA3 = await rejoin(PORT_SHORT, first.a, '短一');
  openClients.push(firstA3);
  const lossReconnect = await waitForMessage(firstA3, (message) => message.type === 'match' && message.view.result !== null, 10_000, '超限方重连看到终态');
  check('超限方重连拿到同一判负结果', JSON.stringify(lossReconnect.view.result) === JSON.stringify(lossView.view.result));

  // 双方离线且任一超限：无胜负中止；双方重连看到同一结果。
  const secondMatch = await startMatch(PORT_SHORT, '短三', '短四');
  openClients.push(secondMatch.a, secondMatch.b);
  await waitForMessage(secondMatch.a, (message) => message.type === 'match', 10_000, '第二局视图');
  secondMatch.a.close();
  secondMatch.b.close();
  await sleep(1_200);
  const third = await rejoin(PORT_SHORT, secondMatch.a, '短三');
  openClients.push(third);
  const abortView = await waitForMessage(third, (message) => message.type === 'match' && message.view.result !== null, 10_000, '无胜负中止');
  check('双方离线且超限为无胜者中止', abortView.view.result?.winner === null && abortView.view.result?.reason === 'disconnect-timeout');
  check('无胜负中止只有一个终态事件', abortView.view.events.filter((event) => event.type === 'match-finished').length === 1);
  const fourth = await rejoin(PORT_SHORT, secondMatch.b, '短四');
  openClients.push(fourth);
  const abortViewB = await waitForMessage(fourth, (message) => message.type === 'match' && message.view.result !== null, 10_000, '对手无胜负中止');
  check('双方看到同一无胜负结果', JSON.stringify(abortViewB.view.result) === JSON.stringify(abortView.view.result));
  const shortFinished = shortLogs.join('').split('room.match_finished').length - 1;
  check('短预算服务只记录两次终局', shortFinished === 2, `finished=${shortFinished}`);

  // ── 服务 3：重启后实例身份变化，旧房间不可恢复 ──
  serviceRestart = spawnService(PORT_RESTART, [], restartLogs);
  await waitForHealth(`http://127.0.0.1:${PORT_RESTART}/health`);
  const before = await connectClient(PORT_RESTART, '重启前');
  openClients.push(before);
  const instanceBefore = before.connection.session.serviceInstanceId;
  before.send({ type: 'create-room', commandId: commandId('restart-create') });
  const createdRoom = await waitForMessage(before, (message) => message.type === 'room' && message.room.you.host, 10_000, '重启前建房').then((message) => message.room);
  await stopService(serviceRestart);
  serviceRestart = spawnService(PORT_RESTART, [], restartLogs);
  await waitForHealth(`http://127.0.0.1:${PORT_RESTART}/health`);
  const after = await connectClient(PORT_RESTART, '重启后', { identity: before.identity });
  openClients.push(after);
  check('服务重启后实例身份变化', after.connection.session.serviceInstanceId !== instanceBefore);
  after.send({ type: 'join-room', commandId: commandId('restart-join'), code: createdRoom.code, roomId: createdRoom.roomId });
  const restartError = await waitForMessage(after, (message) => message.type === 'room-error', 10_000, '旧房间被拒');
  check('旧房间/旧会话不可静默恢复', restartError.code === 'room-not-found');
  check('重启后没有伪造旧对局视图', after.messages.every((message) => message.type !== 'match'));
} catch (error) {
  failures.push(`执行异常: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  for (const client of openClients) {
    try {
      client.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const service of [serviceLong, serviceShort, serviceRestart]) {
    if (service !== undefined) {
      await stopService(service);
    }
  }
  for (const { child, port } of liveServices) {
    const exited = child.exitCode !== null || child.signalCode !== null;
    console.log(`  INFO  临时服务 ${exited ? '已清理' : '仍在运行'} pid=${child.pid} 端口=${port}`);
  }
  await sleep(200);
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n通过 ${passes.length} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
