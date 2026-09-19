// Validator-level tests for the same-name / different-effect data model.
// Run with:
//   node --test tools/card-data/build-card-data.test.mjs
//
// The identity unit tests (identity.test.mjs) pin the hashing policy.  These
// tests exercise the real builder/validator entry points on a synthetic
// evidence set:
//   - two different effects with the same name keep distinct effect identities
//     and one merged name group, but only when the environment declares the
//     variants explicitly;
//   - the at-most-4 same-name cap still counts both variants together;
//   - a declaration that misses or duplicates an effect identity is rejected.
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeIdentities, validateSources } from './build-card-data.mjs';

const ITEM_RULE = '在自己的回合可以使用任意张物品卡。';
const TEST_NAME = '测试物品';

const item = (id, effect, number) => ({
  id,
  name_zh: TEST_NAME,
  card_class: 'trainer',
  subtype: ['物品'],
  effective_category: '物品',
  effect_text_zh: effect,
  class_rule_text_zh: ITEM_RULE,
  printed_class_rule_text_zh: ITEM_RULE,
  tool_banner_text_zh: null,
  special_rule_text_zh: null,
  attacks: [],
  rule_interactions: [],
  print: { print_code: 'TESTC', regulation_mark: 'G', number, total: '100' },
});

const pokemon = (id, name, subtype, extras = {}) => ({
  id,
  name_zh: name,
  card_class: 'pokemon',
  subtype,
  evolves_from: extras.evolves_from ?? null,
  hp: extras.hp ?? 60,
  type: extras.type ?? '无色',
  weakness: null,
  resistance: null,
  retreat: 1,
  rule_labels: [],
  special_rule_text_zh: null,
  abilities: [],
  attacks: [],
  print: { print_code: 'TESTC', regulation_mark: 'G', number: extras.number ?? '1', total: '100' },
});

const basicEnergy = (id, number) => ({
  id,
  name_zh: '基本草能量',
  card_class: 'energy',
  subtype: ['基本能量'],
  type: '草',
  effect_text_zh: null,
  effect_summary_zh: '',
  print: { print_code: 'TESTC', regulation_mark: 'G', number, total: '100' },
});

const CARDS = [
  item('t-item-a', '从自己牌库中抽取1张卡牌。', '10'),
  item('t-item-b', '从自己牌库中抽取2张卡牌。', '11'),
  pokemon('p-basic-1', '测试基础', ['基础'], { number: '20', hp: 60, type: '草' }),
  pokemon('p-stage-1', '测试进化', ['1阶进化'], {
    number: '21',
    hp: 90,
    type: '草',
    evolves_from: '测试基础',
  }),
  pokemon('p-basic-2', '测试基础二', ['基础'], { number: '22', hp: 70, type: '水' }),
  basicEnergy('e-basic', '30'),
];

const DECLARATION = {
  name_group_key: `name:${TEST_NAME}`,
  name_zh: TEST_NAME,
  basis_zh: 'test-only declaration',
  variants: [
    { label: '抽1', card_ids: ['t-item-a'] },
    { label: '抽2', card_ids: ['t-item-b'] },
  ],
};

const testEnvironment = (declarations) => ({
  id: 'test-environment',
  name_variant_declarations: declarations,
  trainer_class_rules: { 物品: { text_zh: ITEM_RULE, per_turn_limit: 'unlimited' } },
  rules_documents: {
    pre_cutoff_archived: [
      { url: 'https://www.pokemon.cn/tcg/other/17144.html' },
      {
        url: 'https://web.archive.org/web/20240818145045/https://www.pokemon.cn/tcg/rules/howtoplay/basic_rules07/',
      },
      {
        url: 'https://web.archive.org/web/20230208093118id_/https://www.pokemon.cn/tcg/pdf/basic_rules08.pdf',
      },
    ],
  },
  card_rule_applications: [{ note: '宝可梦道具' }],
  rule_change_correction: { note: '17127' },
  advanced_rules_manual: {
    document_version: 'test',
    document_date: '2025-03-21',
    pdf: { sha256: 'test' },
  },
});

function makeContext({ declarations = [], itemAEntries = [['t-item-a', 2], ['t-item-b', 2]] } = {}) {
  const itemTotal = itemAEntries.reduce((total, [, count]) => total + count, 0);
  const deckA = {
    code: 'A',
    archetype_zh: '测试打法A',
    cards: [
      ...itemAEntries.map(([id, count]) => ({ id, count })),
      { id: 'p-basic-1', count: 1 },
      { id: 'p-stage-1', count: 1 },
      { id: 'e-basic', count: 58 - itemTotal },
    ],
  };
  const filler = (code) => ({
    code,
    archetype_zh: `测试打法${code}`,
    cards: [
      { id: 'p-basic-2', count: 1 },
      { id: 'e-basic', count: 59 },
    ],
  });
  return {
    environment: testEnvironment(declarations),
    csve1: { card_count: CARDS.length, cards: CARDS },
    extra: { card_count: 0, cards: [] },
    decksDoc: { decks: [deckA, filler('B'), filler('C'), filler('D')] },
    index: { cards: [] },
    matrixDoc: { cards: [] },
    identitiesDoc: null,
    allCards: CARDS,
    byId: new Map(CARDS.map((card) => [card.id, card])),
  };
}

test('declared same-name/different-effect variants keep distinct effect identities and pass validation', () => {
  const context = makeContext({ declarations: [DECLARATION] });
  const identities = computeIdentities(context);
  const group = identities.nameGroups.get(`name:${TEST_NAME}`);
  assert.equal(group.effect_identities.length, 2, 'two effects must stay two identities');
  assert.equal(group.declared_variants.length, 2, 'the declaration must resolve both variants');
  assert.deepEqual(
    group.declared_variants.map((variant) => variant.effect_identity),
    group.effect_identities,
    'each declared variant must resolve to one of the group effect identities',
  );
  assert.deepEqual(
    group.declared_variants.flatMap((variant) => variant.card_ids).sort(),
    ['t-item-a', 't-item-b'],
  );

  const result = validateSources(context, identities);
  assert.deepEqual(result.errors, []);
  assert.equal(result.deckValidation.A.total_cards, 60);
  assert.equal(result.deckValidation.A.name_rule_ok, true);
});

test('the at-most-4 same-name cap counts all declared variants together', () => {
  const context = makeContext({
    declarations: [DECLARATION],
    itemAEntries: [['t-item-a', 3], ['t-item-b', 2]],
  });
  const identities = computeIdentities(context);
  const result = validateSources(context, identities);
  assert.ok(
    result.errors.some((error) => error.startsWith('A:') && error.includes('> 4')),
    `expected the merged name cap to reject 3+2 copies, got ${JSON.stringify(result.errors)}`,
  );
  assert.equal(result.deckValidation.A.name_rule_ok, false);
});

test('an undeclared same-name/different-effect group is rejected', () => {
  const context = makeContext({ declarations: [] });
  const identities = computeIdentities(context);
  const result = validateSources(context, identities);
  assert.ok(
    result.errors.some((error) => error.includes('without a declared_variants mapping')),
    `expected a missing-declaration error, got ${JSON.stringify(result.errors)}`,
  );
});

test('a declaration with fewer than two variants is rejected', () => {
  const incomplete = { ...DECLARATION, variants: [DECLARATION.variants[0]] };
  const context = makeContext({ declarations: [incomplete] });
  const identities = computeIdentities(context);
  const result = validateSources(context, identities);
  assert.ok(
    result.errors.some((error) => error.includes('declare at least two variants')),
    `expected a two-variant error, got ${JSON.stringify(result.errors)}`,
  );
});

test('a declaration that does not cover every effect identity is rejected', () => {
  const overlapping = {
    ...DECLARATION,
    variants: [
      { label: '抽1', card_ids: ['t-item-a'] },
      { label: '重复', card_ids: ['t-item-a'] },
    ],
  };
  const context = makeContext({ declarations: [overlapping] });
  const identities = computeIdentities(context);
  const result = validateSources(context, identities);
  assert.ok(
    result.errors.some((error) => error.includes('misses effect identities')),
    `expected a coverage error, got ${JSON.stringify(result.errors)}`,
  );
});
