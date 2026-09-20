#!/usr/bin/env node
/**
 * 房间端到端验收脚本（T06）。
 *
 * 用真实服务进程 + 两个真实 WebSocket 客户端（以及第三个越权客户端）跑通：
 *   建房 → 6 位房间码 → 第二人加入 → 双方选卡组/准备 → 唯一对局会话与初始版本
 *   → 第三人满座 → 对手载荷不含卡表 → 房主离开关闭房间。
 *
 * 发行目录保持“全部效果未接入”；脚本在临时目录里从发行目录生成一份仅测试
 * 可用的“效果已接入”夹具目录（重新计算内容哈希），传给服务进程。夹具不进仓库、
 * 不进 APK、不改变发行目录。
 *
 * 用法: node scripts/e2e-rooms.mjs
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

const {
  computeCatalogVersion,
  connectToService,
  createDeviceIdentity,
  presetDeckDocument,
} = await import(new URL(`file://${protocolEntry.replace(/\\/gu, '/')}`));

const directory = mkdtempSync(join(tmpdir(), 'ptcg-e2e-rooms-'));
const port = 18788;

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

function waitFor(condition, timeoutMs = 8_000, label = 'condition') {
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
  return { path, release, version };
}

const fixture = await writeFixtureCatalog();
const service = spawn(
  process.execPath,
  [
    serviceEntry,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--db',
    join(directory, 'e2e-rooms.sqlite'),
    '--catalog',
    fixture.path,
  ],
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
const commandId = () => `e2e-room-${(commandSeq += 1)}`;

async function connectClient(nickname, rawLog) {
  const identity = await createDeviceIdentity();
  const result = await connectToService(
    {
      httpUrl: new URL(`http://127.0.0.1:${port}/`),
      wsUrl: new URL(`ws://127.0.0.1:${port}/`),
      identity,
      nickname,
    },
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
  const lastError = () => [...messages].reverse().find((message) => message.type === 'room-error');
  return { identity, connection, messages, room, lastError, send: (message) => connection.send(message) };
}

try {
  console.log('== 房间端到端：真实服务 + 两客户端 ==');
  const health = await waitForHealth();
  check('服务健康检查可用', health.status === 'ok');

  const releaseCatalog = fixture.release;
  const presetA = presetDeckDocument(releaseCatalog.decks.find((deck) => deck.code === 'A'), {
    ...releaseCatalog,
  });
  const presetB = presetDeckDocument(releaseCatalog.decks.find((deck) => deck.code === 'B'), {
    ...releaseCatalog,
  });
  const cardIdsA = presetA.cards.map((entry) => entry.cardId);

  const rawB = [];
  const a = await connectClient('小智');
  const b = await connectClient('小茂', rawB);
  a.send({ type: 'create-room', commandId: commandId() });
  await waitFor(() => a.room()?.status === 'waiting', 8_000, '建房快照');
  const code = a.room().code;
  check('房间码为 6 位数字', /^[0-9]{6}$/u.test(code), code);

  const c = await connectClient('小刚');
  b.send({ type: 'join-room', commandId: commandId(), code });
  await waitFor(() => b.room()?.you.seat === 1, 8_000, '来宾加入');
  check('第二人占据来宾座位', b.room().you.seat === 1 && b.room().opponent.host === true);
  check('房主看到对手但看不到其卡组', a.room().opponent.occupied === true && a.room().opponent.deck === null);

  c.send({ type: 'join-room', commandId: commandId(), code });
  await waitFor(() => c.lastError() !== undefined, 8_000, '第三人拒绝');
  check('第三人得到 room-full 且没有房间快照', c.lastError().code === 'room-full' && !c.messages.some((message) => message.type === 'room'));

  a.send({ type: 'select-deck', commandId: commandId(), deck: presetA });
  b.send({ type: 'select-deck', commandId: commandId(), deck: presetB });
  await waitFor(() => a.room()?.you.deck?.validation.ready === true, 8_000, 'A 卡组就绪');
  await waitFor(() => b.room()?.you.deck?.validation.ready === true, 8_000, 'B 卡组就绪');
  check(
    '服务端把测试夹具卡组判为可对战（发行目录仍全部未就绪）',
    a.room().you.deck.validation.catalogVersion === fixture.version &&
      releaseCatalog.cards.every((card) => card.flags.effectSupported === false),
  );

  a.send({ type: 'set-ready', commandId: commandId(), ready: true });
  b.send({ type: 'set-ready', commandId: commandId(), ready: true });
  await waitFor(() => a.room()?.status === 'started' && b.room()?.status === 'started', 8_000, '双方开局');
  const sessionA = a.room().match;
  const sessionB = b.room().match;
  check('双方准备建立唯一会话且初始版本为 1', sessionA.sessionId === sessionB.sessionId && sessionA.version === 1);
  const matchCreated = serviceLogs.join('').split('room.match_created').length - 1;
  check('服务端只记录一次 room.match_created', matchCreated === 1, `count=${matchCreated}`);

  const leaked = cardIdsA.filter((cardId) => rawB.join('\n').includes(cardId));
  check('对手载荷不含 A 的卡牌编号或身份', leaked.length === 0 && !rawB.join('\n').includes('fx:pokemon:'), leaked.join(','));

  // 开局后返回 UI（离开）不等同认输：会话保留、房间仍在对局状态、座位可重入。
  a.send({ type: 'leave-room', commandId: commandId() });
  await waitFor(() => a.messages.some((message) => message.type === 'room-left'), 8_000, '离开结果');
  await waitFor(() => b.room()?.opponent.online === false, 8_000, '对手离线仍占座');
  check('开局后离开不结束对局：会话与版本不变', b.room().status === 'started' && b.room().match.sessionId === sessionA.sessionId && b.room().match.version === 1);
  a.send({ type: 'join-room', commandId: commandId(), code });
  await waitFor(() => a.room()?.match?.sessionId === sessionA.sessionId, 8_000, '重入原会话');
  check('同一身份重入保留原座位与原会话', a.room().you.seat === 0 && a.room().match.version === 1);

  // 房主开局前离开关闭房间（另开一间验证）。
  const host = await connectClient('房主');
  const guest = await connectClient('来宾');
  host.send({ type: 'create-room', commandId: commandId() });
  await waitFor(() => host.room()?.status === 'waiting', 8_000, '第二间房');
  const secondCode = host.room().code;
  guest.send({ type: 'join-room', commandId: commandId(), code: secondCode });
  await waitFor(() => guest.room()?.you.seat === 1, 8_000, '第二间房加入');
  host.send({ type: 'leave-room', commandId: commandId() });
  await waitFor(() => guest.messages.some((message) => message.type === 'room-closed'), 8_000, '来宾收到关闭');
  check('房主开局前离开关闭房间', guest.messages.some((message) => message.type === 'room-closed' && message.code === secondCode));

  for (const client of [a, b, c, host, guest]) {
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
