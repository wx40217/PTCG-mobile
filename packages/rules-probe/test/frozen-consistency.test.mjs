import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATALOG, PROBE_DECKS } from '../dist/src/index.js';

const root = new URL('../../../', import.meta.url);

function readData(pathFromRepo) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(pathFromRepo, root)), 'utf8'));
}

const matrix = readData('data/decks/zh-cn-standard-2025-06-05-effect-matrix.json');
const csve1 = readData('data/cards/zh-cn-standard-2025-06-05/csve1-card-details.json');
const extras = readData('data/cards/zh-cn-standard-2025-06-05/standard-2025-06-05-extra-card-details.json');

const matrixByEffect = new Map(matrix.cards.map(card => [card.effect_identity, card]));
const detailsByEffect = new Map(
  [...csve1.cards, ...extras.cards].map(card => [card.effect_identity, card]),
);

function parseWeakness(text) {
  if (text === null || text === undefined) {
    return undefined;
  }
  const match = /^(.+?)(?:×|x)(\d+)$/.exec(text);
  assert.ok(match, `unparsable weakness text: ${text}`);
  return { type: match[1], factor: Number(match[2]) };
}

function parseResistance(text) {
  if (text === null || text === undefined) {
    return undefined;
  }
  const match = /^(.+?)(-?\d+)$/.exec(text);
  assert.ok(match, `unparsable resistance text: ${text}`);
  return { type: match[1], value: Number(match[2]) };
}

test('every catalog entry matches the frozen effect matrix', () => {
  assert.ok(Object.keys(CATALOG).length >= 10);
  for (const def of Object.values(CATALOG)) {
    const matrixCard = matrixByEffect.get(def.cardKey);
    assert.ok(matrixCard, `missing effect identity in matrix: ${def.cardKey}`);
    assert.equal(matrixCard.name_zh, def.nameZh, `name mismatch for ${def.cardKey}`);
    assert.equal(matrixCard.card_class, def.kind, `kind mismatch for ${def.cardKey}`);
    if (def.kind === 'trainer') {
      assert.equal(matrixCard.effective_category, def.category, `effective category mismatch for ${def.cardKey}`);
    }
    if (def.kind === 'energy') {
      assert.ok(
        matrixCard.mechanics.some(item => item.includes('基本能量')),
        `${def.cardKey} must be a basic energy`,
      );
    }
  }
});

test('catalog Pokémon stats and attacks match the frozen card details', () => {
  for (const def of Object.values(CATALOG)) {
    if (def.kind !== 'pokemon') {
      continue;
    }
    const detail = detailsByEffect.get(def.cardKey);
    assert.ok(detail, `missing card detail for ${def.cardKey}`);
    assert.equal(detail.hp, def.hp, `hp mismatch for ${def.cardKey}`);
    assert.equal(detail.type, def.type, `type mismatch for ${def.cardKey}`);
    assert.deepEqual(parseWeakness(detail.weakness), def.weakness, `weakness mismatch for ${def.cardKey}`);
    assert.deepEqual(parseResistance(detail.resistance), def.resistance, `resistance mismatch for ${def.cardKey}`);
    assert.equal(detail.retreat, def.retreat, `retreat mismatch for ${def.cardKey}`);
    assert.equal(detail.subtype.includes('基础'), def.basic === true, `basic subtype mismatch for ${def.cardKey}`);
    assert.equal(detail.subtype.includes('ex'), (def.prizeValue ?? 0) === 2, `ex prize rule mismatch for ${def.cardKey}`);

    for (const attack of def.attacks ?? []) {
      const detailAttack = detail.attacks.find(item => item.name === attack.name);
      assert.ok(detailAttack, `attack ${attack.name} missing from frozen details`);
      assert.deepEqual(detailAttack.cost, attack.cost, `attack cost mismatch for ${attack.name}`);
      if (attack.kind === 'fixed') {
        assert.equal(Number(detailAttack.damage), attack.baseDamage, `attack damage mismatch for ${attack.name}`);
      }
      if (attack.kind === 'hail-blade') {
        assert.match(detailAttack.damage, /×/, `hail-blade damage must scale with discarded energy`);
      }
      if (attack.kind === 'pierce') {
        assert.equal(Number(detailAttack.damage), attack.baseDamage);
        assert.match(detailAttack.text, /30/, 'pierce bench damage must match the frozen text');
      }
    }
    for (const ability of def.abilities ?? []) {
      const detailAbility = detail.abilities.find(item => item.name === ability.name);
      assert.ok(detailAbility, `ability ${ability.name} missing from frozen details`);
    }
  }
});

test('2025-01-17 item / Pokémon Tool split is present in the frozen data', () => {
  const irida = matrixByEffect.get('fx:trainer:珠贝:d6960eb0d722');
  assert.ok(irida);
  assert.ok(
    irida.rule_interactions.some(text => text.includes('宝可梦道具') && text.includes('物品')),
    '珠贝 must carry the item/tool interaction from the frozen environment data',
  );
  const tool = matrixByEffect.get('fx:trainer:勇气护符:8eb34c62d928');
  assert.ok(tool);
  assert.equal(tool.effective_category, '宝可梦道具');
  assert.equal(CATALOG[tool.effect_identity].category, '宝可梦道具');
});

test('every probe-deck card comes from a T01 deck and is known to the matrix', () => {
  for (const side of PROBE_DECKS) {
    assert.ok(side.length > 0);
    const total = side.reduce((sum, entry) => sum + entry.count, 0);
    assert.ok(total >= 13, 'a probe deck must hold at least 7 hand plus 6 prize cards');
    for (const entry of side) {
      const matrixCard = matrixByEffect.get(entry.cardKey);
      assert.ok(matrixCard, `probe card is not part of the frozen matrix: ${entry.cardKey}`);
      const deckCounts = Object.values(matrixCard.decks);
      assert.ok(deckCounts.some(count => count > 0), `probe card is not used by any T01 deck: ${entry.cardKey}`);
      assert.ok(entry.count > 0);
    }
  }
});
