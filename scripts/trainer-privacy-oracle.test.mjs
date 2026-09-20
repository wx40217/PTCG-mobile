// T10 训练家端到端隐私 oracle 回归。运行：
//   node --test scripts/trainer-privacy-oracle.test.mjs
//
// 这些测试锁定 e2e-trainers.mjs 隐私断言的关键性质：
//   - 泄露身份出现在动作后的新事件里时，不能用动作后重新推导的公开集合
//     把它洗白（假阴性回归）；
//   - 动作前已合法公开的同一身份允许出现在待决载荷中（不误报）；
//   - 逐张检查全部候选，不为「只查第一张」放水；
//   - 公开身份推导只覆盖公开区域/事件，不把私人字段（手牌/牌库/奖赏/
//     待决候选）纳入白名单。
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPublicCardIds, evaluateCandidatePrivacy, publicIdsFor } from './trainer-privacy-oracle.mjs';

function view(overrides = {}) {
  return {
    you: { discard: [], active: null, bench: [], hand: [], deck: [], prizes: [] },
    opponent: { discard: [], active: null, bench: [] },
    stadium: null,
    events: [],
    pendingChoice: null,
    ...overrides,
  };
}

test('泄露身份出现在新事件中：动作前冻结集合判为泄露，动作后重推才会洗白', () => {
  const leakedEvent = { type: 'cards-searched', cards: [{ cardId: 'probe-leak-1' }] };
  const pendingView = view({ events: [leakedEvent] });
  // 这正是旧断言假阴性的来源：若在动作后重新推导公开身份，泄露事件自身
  // 携带的 cardId 会被算作「已公开」。
  assert.equal(collectPublicCardIds([pendingView]).has('probe-leak-1'), true);
  // 动作前冻结的公开集合为空，因此同一载荷中的身份必须判为泄露。
  const result = evaluateCandidatePrivacy({
    candidateIds: ['probe-leak-1'],
    frozenPublicIds: new Set(),
    payloads: [JSON.stringify(pendingView)],
  });
  assert.deepEqual(result.stillHidden, ['probe-leak-1']);
  assert.deepEqual(result.leaked, ['probe-leak-1']);
  assert.deepEqual(result.reappearedPublic, []);
});

test('动作前已合法公开的同一身份在待决载荷中通过', () => {
  const result = evaluateCandidatePrivacy({
    candidateIds: ['mulligan-public-1'],
    frozenPublicIds: new Set(['mulligan-public-1']),
    payloads: ['{"cards":[{"cardId":"mulligan-public-1"}]}'],
  });
  assert.deepEqual(result.stillHidden, []);
  assert.deepEqual(result.previouslyPublic, ['mulligan-public-1']);
  assert.deepEqual(result.leaked, []);
  assert.deepEqual(result.reappearedPublic, ['mulligan-public-1']);
});

test('逐张检查全部候选：动作前未公开的泄露、已公开的不误报', () => {
  const result = evaluateCandidatePrivacy({
    candidateIds: ['public-a', 'hidden-b', 'hidden-c'],
    frozenPublicIds: new Set(['public-a']),
    payloads: ['{"cardId":"public-a"}', '{"cardId":"hidden-c"}'],
  });
  assert.deepEqual(result.stillHidden, ['hidden-b', 'hidden-c']);
  assert.deepEqual(result.leaked, ['hidden-c']);
  assert.deepEqual(result.previouslyPublic, ['public-a']);
});

test('公开身份推导覆盖公开区域/事件，不把私人字段纳入白名单', () => {
  const ids = collectPublicCardIds([
    view({
      you: {
        discard: [{ cardId: 'public-discard' }],
        active: { card: { cardId: 'public-active' }, energies: [{ card: { cardId: 'public-energy' } }] },
        bench: [{ card: { cardId: 'public-bench' } }],
        hand: [{ cardId: 'private-hand' }],
        deck: [{ cardId: 'private-deck' }],
        prizes: [{ cardId: 'private-prize' }],
      },
      opponent: { discard: [{ cardId: 'public-opponent-discard' }], active: null, bench: [] },
      stadium: { cardId: 'public-stadium' },
      events: [{ type: 'cards-searched', cards: [{ cardId: 'public-event' }] }],
      pendingChoice: { cardCandidates: [{ candidateId: 'candidate-1', card: { cardId: 'private-candidate' } }] },
    }),
  ]);
  for (const publicId of [
    'public-discard',
    'public-active',
    'public-energy',
    'public-bench',
    'public-opponent-discard',
    'public-stadium',
    'public-event',
  ]) {
    assert.equal(ids.has(publicId), true, `${publicId} 应算作合法公开身份`);
  }
  for (const privateId of ['private-hand', 'private-deck', 'private-prize', 'private-candidate']) {
    assert.equal(ids.has(privateId), false, `${privateId} 属于私人信息，不应进入公开身份集合`);
  }
});

test('publicIdsFor 只读取接收方已收到的对局视图', () => {
  const client = {
    messages: [
      { type: 'room', room: {} },
      { type: 'match', view: view({ opponent: { discard: [{ cardId: 'known-1' }], active: null, bench: [] } }) },
    ],
  };
  assert.deepEqual([...publicIdsFor(client)], ['known-1']);
});
