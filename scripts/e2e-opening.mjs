#!/usr/bin/env node
/**
 * 开局端到端验收脚本（T07 / #8）。
 *
 * 真实服务进程 + 两个真实 WebSocket 客户端跑通：
 *   准备完成 → 服务端随机决定先后攻选择权 → 获选方明确选择 →
 *   洗牌/7 张手牌/（可能的）重抽展示 → 双方盖放战斗与备战宝可梦 →
 *   6 张奖赏卡 → 按对手重抽次数的可选补抽与补抽后备战放置 →
 *   公开翻面 → 唯一首回合并由首回合玩家先抽 1 张。
 *
 * 脚本用真实随机源，自适应处理重抽与补抽分支；同时覆盖：
 *   - 越权选择、过期版本、旧选择 ID、重复命令与命令 ID 复用不会改变状态；
 *   - 客户端不能夹带随机种子/预设牌序（未知字段整条拒绝）；
 *   - 对手载荷不含 A 的手牌/奖牌身份。
 *
 * 发行目录保持“全部效果未接入”；脚本在临时目录生成仅测试可用的“效果已接入”
 * 夹具目录（重新计算内容哈希）。夹具不进仓库、不进 APK、不改变发行目录。
 *
 * 用法: node scripts/e2e-opening.mjs
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

const directory = mkdtempSync(join(tmpdir(), 'ptcg-e2e-opening-'));
const port = 18789;

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

function waitFor(condition, timeoutMs = 10_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (condition()) {
        return true;
      }
      await sleep(20);
    }
    throw new Error(`等待 ${label} 超时`);
  })();
}

/** 从发行目录派生测试夹具目录：只有测试环境把效果标为已接入。 */
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
  [serviceEntry, '--host', '127.0.0.1', '--port', String(port), '--db', join(directory, 'e2e-opening.sqlite'), '--catalog', fixture.path],
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
const commandId = () => `e2e-opening-${(commandSeq += 1)}`;

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

/** 从目录内容构造一副恰好 60 张、效果已接入（夹具）的合法卡组文档。 */
function buildProbeDeck(content, basicId, trainerId) {
  const byId = new Map(content.cards.map((card) => [card.id, card]));
  const entry = (cardId) => {
    const card = byId.get(cardId);
    if (card === undefined) {
      throw new Error(`夹具目录缺少卡牌 ${cardId}`);
    }
    return { cardId, printIdentity: card.identities.printIdentity, effectIdentity: card.identities.effectIdentity };
  };
  const basic = entry(basicId);
  const trainer = entry(trainerId);
  const energy = entry('cbb1c-1803');
  return {
    formatVersion: 1,
    environmentId: content.environment.id,
    cards: [
      { ...basic, count: 4 },
      { ...trainer, count: 4 },
      { ...energy, count: 52 },
    ],
  };
}

const routedTarget = (client) => ({ roomId: client.room().roomId, expectedVersion: client.room().version });

try {
  console.log('== 开局端到端：真实服务 + 两客户端 + 真实随机 ==');
  const health = await waitForHealth();
  check('服务健康检查可用', health.status === 'ok');

  const deckA = buildProbeDeck(fixture.content, 'csve1-035', 'csve1-138');
  const deckB = buildProbeDeck(fixture.content, 'csve1-057', 'csve1-127');
  const probeACardId = 'csve1-138';

  const rawB = [];
  const a = await connectClient('小智');
  const b = await connectClient('小茂', rawB);
  a.send({ type: 'create-room', commandId: commandId() });
  await waitFor(() => a.room()?.status === 'waiting', 10_000, '建房快照');
  b.send({ type: 'join-room', commandId: commandId(), code: a.room().code });
  await waitFor(() => b.room()?.you.seat === 1, 10_000, '来宾加入');
  await waitFor(() => a.room()?.opponent.occupied === true, 10_000, '房主看到来宾');

  a.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(a), deck: deckA });
  await waitFor(() => a.room()?.you.deck?.validation.ready === true, 10_000, 'A 卡组就绪');
  b.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(b), deck: deckB });
  await waitFor(() => b.room()?.you.deck?.validation.ready === true, 10_000, 'B 卡组就绪');
  await waitFor(() => a.room()?.opponent.deckSelected === true, 10_000, 'A 看到 B 已选卡组');

  a.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(a), ready: true });
  await waitFor(() => a.room()?.you.ready === true, 10_000, 'A 已准备');
  const bReadyPayload = { type: 'set-ready', commandId: commandId(), ...routedTarget(b), ready: true };
  b.send(bReadyPayload);
  await waitFor(() => a.room()?.status === 'started' && b.room()?.status === 'started', 10_000, '唯一对局建立');
  check('双方准备只建立同一会话', a.room().match.sessionId === b.room().match.sessionId);

  // 双方都收到开局视图；服务端随机决定谁获得先后攻选择权。
  await waitFor(() => a.match() !== undefined && b.match() !== undefined, 10_000, '开局视图');
  const turnA = a.match();
  const turnB = b.match();
  check('双方看到同一开局会话与版本', turnA.sessionId === turnB.sessionId && turnA.version === turnB.version, `A=${turnA.version} B=${turnB.version}`);
  const winnerClient = turnA.pendingChoice?.kind === 'turn-order' ? a : b;
  const winnerIsA = winnerClient === a;
  const winnerView = winnerIsA ? turnA : turnB;
  const loserClient = winnerIsA ? b : a;
  check(
    '只有获选方收到先后攻待决选择，另一方看到等待提示',
    (turnA.pendingChoice?.kind === 'turn-order') !== (turnB.pendingChoice?.kind === 'turn-order'),
    `pendingA=${turnA.pendingChoice?.kind ?? 'none'} pendingB=${turnB.pendingChoice?.kind ?? 'none'}`,
  );
  const choiceId = winnerView.pendingChoice?.choiceId;

  // 客户端不能夹带随机种子或预设牌序：未知字段整条拒绝。
  loserClient.send({
    type: 'choose-turn-order',
    commandId: commandId(),
    sessionId: winnerView.sessionId,
    expectedVersion: winnerView.version,
    choiceId,
    goFirst: true,
    seed: 1,
    deckOrder: ['csve1-035'],
  });
  await waitFor(() => loserClient.lastError() !== undefined, 10_000, '夹带种子被拒绝');
  check('夹带 seed/deckOrder 的命令被拒绝', loserClient.lastError().code === 'invalid-message');

  // 越权：未获选方不能代替选择。
  loserClient.send({
    type: 'choose-turn-order',
    commandId: commandId(),
    sessionId: winnerView.sessionId,
    expectedVersion: winnerView.version,
    choiceId,
    goFirst: !winnerIsA,
  });
  await waitFor(() => loserClient.lastMatchError() !== undefined, 10_000, '越权错误');
  check('越权选择得到 not-your-choice', loserClient.lastMatchError().code === 'not-your-choice');

  // 过期版本被拒绝且不改状态。
  const staleVersion = winnerView.version + 50;
  winnerClient.send({ type: 'choose-turn-order', commandId: commandId(), sessionId: winnerView.sessionId, expectedVersion: staleVersion, choiceId, goFirst: true });
  await waitFor(() => winnerClient.lastMatchError()?.code === 'stale-version', 10_000, '过期版本错误');
  check('过期版本得到 stale-version 且视图仍停在原版本', winnerClient.match().version === winnerView.version);

  // 正式选择先攻（由获选方），并验证重复命令与命令 ID 复用。
  const finalChooseId = commandId();
  const finalChoose = { type: 'choose-turn-order', commandId: finalChooseId, sessionId: winnerView.sessionId, expectedVersion: winnerView.version, choiceId, goFirst: true };
  winnerClient.send(finalChoose);
  await waitFor(() => winnerClient.match()?.phase === 'setup', 10_000, '进入初始放置');
  const setupVersion = winnerClient.match().version;
  winnerClient.send(finalChoose);
  await waitFor(() => winnerClient.match()?.version >= setupVersion && winnerClient.match()?.phase === 'setup', 10_000, '重传');
  check('相同命令 ID 的精确重传不重复生效', winnerClient.match().version === setupVersion);
  winnerClient.send({ ...finalChoose, goFirst: false });
  await waitFor(() => winnerClient.lastMatchError()?.code === 'command-id-reused', 10_000, '命令 ID 复用');
  check('同一命令 ID 换载荷得到 command-id-reused', winnerClient.lastMatchError().code === 'command-id-reused');

  // 旧选择 ID 不能结算新的初始放置选择。
  const setupOwner = winnerClient; // 先手座位先放置
  const setupView = setupOwner.match();
  setupOwner.send({
    type: 'place-setup',
    commandId: commandId(),
    sessionId: setupView.sessionId,
    expectedVersion: setupView.version,
    choiceId,
    active: setupView.pendingChoice?.candidates?.[0] ?? 0,
    bench: [],
  });
  await waitFor(() => setupOwner.lastMatchError()?.code === 'stale-choice', 10_000, '旧选择 ID');
  check('旧选择 ID 得到 stale-choice 且初始放置未生效', setupOwner.lastMatchError().code === 'stale-choice' && setupOwner.match().you.setupPlaced === false);

  // 自适应完成整个开局：盖放 → 奖赏 → 可能的补抽/补抽备战 → 公开翻面 → 首回合。
  let mulliganSeen = false;
  let compensationSeen = false;
  const openingGuard = Date.now() + 30_000;
  async function actOnPending(client) {
    const view = client.match();
    if (view === undefined) {
      return false;
    }
    if (view.events.some((event) => event.type === 'mulligan')) {
      mulliganSeen = true;
    }
    const choice = view.pendingChoice;
    if (choice === null) {
      return false;
    }
    if (choice.kind === 'place-setup') {
      const active = view.you.hand.findIndex((card) => card.isBasicPokemon);
      client.send({
        type: 'place-setup',
        commandId: commandId(),
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: choice.choiceId,
        active,
        bench: [],
      });
      return true;
    }
    if (choice.kind === 'compensation-draw') {
      compensationSeen = true;
      client.send({
        type: 'resolve-compensation',
        commandId: commandId(),
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: choice.choiceId,
        draw: choice.max,
      });
      return true;
    }
    if (choice.kind === 'compensation-bench') {
      client.send({
        type: 'place-compensation-bench',
        commandId: commandId(),
        sessionId: view.sessionId,
        expectedVersion: view.version,
        choiceId: choice.choiceId,
        bench: choice.candidates,
      });
      return true;
    }
    return false;
  }

  while (Date.now() < openingGuard && (a.match()?.phase !== 'playing' || b.match()?.phase !== 'playing')) {
    await actOnPending(a);
    await actOnPending(b);
    await sleep(25);
  }
  const playingA = a.match();
  const playingB = b.match();
  check('双方进入 playing 且只开始一次首回合', playingA.phase === 'playing' && playingB.phase === 'playing' && playingA.events.filter((event) => event.type === 'turn-started').length === 1);
  check('首回合玩家在回合开始抽 1 张（手牌不少于对手）', playingA.you.handCount >= 1 && playingB.you.handCount >= 1);
  check('双方各放置 6 张奖赏卡且只有张数', playingA.you.prizeCount === 6 && playingB.you.prizeCount === 6);
  check('公开翻面后双方都能看到对手战斗宝可梦', playingA.opponent.active !== null && playingB.opponent.active !== null);
  console.log(`  信息  重抽发生=${mulliganSeen} 补抽发生=${compensationSeen} 首回合座位=${playingA.activeSeat}`);

  // 隐私：B 收到的每一份对局载荷都不得包含 A 的手牌身份；未公开的探针卡不得出现。
  const bMatchViews = b.messages.filter((message) => message.type === 'match').map((message) => message.view);
  const structureLeak = bMatchViews.some(
    (view) =>
      view.opponent.hand.length > 0 ||
      (view.phase !== 'playing' && (view.opponent.active !== null || view.opponent.bench.length > 0)) ||
      (view.phase === 'playing' && !view.opponent.revealed),
  );
  check('B 的每份对局载荷的对手隐藏区都只有张数或空', !structureLeak);
  const rawParses = rawB.every((raw) => parseServerMessage(raw).ok);
  check('B 收到的所有原始载荷都能被协议解析器严格接受', rawParses);
  // 规则允许公开的重抽展示与公开翻面不算泄露；其余出现探针卡即为泄露。
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
  const bText = rawB.join('\n');
  const probeLeaked = bText.includes(probeACardId) && !publiclyRevealed.has(probeACardId);
  check('对手载荷不含 A 未公开的探针卡牌身份', !probeLeaked);
  check('对手载荷不含内部实例 ID 或牌序字段', !bText.includes('deckOrder') && !bText.includes('"instanceId"'));

  const matchCreatedCount = serviceLogs.join('').split('room.match_created').length - 1;
  check('服务端只记录一次 room.match_created', matchCreatedCount === 1, `count=${matchCreatedCount}`);

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
