// Shared identity rules for the frozen zh-CN card data.
//
// Three separate concepts (see CONTEXT.md and ADR-0004):
//
//   effect_identity  what the card actually does, plus the rule attributes
//                    that matter for resolving it (category, tags, stats,
//                    abilities/attacks, special-card rule text).  Two
//                    printings may share an effect_identity only when this
//                    canonical payload is byte-identical; a shared name is
//                    never sufficient.
//   print_identity   one concrete printing: product code + card number.
//   name_group_key   the key the at-most-4 same-name construction rule is
//                    evaluated on.  Official rules may declare different
//                    names to be one group (e.g. the various 博士的研究);
//                    such declarations are evidence, not name-string logic.
//
// `composeFullText` renders the card-face reading used by the details,
// index and effect matrix.  It never repeats an effect text and always
// includes the printed class rule for trainer cards, so duplicate-effect
// strings cannot hide behind a "dedupe" pass.
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 'ptcg.card-details/v2';

const CATEGORY_WORDS = new Set([
  '物品',
  '宝可梦道具',
  '支援者',
  '竞技场',
  '特殊能量',
  '基本能量',
]);

export function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text.length ? text : null;
}

function normalizedArray(values) {
  return (values ?? []).map((value) => (typeof value === 'string' ? value.trim() : value));
}

export function isBasicEnergy(card) {
  return card.card_class === 'energy' && normalizedArray(card.subtype).includes('基本能量');
}

export function ruleTags(card) {
  const effectiveCategory = card.effective_category ?? null;
  return normalizedArray(card.subtype)
    .filter((tag) => !CATEGORY_WORDS.has(tag) && tag !== effectiveCategory)
    .sort();
}

export function canonicalEffectPayload(card) {
  const payload = {
    card_class: card.card_class,
    name_zh: normalizeText(card.name_zh),
    rule_tags: ruleTags(card),
    effect_text_zh: normalizeText(card.effect_text_zh),
  };
  if (card.card_class === 'pokemon') {
    payload.subtype = normalizedArray(card.subtype).slice().sort();
    payload.hp = card.hp ?? null;
    payload.type = card.type ?? null;
    payload.weakness = card.weakness ?? null;
    payload.resistance = card.resistance ?? null;
    payload.retreat = card.retreat ?? null;
    payload.rule_labels = normalizedArray(card.rule_labels).slice().sort();
    payload.special_rule_text_zh = normalizeText(card.special_rule_text_zh);
    payload.abilities = (card.abilities ?? []).map((ability) => ({
      label: ability.label ?? null,
      name: ability.name ?? null,
      text: normalizeText(ability.text),
    }));
    payload.attacks = (card.attacks ?? []).map((attack) => ({
      name: attack.name ?? null,
      cost: normalizedArray(attack.cost),
      damage: attack.damage ?? null,
      text: normalizeText(attack.text),
    }));
    return payload;
  }
  if (card.card_class === 'trainer') {
    payload.effective_category = card.effective_category ?? null;
    payload.attacks = (card.attacks ?? []).map((attack) => ({
      name: attack.name ?? null,
      cost: normalizedArray(attack.cost),
      damage: attack.damage ?? null,
      text: normalizeText(attack.text),
    }));
    return payload;
  }
  // energy
  payload.subtype = normalizedArray(card.subtype).slice().sort();
  payload.type = card.type ?? null;
  return payload;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function canonicalPayloadJson(card) {
  return JSON.stringify(sortValue(canonicalEffectPayload(card)));
}

export function effectIdentityOf(card) {
  const sha256 = createHash('sha256').update(canonicalPayloadJson(card)).digest('hex');
  return {
    effect_identity: `fx:${card.card_class}:${normalizeText(card.name_zh)}:${sha256.slice(0, 12)}`,
    canonical_effect_sha256: sha256,
  };
}

export function printIdentityOf(card) {
  return `print:${card.print.print_code}:${card.print.number}`;
}

export function nameGroupKeyOf(card) {
  return `name:${normalizeText(card.name_zh)}`;
}

function attackLine(attack) {
  const cost = (attack.cost ?? []).join('');
  const damage = attack.damage ?? '';
  const text = normalizeText(attack.text) ?? '';
  return `[${cost}] ${attack.name} ${damage} ${text}`.replace(/\s+/g, ' ').trim();
}

/** Card-face reading.  Deterministic: same input -> same output, effect text once. */
export function composeFullText(card) {
  const parts = [];
  const special = normalizeText(card.special_rule_text_zh);
  if (special && card.card_class === 'pokemon') parts.push(special);

  if (card.card_class === 'pokemon') {
    for (const ability of card.abilities ?? []) {
      parts.push(`[${ability.label}] ${ability.name}：${normalizeText(ability.text) ?? ''}`);
    }
    for (const attack of card.attacks ?? []) parts.push(attackLine(attack));
    return parts.join('\n');
  }

  if (card.card_class === 'trainer') {
    const banner = normalizeText(card.tool_banner_text_zh);
    if (banner) parts.push(banner);
    const effect = normalizeText(card.effect_text_zh);
    if (effect) parts.push(effect);
    for (const attack of card.attacks ?? []) parts.push(attackLine(attack));
    const printedRule = normalizeText(card.printed_class_rule_text_zh);
    const effectiveRule = normalizeText(card.class_rule_text_zh);
    if (printedRule && effectiveRule && printedRule !== effectiveRule) {
      parts.push(`[类别规则（卡面印刷）] ${printedRule}`);
      parts.push(`[类别规则（2025-01-17改正后适用）] ${effectiveRule}`);
    } else if (printedRule || effectiveRule) {
      parts.push(`[类别规则] ${printedRule ?? effectiveRule}`);
    }
    return parts.join('\n');
  }

  // energy
  const effect = normalizeText(card.effect_text_zh);
  if (effect) parts.push(effect);
  return parts.join('\n');
}
