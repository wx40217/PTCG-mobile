// T04 catalog-builder tests. Run with:
//   node --test tools/card-catalog/build-catalog.test.mjs
//
// These tests exercise the real builder against the committed T01 data:
//   - the committed artifact is up to date and its version can be recomputed;
//   - every verified card keeps its own print identity and effect identity;
//   - legality / effect support / image source stay independent axes;
//   - deck membership and the frozen-subset wording match the source data;
//   - no local path or private input leaks into the artifact.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { computeCatalogVersion, parseCatalogContent, parseServiceCatalog } from '../../packages/protocol/src/catalog.ts';
import { artifactMatches, buildContent, canonicalTextDigest } from './build-catalog.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACT_PATH = join(ROOT, 'data/catalog/zh-cn-standard-2025-06-05-catalog.json');
const CATALOG = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
const CSVE1 = JSON.parse(readFileSync(join(ROOT, 'data/cards/zh-cn-standard-2025-06-05/csve1-card-details.json'), 'utf8'));
const EXTRA = JSON.parse(
  readFileSync(join(ROOT, 'data/cards/zh-cn-standard-2025-06-05/standard-2025-06-05-extra-card-details.json'), 'utf8'),
);
const IDENTITIES = JSON.parse(readFileSync(join(ROOT, 'data/cards/zh-cn-standard-2025-06-05/card-identities.json'), 'utf8'));
const DECKS = JSON.parse(readFileSync(join(ROOT, 'data/decks/zh-cn-standard-2025-06-05-decks.json'), 'utf8'));
const EVIDENCE = JSON.parse(readFileSync(join(ROOT, 'data/evidence/asar-2025060501-sample.json'), 'utf8'));

test('committed artifact parses and its version recomputes from canonical content', async () => {
  const parsed = parseServiceCatalog(CATALOG);
  assert.ok(parsed, 'artifact must parse');
  assert.equal(await computeCatalogVersion(parsed.content), parsed.catalogVersion);
  assert.equal(parsed.content.cards.length, 47);
});

test('builder check mode is current', async () => {
  const raw = await buildContent();
  const normalized = parseCatalogContent(raw);
  assert.ok(normalized, 'built content must parse');
  const version = await computeCatalogVersion(normalized);
  assert.equal(version, CATALOG.catalogVersion, 'run node tools/card-catalog/build-catalog.mjs --write');
});

test('source revisions are canonical LF UTF-8 hashes independent of checkout line endings', () => {
  for (const file of CATALOG.dataRevision.sourceFiles) {
    const lf = readFileSync(join(ROOT, file.path), 'utf8').replace(/\r\n?/gu, '\n');
    const crlf = lf.replace(/\n/gu, '\r\n');
    assert.equal(canonicalTextDigest(lf), file.sha256, `${file.path}: LF checkout`);
    assert.equal(canonicalTextDigest(crlf), file.sha256, `${file.path}: CRLF checkout`);
  }
});

test('artifact check tolerates CRLF checkout while still spotting content drift', () => {
  const lf = readFileSync(ARTIFACT_PATH, 'utf8');
  assert.equal(artifactMatches(lf, lf), true);
  assert.equal(artifactMatches(lf.replace(/\n/gu, '\r\n'), lf), true);
  assert.equal(artifactMatches(`${lf}\n`, lf), false);
  assert.equal(artifactMatches(lf.replace('"schema"', '"schema2"'), lf), false);
});

test('every source card appears once with distinct print and effect identities', () => {
  const sourceIds = [...CSVE1.cards, ...EXTRA.cards].map((card) => card.id).sort();
  const catalogIds = CATALOG.cards.map((card) => card.id).sort();
  assert.deepEqual(catalogIds, sourceIds);

  const printIds = new Set(CATALOG.cards.map((card) => card.identities.printIdentity));
  assert.equal(printIds.size, CATALOG.cards.length);
  for (const card of CATALOG.cards) {
    const source = IDENTITIES.print_identities.find((entry) => entry.record_id === card.id);
    assert.equal(card.identities.effectIdentity, source.effect_identity);
    assert.equal(card.identities.printIdentity, source.print_identity);
    assert.equal(card.identities.nameGroupKey, source.name_group_key);
  }
});

test('authoritative text is complete Simplified Chinese', () => {
  for (const card of CATALOG.cards) {
    assert.ok(card.nameZh.length > 0, `${card.id} name`);
    assert.ok(card.fullTextZh.length > 0, `${card.id} full text`);
    assert.ok(card.effectSummaryZh.length > 0, `${card.id} summary`);
    assert.doesNotMatch(card.fullTextZh, /validation_errors|placeholder|TODO/iu);
  }
});

test('legality, effect support and image source are independent axes', () => {
  for (const card of CATALOG.cards) {
    assert.equal(card.flags.environmentLegal, true, `${card.id} legal`);
    assert.equal(card.flags.effectSupported, false, `${card.id} effect support must stay off until engine integration`);
    assert.equal(typeof card.flags.legalityNoteZh, 'string');
    assert.equal(typeof card.flags.effectNoteZh, 'string');
    assert.ok(card.imageSource === null || /^[0-9a-f]{64}$/u.test(card.imageSource.sha256));
  }
  assert.equal(CATALOG.supportPolicy.playable, false);
  assert.equal(CATALOG.supportPolicy.engineIntegration, 'not-integrated');
  assert.match(CATALOG.environment.supportedSubsetZh, /未接入/u);
  assert.match(CATALOG.environment.scopeZh, /不是完整标准卡池/u);
});

test('deck membership matches the frozen deck lists', () => {
  const expected = new Map();
  for (const deck of DECKS.decks) {
    for (const entry of deck.cards) {
      const codes = expected.get(entry.id) ?? [];
      codes.push(deck.code);
      expected.set(entry.id, codes);
    }
  }
  for (const card of CATALOG.cards) {
    assert.deepEqual([...card.decks].sort(), [...(expected.get(card.id) ?? [])].sort(), card.id);
  }
  assert.equal(CATALOG.decks.length, 4);
  for (const deck of CATALOG.decks) {
    const total = deck.cards.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(total, 60, deck.code);
    assert.equal(deck.cardCount, 60, deck.code);
  }
});

test('resource sample metadata ties back to T01 asar evidence', () => {
  const sample = EVIDENCE.samples.find((entry) => entry.entry === 'files/sv1_en_170');
  assert.ok(sample);
  for (const resource of CATALOG.resources) {
    assert.equal(resource.sha256, sample.png_sha256);
    assert.equal(resource.width, sample.width);
    assert.equal(resource.height, sample.height);
    assert.doesNotMatch(resource.file, /[\\/]/u, 'resource file must be a bare file name');
    assert.match(resource.caveatZh, /不能作为简中卡牌身份或文字的权威来源/u);
  }
});

test('artifact carries no local path or private input leakage', () => {
  const serialized = JSON.stringify(CATALOG);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\/u, 'no Windows drive path');
  assert.doesNotMatch(serialized, /\.scratch/u);
  assert.doesNotMatch(serialized, /Z:\\/u);
  assert.doesNotMatch(serialized, /auth_key/u);
  for (const file of CATALOG.dataRevision.sourceFiles) {
    assert.match(file.path, /^data\//u);
  }
});

test('version changes when authoritative content changes', async () => {
  const mutated = JSON.parse(JSON.stringify(CATALOG));
  delete mutated.catalogVersion;
  mutated.cards[0].nameZh = `${mutated.cards[0].nameZh}（修改）`;
  const version = await computeCatalogVersion(mutated);
  assert.notEqual(version, CATALOG.catalogVersion);
});
