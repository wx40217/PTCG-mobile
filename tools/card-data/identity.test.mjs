// Unit tests for the identity policy.  Run with:
//   node --test tools/card-data/identity.test.mjs
//
// These tests pin the two behaviours the data model must keep apart:
//   - same name + different effect  -> different effect_identity, same name_group_key
//   - same effect + different print -> same effect_identity, different print_identity
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeFullText, effectIdentityOf, nameGroupKeyOf, printIdentityOf } from './identity.mjs';

const supporterRule = '在自己的回合只可以使用1张支援者卡。';

function trainer(overrides = {}) {
  return {
    id: 'fx-test',
    name_zh: '珠贝',
    card_class: 'trainer',
    subtype: ['支援者'],
    effective_category: '支援者',
    effect_text_zh: '选择自己牌库中的[水]宝可梦和物品各1张，加入手牌。',
    class_rule_text_zh: supporterRule,
    printed_class_rule_text_zh: supporterRule,
    tool_banner_text_zh: null,
    special_rule_text_zh: null,
    attacks: [],
    print: { print_code: 'CSVE1C', regulation_mark: 'F', number: '138', total: '177' },
    ...overrides,
  };
}

test('same name with a different effect gets a different effect_identity but the same name group', () => {
  const first = trainer();
  const second = trainer({
    effect_text_zh: '从自己牌库中抽取3张卡牌。',
    print: { print_code: 'CSVE1C', regulation_mark: 'F', number: '139', total: '177' },
  });
  assert.notEqual(
    effectIdentityOf(first).effect_identity,
    effectIdentityOf(second).effect_identity,
    'different effects must not share an effect identity',
  );
  assert.equal(nameGroupKeyOf(first), nameGroupKeyOf(second));
});

test('same effect from another printing merges identities but keeps distinct print identities', () => {
  const first = trainer();
  const reprint = trainer({
    print: { print_code: 'CSVE1C', regulation_mark: 'F', number: '200', total: '200' },
  });
  assert.equal(
    effectIdentityOf(first).effect_identity,
    effectIdentityOf(reprint).effect_identity,
    'an identical canonical payload is a legitimate same-effect reprint',
  );
  assert.notEqual(printIdentityOf(first), printIdentityOf(reprint));
});

test('a Pokemon Tool printed as 物品 and an effective 宝可梦道具 printing share the effect identity', () => {
  const base = {
    id: 'fx-test-tool',
    name_zh: '一击卷轴 愤怒之卷',
    card_class: 'trainer',
    subtype: ['物品', '宝可梦道具', '一击'],
    effective_category: '宝可梦道具',
    effect_text_zh: '身上放有这张卡牌的「一击」宝可梦，可以使用这张卡牌上的招式。',
    class_rule_text_zh: '在自己的回合可以将任意张宝可梦道具卡，放于自己的宝可梦身上。',
    printed_class_rule_text_zh: '在自己的回合可以使用任意张物品卡。',
    tool_banner_text_zh: '宝可梦道具可以附着在自己的宝可梦身上。',
    attacks: [],
  };
  const oldPrint = {
    ...base,
    print: { print_code: 'CSVE1C', regulation_mark: 'E', number: '127', total: '177' },
  };
  // A later printing updates only the printed header and bottom rule; the
  // effect text and the effective category are unchanged.
  const newPrint = {
    ...base,
    subtype: ['宝可梦道具', '一击'],
    printed_class_rule_text_zh:
      '在自己的回合可以将任意张宝可梦道具卡，放于自己的宝可梦身上。',
    tool_banner_text_zh: null,
    print: { print_code: 'CSV4C', regulation_mark: 'H', number: '090', total: '100' },
  };
  assert.equal(
    effectIdentityOf(oldPrint).effect_identity,
    effectIdentityOf(newPrint).effect_identity,
    'printed category wording is not part of the effect identity; the effective category is',
  );

  const changedEffect = {
    ...newPrint,
    effect_text_zh: '身上放有这张卡牌的「一击」宝可梦，可以使用这张卡牌上的招式。追加效果。',
  };
  assert.notEqual(
    effectIdentityOf(oldPrint).effect_identity,
    effectIdentityOf(changedEffect).effect_identity,
    'a changed effect text must not merge identities',
  );
});

test('composeFullText keeps the effect once and includes the printed class rule', () => {
  const card = trainer();
  const text = composeFullText(card);
  assert.equal(text.split(card.effect_text_zh).length - 1, 1);
  assert.match(text, /\[类别规则\]/);
  assert.equal(text.split(card.class_rule_text_zh).length - 1, 1);
  const paragraphs = text.split('\n').filter(Boolean);
  assert.equal(new Set(paragraphs).size, paragraphs.length);
});
