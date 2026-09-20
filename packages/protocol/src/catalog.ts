import { sha256, utf8 } from './base64url.ts';

/**
 * 冻结卡牌目录（T04）的公共契约。
 *
 * 目录把三个轴分开：环境合法性、效果支持状态、卡图可用状态。资料内容由
 * `tools/card-catalog/build-catalog.mjs` 生成；服务只做校验与运行期覆盖
 * （本机资源是否真的存在），客户端读取同一份结构用于搜索、详情与离线缓存。
 *
 * `catalogVersion` 覆盖「内容」的规范 JSON 哈希；运行期覆盖（服务是否配置了
 * 本机资源、服务时间）不参与哈希，因此缓存可以重算版本校验完整性。
 */

export const CATALOG_SCHEMA = 'ptcg.catalog/v1';
export const CATALOG_PATH = 'catalog';
export const CATALOG_RESOURCE_PREFIX = 'catalog/resources';
export const CATALOG_CARD_IMAGE_PREFIX = 'catalog/card-images';

/** 目录条目的卡牌大类；与规则探针的 CardKind 一致。 */
export type CatalogCardClass = 'pokemon' | 'trainer' | 'energy';

export interface CatalogIdentityRefs {
  /** 规则效果身份：规范效果载荷哈希；重印合并只按它，不看卡名。 */
  readonly effectIdentity: string;
  /** 印刷身份：商品代码 + 印刷编号。 */
  readonly printIdentity: string;
  /** 同名构筑分组：同名 ≤4 的计数单位。 */
  readonly nameGroupKey: string;
}

export interface CatalogPrint {
  readonly printCode: string;
  /** 基本能量可无赛制标记。 */
  readonly regulationMark: string | null;
  readonly number: string;
  readonly total: string;
  /** 供界面直接显示，如 `CSVE1C 035/177`。 */
  readonly displayNumber: string;
  /** 基本能量等卡面可能没有画师信息。 */
  readonly illustrator: string | null;
  readonly copyright: string;
}

export interface CatalogAbility {
  readonly label: string;
  readonly name: string;
  readonly text: string;
}

export interface CatalogAttack {
  readonly name: string;
  readonly cost: readonly string[];
  readonly damage: string | null;
  readonly text: string | null;
  readonly attackKind: string | null;
}

/** 资料级状态；运行期卡图状态在 `CatalogRuntime` 中单独覆盖。 */
export interface CatalogCardFlags {
  readonly environmentLegal: boolean;
  readonly legalityNoteZh: string;
  /** 是否已接入正式对局引擎。T04 阶段全部为 false，「可浏览、不可对战」。 */
  readonly effectSupported: boolean;
  readonly effectNoteZh: string;
}

/** T01 已核实的官方商品文章图；图片字节不入库，只记录哈希与出处。 */
export interface CatalogImageSource {
  readonly sha256: string;
  readonly labelZh: string;
  readonly provenanceZh: string;
  readonly articleUrl: string;
}

export interface CatalogCard {
  readonly id: string;
  readonly nameZh: string;
  readonly cardClass: CatalogCardClass;
  readonly classLabelZh: string;
  readonly subtypes: readonly string[];
  /** 训练家实际类别（物品/支援者/宝可梦道具/竞技场）或基本能量；宝可梦为 null。 */
  readonly effectiveCategory: string | null;
  readonly categoryLabelZh: string;
  readonly type: string | null;
  readonly hp: number | null;
  readonly weakness: string | null;
  readonly resistance: string | null;
  readonly retreat: number | null;
  readonly evolvesFrom: string | null;
  readonly pokedexText: string | null;
  readonly abilities: readonly CatalogAbility[];
  readonly attacks: readonly CatalogAttack[];
  readonly ruleLabels: readonly string[];
  readonly specialRuleTextZh: string | null;
  readonly effectTextZh: string | null;
  readonly classRuleTextZh: string | null;
  readonly printedClassRuleTextZh: string | null;
  readonly toolBannerTextZh: string | null;
  /** 可读的完整卡面文字（含规则文字），无图时的兜底内容。 */
  readonly fullTextZh: string;
  readonly effectSummaryZh: string;
  readonly mechanics: readonly string[];
  readonly identities: CatalogIdentityRefs;
  readonly print: CatalogPrint;
  readonly productCode: string;
  readonly productNameZh: string;
  readonly flags: CatalogCardFlags;
  readonly imageSource: CatalogImageSource | null;
  /** 使用该卡印刷版本的预设卡组代号（A/B/C/D）。 */
  readonly decks: readonly string[];
}

export interface CatalogDeckCard {
  readonly id: string;
  readonly count: number;
}

export interface CatalogDeck {
  readonly code: string;
  readonly nameZh: string;
  readonly playstyleZh: string;
  readonly evolutionStrategyZh: string;
  readonly cardCount: number;
  readonly cards: readonly CatalogDeckCard[];
}

export interface CatalogRuleManual {
  readonly title: string;
  readonly version: string;
  readonly date: string;
}

export interface CatalogCounts {
  readonly verifiedCards: number;
  readonly printIdentities: number;
  readonly effectIdentities: number;
  readonly presetDeckCards: number;
}

export interface CatalogEnvironment {
  readonly id: string;
  readonly nameZh: string;
  readonly formatZh: string;
  readonly frozenAt: string;
  readonly legalitySummaryZh: string;
  /** 冻结范围说明：只承诺已核实子集，不宣传全卡库。 */
  readonly scopeZh: string;
  readonly supportedSubsetZh: string;
  readonly ruleManual: CatalogRuleManual;
  readonly counts: CatalogCounts;
}

export interface CatalogSupportPolicy {
  /** 正式引擎尚未接入目录；任何条目都不得被标成可对战。 */
  readonly engineIntegration: 'not-integrated';
  readonly playable: false;
  readonly noteZh: string;
}

/** 资源清单条目：本机资源样本；`file` 只允许单个文件名，禁止路径。 */
export interface CatalogResource {
  readonly resourceId: string;
  readonly kind: string;
  readonly file: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly labelZh: string;
  readonly provenanceZh: string;
  readonly caveatZh: string;
  readonly redistributionZh: string;
}

export interface CatalogSourceFile {
  readonly path: string;
  readonly sha256: string;
}

export interface CatalogDataRevision {
  readonly environment: string;
  readonly sourceDigest: string;
  readonly sourceFiles: readonly CatalogSourceFile[];
}

export interface CatalogContent {
  readonly schema: string;
  readonly dataRevision: CatalogDataRevision;
  readonly generatedBy: string;
  readonly environment: CatalogEnvironment;
  readonly supportPolicy: CatalogSupportPolicy;
  readonly categories: readonly string[];
  readonly cards: readonly CatalogCard[];
  readonly decks: readonly CatalogDeck[];
  readonly resources: readonly CatalogResource[];
}

export interface CatalogRuntimeResource {
  readonly available: boolean;
  /** 相对服务地址的路径；不可用时为 null。 */
  readonly path: string | null;
  readonly sha256: string;
  readonly labelZh: string;
  readonly provenanceZh: string;
}

export interface CatalogRuntimeCardImage {
  readonly available: boolean;
  readonly path: string | null;
  readonly sha256: string;
  readonly labelZh: string;
  readonly provenanceZh: string;
}

export interface CatalogRuntime {
  readonly servedAt: string;
  readonly resources: Readonly<Record<string, CatalogRuntimeResource>>;
  readonly cardImages: Readonly<Record<string, CatalogRuntimeCardImage>>;
}

export interface ServiceCatalog {
  readonly content: CatalogContent;
  readonly catalogVersion: string;
  readonly runtime: CatalogRuntime;
}

/* ------------------------------------------------------------------ */
/* 规范 JSON 与版本哈希                                                */
/* ------------------------------------------------------------------ */

/**
 * 确定性 JSON：对象键排序、数组保序、只允许 JSON 值。
 *
 * 生成工具、服务与客户端缓存校验都使用同一实现，因此内容相同必然得到
 * 相同 `catalogVersion`，与解析后的键顺序无关。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`无法规范化的 JSON 值: ${typeof value}`);
}

function encodeHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** 对目录内容计算版本哈希（64 位十六进制小写）。 */
export async function computeCatalogVersion(content: unknown): Promise<string> {
  return encodeHex(await sha256(utf8(canonicalJson(content))));
}

/* ------------------------------------------------------------------ */
/* 解析与校验                                                          */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const HEX64 = /^[0-9a-f]{64}$/u;

function parseIdentityRefs(value: unknown): CatalogIdentityRefs | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isString(value['effectIdentity']) || !isString(value['printIdentity']) || !isString(value['nameGroupKey'])) {
    return null;
  }
  return {
    effectIdentity: value['effectIdentity'],
    printIdentity: value['printIdentity'],
    nameGroupKey: value['nameGroupKey'],
  };
}

function parsePrint(value: unknown): CatalogPrint | null {
  if (!isRecord(value)) {
    return null;
  }
  const { printCode, regulationMark, number, total, displayNumber, illustrator, copyright } = value;
  if (
    !isString(printCode) ||
    !isNullableString(regulationMark) ||
    !isString(number) ||
    !isString(total) ||
    !isString(displayNumber) ||
    !isNullableString(illustrator) ||
    !isString(copyright)
  ) {
    return null;
  }
  return { printCode, regulationMark, number, total, displayNumber, illustrator, copyright };
}

function parseAbility(value: unknown): CatalogAbility | null {
  if (!isRecord(value)) {
    return null;
  }
  const { label, name, text } = value;
  if (!isString(label) || !isString(name) || !isString(text)) {
    return null;
  }
  return { label, name, text };
}

function parseAttack(value: unknown): CatalogAttack | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, cost, damage, text, attackKind } = value;
  if (!isString(name) || !isStringArray(cost) || !isNullableString(damage) || !isNullableString(text)) {
    return null;
  }
  if (attackKind !== null && !isString(attackKind)) {
    return null;
  }
  return { name, cost, damage, text, attackKind };
}

const CARD_CLASSES: readonly string[] = ['pokemon', 'trainer', 'energy'];

function parseCard(value: unknown): CatalogCard | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isString(value['id']) || !isString(value['nameZh']) || !isString(value['cardClass'])) {
    return null;
  }
  if (!CARD_CLASSES.includes(value['cardClass'])) {
    return null;
  }
  const flags = value['flags'];
  if (!isRecord(flags) || typeof flags['environmentLegal'] !== 'boolean' || typeof flags['effectSupported'] !== 'boolean') {
    return null;
  }
  if (!isString(flags['legalityNoteZh']) || !isString(flags['effectNoteZh'])) {
    return null;
  }
  const identities = parseIdentityRefs(value['identities']);
  const print = parsePrint(value['print']);
  if (identities === null || print === null) {
    return null;
  }
  if (!isString(value['fullTextZh']) || !isString(value['effectSummaryZh']) || !isString(value['classLabelZh'])) {
    return null;
  }
  if (!isString(value['categoryLabelZh']) || !isString(value['productCode']) || !isString(value['productNameZh'])) {
    return null;
  }
  if (!isStringArray(value['subtypes']) || !isStringArray(value['ruleLabels']) || !isStringArray(value['mechanics'])) {
    return null;
  }
  if (!isStringArray(value['decks'])) {
    return null;
  }
  const abilities = value['abilities'];
  const attacks = value['attacks'];
  if (!Array.isArray(abilities) || !Array.isArray(attacks)) {
    return null;
  }
  const parsedAbilities: CatalogAbility[] = [];
  for (const ability of abilities) {
    const parsed = parseAbility(ability);
    if (parsed === null) {
      return null;
    }
    parsedAbilities.push(parsed);
  }
  const parsedAttacks: CatalogAttack[] = [];
  for (const attack of attacks) {
    const parsed = parseAttack(attack);
    if (parsed === null) {
      return null;
    }
    parsedAttacks.push(parsed);
  }
  let imageSource: CatalogImageSource | null = null;
  if (value['imageSource'] !== null && value['imageSource'] !== undefined) {
    const source = value['imageSource'];
    if (!isRecord(source)) {
      return null;
    }
    if (!isString(source['sha256']) || !isString(source['labelZh']) || !isString(source['provenanceZh']) || !isString(source['articleUrl'])) {
      return null;
    }
    imageSource = {
      sha256: source['sha256'],
      labelZh: source['labelZh'],
      provenanceZh: source['provenanceZh'],
      articleUrl: source['articleUrl'],
    };
  }
  if (
    !isNullableString(value['effectiveCategory']) ||
    !isNullableString(value['type']) ||
    !isNullableString(value['weakness']) ||
    !isNullableString(value['resistance']) ||
    !isNullableString(value['evolvesFrom']) ||
    !isNullableString(value['pokedexText']) ||
    !isNullableString(value['specialRuleTextZh']) ||
    !isNullableString(value['effectTextZh']) ||
    !isNullableString(value['classRuleTextZh']) ||
    !isNullableString(value['printedClassRuleTextZh']) ||
    !isNullableString(value['toolBannerTextZh'])
  ) {
    return null;
  }
  if (value['hp'] !== null && !isFiniteNumber(value['hp'])) {
    return null;
  }
  if (value['retreat'] !== null && !isFiniteNumber(value['retreat'])) {
    return null;
  }
  return {
    id: value['id'],
    nameZh: value['nameZh'],
    cardClass: value['cardClass'] as CatalogCard['cardClass'],
    classLabelZh: value['classLabelZh'],
    subtypes: value['subtypes'],
    effectiveCategory: value['effectiveCategory'],
    categoryLabelZh: value['categoryLabelZh'],
    type: value['type'],
    hp: value['hp'] as number | null,
    weakness: value['weakness'],
    resistance: value['resistance'],
    retreat: value['retreat'] as number | null,
    evolvesFrom: value['evolvesFrom'],
    pokedexText: value['pokedexText'],
    abilities: parsedAbilities,
    attacks: parsedAttacks,
    ruleLabels: value['ruleLabels'],
    specialRuleTextZh: value['specialRuleTextZh'],
    effectTextZh: value['effectTextZh'],
    classRuleTextZh: value['classRuleTextZh'],
    printedClassRuleTextZh: value['printedClassRuleTextZh'],
    toolBannerTextZh: value['toolBannerTextZh'],
    fullTextZh: value['fullTextZh'],
    effectSummaryZh: value['effectSummaryZh'],
    mechanics: value['mechanics'],
    identities,
    print,
    productCode: value['productCode'],
    productNameZh: value['productNameZh'],
    flags: {
      environmentLegal: flags['environmentLegal'],
      legalityNoteZh: flags['legalityNoteZh'],
      effectSupported: flags['effectSupported'],
      effectNoteZh: flags['effectNoteZh'],
    },
    imageSource,
    decks: value['decks'],
  };
}

function parseDeck(value: unknown): CatalogDeck | null {
  if (!isRecord(value)) {
    return null;
  }
  const { code, nameZh, playstyleZh, evolutionStrategyZh, cardCount, cards } = value;
  if (!isString(code) || !isString(nameZh) || !isString(playstyleZh) || !isString(evolutionStrategyZh) || !isFiniteNumber(cardCount)) {
    return null;
  }
  if (!Array.isArray(cards)) {
    return null;
  }
  const parsed: CatalogDeckCard[] = [];
  for (const entry of cards) {
    if (!isRecord(entry) || !isString(entry['id']) || !isFiniteNumber(entry['count'])) {
      return null;
    }
    parsed.push({ id: entry['id'], count: entry['count'] });
  }
  return { code, nameZh, playstyleZh, evolutionStrategyZh, cardCount, cards: parsed };
}

function parseResource(value: unknown): CatalogResource | null {
  if (!isRecord(value)) {
    return null;
  }
  const { resourceId, kind, file, sha256: digest, width, height, labelZh, provenanceZh, caveatZh, redistributionZh } = value;
  if (
    !isString(resourceId) ||
    !isString(kind) ||
    !isString(file) ||
    !isString(digest) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    !isString(labelZh) ||
    !isString(provenanceZh) ||
    !isString(caveatZh) ||
    !isString(redistributionZh)
  ) {
    return null;
  }
  return { resourceId, kind, file, sha256: digest, width, height, labelZh, provenanceZh, caveatZh, redistributionZh };
}

function parseEnvironment(value: unknown): CatalogEnvironment | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, nameZh, formatZh, frozenAt, legalitySummaryZh, scopeZh, supportedSubsetZh, ruleManual, counts } = value;
  if (
    !isString(id) ||
    !isString(nameZh) ||
    !isString(formatZh) ||
    !isString(frozenAt) ||
    !isString(legalitySummaryZh) ||
    !isString(scopeZh) ||
    !isString(supportedSubsetZh)
  ) {
    return null;
  }
  if (!isRecord(ruleManual) || !isString(ruleManual['title']) || !isString(ruleManual['version']) || !isString(ruleManual['date'])) {
    return null;
  }
  if (
    !isRecord(counts) ||
    !isFiniteNumber(counts['verifiedCards']) ||
    !isFiniteNumber(counts['printIdentities']) ||
    !isFiniteNumber(counts['effectIdentities']) ||
    !isFiniteNumber(counts['presetDeckCards'])
  ) {
    return null;
  }
  return {
    id,
    nameZh,
    formatZh,
    frozenAt,
    legalitySummaryZh,
    scopeZh,
    supportedSubsetZh,
    ruleManual: { title: ruleManual['title'], version: ruleManual['version'], date: ruleManual['date'] },
    counts: {
      verifiedCards: counts['verifiedCards'],
      printIdentities: counts['printIdentities'],
      effectIdentities: counts['effectIdentities'],
      presetDeckCards: counts['presetDeckCards'],
    },
  };
}

function parseSupportPolicy(value: unknown): CatalogSupportPolicy | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['engineIntegration'] !== 'not-integrated' || value['playable'] !== false || !isString(value['noteZh'])) {
    return null;
  }
  return { engineIntegration: 'not-integrated', playable: false, noteZh: value['noteZh'] };
}

function parseDataRevision(value: unknown, environmentId: string): CatalogDataRevision | null {
  if (!isRecord(value)) {
    return null;
  }
  const { environment, sourceDigest, sourceFiles } = value;
  if (!isString(environment) || !isString(sourceDigest) || !Array.isArray(sourceFiles)) {
    return null;
  }
  if (environment !== environmentId || !HEX64.test(sourceDigest)) {
    return null;
  }
  const files: CatalogSourceFile[] = [];
  for (const entry of sourceFiles) {
    if (!isRecord(entry) || !isString(entry['path']) || !isString(entry['sha256']) || !HEX64.test(entry['sha256'])) {
      return null;
    }
    files.push({ path: entry['path'], sha256: entry['sha256'] });
  }
  return { environment, sourceDigest, sourceFiles: files };
}

/**
 * 解析目录内容（不含运行期覆盖）。
 *
 * 返回 `null` 表示结构不完整或字段类型不符；调用方不得据此渲染半份目录。
 */
export function parseCatalogContent(value: unknown): CatalogContent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['schema'] !== CATALOG_SCHEMA || !isString(value['generatedBy'])) {
    return null;
  }
  const environment = parseEnvironment(value['environment']);
  if (environment === null) {
    return null;
  }
  const dataRevision = parseDataRevision(value['dataRevision'], environment.id);
  const supportPolicy = parseSupportPolicy(value['supportPolicy']);
  if (dataRevision === null || supportPolicy === null) {
    return null;
  }
  if (!isStringArray(value['categories'])) {
    return null;
  }
  const cards = value['cards'];
  const decks = value['decks'];
  const resources = value['resources'];
  if (!Array.isArray(cards) || cards.length === 0 || !Array.isArray(decks) || !Array.isArray(resources)) {
    return null;
  }
  const parsedCards: CatalogCard[] = [];
  const cardIds = new Set<string>();
  for (const card of cards) {
    const parsed = parseCard(card);
    if (parsed === null || cardIds.has(parsed.id)) {
      return null;
    }
    cardIds.add(parsed.id);
    parsedCards.push(parsed);
  }
  const parsedDecks: CatalogDeck[] = [];
  for (const deck of decks) {
    const parsed = parseDeck(deck);
    if (parsed === null) {
      return null;
    }
    parsedDecks.push(parsed);
  }
  const parsedResources: CatalogResource[] = [];
  const resourceIds = new Set<string>();
  for (const resource of resources) {
    const parsed = parseResource(resource);
    if (parsed === null || resourceIds.has(parsed.resourceId)) {
      return null;
    }
    resourceIds.add(parsed.resourceId);
    parsedResources.push(parsed);
  }
  return {
    schema: CATALOG_SCHEMA,
    dataRevision,
    generatedBy: value['generatedBy'],
    environment,
    supportPolicy,
    categories: value['categories'],
    cards: parsedCards,
    decks: parsedDecks,
    resources: parsedResources,
  };
}

function parseRuntimeImage(value: unknown): CatalogRuntimeResource | null {
  if (!isRecord(value)) {
    return null;
  }
  const { available, path, sha256: digest, labelZh, provenanceZh } = value;
  if (typeof available !== 'boolean' || !isNullableString(path) || !isString(digest) || !isString(labelZh) || !isString(provenanceZh)) {
    return null;
  }
  return { available, path, sha256: digest, labelZh, provenanceZh };
}

function parseRuntime(value: unknown): CatalogRuntime | null {
  if (!isRecord(value) || !isString(value['servedAt'])) {
    return null;
  }
  const resources: Record<string, CatalogRuntimeResource> = {};
  const cardImages: Record<string, CatalogRuntimeCardImage> = {};
  const rawResources = value['resources'];
  const rawCards = value['cardImages'];
  if (!isRecord(rawResources) || !isRecord(rawCards)) {
    return null;
  }
  for (const [key, entry] of Object.entries(rawResources)) {
    const parsed = parseRuntimeImage(entry);
    if (parsed === null) {
      return null;
    }
    resources[key] = parsed;
  }
  for (const [key, entry] of Object.entries(rawCards)) {
    const parsed = parseRuntimeImage(entry);
    if (parsed === null) {
      return null;
    }
    cardImages[key] = parsed;
  }
  return { servedAt: value['servedAt'], resources, cardImages };
}

const EMPTY_RUNTIME: CatalogRuntime = { servedAt: '', resources: {}, cardImages: {} };

/**
 * 解析服务或缓存中的完整目录：内容 + 版本 + 运行期覆盖。
 *
 * 生成工具的产物没有 `runtime` 键，此时运行期覆盖为空。`catalogVersion`
 * 必须存在且为 64 位十六进制。
 */
export function parseServiceCatalog(value: unknown): ServiceCatalog | null {
  if (!isRecord(value)) {
    return null;
  }
  const catalogVersion = value['catalogVersion'];
  if (!isString(catalogVersion) || !HEX64.test(catalogVersion)) {
    return null;
  }
  const { catalogVersion: _ignoredVersion, runtime: _ignoredRuntime, ...content } = value;
  const parsedContent = parseCatalogContent(content);
  if (parsedContent === null) {
    return null;
  }
  const runtimeValue = value['runtime'];
  if (runtimeValue === undefined) {
    return { content: parsedContent, catalogVersion, runtime: EMPTY_RUNTIME };
  }
  const runtime = parseRuntime(runtimeValue);
  if (runtime === null) {
    return null;
  }
  return { content: parsedContent, catalogVersion, runtime };
}

/** 运行期是否会为该资源提供图片字节。 */
export function isResourceAvailable(catalog: ServiceCatalog, resourceId: string): boolean {
  return catalog.runtime.resources[resourceId]?.available === true;
}

/** 运行期是否会为该卡提供 T01 已核实的官方图。 */
export function isCardImageAvailable(catalog: ServiceCatalog, cardId: string): boolean {
  return catalog.runtime.cardImages[cardId]?.available === true;
}
