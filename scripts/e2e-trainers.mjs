#!/usr/bin/env node
/**
 * 真实训练家卡端到端验收脚本（T10 / #11）。
 *
 * 真实服务进程 + 两个真实 WebSocket 客户端，在同一份夹具目录上跑四场真实对局
 * （每场聚焦一组训练家效果身份）：
 *   1. 高级球：弃 2 张手牌代价 → 牌库检索 → 公开展示 → 重洗 → 继续对局；
 *      并验证精确重传不重复消耗、对手载荷在展示前不含候选身份。
 *   2. 超级球：查看牌库顶 7 张（全部私人展示、只有宝可梦可选），提交 0 张
 *      结束检索并重洗；对手载荷不含被查看的隐藏别名身份。
 *   3. 莎莉娜：模式 1 弃牌后抽到手牌 5 张；模式 2 互换对手备战区「宝可梦V」。
 *   4. 深钵镇：竞技场持续存在、双方每回合 1 次、检索基础非规则宝可梦直接进
 *      备战区、第二次使用被拒绝。
 *   5. 精灵球：硬币判定；反面重试、正面检索并公开结果。
 *
 * 夹具通过“同效果身份的多个别名印刷版本”保证手牌里出现目标卡，同时服务端
 * 实际执行的是冻结卡牌的正式效果身份实现（生产注册表）。发行目录本身只标记
 * 7 张已验证训练家卡，且整套目录仍不可正式对战。
 *
 * 用法: node scripts/e2e-trainers.mjs
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

const { computeCatalogVersion, connectToService, createDeviceIdentity } = await import(
  new URL(`file://${protocolEntry.replace(/\\/gu, '/')}`)
);

const directory = mkdtempSync(join(tmpdir(), 'ptcg-e2e-trainers-'));
const port = 18793;

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

/** JSON 载荷中的卡牌实例身份；带引号匹配，避免 `...-1` 误命中 `...-12`。 */
function payloadHasCardId(raw, cardId) {
  return raw.includes(`"${cardId}"`);
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
      .slice(-6)
      .map((message) =>
        message.type === 'match'
          ? `match v${message.view.version} phase=${message.view.phase} turn=${message.view.turn} choice=${message.view.pendingChoice?.kind ?? '-'}`
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
        if (predicate(client.messages[index])) {
          return client.messages[index];
        }
      }
      await sleep(20);
    }
    throw new Error(`等待新的 ${label} 超时`);
  })();
}

/* ------------------------------------------------------------------ */
/* 夹具目录：真实效果身份 + 多个别名印刷版本                              */
/* ------------------------------------------------------------------ */

const FOCUS = {
  ultraBall: { identity: 'fx:trainer:高级球:d8722e9e5903', name: '高级球', category: '物品', template: 'cbb1c-1703' },
  greatBall: { identity: 'fx:trainer:超级球:e8abaed723aa', name: '超级球', category: '物品', template: 'cbb1c-1702' },
  serena: { identity: 'fx:trainer:莎莉娜:2cbdb4c4540e', name: '莎莉娜', category: '支援者', template: 'csve1-152' },
  deepBowl: { identity: 'fx:trainer:深钵镇:7c178228afc9', name: '深钵镇', category: '竞技场', template: 'csv2c-127' },
  pokeBall: { identity: 'fx:trainer:精灵球:992d7d8946ca', name: '精灵球', category: '物品', template: 'cbb1c-1701' },
};

async function writeFixtureCatalog() {
  const release = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const { catalogVersion: _version, runtime: _runtime, ...content } = release;
  const byId = new Map(content.cards.map((card) => [card.id, card]));
  const aliasCards = [];
  for (const [key, focus] of Object.entries(FOCUS)) {
    const template = byId.get(focus.template);
    if (template === undefined) {
      throw new Error(`发行目录缺少模板 ${focus.template}`);
    }
    for (let index = 1; index <= 36; index += 1) {
      aliasCards.push({
        ...template,
        id: `e2e-${key}-${index}`,
        nameZh: `${focus.name}${index}`,
        flags: { ...template.flags, effectSupported: true, effectNoteZh: '训练家端到端夹具别名。' },
        identities: {
          effectIdentity: focus.identity,
          printIdentity: `print:E2E:${key}-${index}`,
          nameGroupKey: `name:${focus.name}${index}`,
        },
        print: { ...template.print, printCode: 'E2E', number: `${key}-${index}`, total: '060', displayNumber: `E2E ${focus.name}${index}` },
        decks: [],
        imageSource: null,
      });
    }
  }
  const basicTemplate = byId.get('csve1-035');
  const basicFixtures = [
    {
      ...basicTemplate,
      id: 'e2e-basic',
      nameZh: 'E2E 基础宝可梦',
      hp: 100,
      flags: { ...basicTemplate.flags, effectSupported: true, effectNoteZh: '训练家端到端夹具。' },
      identities: { effectIdentity: 'fx:e2e:basic', printIdentity: 'print:E2E:basic', nameGroupKey: 'name:E2E 基础宝可梦' },
      print: { ...basicTemplate.print, printCode: 'E2E', number: 'basic', total: '060', displayNumber: 'E2E basic' },
      decks: [],
      imageSource: null,
    },
    {
      ...basicTemplate,
      id: 'e2e-small',
      nameZh: 'E2E 小基础宝可梦',
      hp: 90,
      flags: { ...basicTemplate.flags, effectSupported: true, effectNoteZh: '训练家端到端夹具。' },
      identities: { effectIdentity: 'fx:e2e:small', printIdentity: 'print:E2E:small', nameGroupKey: 'name:E2E 小基础宝可梦' },
      print: { ...basicTemplate.print, printCode: 'E2E', number: 'small', total: '060', displayNumber: 'E2E small' },
      decks: [],
      imageSource: null,
    },
  ];
  const vAliases = [];
  for (let index = 1; index <= 40; index += 1) {
    vAliases.push({
      ...basicTemplate,
      id: `e2e-v-${index}`,
      nameZh: `E2E 宝可梦V${index}`,
      hp: 100,
      flags: { ...basicTemplate.flags, effectSupported: true, effectNoteZh: '训练家端到端夹具。' },
      identities: { effectIdentity: `fx:e2e:v-${index}`, printIdentity: `print:E2E:v-${index}`, nameGroupKey: `name:E2E 宝可梦V${index}` },
      print: { ...basicTemplate.print, printCode: 'E2E', number: `v-${index}`, total: '060', displayNumber: `E2E V${index}` },
      decks: [],
      imageSource: null,
      specialRuleTextZh: 'V规则：当宝可梦V昏厥时，对手将拿取2张奖赏卡。',
    });
  }
  const fixture = {
    ...content,
    supportPolicy: {
      engineIntegration: 'integrated',
      playable: true,
      noteZh: '训练家端到端夹具：只用于自动化验证，不进入发行目录。',
    },
    cards: [
      ...content.cards.map((card) => ({
        ...card,
        flags: { ...card.flags, effectSupported: true, effectNoteZh: '训练家端到端夹具。' },
      })),
      ...aliasCards,
      ...basicFixtures,
      ...vAliases,
    ],
  };
  const version = await computeCatalogVersion(fixture);
  const path = join(directory, 'trainer-fixture-catalog.json');
  writeFileSync(path, JSON.stringify({ ...fixture, catalogVersion: version }), 'utf8');
  return { path, release, version, content: fixture };
}

const fixture = await writeFixtureCatalog();
const service = spawn(
  process.execPath,
  [serviceEntry, '--host', '127.0.0.1', '--port', String(port), '--db', join(directory, 'e2e-trainers.sqlite'), '--catalog', fixture.path],
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
const commandId = () => `e2e-trainers-${(commandSeq += 1)}`;

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

function buildDeck(cards) {
  const byId = new Map(fixture.content.cards.map((card) => [card.id, card]));
  return {
    formatVersion: 1,
    environmentId: fixture.content.environment.id,
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

function aliasIds(key, count) {
  return Array.from({ length: count }, (_value, index) => `e2e-${key}-${index + 1}`);
}

function focusDeck(key, basics = 8, aliases = 36) {
  const cards = [['e2e-basic', Math.ceil(basics / 2)], ['e2e-small', Math.floor(basics / 2)]];
  const ids = aliasIds(key, aliasCount());
  for (let index = 0; index < aliases; index += 1) {
    cards.push([ids[index], 1]);
  }
  const used = cards.reduce((sum, [, count]) => sum + count, 0);
  cards.push(['cbb1c-1803', 60 - used]);
  return buildDeck(cards);
}

function aliasCount() {
  return 36;
}

function vDeck() {
  const cards = [['e2e-basic', 4]];
  for (let index = 1; index <= 40; index += 1) {
    cards.push([`e2e-v-${index}`, 1]);
  }
  const used = cards.reduce((sum, [, count]) => sum + count, 0);
  cards.push(['cbb1c-1803', 60 - used]);
  return buildDeck(cards);
}

function basicDeck() {
  return buildDeck([
    ['e2e-basic', 4],
    ['cbb1c-1803', 56],
  ]);
}

/** 建立一场双方就绪的对局；A 固定为后攻方（turn 2 开始行动）。 */
async function startMatch({ nicknameA = '小智', nicknameB = '小茂', deckA, deckB, benchBasicsA = false, benchBasicsB = false }) {
  const rawA = [];
  const rawB = [];
  const a = await connectClient(nicknameA, rawA);
  const b = await connectClient(nicknameB, rawB);
  a.send({ type: 'create-room', commandId: commandId() });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.host, 10_000, '建房快照');
  b.send({ type: 'join-room', commandId: commandId(), code: a.room().code });
  await waitForMessage(b, (message) => message.type === 'room' && message.room.you.seat === 1, 10_000, '来宾加入');
  await waitForMessage(a, (message) => message.type === 'room' && message.room.opponent.occupied, 10_000, '房主看到来宾');
  for (const [client, deck] of [
    [a, deckA],
    [b, deckB],
  ]) {
    client.send({ type: 'select-deck', commandId: commandId(), ...routedTarget(client), deck });
    await waitForMessage(client, (message) => message.type === 'room' && message.room.you.deck?.validation.ready === true, 10_000, `${client === a ? 'A' : 'B'} 卡组就绪`);
  }
  a.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(a), ready: true });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.you.ready === true, 10_000, 'A 准备');
  b.send({ type: 'set-ready', commandId: commandId(), ...routedTarget(b), ready: true });
  await waitForMessage(a, (message) => message.type === 'room' && message.room.status === 'started', 10_000, '开局建立');
  await waitForMessage(a, (message) => message.type === 'match', 10_000, 'A 开局视图');
  await waitForMessage(b, (message) => message.type === 'match', 10_000, 'B 开局视图');

  // 先后攻选择：总是让 B 先攻，A 从 turn 2 开始行动（支援者限制已解除）。
  const winner = a.match().pendingChoice?.kind === 'turn-order' ? a : b;
  const winnerIsA = winner === a;
  winner.send({
    type: 'choose-turn-order',
    commandId: commandId(),
    sessionId: winner.match().sessionId,
    expectedVersion: winner.match().version,
    choiceId: winner.match().pendingChoice.choiceId,
    goFirst: !winnerIsA,
  });
  const opening = await runOpening(a, b, { benchBasicsA, benchBasicsB });
  return { a, b, rawA, rawB, ...opening };
}

async function runOpening(a, b, { benchBasicsA, benchBasicsB }) {
  const sent = new Map();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (a.match()?.phase === 'playing' && b.match()?.phase === 'playing') {
      break;
    }
    for (const [client, benchBasics] of [
      [a, benchBasicsA],
      [b, benchBasicsB],
    ]) {
      const view = client.match();
      const choice = view?.pendingChoice;
      if (view === undefined || choice === null || choice === undefined || sent.get(client) === choice.choiceId) {
        continue;
      }
      sent.set(client, choice.choiceId);
      if (choice.kind === 'place-setup') {
        const basics = view.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0);
        client.send({
          type: 'place-setup',
          commandId: commandId(),
          sessionId: view.sessionId,
          expectedVersion: view.version,
          choiceId: choice.choiceId,
          active: basics[0],
          bench: benchBasics ? basics.slice(1, 6) : [],
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
    await sleep(20);
  }
  if (a.match()?.phase !== 'playing' || b.match()?.phase !== 'playing') {
    throw new Error('开局未能在超时前完成');
  }
  return {
    firstSeat: a.match().firstSeat,
    aTurn: () => a.match()?.activeSeat === 0,
    bTurn: () => a.match()?.activeSeat === 1,
    endTurn: async (client) => {
      const view = client.match();
      client.send({ type: 'end-turn', commandId: commandId(), sessionId: view.sessionId, expectedVersion: view.version });
    },
  };
}

function handIndexOf(client, predicate) {
  const view = client.match();
  const index = view.you.hand.findIndex(predicate);
  if (index < 0) {
    throw new Error('手牌中没有满足条件的卡');
  }
  return index;
}

async function playTrainer(client, predicate, label) {
  const view = client.match();
  const index = handIndexOf(client, predicate);
  const command = commandId();
  client.send({ type: 'play-trainer', commandId: command, sessionId: view.sessionId, expectedVersion: view.version, handIndex: index });
  await waitForNextMessage(client, (message) => message.type === 'match' && message.commandId === command, 10_000, `${label} 出牌结果`);
  return command;
}

/* ------------------------------------------------------------------ */
/* 四场真实对局                                                          */
/* ------------------------------------------------------------------ */

async function ultraBallFlow(a, b, rawB) {
  await ensureTrainerForFlow(a, b, '高级球');
  const playCommand = await playTrainer(a, (card) => card.nameZh.startsWith('高级球'), '高级球');
  void playCommand;
  const discard = await waitForMessage(a, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'discard-hand', 10_000, '高级球弃牌代价');
  const discardChoice = discard.view.pendingChoice;
  check('高级球先要求弃 2 张手牌代价', discardChoice.min === 2 && discardChoice.max === 2 && discardChoice.step === 1 && discardChoice.stepCount === 2);
  const viewAfterPlay = a.match();
  const discardIndices = [0, 1].filter((index) => index < viewAfterPlay.you.hand.length);
  a.send({
    type: 'discard-hand',
    commandId: commandId(),
    sessionId: viewAfterPlay.sessionId,
    expectedVersion: viewAfterPlay.version,
    choiceId: discardChoice.choiceId,
    handIndices: discardIndices,
  });
  const search = await waitForMessage(a, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'search-deck', 10_000, '高级球检索');
  const searchChoice = search.view.pendingChoice;
  check('支付代价后进入第 2 步检索', searchChoice.step === 2 && searchChoice.stepCount === 2);
  check('高级球检索也允许选择 0 张', searchChoice.min === 0 && searchChoice.max === 1);
  check('代价已进入公开弃牌区', search.view.you.discard.length >= 2);
  const candidates = searchChoice.cardCandidates.map((candidate) => candidate.card.cardId);
  check('候选只发给检索者', a.match().pendingChoice.cardCandidates.length === candidates.length && b.match().pendingChoice === null);
  // 只比较 A 的隐藏别名候选；B 自己的卡组里的基础宝可梦不算泄露。
  const hiddenCandidates = searchChoice.cardCandidates
    .map((candidate) => candidate.card.cardId)
    .filter((cardId) => cardId.startsWith('e2e-ultraBall-'));
  const leaked = hiddenCandidates.some((cardId) => payloadHasCardId(rawB.join('\n'), cardId));
  check('展示前对手载荷不含隐藏候选身份', !leaked);
  const chosenCandidate = searchChoice.cardCandidates[0];
  const chosen = chosenCandidate.card.cardId;
  const searchCommand = commandId();
  a.send({
    type: 'search-deck',
    commandId: searchCommand,
    sessionId: search.view.sessionId,
    expectedVersion: search.view.version,
    choiceId: searchChoice.choiceId,
    candidateIds: [chosenCandidate.candidateId],
  });
  const resolved = await waitForMessage(a, (message) => message.type === 'match' && message.view.events.some((event) => event.type === 'cards-searched'), 10_000, '检索公开结果');
  const reveal = resolved.view.events.filter((event) => event.type === 'cards-searched').at(-1);
  check('检索结果只公开所选的 1 张卡', reveal.cards.length === 1 && reveal.cards[0].cardId === chosen);
  check('检索后重洗牌库并加入手牌', resolved.view.events.some((event) => event.type === 'deck-shuffled') && resolved.view.you.hand.some((card) => card.cardId === chosen));
  const versionAfterResolve = a.match().version;
  const searchedCount = a.match().events.filter((event) => event.type === 'cards-searched').length;
  // 精确重传：返回同一结果、不重复抽卡/洗牌。
  a.send({
    type: 'search-deck',
    commandId: searchCommand,
    sessionId: search.view.sessionId,
    expectedVersion: search.view.version,
    choiceId: searchChoice.choiceId,
    candidateIds: [chosenCandidate.candidateId],
  });
  await sleep(250);
  check(
    '检索答案精确重传不重复生效',
    a.match().version === versionAfterResolve &&
      a.match().events.filter((event) => event.type === 'cards-searched').length === searchedCount,
  );
  check('对手只看到公开的检索结果', rawB.join('\n').includes(chosen));
}

async function greatBallFlow(a, b, rawB) {
  await ensureTrainerForFlow(a, b, '超级球');
  const playCommand = await playTrainer(a, (card) => card.nameZh.startsWith('超级球'), '超级球');
  void playCommand;
  const looked = await waitForMessage(
    a,
    (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'search-deck' && message.view.pendingChoice.source === 'top-deck',
    10_000,
    '超级球查看牌库顶',
  );
  const choice = looked.view.pendingChoice;
  check('超级球把被查看的全部 7 张作为私人候选展示', choice.cardCandidates.length === 7, `got=${choice.cardCandidates.length}`);
  check(
    '超级球只有宝可梦可选（被查看的其它卡展示但 selectable=false）',
    choice.cardCandidates.every((candidate) => candidate.selectable === (candidate.card.kind === 'pokemon')),
  );
  check('超级球允许提交 0 张', choice.min === 0);
  // 私人候选只发给选择者；对手载荷不得出现被查看的隐藏别名身份。
  const hiddenLooked = choice.cardCandidates.map((candidate) => candidate.card.cardId).filter((cardId) => cardId.startsWith('e2e-greatBall-'));
  const leakedLooked = hiddenLooked.filter((cardId) => payloadHasCardId(rawB.join('\n'), cardId) && !publicIds.has(cardId));
  check('被查看的 7 张只发给选择者，对手载荷不含隐藏别名', leakedLooked.length === 0, `leaked=${leakedLooked.join(',')}`);
  check('对手在等待超级球选择时看不到私人候选', b.match().pendingChoice === null && b.match().waitingForOpponentChoice === true);
  const shuffledBefore = a.match().events.filter((event) => event.type === 'deck-shuffled').length;
  a.send({
    type: 'search-deck',
    commandId: commandId(),
    sessionId: looked.view.sessionId,
    expectedVersion: looked.view.version,
    choiceId: choice.choiceId,
    candidateIds: [],
  });
  const zero = await waitForMessage(
    a,
    (message) =>
      message.type === 'match' &&
      message.view.pendingChoice === null &&
      message.view.events.filter((event) => event.type === 'deck-shuffled').length > shuffledBefore,
    10_000,
    '超级球 0 张重洗',
  );
  check('超级球提交 0 张：不公开检索结果但仍重洗牌库', !zero.view.events.some((event) => event.type === 'cards-searched'));
  check('超级球 0 张后仍可继续对局', zero.view.phase === 'playing');
}

async function serenaFlow(a, b, rawB) {
  await ensureTrainerForFlow(a, b, '莎莉娜');
  await playTrainer(a, (card) => card.nameZh.startsWith('莎莉娜'), '莎莉娜模式1');
  const mode = await waitForMessage(a, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'choose-mode', 10_000, '莎莉娜模式选择');
  const modeChoice = mode.view.pendingChoice;
  check('莎莉娜提供两个效果并由选择者明确选择', modeChoice.modes.length === 2);
  const switchMode = modeChoice.modes.find((entry) => entry.modeId === 'switch-opponent-v');
  check('对手备战区有宝可梦V时第二模式可用', switchMode.available === true);
  a.send({
    type: 'choose-mode',
    commandId: commandId(),
    sessionId: mode.view.sessionId,
    expectedVersion: mode.view.version,
    choiceId: modeChoice.choiceId,
    modeId: 'discard-draw-five',
  });
  const discard = await waitForMessage(a, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'discard-hand', 10_000, '莎莉娜弃牌');
  check('模式 1 允许弃 1 到 3 张', discard.view.pendingChoice.min === 1 && discard.view.pendingChoice.max === 3);
  a.send({
    type: 'discard-hand',
    commandId: commandId(),
    sessionId: discard.view.sessionId,
    expectedVersion: discard.view.version,
    choiceId: discard.view.pendingChoice.choiceId,
    handIndices: [handIndexOf(a, () => true)],
  });
  const drawn = await waitForMessage(a, (message) => message.type === 'match' && message.view.pendingChoice === null && message.view.events.some((event) => event.type === 'cards-discarded'), 10_000, '莎莉娜抽牌完成');
  check('弃牌后抽到手牌 5 张', drawn.view.you.handCount === 5, `hand=${drawn.view.you.handCount}`);

  // 等 B 回合结束后回到 A，使用第二模式互换 B 的备战宝可梦V。
  await advanceToNextATurn(a, b);
  await ensureTrainerForFlow(a, b, '莎莉娜');
  await playTrainer(a, (card) => card.nameZh.startsWith('莎莉娜'), '莎莉娜模式2');
  const mode2 = a.match();
  if (mode2.pendingChoice?.kind !== 'choose-mode') {
    check('莎莉娜模式 2 选择已就绪', false, `choice=${mode2.pendingChoice?.kind ?? 'null'}`);
    return;
  }
  check('莎莉娜模式 2 选择已就绪', true);
  a.send({
    type: 'choose-mode',
    commandId: commandId(),
    sessionId: mode2.sessionId,
    expectedVersion: mode2.version,
    choiceId: mode2.pendingChoice.choiceId,
    modeId: 'switch-opponent-v',
  });
  const switchChoice = await waitForMessage(a, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'switch-opponent', 10_000, '互换目标');
  check('互换候选只包含对手备战区的宝可梦V', switchChoice.view.pendingChoice.candidates.length >= 1);
  const beforeActive = b.match().you.active.card.cardId;
  a.send({
    type: 'switch-opponent',
    commandId: commandId(),
    sessionId: switchChoice.view.sessionId,
    expectedVersion: switchChoice.view.version,
    choiceId: switchChoice.view.pendingChoice.choiceId,
    benchIndex: switchChoice.view.pendingChoice.candidates[0],
  });
  const switched = await waitForMessage(a, (message) => message.type === 'match' && message.view.events.some((event) => event.type === 'bench-switched'), 10_000, '互换公开事件');
  const event = switched.view.events.filter((entry) => entry.type === 'bench-switched').at(-1);
  check('互换事件公开新的战斗宝可梦与回到备战的旧战斗宝可梦', event.active.cardId.startsWith('e2e-v-') && event.active.cardId !== beforeActive && event.bench.cardId === beforeActive);
  check('对手视图同步新的战斗宝可梦', b.match().you.active.card.cardId === event.active.cardId);
  void rawB;
}

async function deepBowlFlow(a, b) {
  await ensureTrainerForFlow(a, b, '深钵镇');
  await playTrainer(a, (card) => card.nameZh.startsWith('深钵镇'), '深钵镇');
  const placed = await waitForMessage(a, (message) => message.type === 'match' && message.view.events.some((event) => event.type === 'stadium-placed'), 10_000, '竞技场放置');
  check('竞技场放于场上并持续存在', placed.view.stadium !== null && placed.view.you.stadiumPlayedThisTurn === true);
  check('对手可见同一竞技场', b.match().stadium?.cardId === placed.view.stadium.cardId);
  a.send({ type: 'use-stadium', commandId: commandId(), sessionId: a.match().sessionId, expectedVersion: a.match().version });
  const search = await waitForMessage(a, (message) => message.type === 'match' && message.view.pendingChoice?.kind === 'search-deck', 10_000, '深钵镇检索');
  const searchChoice = search.view.pendingChoice;
  check('深钵镇检索候选只含基础非规则宝可梦', searchChoice.cardCandidates.length >= 1 && searchChoice.cardCandidates.every((candidate) => candidate.card.isBasicPokemon));
  if (searchChoice.cardCandidates.length === 0) {
    return;
  }
  const chosen = searchChoice.cardCandidates[0].candidateId;
  a.send({
    type: 'search-deck',
    commandId: commandId(),
    sessionId: search.view.sessionId,
    expectedVersion: search.view.version,
    choiceId: searchChoice.choiceId,
    candidateIds: [chosen],
  });
  const used = await waitForMessage(a, (message) => message.type === 'match' && message.view.events.some((event) => event.type === 'cards-searched' && event.destination === 'bench'), 10_000, '深钵镇放置');
  check('检索结果直接放于备战区并消耗本回合次数', used.view.you.stadiumUsedThisTurn === true && used.view.you.bench.length >= 1);
  a.send({ type: 'use-stadium', commandId: commandId(), sessionId: a.match().sessionId, expectedVersion: a.match().version });
  const denied = await waitForMessage(a, (message) => message.type === 'match-error' && message.code === 'action-not-allowed', 10_000, '第二次使用被拒绝');
  check('同一回合第二次使用竞技场效果被拒绝', denied.message.includes('竞技场'));
  const version = a.match().version;
  await endTurnAndWait(a, a.match().turn + 1);
  check('竞技场在对局中持续存在', b.match().stadium !== null && a.match().stadium !== null);
  void version;
}

async function pokeBallFlow(a, b) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    await ensureTrainerForFlow(a, b, '精灵球');
    await playTrainer(a, (card) => card.nameZh.startsWith('精灵球'), `精灵球第 ${attempt} 次`);
    const after = a.match();
    const flip = after.events.filter((event) => event.type === 'coin-flip').at(-1);
    if (flip?.result === 'tails') {
      check(`精灵球第 ${attempt} 次反面不创建检索选择`, after.pendingChoice === null);
      continue;
    }
    check(`精灵球第 ${attempt} 次正面后进入检索`, after.pendingChoice?.kind === 'search-deck');
    const searchChoice = after.pendingChoice;
    const chosen = searchChoice.cardCandidates[0].candidateId;
    a.send({
      type: 'search-deck',
      commandId: commandId(),
      sessionId: after.sessionId,
      expectedVersion: after.version,
      choiceId: searchChoice.choiceId,
      candidateIds: [chosen],
    });
    const done = await waitForMessage(a, (message) => message.type === 'match' && message.view.events.some((event) => event.type === 'cards-searched'), 10_000, '精灵球检索结果');
    check('精灵球正面检索展示并加入手牌', done.view.you.hand.some((card) => card.cardId === searchChoice.cardCandidates[0].card.cardId));
    return;
  }
  check('精灵球在 12 次内出现正面', false, '连续反面');
}

async function endTurnAndWait(client, nextTurn) {
  const view = client.match();
  const command = commandId();
  client.send({ type: 'end-turn', commandId: command, sessionId: view.sessionId, expectedVersion: view.version });
  await waitForNextMessage(client, (message) => message.type === 'match' && message.commandId === command, 10_000, '结束回合结果');
  await waitForMessage(client, (message) => message.type === 'match' && message.view.turn === nextTurn, 10_000, `回合 ${nextTurn}`);
}

/**
 * 结束 A 当前回合、驱动 B 结束其回合，回到 A 的下一个回合。
 * 用于在目标训练家卡尚未抽到时自然抽牌，而不是让端到端脚本依赖开局手牌的随机组合。
 */
async function advanceToNextATurn(a, b) {
  const currentTurn = a.match().turn;
  await endTurnAndWait(a, currentTurn + 1);
  await endTurnAndWait(b, currentTurn + 2);
  await waitForMessage(
    a,
    (message) => message.type === 'match' && message.view.turn === currentTurn + 2 && message.view.activeSeat === 0,
    10_000,
    'A 的下一个回合',
  );
}

/** 确保 A 手牌中有指定名称前缀的训练家别名；必要时推进回合继续抽牌。 */
async function ensureTrainerForFlow(a, b, namePrefix, maxRounds = 6) {
  for (let round = 0; round <= maxRounds; round += 1) {
    if (a.match().you.hand.some((card) => card.nameZh.startsWith(namePrefix))) {
      return;
    }
    if (round === maxRounds) {
      throw new Error(`等待「${namePrefix}」别名进入手牌超时`);
    }
    await advanceToNextATurn(a, b);
  }
}

async function runMatch(name, { deckA, deckB, benchBasicsA = false, benchBasicsB = false }, flow) {
  console.log(`\n-- ${name} --`);
  const { a, b, rawB } = await startMatch({ deckA, deckB, benchBasicsA, benchBasicsB });
  if (a.match().activeSeat !== 0) {
    await endTurnAndWait(b, 2);
  }
  check(`${name}：开局后 A 为后攻方（第 2 回合行动）`, a.match().turn === 2 && a.match().activeSeat === 0);
  await flow(a, b, rawB);
  return { a, b };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                                */
/* ------------------------------------------------------------------ */

try {
  console.log('== 真实训练家卡端到端：真实服务 + 两客户端 + 生产效果注册表 ==');
  const health = await waitForHealth();
  check('服务健康检查可用', health.status === 'ok');

  // 发行目录只标记 7 张已验证训练家卡，且仍不能正式对战。
  const supported = fixture.release.cards.filter((card) => card.flags.effectSupported);
  check('发行目录仍标记 7 张训练家卡为已支持', supported.length === 7);
  check('发行目录整体仍不可正式对战', fixture.release.supportPolicy.playable === false);

  const ultra = await runMatch('高级球', { deckA: focusDeck('ultraBall'), deckB: basicDeck() }, ultraBallFlow);
  await advanceToNextATurn(ultra.a, ultra.b);
  check('高级球结束后对局继续（进入下一回合）', ultra.a.match().phase === 'playing');
  ultra.a.connection.close();
  ultra.b.connection.close();

  const great = await runMatch('超级球', { deckA: focusDeck('greatBall'), deckB: basicDeck() }, greatBallFlow);
  await advanceToNextATurn(great.a, great.b);
  check('超级球零张选择结束后对局继续', great.a.match().phase === 'playing');
  great.a.connection.close();
  great.b.connection.close();

  const serena = await runMatch('莎莉娜', { deckA: focusDeck('serena'), deckB: vDeck(), benchBasicsB: true }, serenaFlow);
  void serena;

  const deepBowl = await runMatch('深钵镇', { deckA: focusDeck('deepBowl'), deckB: basicDeck() }, deepBowlFlow);
  void deepBowl;

  const pokeBall = await runMatch('精灵球', { deckA: focusDeck('pokeBall'), deckB: basicDeck() }, pokeBallFlow);
  void pokeBall;
} catch (error) {
  check('端到端流程未抛出未处理错误', false, error instanceof Error ? error.message : String(error));
} finally {
  service.kill();
  await sleep(300);
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 临时目录清理失败不改变验收结论 */
  }
  console.log(`\n结果: ${passes.length} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    console.log('失败项：');
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exit(1);
  }
  if (serviceLogs.some((line) => line.includes('未处理') || line.includes('Error'))) {
    console.log('注意：服务日志包含错误行，请检查。');
  }
}
