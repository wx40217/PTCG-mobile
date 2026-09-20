#!/usr/bin/env node
/**
 * 构建冻结卡牌目录（T04）的规范产物。
 *
 * 输入（全部为 T01 已核实资料）：
 *   - data/environment/zh-cn-standard-2025-06-05.json
 *   - data/cards/zh-cn-standard-2025-06-05/csve1-card-details.json
 *   - data/cards/zh-cn-standard-2025-06-05/standard-2025-06-05-extra-card-details.json
 *   - data/cards/zh-cn-standard-2025-06-05/card-identities.json
 *   - data/decks/zh-cn-standard-2025-06-05-decks.json
 *   - data/decks/zh-cn-standard-2025-06-05-effect-matrix.json
 *   - data/catalog/zh-cn-standard-2025-06-05-resources.json（本机资源样本清单，仅元数据）
 *
 * 产物：data/catalog/zh-cn-standard-2025-06-05-catalog.json
 *
 * 默认只校验产物是否为最新（`--check` 行为）；`--write` 时写回。
 * `catalogVersion` 由 `parseCatalogContent` 规范化后的内容哈希得到，服务与
 * 客户端缓存用同一函数复核，避免出现“服务认为有效、客户端算不出”的版本。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCatalogVersion, parseCatalogContent } from '../../packages/protocol/src/catalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ENVIRONMENT_ID = 'zh-cn-standard-2025-06-05';

const SOURCE_FILES = Object.freeze([
  'data/environment/zh-cn-standard-2025-06-05.json',
  'data/cards/zh-cn-standard-2025-06-05/csve1-card-details.json',
  'data/cards/zh-cn-standard-2025-06-05/standard-2025-06-05-extra-card-details.json',
  'data/cards/zh-cn-standard-2025-06-05/card-identities.json',
  'data/decks/zh-cn-standard-2025-06-05-decks.json',
  'data/decks/zh-cn-standard-2025-06-05-effect-matrix.json',
  'data/effects/zh-cn-standard-2025-06-05-supported-effects.json',
  'data/catalog/zh-cn-standard-2025-06-05-resources.json',
]);

const OUTPUT_PATH = join(ROOT, 'data', 'catalog', `${ENVIRONMENT_ID}-catalog.json`);
const RESOURCE_EVIDENCE_PATH = join(ROOT, 'data', 'evidence', 'asar-2025060501-sample.json');

const CLASS_LABELS = Object.freeze({ pokemon: '宝可梦', trainer: '训练家', energy: '能量' });

function fail(message) {
  console.error(`build-catalog: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 规范文本摘要：JSON 资料按 LF 换行规范化后的 UTF-8 字节计算 SHA-256。
 *
 * 仓库在 Windows 的 `core.autocrlf=true` 检出下会把文本文件写成 CRLF，而 git
 * blob 与 Linux 检出是 LF；`sourceFiles` 属于可复现元数据，必须与检出换行无关。
 * 图片字节不在 `SOURCE_FILES` 中，仍按原始字节校验。
 */
export function canonicalTextDigest(text) {
  return sha256Bytes(Buffer.from(text.replace(/\r\n?/gu, '\n'), 'utf8'));
}

function fileDigest(path) {
  return canonicalTextDigest(readFileSync(path, 'utf8'));
}

/**
 * 校验产物是否与本次生成结果一致。检出工具可能把产物文件换成 CRLF，因此比较
 * 时同样做 LF 规范化；内容有任何其他差异仍会失败。
 */
export function artifactMatches(current, serialized) {
  return current.replace(/\r\n?/gu, '\n') === serialized;
}

function requireBasename(name, context) {
  if (name.includes('/') || name.includes('\\') || name.length === 0 || name === '.' || name === '..') {
    fail(`${context}: 资源文件名必须是单个安全文件名，收到 ${JSON.stringify(name)}`);
  }
  return name;
}

function displayNumber(print) {
  const printed = typeof print.number === 'string' && print.number.includes('/') ? print.number : `${print.number}/${print.total}`;
  return `${print.print_code} ${printed}`;
}

function legalityNote(card) {
  const mark = card.print.regulation_mark;
  if (mark === null || mark === undefined) {
    if (card.card_class === 'energy' && card.subtype.includes('基本能量')) {
      return '基本能量不受赛制标记限制；冻结快照内合法。';
    }
    return '未记录赛制标记，不能认定为冻结环境合法。';
  }
  if (!['E', 'F', 'G'].includes(mark)) {
    return `赛制标记 ${mark} 不在冻结快照的 E/F/G 范围内。`;
  }
  return `赛制标记 ${mark}（E/F/G）在冻结快照范围内，2025-01-17 起标准赛制可用。`;
}

function imageSourceOf(card) {
  const source = card.source;
  if (source === undefined || typeof source.image_sha256 !== 'string' || source.image_sha256.length === 0) {
    return null;
  }
  const articleUrl = typeof source.article === 'string' ? source.article : '';
  return {
    sha256: source.image_sha256,
    labelZh: '官方商品文章图（T01 已核实）',
    provenanceZh: `T01 从官方商品文章逐张核对卡面文字并记录图片 SHA-256 ${source.image_sha256}；图片字节不入库，由本机配置的卡图目录提供。`,
    articleUrl,
  };
}

function buildCards(environment, details, extraDetails, identities, decks, effectMatrix, supportedEffects) {
  const productNames = new Map();
  productNames.set(details.product.name_zh, details.product.name_zh);
  const productNameByCode = new Map();
  // CSVE1 的详情文件只声明一个商品；印刷代码统一取 CSVE1C。
  productNameByCode.set('CSVE1C', details.product.name_zh);
  for (const product of extraDetails.products) {
    productNameByCode.set(product.print_code, product.name_zh);
  }

  const deckMembership = new Map();
  for (const deck of decks.decks) {
    for (const entry of deck.cards) {
      const list = deckMembership.get(entry.id) ?? [];
      list.push(deck.code);
      deckMembership.set(entry.id, list);
    }
  }

  const identityByRecord = new Map(identities.print_identities.map((entry) => [entry.record_id, entry]));
  const effectByKey = new Map(identities.effect_identities.map((entry) => [entry.effect_identity, entry]));
  const matrixById = new Map(effectMatrix.cards.map((entry) => [entry.id, entry]));

  const all = [...details.cards, ...extraDetails.cards];
  const cards = [];
  for (const card of all) {
    const identity = identityByRecord.get(card.id);
    if (identity === undefined) {
      fail(`身份表缺少 ${card.id}`);
    }
    const effectIdentity = identity.effect_identity;
    if (effectByKey.get(effectIdentity) === undefined) {
      fail(`效果身份表缺少 ${effectIdentity}`);
    }
    const matrix = matrixById.get(card.id);
    if (matrix !== undefined) {
      if (matrix.effect_identity !== effectIdentity || matrix.print_identity !== identity.print_identity) {
        fail(`${card.id}: 效果矩阵与身份表引用不一致`);
      }
    }
    if (card.effect_identity !== effectIdentity || card.print_identity !== identity.print_identity) {
      fail(`${card.id}: 详情与身份表引用不一致`);
    }
    const productNameZh = productNameByCode.get(card.print.print_code);
    if (productNameZh === undefined) {
      fail(`${card.id}: 未知商品代码 ${card.print.print_code}`);
    }
    const support = supportedEffects.get(effectIdentity);
    if (support !== undefined && !support.cardIds.includes(card.id)) {
      fail(`${card.id}: 支持清单 ${effectIdentity} 未声明该印刷版本`);
    }
    const effectiveCategory =
      card.effective_category ?? (card.card_class === 'energy' && card.subtype.includes('基本能量') ? '基本能量' : null);
    const mark = card.print.regulation_mark ?? null;
    const legal = ['E', 'F', 'G'].includes(mark) || (card.card_class === 'energy' && card.subtype.includes('基本能量'));
    cards.push({
      id: card.id,
      nameZh: card.name_zh,
      cardClass: card.card_class,
      classLabelZh: CLASS_LABELS[card.card_class] ?? card.card_class,
      subtypes: card.subtype,
      effectiveCategory,
      categoryLabelZh: effectiveCategory ?? CLASS_LABELS[card.card_class] ?? card.card_class,
      type: card.type ?? null,
      hp: card.hp ?? null,
      weakness: card.weakness ?? null,
      resistance: card.resistance ?? null,
      retreat: card.retreat ?? null,
      evolvesFrom: card.evolves_from ?? null,
      pokedexText: card.pokedex_text ?? null,
      abilities: card.abilities.map((ability) => ({ label: ability.label, name: ability.name, text: ability.text })),
      attacks: card.attacks.map((attack) => ({
        name: attack.name,
        cost: attack.cost,
        damage: attack.damage ?? null,
        text: attack.text ?? null,
        attackKind: attack.attack_kind ?? null,
      })),
      ruleLabels: card.rule_labels,
      specialRuleTextZh: card.special_rule_text_zh ?? null,
      effectTextZh: card.effect_text_zh ?? null,
      classRuleTextZh: card.class_rule_text_zh ?? null,
      printedClassRuleTextZh: card.printed_class_rule_text_zh ?? null,
      toolBannerTextZh: card.tool_banner_text_zh ?? null,
      fullTextZh: card.full_text_zh.length > 0 ? card.full_text_zh : (matrix?.full_text_zh ?? card.full_text_zh),
      effectSummaryZh: card.effect_summary_zh,
      mechanics: card.mechanics,
      identities: {
        effectIdentity,
        printIdentity: identity.print_identity,
        nameGroupKey: identity.name_group_key,
      },
      print: {
        printCode: card.print.print_code,
        regulationMark: card.print.regulation_mark ?? null,
        number: card.print.number,
        total: card.print.total,
        displayNumber: displayNumber(card.print),
        illustrator: card.print.illustrator ?? null,
        copyright: card.print.copyright,
      },
      productCode: card.print.print_code,
      productNameZh,
      flags: {
        environmentLegal: legal,
        legalityNoteZh: legalityNote(card),
        effectSupported: support !== undefined,
        effectNoteZh:
          support === undefined
            ? '规则引擎尚未接入该卡效果；资料可浏览，但不能用于正式对战。'
            : `${support.noteZh}整套卡组就绪仍由所有卡牌的效果支持标记共同决定。`,
      },
      imageSource: imageSourceOf(card),
      decks: deckMembership.get(card.id) ?? [],
    });
  }

  const seenPrint = new Set();
  for (const card of cards) {
    if (!card.flags.environmentLegal) {
      fail(`${card.id}: 冻结目录中出现环境不合法条目`);
    }
    if (seenPrint.has(card.identities.printIdentity)) {
      fail(`重复印刷身份 ${card.identities.printIdentity}`);
    }
    seenPrint.add(card.identities.printIdentity);
  }
  return cards;
}

function buildDecks(decks) {
  return decks.decks.map((deck) => ({
    code: deck.code,
    nameZh: deck.archetype_zh,
    playstyleZh: deck.playstyle,
    evolutionStrategyZh: deck.evolution_strategy,
    cardCount: deck.cards.reduce((total, entry) => total + entry.count, 0),
    cards: deck.cards.map((entry) => ({ id: entry.id, count: entry.count })),
  }));
}

function buildResources(manifest, evidence) {
  const evidenceById = new Map(evidence.samples.map((sample) => [sample.entry, sample]));
  const resources = manifest.resources.map((resource) => {
    requireBasename(resource.file, 'buildResources');
    const sample = evidenceById.get(resource.sourceEntry);
    if (sample === undefined) {
      fail(`资源样本 ${resource.resourceId}: 证据 ${resource.sourceEntry} 不存在`);
    }
    if (sample.png_sha256 !== resource.sha256) {
      fail(`资源样本 ${resource.resourceId}: sha256 与 T01 证据不一致`);
    }
    if (sample.width !== resource.width || sample.height !== resource.height) {
      fail(`资源样本 ${resource.resourceId}: 尺寸与 T01 证据不一致`);
    }
    if (sample.bundle_sha256 !== resource.bundleSha256) {
      fail(`资源样本 ${resource.resourceId}: bundle SHA-256 与 T01 证据不一致`);
    }
    return {
      resourceId: resource.resourceId,
      kind: resource.kind,
      file: resource.file,
      sha256: resource.sha256,
      width: resource.width,
      height: resource.height,
      labelZh: resource.labelZh,
      provenanceZh: resource.provenanceZh,
      caveatZh: resource.caveatZh,
      redistributionZh: resource.redistributionZh,
    };
  });
  const seen = new Set();
  for (const resource of resources) {
    if (seen.has(resource.resourceId)) {
      fail(`重复资源 id ${resource.resourceId}`);
    }
    seen.add(resource.resourceId);
  }
  return resources;
}

function sourceRevision(environment) {
  const files = SOURCE_FILES.map((path) => ({ path, sha256: fileDigest(join(ROOT, path)) }));
  return { environment: environment.id, files };
}

/**
 * 读取并校验已支持效果清单：每个效果身份必须真实存在，声明的印刷版本必须与
 * 身份表逐条一致；清单条目只影响目录的“效果支持”轴，不改变环境合法或卡图轴。
 */
function loadSupportedEffects(support, identityByRecord) {
  if (support.schema !== 'ptcg.supported-effects/v1') {
    fail(`支持清单 schema 非法：${support.schema}`);
  }
  if (support.environment !== ENVIRONMENT_ID) {
    fail(`支持清单环境不匹配：${support.environment}`);
  }
  if (!Array.isArray(support.effects)) {
    fail('支持清单缺少 effects 数组');
  }
  const map = new Map();
  for (const entry of support.effects) {
    if (typeof entry.effect_identity !== 'string' || map.has(entry.effect_identity)) {
      fail(`支持清单效果身份重复或非法：${entry.effect_identity}`);
    }
    if (!Array.isArray(entry.card_ids) || entry.card_ids.length === 0 || !entry.card_ids.every((id) => typeof id === 'string' && id.length > 0)) {
      fail(`${entry.effect_identity}: card_ids 非法`);
    }
    if (
      typeof entry.name_zh !== 'string' ||
      !Array.isArray(entry.implemented_behaviors) ||
      entry.implemented_behaviors.length === 0 ||
      !entry.implemented_behaviors.every((behavior) => typeof behavior === 'string' && behavior.length > 0)
    ) {
      fail(`${entry.effect_identity}: name_zh / implemented_behaviors 非法`);
    }
    for (const id of entry.card_ids) {
      const identity = identityByRecord.get(id);
      if (identity === undefined) {
        fail(`${entry.effect_identity}: 支持清单引用了不存在的印刷版本 ${id}`);
      }
      if (identity.effect_identity !== entry.effect_identity) {
        fail(`${id}: 支持清单声明的效果身份为 ${entry.effect_identity}，实际为 ${identity.effect_identity}`);
      }
    }
    map.set(entry.effect_identity, {
      cardIds: [...entry.card_ids],
      noteZh: `规则引擎已接入并通过按冻结卡面文字的行为测试：${entry.implemented_behaviors.join('；')}。`,
    });
  }
  return map;
}

async function buildContent() {
  const environment = readJson(join(ROOT, SOURCE_FILES[0]));
  if (environment.id !== ENVIRONMENT_ID) {
    fail(`环境 id 不匹配：${environment.id}`);
  }
  const details = readJson(join(ROOT, SOURCE_FILES[1]));
  const extraDetails = readJson(join(ROOT, SOURCE_FILES[2]));
  const identities = readJson(join(ROOT, SOURCE_FILES[3]));
  const decks = readJson(join(ROOT, SOURCE_FILES[4]));
  const effectMatrix = readJson(join(ROOT, SOURCE_FILES[5]));
  const supportManifest = readJson(join(ROOT, SOURCE_FILES[6]));
  const resourceManifest = readJson(join(ROOT, SOURCE_FILES[7]));
  const evidence = readJson(RESOURCE_EVIDENCE_PATH);

  const identityByRecord = new Map(identities.print_identities.map((entry) => [entry.record_id, entry]));
  const supportedEffects = loadSupportedEffects(supportManifest, identityByRecord);
  const cards = buildCards(environment, details, extraDetails, identities, decks, effectMatrix, supportedEffects);
  const catalogDecks = buildDecks(decks);
  const resources = buildResources(resourceManifest, evidence);
  const supportedCards = cards.filter((card) => card.flags.effectSupported);

  const source = sourceRevision(environment);
  const revision = {
    environment: environment.id,
    sourceDigest: await computeCatalogVersion({ files: source.files }),
    sourceFiles: source.files,
  };

  const presetDeckCardIds = new Set(catalogDecks.flatMap((deck) => deck.cards.map((entry) => entry.id)));
  const effectIdentities = new Set(cards.map((card) => card.identities.effectIdentity));

  const content = {
    schema: 'ptcg.catalog/v1',
    dataRevision: revision,
    generatedBy: 'tools/card-catalog/build-catalog.mjs',
    environment: {
      id: environment.id,
      nameZh: `简中标准赛制冻结快照 ${environment.frozen_at}`,
      formatZh: '标准赛制（standard）',
      frozenAt: environment.frozen_at,
      legalitySummaryZh:
        '卡面左下角赛制标记为 E/F/G（2025-01-17 起 D 已退出标准赛制），另加八种基本能量；依据官方公告 17144 与 2025-02-28 更新的官方赛制页。',
      scopeZh: `冻结资料集共 ${cards.length} 张经官方商品图像逐张核实的简中卡牌（${cards.length} 个印刷身份、${effectIdentities.size} 个规则效果身份）；四套预设 60 张卡组使用其中 ${presetDeckCardIds.size} 张。这里交付的是“冻结环境中的已核实资料子集”，不是完整标准卡池。`,
      supportedSubsetZh: `是否可正式对战由每张卡的“效果支持”独立标记决定；当前 ${supportedCards.length}/${cards.length} 张已核实条目的效果已接入（T10 / #11 首批训练家卡与 T11 / #12 首批宝可梦效果），其余仍为“效果未接入”。整套卡组就绪要求全部卡牌效果已接入。`,
      ruleManual: {
        title: environment.advanced_rules_manual.title,
        version: environment.advanced_rules_manual.document_version,
        date: environment.advanced_rules_manual.document_date,
      },
      counts: {
        verifiedCards: cards.length,
        printIdentities: new Set(cards.map((card) => card.identities.printIdentity)).size,
        effectIdentities: effectIdentities.size,
        presetDeckCards: presetDeckCardIds.size,
      },
    },
    supportPolicy: {
      engineIntegration: 'integrated',
      playable: false,
      noteZh:
        '服务端规则引擎已接入部分训练家卡与宝可梦效果；环境合法、效果支持、卡图可用三者独立展示。未标记效果支持的条目不能用于正式对战，整套卡组就绪仍要求全部卡牌效果已接入。',
    },
    categories: ['宝可梦', '训练家', '能量'],
    cards,
    decks: catalogDecks,
    resources,
  };
  return content;
}

async function main() {
  const write = process.argv.includes('--write');
  const rawContent = await buildContent();
  const content = parseCatalogContent(rawContent);
  if (content === null) {
    fail('构建出的目录未能通过协议解析器校验');
  }
  const catalogVersion = await computeCatalogVersion(content);
  const artifact = { ...content, catalogVersion };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  if (write) {
    writeFileSync(OUTPUT_PATH, serialized);
    console.log(`build-catalog: 已写入 ${relative(ROOT, OUTPUT_PATH)}（catalogVersion=${catalogVersion}）`);
    return;
  }

  let current;
  try {
    current = readFileSync(OUTPUT_PATH, 'utf8');
  } catch {
    fail(`缺少产物 ${relative(ROOT, OUTPUT_PATH)}；运行 node tools/card-catalog/build-catalog.mjs --write`);
  }
  if (!artifactMatches(current, serialized)) {
    fail('产物与当前资料不一致；运行 node tools/card-catalog/build-catalog.mjs --write 后复核 diff');
  }
  console.log(`build-catalog: 校验通过（catalogVersion=${catalogVersion}，${content.cards.length} 张卡）`);
}

const isMainEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainEntry) {
  main().catch((error) => {
    console.error(`build-catalog: 未处理错误：${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
}

export { buildContent };
