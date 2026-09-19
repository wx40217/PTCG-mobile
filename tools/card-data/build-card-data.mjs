#!/usr/bin/env node
// Build / validate the frozen zh-CN card data.
//
//   node tools/card-data/build-card-data.mjs           # verify committed data
//   node tools/card-data/build-card-data.mjs --write   # regenerate derived files
//
// The details files are the hand-verified source of truth.  This script
// recomputes the effect / print / name-group identities (see identity.mjs),
// derives the identity registry, enriches the index and deck lists, derives
// the effect matrix, and checks every cross-file invariant.  Nothing here
// trusts the `validation_errors` field of any input file.
//
// Two validation layers:
//   sources   edits to the details / deck design / environment.  `--write`
//             refuses to run when these fail.
//   artifacts redundant fields stored in index / decks / matrix / registry.
//             `--write` regenerates them, then re-validates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeFullText,
  effectIdentityOf,
  isBasicEnergy,
  nameGroupKeyOf,
  printIdentityOf,
  SCHEMA_VERSION,
} from './identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WRITE = process.argv.includes('--write');

const PATHS = {
  environment: 'data/environment/zh-cn-standard-2025-06-05.json',
  csve1Details: 'data/cards/zh-cn-standard-2025-06-05/csve1-card-details.json',
  extraDetails: 'data/cards/zh-cn-standard-2025-06-05/standard-2025-06-05-extra-card-details.json',
  index: 'data/cards/zh-cn-standard-2025-06-05/csve1-card-index.json',
  identities: 'data/cards/zh-cn-standard-2025-06-05/card-identities.json',
  decks: 'data/decks/zh-cn-standard-2025-06-05-decks.json',
  matrix: 'data/decks/zh-cn-standard-2025-06-05-effect-matrix.json',
};

const IDENTITY_MODEL = {
  source_of_truth: 'tools/card-data/identity.mjs',
  check_entry: 'node tools/card-data/build-card-data.mjs',
  effect_identity:
    'Canonical effect + rule attributes (class, category/tags, stats, abilities/attacks, special-card rule). Same-effect reprints share it only when the canonical payload is identical; a shared name is never enough.',
  print_identity: 'One concrete printing: print_code + printed number.',
  name_group_key:
    'Key for the at-most-4 same-name construction rule. Official rules may declare different names to be one group (see environment reprint_provision name_identity_notes); effect identity is a separate axis.',
};

const readJson = (relPath) => JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
const writeJson = (relPath, value) =>
  fs.writeFileSync(path.join(ROOT, relPath), JSON.stringify(value, null, 2) + '\n');
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const occurrenceCount = (haystack, needle) => {
  if (!needle) return 0;
  let count = 0;
  let at = 0;
  while ((at = haystack.indexOf(needle, at)) !== -1) {
    count += 1;
    at += needle.length;
  }
  return count;
};

function loadContext() {
  const environment = readJson(PATHS.environment);
  const csve1 = readJson(PATHS.csve1Details);
  const extra = readJson(PATHS.extraDetails);
  const index = readJson(PATHS.index);
  const decksDoc = readJson(PATHS.decks);
  const matrixDoc = readJson(PATHS.matrix);
  const identitiesDoc = fs.existsSync(path.join(ROOT, PATHS.identities))
    ? readJson(PATHS.identities)
    : null;
  const allCards = [...csve1.cards, ...extra.cards];
  const byId = new Map(allCards.map((card) => [card.id, card]));
  return { environment, csve1, extra, index, decksDoc, matrixDoc, identitiesDoc, allCards, byId };
}

function computeIdentities(context) {
  const computed = context.allCards.map((card) => {
    const { effect_identity, canonical_effect_sha256 } = effectIdentityOf(card);
    return {
      id: card.id,
      card,
      effect_identity,
      canonical_effect_sha256,
      print_identity: printIdentityOf(card),
      name_group_key: nameGroupKeyOf(card),
    };
  });
  const effectGroups = new Map();
  const printToRow = new Map();
  for (const row of computed) {
    if (!effectGroups.has(row.effect_identity)) effectGroups.set(row.effect_identity, []);
    effectGroups.get(row.effect_identity).push(row);
    printToRow.set(row.print_identity, row);
  }
  const nameGroups = new Map();
  for (const row of computed) {
    const group = nameGroups.get(row.name_group_key) ?? {
      name_group_key: row.name_group_key,
      name_zh: row.card.name_zh,
      card_class: row.card.card_class,
      basic_energy_exempt: false,
      effect_identities: [],
      print_identities: [],
      declared_variants: [],
    };
    if (!group.effect_identities.includes(row.effect_identity)) {
      group.effect_identities.push(row.effect_identity);
    }
    if (!group.print_identities.includes(row.print_identity)) {
      group.print_identities.push(row.print_identity);
    }
    if (isBasicEnergy(row.card)) group.basic_energy_exempt = true;
    nameGroups.set(row.name_group_key, group);
  }
  for (const group of nameGroups.values()) {
    group.effect_identities.sort();
    group.print_identities.sort();
  }
  return { computed, effectGroups, printToRow, nameGroups };
}

function buildDeckUnion(context) {
  const union = new Map();
  for (const deck of context.decksDoc.decks) {
    for (const entry of deck.cards) {
      const card = context.byId.get(entry.id);
      if (!card) continue;
      if (!union.has(entry.id)) union.set(entry.id, { count: 0, decks: {} });
      const slot = union.get(entry.id);
      slot.count += entry.count;
      slot.decks[deck.code] = (slot.decks[deck.code] ?? 0) + entry.count;
    }
  }
  return union;
}

function validateSources(context, identities) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const { environment, decksDoc, allCards, byId } = context;

  if (byId.size !== allCards.length) fail('duplicate card ids in the details files');
  if (context.csve1.card_count !== context.csve1.cards.length) {
    fail('csve1 details card_count differs from cards.length');
  }
  if (context.extra.card_count !== context.extra.cards.length) {
    fail('extra details card_count differs from cards.length');
  }

  for (const card of allCards) {
    if (card.card_class === 'pokemon') {
      if (card.special_rule_text_zh === undefined) {
        fail(`${card.id}: missing special_rule_text_zh`);
      }
    }
    if (card.card_class === 'trainer') {
      if (!card.effect_text_zh) fail(`${card.id}: trainer without effect_text_zh`);
      if (!card.class_rule_text_zh) fail(`${card.id}: trainer without class_rule_text_zh`);
      if (!card.printed_class_rule_text_zh) {
        fail(`${card.id}: trainer without printed_class_rule_text_zh`);
      }
      if (!card.effective_category) fail(`${card.id}: trainer without effective_category`);
    }
    if (card.card_class === 'energy' && !isBasicEnergy(card) && !card.effect_text_zh) {
      fail(`${card.id}: special energy without effect_text_zh`);
    }
    if (isBasicEnergy(card) && card.effect_text_zh !== null) {
      fail(`${card.id}: basic energy must not carry effect_text_zh`);
    }
    if (card.rule_interactions && !Array.isArray(card.rule_interactions)) {
      fail(`${card.id}: rule_interactions must be an array`);
    }
  }

  for (const group of identities.nameGroups.values()) {
    if (group.effect_identities.length > 1 && group.declared_variants.length === 0) {
      fail(
        `name group ${group.name_group_key} contains ${group.effect_identities.length} different effects without a declared_variants mapping`,
      );
    }
  }

  const categoryRules = environment.trainer_class_rules ?? {};
  for (const card of allCards.filter((entry) => entry.card_class === 'trainer')) {
    const category = card.effective_category;
    const rule = categoryRules[category];
    if (!rule) {
      fail(`${card.id}: no environment trainer_class_rules entry for ${category}`);
      continue;
    }
    if (Array.isArray(rule.text_zh_variants)) {
      if (!rule.text_zh_variants.includes(card.class_rule_text_zh)) {
        fail(`${card.id}: class rule text not in the verified variants for ${category}`);
      }
    } else if (rule.text_zh !== card.class_rule_text_zh) {
      fail(`${card.id}: class rule text differs from the verified ${category} rule`);
    }
  }

  // Decks: design legality.
  const deckValidation = {};
  if (decksDoc.decks.length !== 4) fail('expected exactly four preset decks');
  if (new Set(decksDoc.decks.map((deck) => deck.code)).size !== decksDoc.decks.length) {
    fail('deck codes must be unique');
  }
  for (const deck of decksDoc.decks) {
    const problems = [];
    const nameTotals = {};
    const nameGroupInfo = {};
    let total = 0;
    let basicPokemon = 0;
    let evolutionCards = 0;
    for (const entry of deck.cards) {
      const card = byId.get(entry.id);
      if (!card) {
        problems.push(`unknown card id ${entry.id}`);
        continue;
      }
      total += entry.count;
      if (!Number.isInteger(entry.count) || entry.count <= 0) {
        problems.push(`${entry.id}: bad count`);
      }
      const row = identities.computed.find((item) => item.id === entry.id);
      nameTotals[row.name_group_key] = (nameTotals[row.name_group_key] ?? 0) + entry.count;
      nameGroupInfo[row.name_group_key] = {
        name_zh: card.name_zh,
        count: nameTotals[row.name_group_key],
        exempt: isBasicEnergy(card),
      };
      if (card.card_class === 'pokemon' && (card.subtype ?? []).includes('基础')) basicPokemon += entry.count;
      if (card.evolves_from) evolutionCards += entry.count;
      if (!isBasicEnergy(card)) {
        const mark = card.print.regulation_mark;
        if (!['E', 'F', 'G'].includes(mark)) {
          problems.push(`${entry.id}: regulation mark ${mark} is not E/F/G`);
        }
      }
      for (const label of [...(card.rule_labels ?? []), ...(card.subtype ?? [])]) {
        if (/ACE SPEC|王牌|光辉|棱镜之星/.test(label)) {
          problems.push(`${entry.id}: uses a special limit (ACE SPEC / Radiant / Prism Star)`);
        }
      }
      if (card.evolves_from) {
        const present = deck.cards.some((other) => byId.get(other.id)?.name_zh === card.evolves_from);
        if (!present) problems.push(`${card.name_zh} needs pre-evolution ${card.evolves_from}`);
      }
    }
    if (total !== 60) problems.push(`deck has ${total} cards, expected 60`);
    if (basicPokemon < 1) problems.push('no Basic Pokemon');
    for (const [groupKey, info] of Object.entries(nameGroupInfo)) {
      if (!info.exempt && info.count > 4) {
        problems.push(`${info.name_zh}: ${info.count} copies > 4 (${groupKey})`);
      }
    }
    if (problems.length) fail(`${deck.code}: ${problems.join('; ')}`);
    deckValidation[deck.code] = {
      total_cards: total,
      total_is_60: total === 60,
      name_groups_over_4: Object.fromEntries(
        Object.entries(nameGroupInfo).filter(([, info]) => !info.exempt && info.count > 4),
      ),
      name_rule_ok: !Object.values(nameGroupInfo).some((info) => !info.exempt && info.count > 4),
      basic_pokemon_count: basicPokemon,
      has_basic_pokemon: basicPokemon >= 1,
      basic_energy_exempt: true,
      marks_used: [
        ...new Set(deck.cards.map((e) => byId.get(e.id)?.print.regulation_mark).filter(Boolean)),
      ].sort(),
      evolution_cards: evolutionCards,
    };
  }
  if (new Set(decksDoc.decks.map((deck) => deck.archetype_zh)).size < 2) {
    fail('at least two playstyles are required');
  }
  if (!decksDoc.decks.some((deck) => deck.cards.some((entry) => byId.get(entry.id)?.evolves_from))) {
    fail('at least one deck must contain an evolution line');
  }

  // Environment: the 2025-01-17 item/tool revision and the 17127 correction.
  const rules = environment.rules_documents ?? {};
  if (
    !(rules.pre_cutoff_archived ?? []).some(
      (entry) => entry.url === 'https://www.pokemon.cn/tcg/other/17144.html',
    )
  ) {
    fail('environment: dated 17144 rule-change notice is not recorded');
  }
  if (!JSON.stringify(environment.card_rule_applications ?? '').includes('宝可梦道具')) {
    fail('environment: card_rule_applications must describe the Pokemon Tool / Item revision');
  }
  if (!JSON.stringify(environment.rule_change_correction ?? '').includes('17127')) {
    fail('environment: must record that 17127 is not a rules erratum');
  }
  if (JSON.stringify(environment.errata ?? '').includes('17127')) {
    fail('environment: former 17127-as-errata conclusion must be removed');
  }

  return { errors, deckValidation };
}

function validateArtifacts(context, identities, deckUnion) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const { csve1, index, decksDoc, matrixDoc, identitiesDoc, byId } = context;

  for (const row of identities.computed) {
    if (row.card.effect_identity !== row.effect_identity) {
      fail(`${row.card.id}: stored effect_identity does not match recomputed canonical payload`);
    }
    if (row.card.print_identity !== row.print_identity) {
      fail(`${row.card.id}: stored print_identity mismatch`);
    }
    if (row.card.name_group_key !== row.name_group_key) {
      fail(`${row.card.id}: stored name_group_key mismatch`);
    }
    const expectedText = composeFullText(row.card);
    if (row.card.full_text_zh !== expectedText) {
      fail(`${row.card.id}: full_text_zh is not the deterministic card-face composition`);
    }
    if (row.card.effect_text_zh && row.card.card_class !== 'pokemon') {
      if (occurrenceCount(row.card.full_text_zh, row.card.effect_text_zh) !== 1) {
        fail(`${row.card.id}: effect text must appear exactly once in full_text_zh`);
      }
    }
    if (row.card.class_rule_text_zh) {
      if (occurrenceCount(row.card.full_text_zh, row.card.class_rule_text_zh) !== 1) {
        fail(`${row.card.id}: class rule text must appear exactly once in full_text_zh`);
      }
    }
    const paragraphs = (row.card.full_text_zh ?? '')
      .split('\n')
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    if (new Set(paragraphs).size !== paragraphs.length) {
      fail(`${row.card.id}: full_text_zh repeats a paragraph`);
    }
  }

  // Identity registry mapping.
  const expectedRegistry = buildIdentityRegistry(context, identities);
  if (!identitiesDoc) {
    fail(`${PATHS.identities} is missing`);
  } else {
    for (const key of ['effect_identities', 'print_identities', 'name_groups']) {
      if (!sameJson(identitiesDoc[key], expectedRegistry[key])) {
        fail(`card-identities.json ${key} out of sync with the details files`);
      }
    }
  }

  // Index.
  const indexById = new Map(index.cards.map((card) => [card.id, card]));
  if (index.cards.length !== csve1.cards.length) {
    fail('index card count differs from csve1 details');
  }
  if (index.card_count !== index.cards.length) {
    fail('index card_count differs from cards.length');
  }
  for (const card of csve1.cards) {
    const row = identities.computed.find((entry) => entry.id === card.id);
    const indexed = indexById.get(card.id);
    if (!indexed) {
      fail(`index is missing ${card.id}`);
      continue;
    }
    for (const field of ['name_zh', 'card_class', 'subtype', 'evolves_from', 'hp', 'type']) {
      if (!sameJson(indexed[field], card[field])) {
        fail(`index ${card.id}: ${field} differs from details`);
      }
    }
    if (indexed.effect_identity !== row.effect_identity) {
      fail(`index ${card.id}: effect_identity mismatch`);
    }
    if (indexed.print_identity !== row.print_identity) {
      fail(`index ${card.id}: print_identity mismatch`);
    }
    if (indexed.name_group_key !== row.name_group_key) {
      fail(`index ${card.id}: name_group_key mismatch`);
    }
    for (const [key, value] of Object.entries(card.print)) {
      if (!sameJson(indexed[key], value)) {
        fail(`index ${card.id}: print.${key} differs from details`);
      }
    }
    if (indexed.source_article !== card.source.article) fail(`index ${card.id}: source_article differs`);
    if (indexed.source_image_base !== card.source.image_base) {
      fail(`index ${card.id}: source_image_base differs`);
    }
    if (indexed.source_image_dir !== card.source.image_dir) {
      fail(`index ${card.id}: source_image_dir differs`);
    }
    if (indexed.source_image_sha256 !== card.source.image_sha256) {
      fail(`index ${card.id}: source_image_sha256 differs`);
    }
    if (indexed.evidence_status !== card.evidence.status) {
      fail(`index ${card.id}: evidence_status differs`);
    }
    if (!sameJson(indexed.unresolved, card.unresolved)) {
      fail(`index ${card.id}: unresolved differs from details`);
    }
  }

  // Deck redundant fields.
  for (const deck of decksDoc.decks) {
    for (const entry of deck.cards) {
      const card = byId.get(entry.id);
      if (!card) continue;
      const row = identities.computed.find((item) => item.id === entry.id);
      if (entry.effect_identity !== row.effect_identity) {
        fail(`${deck.code}/${entry.id}: effect_identity mismatch`);
      }
      if (entry.print_identity !== row.print_identity) {
        fail(`${deck.code}/${entry.id}: print_identity mismatch`);
      }
      if (entry.name_group_key !== row.name_group_key) {
        fail(`${deck.code}/${entry.id}: name_group_key mismatch`);
      }
      if (entry.name_zh !== card.name_zh) fail(`${deck.code}/${entry.id}: name differs from details`);
      if (entry.card_class !== card.card_class) {
        fail(`${deck.code}/${entry.id}: class differs from details`);
      }
      if (!sameJson(entry.print, card.print)) {
        fail(`${deck.code}/${entry.id}: print differs from details`);
      }
    }
  }
  if (!(decksDoc.validation_method ?? '').includes('tools/card-data/build-card-data.mjs')) {
    fail('decks validation_method must reference the committed build-card-data entry point');
  }
  if ((decksDoc.validation_errors ?? []).length) {
    fail('decks validation_errors must be empty; the committed script computes the checks itself');
  }

  // Matrix.
  const matrixById = new Map(matrixDoc.cards.map((entry) => [entry.id, entry]));
  if (matrixDoc.cards.length !== deckUnion.size) {
    fail(`matrix has ${matrixDoc.cards.length} cards but the decks use ${deckUnion.size}`);
  }
  if (matrixDoc.card_count !== matrixDoc.cards.length) {
    fail('matrix card_count differs from cards.length');
  }
  for (const [id, union] of deckUnion) {
    const card = byId.get(id);
    const row = identities.computed.find((item) => item.id === id);
    const entry = matrixById.get(id);
    if (!entry) {
      fail(`matrix is missing deck card ${id}`);
      continue;
    }
    if (entry.effect_identity !== row.effect_identity) fail(`matrix ${id}: effect_identity mismatch`);
    if (entry.print_identity !== row.print_identity) fail(`matrix ${id}: print_identity mismatch`);
    if (entry.name_group_key !== row.name_group_key) fail(`matrix ${id}: name_group_key mismatch`);
    if (!sameJson(entry.print, card.print)) fail(`matrix ${id}: print differs from details`);
    if (entry.name_zh !== card.name_zh) fail(`matrix ${id}: name differs from details`);
    if (entry.card_class !== card.card_class) fail(`matrix ${id}: class differs from details`);
    const expectedText = composeFullText(card) || (isBasicEnergy(card) ? card.effect_summary_zh ?? '' : '');
    if (entry.full_text_zh !== expectedText) fail(`matrix ${id}: full_text_zh differs from details`);
    if (!sameJson(entry.mechanics, card.mechanics)) fail(`matrix ${id}: mechanics differ from details`);
    if (!sameJson(entry.source, card.source)) fail(`matrix ${id}: source differs from details`);
    if (!sameJson(entry.effect_text_zh ?? null, card.effect_text_zh ?? null)) {
      fail(`matrix ${id}: effect_text_zh differs from details`);
    }
    if (!sameJson(entry.class_rule_text_zh ?? null, card.class_rule_text_zh ?? null)) {
      fail(`matrix ${id}: class_rule_text_zh differs from details`);
    }
    if (!sameJson(entry.rule_interactions ?? [], card.rule_interactions ?? [])) {
      fail(`matrix ${id}: rule_interactions differ from details`);
    }
    if (!sameJson(entry.decks, union.decks)) {
      fail(`matrix ${id}: per-deck counts differ from the deck lists`);
    }
    const acceptance = Object.keys(union.decks).sort();
    if (!sameJson((entry.effect_acceptance ?? []).slice().sort(), acceptance)) {
      fail(`matrix ${id}: effect_acceptance differs from the deck lists`);
    }
    if (card.effect_text_zh && card.card_class !== 'pokemon') {
      if (occurrenceCount(entry.full_text_zh, card.effect_text_zh) !== 1) {
        fail(`matrix ${id}: effect text must appear exactly once`);
      }
    }
  }
  for (const entry of matrixDoc.cards) {
    if (!deckUnion.has(entry.id)) fail(`matrix contains ${entry.id} which no deck uses`);
  }

  return { errors, expectedRegistry };
}

function buildIdentityRegistry(context, identities) {
  const { environment } = context;
  return {
    schema: 'ptcg.card-identities/v1',
    environment: environment.id,
    note: 'Effect identity, print identity and same-name grouping are separate mappings. Effect identities merge printings only on an identical canonical payload; none of the submitted printings is merged across products.',
    model: IDENTITY_MODEL,
    official_same_name_declarations: [
      {
        group_label: '博士的研究',
        basis: environment.reprint_provision?.name_identity_notes?.[0] ?? null,
        declaration_members: [
          '博士的研究（木兰博士）',
          '博士的研究（红豆杉博士）',
          '博士的研究（山梨博士）',
          '博士的研究（奥琳博士）',
          '博士的研究（弗图博士）',
          '博士的研究（大木博士）',
        ],
        in_evidence_set: false,
      },
      {
        group_label: '老大的指令',
        basis: environment.reprint_provision?.name_identity_notes?.[1] ?? null,
        declaration_members: [
          '老大的指令（坂木）',
          '老大的指令（弗拉达利）',
          '老大的指令（赤日）',
          '老大的指令（魁奇思）',
        ],
        in_evidence_set: false,
      },
    ],
    effect_identities: [...identities.effectGroups.entries()]
      .map(([effect_identity, rows]) => ({
        effect_identity,
        name_zh: rows[0].card.name_zh,
        card_class: rows[0].card.card_class,
        effective_category: rows[0].card.effective_category ?? null,
        canonical_effect_sha256: rows[0].canonical_effect_sha256,
        print_identities: rows.map((row) => row.print_identity).sort(),
        merge_evidence:
          rows.length > 1
            ? `canonical payload identical across ${rows.length} printings (see canonical_effect_sha256)`
            : 'single printing in this evidence set; no cross-print merge',
      }))
      .sort((a, b) => a.effect_identity.localeCompare(b.effect_identity)),
    print_identities: [...identities.printToRow.values()]
      .map((row) => ({
        print_identity: row.print_identity,
        record_id: row.card.id,
        effect_identity: row.effect_identity,
        name_group_key: row.name_group_key,
        print: row.card.print,
      }))
      .sort((a, b) => a.print_identity.localeCompare(b.print_identity)),
    name_groups: [...identities.nameGroups.values()].sort((a, b) =>
      a.name_group_key.localeCompare(b.name_group_key),
    ),
  };
}

function writeOutputs(context, identities, deckUnion, deckValidation) {
  const { environment, csve1, extra, index, decksDoc, matrixDoc, byId } = context;
  const identityFields = (card) => ({
    ...card,
    effect_identity: effectIdentityOf(card).effect_identity,
    print_identity: printIdentityOf(card),
    name_group_key: nameGroupKeyOf(card),
    full_text_zh: composeFullText(card),
  });
  csve1.schema = SCHEMA_VERSION;
  extra.schema = SCHEMA_VERSION;
  csve1.cards = csve1.cards.map(identityFields);
  extra.cards = extra.cards.map(identityFields);
  csve1.card_count = csve1.cards.length;
  extra.card_count = extra.cards.length;
  const orderedDetails = (doc) => {
    const { schema: _schema, identity_model: _model, environment, ...rest } = doc;
    return { schema: SCHEMA_VERSION, environment, identity_model: IDENTITY_MODEL, ...rest };
  };
  writeJson(PATHS.csve1Details, orderedDetails(csve1));
  writeJson(PATHS.extraDetails, orderedDetails(extra));

  writeJson(PATHS.identities, buildIdentityRegistry(context, identities));

  const existingIndex = new Map(index.cards.map((card, at) => [card.id, { card, at }]));
  const orderOf = (id) => (existingIndex.has(id) ? existingIndex.get(id).at : Number.MAX_SAFE_INTEGER);
  const indexCards = [...csve1.cards]
    .sort((a, b) => orderOf(a.id) - orderOf(b.id) || a.id.localeCompare(b.id))
    .map((card) => {
      const row = identities.computed.find((entry) => entry.id === card.id);
      const previous = existingIndex.get(card.id)?.card ?? {};
      return {
        batch: previous.batch ?? null,
        id: card.id,
        name_zh: card.name_zh,
        card_class: card.card_class,
        subtype: card.subtype,
        evolves_from: card.evolves_from,
        hp: card.hp,
        type: card.type,
        weakness: card.weakness,
        resistance: card.resistance,
        retreat: card.retreat,
        ...card.print,
        source_article: card.source.article,
        source_image_base: card.source.image_base,
        source_image_dir: card.source.image_dir,
        source_image_sha256: card.source.image_sha256,
        evidence_status: card.evidence.status,
        unresolved: card.unresolved,
        effect_identity: row.effect_identity,
        print_identity: row.print_identity,
        name_group_key: row.name_group_key,
      };
    });
  writeJson(PATHS.index, {
    ...index,
    schema: 'ptcg.card-index/v2',
    card_count: indexCards.length,
    cards: indexCards,
  });

  const rebuiltDecks = {
    ...decksDoc,
    validation_method:
      'node tools/card-data/build-card-data.mjs (recomputes identities, 60-card totals, same-name groups, basic Pokemon, mark legality, evolution prerequisites, matrix/detail text consistency; --write regenerates derived files)',
    validation_errors: [],
    decks: decksDoc.decks.map((deck) => ({
      ...deck,
      validation: { ...(deck.validation ?? {}), ...deckValidation[deck.code] },
      cards: deck.cards.map((entry) => {
        const card = byId.get(entry.id);
        const row = identities.computed.find((item) => item.id === entry.id);
        return {
          ...entry,
          name_zh: card.name_zh,
          card_class: card.card_class,
          subtype: card.subtype,
          effect_identity: row.effect_identity,
          print_identity: row.print_identity,
          name_group_key: row.name_group_key,
          print: card.print,
        };
      }),
    })),
  };
  writeJson(PATHS.decks, rebuiltDecks);

  const matrixCards = [...deckUnion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, union]) => {
      const card = byId.get(id);
      const row = identities.computed.find((item) => item.id === id);
      return {
        id,
        name_zh: card.name_zh,
        card_class: card.card_class,
        effect_identity: row.effect_identity,
        print_identity: row.print_identity,
        name_group_key: row.name_group_key,
        print: card.print,
        effective_category: card.effective_category ?? null,
        effect_text_zh: card.effect_text_zh ?? null,
        class_rule_text_zh: card.class_rule_text_zh ?? null,
        printed_class_rule_text_zh: card.printed_class_rule_text_zh ?? null,
        tool_banner_text_zh: card.tool_banner_text_zh ?? null,
        special_rule_text_zh: card.special_rule_text_zh ?? null,
        rule_interactions: card.rule_interactions ?? [],
        full_text_zh:
          composeFullText(card) || (isBasicEnergy(card) ? card.effect_summary_zh ?? '' : ''),
        mechanics: card.mechanics,
        source: card.source,
        decks: union.decks,
        effect_acceptance: Object.keys(union.decks).sort(),
      };
    });
  writeJson(PATHS.matrix, {
    ...matrixDoc,
    note: "Deduplicated card list of the four decks. Effect identity, print identity and same-name group are separate references (see card-identities.json). full_text_zh is the deterministic card-face composition from the details files: effect text once, plus the printed class rule for trainers. effect_acceptance lists the decks whose downstream implementation must accept this card's effect; data verified only, engine implementation is downstream.",
    card_count: matrixCards.length,
    cards: matrixCards,
  });
}

const report = (label, errors) => {
  if (!errors.length) return false;
  for (const error of errors) console.error(`error: ${error}`);
  console.error(`${label}: ${errors.length} error(s)`);
  return true;
};

if (WRITE) {
  const before = loadContext();
  const beforeIdentities = computeIdentities(before);
  const source = validateSources(before, beforeIdentities);
  if (report('sources', source.errors)) process.exit(1);
  const deckUnion = buildDeckUnion(before);
  writeOutputs(before, beforeIdentities, deckUnion, source.deckValidation);
  console.log('wrote details, identity registry, index, decks and effect matrix');
}

const context = loadContext();
const identities = computeIdentities(context);
const deckUnion = buildDeckUnion(context);
const source = validateSources(context, identities);
const artifacts = validateArtifacts(context, identities, deckUnion);
if (report('sources', source.errors)) process.exit(1);
if (report('artifacts', artifacts.errors)) process.exit(1);
console.log(
  `OK: ${context.allCards.length} cards, ${identities.nameGroups.size} name groups, ${context.decksDoc.decks.length} decks x 60, ${context.matrixDoc.cards.length} matrix entries`,
);
