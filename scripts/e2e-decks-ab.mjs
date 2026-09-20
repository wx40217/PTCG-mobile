#!/usr/bin/env node
/**
 * A/B 预设卡组完整对局端到端验收（T12 / #13）。
 *
 * 真实服务进程 + 两个真实 WebSocket 客户端，使用发行目录中的预设 A/B 与
 * 一副合法混搭改组，跑完整单局：A 对 B（双方先后攻）、A 镜像、B 镜像、
 * 改组对 B。每个动作只走公开协议命令，等待同一 `commandId` 的服务端结果；
 * 策略机器人只根据双方可见视图做合法选择（盖放、进化、附能、特性、招式、
 * 取奖赏、强制升前与各类效果选择），不以固定牌序或人工记伤代替结算。
 *
 * 用法: node scripts/e2e-decks-ab.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const serviceEntry = join(root, 'packages', 'service', 'dist', 'main.js');
const protocolEntry = join(root, 'packages', 'protocol', 'dist', 'index.js');
const catalogPath = join(root, 'data', 'catalog', 'zh-cn-standard-2025-06-05-catalog.json');

const { connectToService, createDeviceIdentity } = await import(
  new URL(`file://${protocolEntry.replace(/\\/gu, '/')}`)
);

const directory = mkdtempSync(join(tmpdir(), 'ptcg-e2e-decks-ab-'));
const port = 18937;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const catalogContent = JSON.parse(readFileSync(catalogPath, 'utf8'));

function buildDeckFromEntries(entries) {
  const byId = new Map(catalogContent.cards.map((card) => [card.id, card]));
  return {
    formatVersion: 1,
    environmentId: catalogContent.environment.id,
    cards: entries.map(([cardId, count]) => {
      const card = byId.get(cardId);
      if (card === undefined) {
        throw new Error(`发行目录缺少卡牌 ${cardId}`);
      }
      return { cardId, printIdentity: card.identities.printIdentity, effectIdentity: card.identities.effectIdentity, count };
    }),
  };
}

function presetDeck(code) {
  const preset = catalogContent.decks.find((entry) => entry.code === code);
  if (preset === undefined) {
    throw new Error(`发行目录缺少预设 ${code}`);
  }
  return buildDeckFromEntries(preset.cards.map((entry) => [entry.id, entry.count]));
}

/** 合法混搭改组：A/B 已支持卡池内的任意 60 张（同名 ≤4、含基础宝可梦、环境内）。 */
const MODIFIED_DECK = buildDeckFromEntries([
  ['csve1-062', 4],
  ['csve1-063', 4],
  ['csv3c-043', 4],
  ['csv3c-095', 4],
  ['csve1-152', 4],
  ['csve1-138', 4],
  ['cbb1c-1701', 4],
  ['cbb1c-1702', 4],
  ['cbb1c-1703', 4],
  ['csv2c-111', 4],
  ['csv1c-118', 4],
  ['csv2c-127', 4],
  ['cbb1c-1803', 12],
]);

const service = spawn(
  process.execPath,
  [serviceEntry, '--host', '127.0.0.1', '--port', String(port), '--db', join(directory, 'e2e-decks-ab.sqlite'), '--catalog', catalogPath],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
const serviceLogs = [];
service.stdout.on('data', (chunk) => serviceLogs.push(chunk.toString('utf8')));
service.stderr.on('data', (chunk) => serviceLogs.push(chunk.toString('utf8')));

async function waitForHealth(timeoutMs = 20_000) {
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
const commandId = () => `e2e-decks-ab-${(commandSeq += 1)}`;

async function connectClient(nickname) {
  const identity = await createDeviceIdentity();
  const result = await connectToService(
    { httpUrl: new URL(`http://127.0.0.1:${port}/`), wsUrl: new URL(`ws://127.0.0.1:${port}/`), identity, nickname },
    {},
  );
  if (!result.ok) {
    throw new Error(`客户端 ${nickname} 连接失败: ${result.failure.message}`);
  }
  const connection = result.connection;
  const messages = [];
  connection.onMessage((message) => messages.push(message));
  connection.onClosed?.((reason) => {
    console.log(`  DEBUG closed ${nickname}: ${JSON.stringify(reason)}`);
  });
  const match = () => [...messages].reverse().find((message) => message.type === 'match')?.view;
  const room = () => [...messages].reverse().find((message) => message.type === 'room')?.room;
  const lastRoomError = () => [...messages].reverse().find((message) => message.type === 'room-error');
  return { nickname, identity, connection, messages, match, room, lastRoomError, errors: [], send: (message) => connection.send(message) };
}

const routedTarget = (client) => ({ roomId: client.room().roomId, expectedVersion: client.room().version });

/** 发送一条命令并等待同一 commandId 的直接结果；返回 { ok, view, error }。 */
async function sendAndWait(client, command, timeoutMs = 10_000) {
  const id = commandId();
  const view = client.match();
  // 回合动作不带 sessionId/expectedVersion，由当前权威视图补齐；待决选择命令已自带。
  const payload = {
    commandId: id,
    sessionId: command.sessionId ?? view?.sessionId,
    expectedVersion: command.expectedVersion ?? view?.version,
    ...command,
  };
  client.send(payload);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.find(
      (message) => (message.type === 'match' || message.type === 'match-error') && message.commandId === id,
    );
    if (found !== undefined) {
      if (found.type === 'match-error') {
        client.errors.push(`${command.type}: ${found.code} ${found.message}`);
        return { ok: false, error: found };
      }
      return { ok: true, view: found.view };
    }
    await sleep(4);
  }
  client.errors.push(`${command.type}: timeout`);
  console.log(`  DEBUG timeout ${client.nickname} ${command.type} -> ${JSON.stringify(command).slice(0, 160)}`);
  return { ok: false, error: { type: 'timeout', code: 'timeout', message: '命令超时' } };
}

function energyCoversCost(cost, energyTypes) {
  const pool = [...energyTypes];
  for (const requirement of cost) {
    if (requirement === '无') {
      continue;
    }
    const index = pool.indexOf(requirement);
    if (index < 0) {
      return false;
    }
    pool.splice(index, 1);
  }
  return pool.length >= cost.filter((entry) => entry === '无').length;
}

/** 按当前视图给出一条可尝试的回合动作（不含需要 choiceId 的待决选择）。 */
function turnActionCandidates(view) {
  const own = view.you;
  const actions = [];

  const basicIndex = own.hand.findIndex((card) => card.isBasicPokemon);
  if (own.bench.length < 5 && basicIndex >= 0) {
    actions.push({ type: 'play-basic', handIndex: basicIndex });
  }
  const evolveTargets = [
    ...(own.active === null ? [] : [{ pokemon: own.active, target: { slot: 'active' } }]),
    ...own.bench.map((pokemon, index) => ({ pokemon, target: { slot: 'bench', index } })),
  ];
  for (const entry of evolveTargets) {
    if (entry.pokemon.canEvolve !== true) {
      continue;
    }
    const handIndex = own.hand.findIndex((card) => card.evolvesFrom === entry.pokemon.card.nameZh);
    if (handIndex >= 0) {
      actions.push({ type: 'evolve', handIndex, target: entry.target });
    }
  }
  if (!own.energyAttachedThisTurn) {
    const energyIndex = own.hand.findIndex((card) => card.kind === 'energy');
    if (energyIndex >= 0) {
      actions.push({ type: 'attach-energy', handIndex: energyIndex, target: { slot: 'active' } });
    }
  }
  const toolIndex = own.hand.findIndex((card) => card.kind === 'trainer' && card.classLabelZh === '宝可梦道具');
  if (toolIndex >= 0 && own.active !== null && own.active.tools.length === 0) {
    actions.push({ type: 'attach-tool', handIndex: toolIndex, target: { slot: 'active' } });
  }
  for (const [slot, pokemon] of [['active', own.active], ...own.bench.map((entry, index) => [`bench-${index}`, entry])]) {
    if (pokemon === null || pokemon === undefined) {
      continue;
    }
    for (const ability of pokemon.abilities ?? []) {
      if (ability.usable === true) {
        actions.push({
          type: 'use-ability',
          abilityIndex: ability.index,
          target: slot === 'active' ? { slot: 'active' } : { slot: 'bench', index: Number(slot.split('-')[1]) },
        });
      }
    }
  }
  // 每回合在招式前使用一张训练家卡（检索/铺场/支援者）；失败会被忽略。
  const trainerIndex = own.hand.findIndex((card) => card.kind === 'trainer');
  if (trainerIndex >= 0) {
    actions.push({ type: 'play-trainer', handIndex: trainerIndex });
  }
  const energyTypes = (own.active?.energies ?? []).map((entry) => entry.card.type);
  const attackIndices = (own.active?.attacks ?? [])
    .map((attack, index) => ({ attack, index }))
    .filter((entry) => entry.attack.supported === true && energyCoversCost(entry.attack.cost, energyTypes))
    .map((entry) => entry.index);
  for (const attackIndex of attackIndices.reverse()) {
    actions.push({ type: 'attack', attackIndex, target: { slot: 'active' } });
  }
  actions.push({ type: 'end-turn' });
  return { actions };
}

function choicePayload(view, choice) {
  const base = { sessionId: view.sessionId, expectedVersion: view.version, choiceId: choice.choiceId };
  switch (choice.kind) {
    case 'turn-order':
      return { type: 'choose-turn-order', ...base, goFirst: true };
    case 'place-setup': {
      const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
      return { type: 'place-setup', ...base, active: basics[0], bench: basics.slice(1, 4) };
    }
    case 'compensation-draw':
      return { type: 'resolve-compensation', ...base, draw: 0 };
    case 'place-bench':
      return { type: 'place-bench', ...base, bench: choice.candidates.slice(0, 5) };
    case 'take-prizes':
      return { type: 'take-prizes', ...base, prizes: choice.candidates.slice(0, Math.max(choice.min, 1)) };
    case 'choose-replacement':
      return { type: 'choose-replacement', ...base, benchIndex: choice.candidates[0] };
    case 'discard-hand':
      return { type: 'discard-hand', ...base, handIndices: choice.candidates.slice(0, Math.max(choice.min, 0)) };
    case 'discard-energy':
      return { type: 'discard-energy', ...base, candidateIds: choice.cardCandidates.filter((entry) => entry.selectable !== false).map((entry) => entry.candidateId) };
    case 'search-deck': {
      const selectable = choice.cardCandidates.filter((entry) => entry.selectable !== false);
      const wanted = Math.min(choice.max, Math.max(choice.min, 0), selectable.length);
      return { type: 'search-deck', ...base, candidateIds: selectable.slice(0, wanted).map((entry) => entry.candidateId) };
    }
    case 'choose-mode': {
      const available = choice.modes.filter((entry) => entry.available === true);
      // 优先选择非「基因侵入」的模式，避免机器人主动进入复制循环；
      // 引擎侧还有有界安全阀。
      const mode = available.find((entry) => !entry.labelZh.includes('基因侵入')) ?? available[0];
      return { type: 'choose-mode', ...base, modeId: mode.modeId };
    }
    case 'switch-opponent':
      return { type: 'switch-opponent', ...base, benchIndex: choice.candidates[0] };
    case 'choose-own-bench':
      return { type: 'choose-own-bench', ...base, benchIndex: choice.candidates[0] };
    case 'attach-hand-energy':
      return { type: 'attach-hand-energy', ...base, candidateId: choice.cardCandidates.find((entry) => entry.selectable !== false).candidateId };
    default:
      throw new Error(`机器人不支持的选择种类：${choice.kind}`);
  }
}

/** 机器人主循环：任意一方有待决选择或轮到其行动时就推进一步。 */
async function playGame(a, b, gameLabel, deadlineMs) {
  const clients = [a, b];
  let steps = 0;
  while (Date.now() < deadlineMs) {
    if (a.match()?.result !== null && a.match()?.result !== undefined && b.match()?.result !== null && b.match()?.result !== undefined) {
      return { resultA: a.match().result, resultB: b.match().result, steps };
    }
    let acted = false;
    for (const client of clients) {
      const view = client.match();
      if (view === undefined || view.result !== null) {
        continue;
      }
      if (view.pendingChoice !== null && view.pendingChoice !== undefined) {
        const choice = view.pendingChoice;
        const payload = choicePayload(view, choice);
        const outcome = await sendAndWait(client, payload);
        if (!outcome.ok) {
          // 选择命令失败时回退到最小合法答案，避免卡死。
          const fallback = (() => {
            const base = { sessionId: view.sessionId, expectedVersion: view.version, choiceId: choice.choiceId };
            if (choice.kind === 'search-deck') {
              return { type: 'search-deck', ...base, candidateIds: [] };
            }
            if (choice.kind === 'switch-opponent') {
              return { type: 'switch-opponent', ...base, benchIndex: choice.candidates[0] };
            }
            return null;
          })();
          if (fallback !== null) {
            await sendAndWait(client, fallback);
          }
        }
        acted = true;
        break;
      }
      if (view.phase === 'playing' && view.activeSeat === view.you.seat) {
        const { actions } = turnActionCandidates(view);
        let progressed = false;
        for (const action of actions) {
          const outcome = await sendAndWait(client, action);
          if (outcome.ok) {
            progressed = true;
            acted = true;
            break;
          }
        }
        if (!progressed) {
          // 所有动作都被拒绝时尝试结束回合；若也被待决选择阻塞，让另一个座位处理选择。
          const endOutcome = await sendAndWait(client, { type: 'end-turn' });
          acted = endOutcome.ok;
        }
        if (acted) {
          break;
        }
      }
    }
    if (!acted) {
      await sleep(6);
    }
    steps += 1;
    if (steps > 60_000) {
      throw new Error(`${gameLabel} 步数超限`);
    }
  }
  throw new Error(`${gameLabel} 在时限内未结束`);
}

async function runMatch(gameLabel, deckA, deckB) {
  const a = await connectClient('小智');
  const b = await connectClient('小茂');
  a.send({ type: 'create-room', commandId: commandId() });
  await waitFor(() => a.room()?.you?.host === true, `${gameLabel} 建房`);
  b.send({ type: 'join-room', commandId: commandId(), code: a.room().code });
  await waitFor(() => b.room()?.you?.seat === 1, `${gameLabel} 加入`);
  await waitFor(() => a.room()?.opponent?.occupied === true, `${gameLabel} 房主看到来宾`);

  a.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(a), deck: deckA });
  const aSelected = await waitFor(() => a.room()?.you?.deckSelected === true, `${gameLabel} A 选卡组`);
  const aReadyFlag = a.room().you.deck?.validation?.ready === true;
  b.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(b), deck: deckB });
  await waitFor(() => b.room()?.you?.deckSelected === true, `${gameLabel} B 选卡组`);
  const bReadyFlag = b.room().you.deck?.validation?.ready === true;

  a.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(a), ready: true });
  await waitFor(() => a.room()?.you?.ready === true, `${gameLabel} A 准备`);
  b.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(b), ready: true });
  await waitFor(() => a.room()?.status === 'started' && b.room()?.status === 'started', `${gameLabel} 开局`);

  const { resultA, resultB, steps } = await playGame(a, b, gameLabel, Date.now() + 60_000);
  const roomErrors = [a.lastRoomError(), b.lastRoomError()].filter(Boolean).map((entry) => `${entry.code}`).join(',');
  const firstSeat = a.match().firstSeat;
  const attackEvents = a.match().events.filter((event) => event.type === 'attack-used').length;
  const finalEvents = a.match().events;
  a.connection.close();
  b.connection.close();
  return { aSelected, bSelected: true, aReadyFlag, bReadyFlag, resultA, resultB, steps, roomErrors, firstSeat, attackEvents, finalEvents };
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value === true) {
        return value;
      }
    } catch {
      /* 快照尚未就绪 */
    }
    await sleep(10);
  }
  throw new Error(`等待 ${label} 超时`);
}

async function main() {
  console.log('== A/B 预设完整对局端到端：真实服务 + 两个真实 WebSocket 客户端 + 发行目录 ==');
  const health = await waitForHealth();
  check('服务健康检查可用', health.status === 'ok');
  check('预设 A/B 已可正式对战', ['A', 'B'].every((code) => catalogContent.decks.find((deck) => deck.code === code) !== undefined));

  const allGames = [
    { label: 'A 对 B', deckA: presetDeck('A'), deckB: presetDeck('B') },
    { label: 'B 对 A', deckA: presetDeck('B'), deckB: presetDeck('A') },
    { label: 'A 镜像', deckA: presetDeck('A'), deckB: presetDeck('A') },
    { label: 'B 镜像', deckA: presetDeck('B'), deckB: presetDeck('B') },
    { label: '合法改组对 B', deckA: MODIFIED_DECK, deckB: presetDeck('B') },
  ];
  const filter = process.env['E2E_GAMES'];
  const games = filter === undefined ? allGames : allGames.filter((game) => game.label.includes(filter));

  const firstSeats = new Set();
  let finished = 0;
  for (const game of games) {
    const outcome = await runMatch(game.label, game.deckA, game.deckB);
    check(`${game.label}：A 卡组经服务端校验就绪`, outcome.aReadyFlag === true);
    check(`${game.label}：对局产生唯一终态且双方一致`, outcome.resultA !== null && outcome.resultB !== null && outcome.resultA.winner === outcome.resultB.winner && outcome.resultA.reason === outcome.resultB.reason);
    check(`${game.label}：未落入 room-error`, outcome.roomErrors === '');
    check(`${game.label}：有真实招式结算`, outcome.attackEvents > 0);
    firstSeats.add(outcome.firstSeat);
    finished += 1;
    if (outcome.attackEvents === 0) {
      console.log(`  DEBUG ${game.label} 无招式结束：result=${JSON.stringify(outcome.resultA)} events=${JSON.stringify(outcome.finalEvents?.map((event) => event.type))}`);
    }
    console.log(`  INFO  ${game.label}：winner=${outcome.resultA?.winner} reason=${outcome.resultA?.reason} steps=${outcome.steps} attacks=${outcome.attackEvents}`);
  }
  check('全部对局均完成', finished === games.length);
  if (filter === undefined) {
    check('覆盖双方先后攻', firstSeats.size === 2, `firstSeats=${[...firstSeats].join(',')}`);
  }
}

try {
  await main();
} catch (error) {
  failures.push(`脚本异常：${error.message}`);
  console.log(`  FAIL  脚本异常：${error.stack}`);
  console.log(`  DEBUG 服务日志（尾 2000 字）：\n${serviceLogs.join('').slice(-2000)}`);
} finally {
  service.kill();
  await sleep(200);
  rmSync(directory, { recursive: true, force: true });
  console.log(`\n结果：${passes.length} 项通过，${failures.length} 项失败。`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`  FAIL  ${failure}`);
    }
    process.exitCode = 1;
  }
}
