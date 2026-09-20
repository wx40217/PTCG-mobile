import type { CatalogCard, CatalogContent, CatalogDeck } from './catalog.ts';

/**
 * 卡组草稿、文本交换与合法性校验的公共契约（T05）。
 *
 * 三个身份轴在数据结构里保持分离：
 *   - 目录条目 `cardId`：定位具体印刷版本；
 *   - `printIdentity`：商品 + 印刷编号；
 *   - `effectIdentity`：规则效果身份。
 *
 * 同名 ≤4 的构筑限制永远按目录的 `nameGroupKey`（官方卡名）聚合，因此异画和
 * 重印不能通过显示名称或不同印刷身份绕过限额。服务端独立执行同一实现，不
 * 接受客户端自行声明的合法性或就绪状态。
 *
 * “规则合法”与“效果已接入、可正式对战”是两个独立状态：卡组可以在规则上
 * 完全合法，但只要有卡牌效果未接入，就不能用于正式对局。
 */

export const DECK_FORMAT_VERSION = 1;
export const DECK_TEXT_HEADER = 'PTCG-DECK';
export const MAX_DECK_CARDS = 60;
export const MAX_COPIES_PER_NAME = 4;
export const BASIC_ENERGY_CATEGORY = '基本能量';
export const BASIC_POKEMON_SUBTYPE = '基础';

/** 王牌（ACE SPEC）：整副卡组最多 1 张。 */
export const ACE_SPEC_SUBTYPES: readonly string[] = ['ACE SPEC', 'ACE SPEC卡', '王牌'];
/** 棱镜之星：同名最多 1 张。 */
export const PRISM_STAR_SUBTYPES: readonly string[] = ['棱镜之星'];
/** 光辉宝可梦：整副卡组最多 1 张。 */
export const RADIANT_SUBTYPES: readonly string[] = ['光辉', '光辉宝可梦'];

export interface DeckCardEntry {
  readonly cardId: string;
  /** 印刷身份；与 `cardId` 指向的目录条目必须一致。 */
  readonly printIdentity: string;
  /** 规则效果身份；与 `cardId` 指向的目录条目必须一致。 */
  readonly effectIdentity: string;
  readonly count: number;
}

export interface DeckDocument {
  readonly formatVersion: number;
  /** 卡组绑定环境快照；与服务端当前目录不一致时不能开局。 */
  readonly environmentId: string;
  readonly cards: readonly DeckCardEntry[];
}

export type DeckProblemCode =
  | 'format-version'
  | 'environment-mismatch'
  | 'unknown-card'
  | 'identity-mismatch'
  | 'invalid-count'
  | 'deck-size'
  | 'no-basic-pokemon'
  | 'name-limit'
  | 'special-limit'
  | 'environment-illegal'
  | 'evolution-line'
  | 'effect-unsupported'
  | 'engine-not-integrated';

export type DeckProblemKind = 'legality' | 'readiness';

export interface DeckValidationProblem {
  readonly code: DeckProblemCode;
  readonly kind: DeckProblemKind;
  readonly message: string;
  readonly cardIds: readonly string[];
}

export interface DeckValidationResponse {
  readonly formatVersion: number;
  readonly environmentId: string;
  readonly catalogVersion: string;
  /** 目录资料修订摘要（`dataRevision.sourceDigest`）；离线校验据此说明依据版本。 */
  readonly dataRevision: string;
  readonly totalCards: number;
  readonly legal: boolean;
  /** 规则合法且所有卡牌效果均已接入时才是正式对战就绪。 */
  readonly ready: boolean;
  readonly problems: readonly DeckValidationProblem[];
}

export interface DeckCatalogView {
  readonly content: CatalogContent;
  readonly catalogVersion: string;
}

/* ------------------------------------------------------------------ */
/* 严格解析（客户端草稿存储、服务端入口共用）                          */
/* ------------------------------------------------------------------ */

export type DeckDocumentParse =
  | { readonly ok: true; readonly deck: DeckDocument }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 解析卡组文档结构。
 *
 * 只做结构校验：卡牌是否存在、构筑是否合法由 `validateDeck` 依据目录判断。
 * 允许空 `cards`，因为编辑中的草稿可以暂时没有卡牌。
 */
export function parseDeckDocument(value: unknown): DeckDocumentParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['卡组文档必须是 JSON 对象。'] };
  }
  if (value['formatVersion'] !== DECK_FORMAT_VERSION) {
    errors.push(`卡组格式版本必须是 ${DECK_FORMAT_VERSION}。`);
  }
  if (!isNonEmptyString(value['environmentId'])) {
    errors.push('卡组缺少环境标识。');
  }
  const rawCards = value['cards'];
  const cards: DeckCardEntry[] = [];
  if (!Array.isArray(rawCards)) {
    errors.push('卡组缺少卡牌列表。');
  } else {
    rawCards.forEach((entry, index) => {
      if (!isRecord(entry)) {
        errors.push(`第 ${index + 1} 项卡牌必须是对象。`);
        return;
      }
      const cardId = entry['cardId'];
      const printIdentity = entry['printIdentity'];
      const effectIdentity = entry['effectIdentity'];
      const count = entry['count'];
      if (!isNonEmptyString(cardId)) {
        errors.push(`第 ${index + 1} 项卡牌缺少编号。`);
      }
      if (!isNonEmptyString(printIdentity)) {
        errors.push(`第 ${index + 1} 项卡牌缺少印刷身份。`);
      }
      if (!isNonEmptyString(effectIdentity)) {
        errors.push(`第 ${index + 1} 项卡牌缺少效果身份。`);
      }
      if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 99) {
        errors.push(`第 ${index + 1} 项卡牌数量必须是 1-99 的整数。`);
      }
      if (
        isNonEmptyString(cardId) &&
        isNonEmptyString(printIdentity) &&
        isNonEmptyString(effectIdentity) &&
        Number.isInteger(count) &&
        (count as number) >= 1 &&
        (count as number) <= 99
      ) {
        cards.push({ cardId, printIdentity, effectIdentity, count: count as number });
      }
    });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    deck: {
      formatVersion: DECK_FORMAT_VERSION,
      environmentId: value['environmentId'] as string,
      cards,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function isBasicEnergy(card: CatalogCard): boolean {
  if (card.cardClass !== 'energy') {
    return false;
  }
  return card.effectiveCategory === BASIC_ENERGY_CATEGORY || card.subtypes.includes(BASIC_ENERGY_CATEGORY);
}

function hasAnySubtype(card: CatalogCard, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => card.subtypes.includes(candidate));
}

function isBasicPokemon(card: CatalogCard): boolean {
  return card.cardClass === 'pokemon' && card.subtypes.includes(BASIC_POKEMON_SUBTYPE);
}

function withCounts(entries: readonly { readonly card: CatalogCard; readonly count: number }[]): string {
  return entries.map((entry) => `${entry.card.nameZh}×${entry.count}（${entry.card.id}）`).join('、');
}

/**
 * 依据冻结目录校验卡组。纯函数：不读取时间、网络或本机资源，服务端与客户端
 * 可以对同一份目录得到完全一致的结果。
 */
export function validateDeck(deck: DeckDocument, catalog: DeckCatalogView): DeckValidationResponse {
  const { content } = catalog;
  const problems: DeckValidationProblem[] = [];
  if (deck.formatVersion !== DECK_FORMAT_VERSION) {
    problems.push({
      code: 'format-version',
      kind: 'legality',
      message: `卡组格式版本 ${deck.formatVersion} 不受支持，需要 ${DECK_FORMAT_VERSION}。`,
      cardIds: [],
    });
  }
  if (deck.environmentId !== content.environment.id) {
    problems.push({
      code: 'environment-mismatch',
      kind: 'legality',
      message: `卡组环境 ${deck.environmentId} 与当前目录环境 ${content.environment.id} 不一致。`,
      cardIds: [],
    });
  }

  const cardsById = new Map<string, CatalogCard>();
  for (const card of content.cards) {
    cardsById.set(card.id, card);
  }

  interface ResolvedEntry {
    readonly card: CatalogCard;
    readonly count: number;
    /** 该条目在提交中的下标，用于稳定排序。 */
    readonly index: number;
  }

  const resolved: ResolvedEntry[] = [];
  const unknownIds: string[] = [];
  let totalCards = 0;
  deck.cards.forEach((entry, index) => {
    if (!Number.isInteger(entry.count) || entry.count < 1 || entry.count > 99) {
      problems.push({
        code: 'invalid-count',
        kind: 'legality',
        message: `卡牌 ${entry.cardId} 的数量 ${entry.count} 不合法，必须是 1-99 的整数。`,
        cardIds: [entry.cardId],
      });
      return;
    }
    totalCards += entry.count;
    const card = cardsById.get(entry.cardId);
    if (card === undefined) {
      unknownIds.push(entry.cardId);
      return;
    }
    if (card.identities.printIdentity !== entry.printIdentity || card.identities.effectIdentity !== entry.effectIdentity) {
      problems.push({
        code: 'identity-mismatch',
        kind: 'legality',
        message: `卡牌 ${entry.cardId}（${card.nameZh}）的印刷身份或效果身份与目录不一致，可能来自其他目录版本。`,
        cardIds: [entry.cardId],
      });
    }
    resolved.push({ card, count: entry.count, index });
  });

  if (unknownIds.length > 0) {
    const unique = [...new Set(unknownIds)];
    problems.push({
      code: 'unknown-card',
      kind: 'legality',
      message: `目录中没有这些卡牌编号：${unique.join('、')}。`,
      cardIds: unique,
    });
  }

  if (totalCards !== MAX_DECK_CARDS) {
    problems.push({
      code: 'deck-size',
      kind: 'legality',
      message: `卡组共 ${totalCards} 张，必须正好 ${MAX_DECK_CARDS} 张。`,
      cardIds: [],
    });
  }

  const basicPokemonCount = resolved
    .filter((entry) => isBasicPokemon(entry.card))
    .reduce((sum, entry) => sum + entry.count, 0);
  if (basicPokemonCount < 1) {
    problems.push({
      code: 'no-basic-pokemon',
      kind: 'legality',
      message: '卡组必须至少放入 1 张基础宝可梦。',
      cardIds: [],
    });
  }

  interface NameGroup {
    readonly nameGroupKey: string;
    readonly nameZh: string;
    count: number;
    readonly cards: Map<string, { card: CatalogCard; count: number }>;
    basicEnergy: boolean;
  }

  const groups = new Map<string, NameGroup>();
  for (const entry of resolved) {
    const key = entry.card.identities.nameGroupKey;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        nameGroupKey: key,
        nameZh: entry.card.nameZh,
        count: entry.count,
        cards: new Map([[entry.card.id, { card: entry.card, count: entry.count }]]),
        basicEnergy: isBasicEnergy(entry.card),
      });
      continue;
    }
    group.count += entry.count;
    const existing = group.cards.get(entry.card.id);
    group.cards.set(entry.card.id, { card: entry.card, count: (existing?.count ?? 0) + entry.count });
    group.basicEnergy = group.basicEnergy && isBasicEnergy(entry.card);
  }

  for (const group of groups.values()) {
    if (!group.basicEnergy && group.count > MAX_COPIES_PER_NAME) {
      const detail = withCounts(
        [...group.cards.values()].sort((left, right) => left.card.id.localeCompare(right.card.id)),
      );
      problems.push({
        code: 'name-limit',
        kind: 'legality',
        message: `「${group.nameZh}」同名卡共 ${group.count} 张，超过上限 ${MAX_COPIES_PER_NAME} 张：${detail}。`,
        cardIds: [...group.cards.keys()].sort(),
      });
    }
    if ([...group.cards.values()].some((entry) => hasAnySubtype(entry.card, PRISM_STAR_SUBTYPES)) && group.count > 1) {
      problems.push({
        code: 'special-limit',
        kind: 'legality',
        message: `棱镜之星「${group.nameZh}」最多只能放入 1 张。`,
        cardIds: [...group.cards.keys()].sort(),
      });
    }
  }

  const aceSpecCards = [...new Map(resolved.filter((entry) => hasAnySubtype(entry.card, ACE_SPEC_SUBTYPES)).map((entry) => [entry.card.id, entry])).values()];
  const aceSpecCount = resolved
    .filter((entry) => hasAnySubtype(entry.card, ACE_SPEC_SUBTYPES))
    .reduce((sum, entry) => sum + entry.count, 0);
  if (aceSpecCount > 1) {
    problems.push({
      code: 'special-limit',
      kind: 'legality',
      message: `王牌（ACE SPEC）卡整副卡组最多 1 张，当前共 ${aceSpecCount} 张。`,
      cardIds: aceSpecCards.map((entry) => entry.card.id).sort(),
    });
  }

  const radiantCards = [...new Map(resolved.filter((entry) => hasAnySubtype(entry.card, RADIANT_SUBTYPES)).map((entry) => [entry.card.id, entry])).values()];
  const radiantCount = resolved
    .filter((entry) => hasAnySubtype(entry.card, RADIANT_SUBTYPES))
    .reduce((sum, entry) => sum + entry.count, 0);
  if (radiantCount > 1) {
    problems.push({
      code: 'special-limit',
      kind: 'legality',
      message: `光辉宝可梦整副卡组最多 1 张，当前共 ${radiantCount} 张。`,
      cardIds: radiantCards.map((entry) => entry.card.id).sort(),
    });
  }

  const illegalCards = [...new Map(resolved.filter((entry) => !entry.card.flags.environmentLegal).map((entry) => [entry.card.id, entry])).values()];
  if (illegalCards.length > 0) {
    problems.push({
      code: 'environment-illegal',
      kind: 'legality',
      message: `这些卡牌不在当前冻结环境内：${illegalCards.map((entry) => `${entry.card.nameZh}（${entry.card.id}）`).join('、')}。`,
      cardIds: illegalCards.map((entry) => entry.card.id).sort(),
    });
  }

  const presentNames = new Set(resolved.map((entry) => entry.card.nameZh));
  const evolutionBroken = new Map<string, CatalogCard>();
  for (const entry of resolved) {
    const card = entry.card;
    if (card.evolvesFrom !== null && !presentNames.has(card.evolvesFrom)) {
      evolutionBroken.set(card.id, card);
    }
  }
  for (const card of evolutionBroken.values()) {
    problems.push({
      code: 'evolution-line',
      kind: 'legality',
      message: `「${card.nameZh}」需要卡组内存在进化前置「${card.evolvesFrom}」。`,
      cardIds: [card.id],
    });
  }

  const unsupported = [...new Map(resolved.filter((entry) => !entry.card.flags.effectSupported).map((entry) => [entry.card.id, entry])).values()];
  if (unsupported.length > 0) {
    const unsupportedTotal = resolved
      .filter((entry) => !entry.card.flags.effectSupported)
      .reduce((sum, entry) => sum + entry.count, 0);
    problems.push({
      code: 'effect-unsupported',
      kind: 'readiness',
      message: `${unsupported.length} 种卡（共 ${unsupportedTotal} 张）效果未接入，不能用于正式对战：${unsupported
        .map((entry) => `${entry.card.nameZh}（${entry.card.id}）`)
        .join('、')}。`,
      cardIds: unsupported.map((entry) => entry.card.id).sort(),
    });
  } else if (!content.supportPolicy.playable) {
    problems.push({
      code: 'engine-not-integrated',
      kind: 'readiness',
      message: '服务端尚未接入正式对战引擎，当前不能开局。',
      cardIds: [],
    });
  }

  const legal = !problems.some((problem) => problem.kind === 'legality');
  const ready = legal && !problems.some((problem) => problem.kind === 'readiness');
  return {
    formatVersion: deck.formatVersion,
    environmentId: deck.environmentId,
    catalogVersion: catalog.catalogVersion,
    dataRevision: content.dataRevision.sourceDigest,
    totalCards,
    legal,
    ready,
    problems,
  };
}

/** 把预设卡表转换成带精确身份的卡组文档；目录缺卡时返回 null（不得猜测）。 */
export function presetDeckDocument(preset: CatalogDeck, content: CatalogContent): DeckDocument | null {
  const cards: DeckCardEntry[] = [];
  for (const entry of preset.cards) {
    const card = content.cards.find((candidate) => candidate.id === entry.id);
    if (card === undefined) {
      return null;
    }
    cards.push({
      cardId: card.id,
      printIdentity: card.identities.printIdentity,
      effectIdentity: card.identities.effectIdentity,
      count: entry.count,
    });
  }
  return { formatVersion: DECK_FORMAT_VERSION, environmentId: content.environment.id, cards };
}

/** 卡组文档中的卡牌总数（数量字段已由解析或校验保证为正整数）。 */
export function deckCardTotal(deck: DeckDocument): number {
  return deck.cards.reduce((sum, entry) => sum + entry.count, 0);
}

/* ------------------------------------------------------------------ */
/* 版本化文本导入 / 导出                                               */
/* ------------------------------------------------------------------ */

export type DeckImportIssueCode =
  | 'empty'
  | 'format-version'
  | 'malformed'
  | 'environment-mismatch'
  | 'unknown-card'
  | 'ambiguous-card'
  | 'identity-mismatch';

export interface DeckImportIssue {
  readonly code: DeckImportIssueCode;
  readonly message: string;
  readonly line?: number;
}

export type DeckImportResult =
  | { readonly ok: true; readonly deck: DeckDocument }
  | { readonly ok: false; readonly issues: readonly DeckImportIssue[] };

const MAX_IMPORT_ISSUES = 20;

/**
 * 导出可分享文本。
 *
 * 每行是 `数量 卡牌编号 印刷身份 效果身份`，末尾 `# 卡名` 只是给人看的注释，
 * 导入时忽略；因此导出文本可以安全地在聊天工具中粘贴而不改变含义。
 */
export function exportDeckText(deck: DeckDocument, catalog: { readonly content: Pick<CatalogContent, 'cards'> }): string {
  const lines = [`${DECK_TEXT_HEADER}/${deck.formatVersion}`, `ENV ${deck.environmentId}`];
  for (const entry of deck.cards) {
    const card = catalog.content.cards.find((candidate) => candidate.id === entry.cardId);
    const comment = card === undefined ? '' : ` # ${card.nameZh}`;
    lines.push(`${entry.count} ${entry.cardId} ${entry.printIdentity} ${entry.effectIdentity}${comment}`);
  }
  return lines.join('\n');
}

const HEADER_PATTERN = /^PTCG-DECK\/(\d+)$/u;

/**
 * 解析分享文本。
 *
 * 支持两种卡牌行：带完整身份的规范行（导出产物）和只写卡名或卡牌编号的
 * 简化行。简化行只允许唯一匹配，否则要求改用卡牌编号，避免把同名不同效果的
 * 卡牌猜错。任何错误都不会产生部分结果，调用方据此保留原卡组。
 */
export function importDeckText(text: string, catalog: DeckCatalogView): DeckImportResult {
  const issues: DeckImportIssue[] = [];
  const addIssue = (code: DeckImportIssueCode, message: string, line?: number): void => {
    if (issues.length < MAX_IMPORT_ISSUES) {
      issues.push(line === undefined ? { code, message } : { code, message, line });
    }
  };

  if (text.trim().length === 0) {
    return { ok: false, issues: [{ code: 'empty', message: '卡组文本为空。' }] };
  }

  const rawLines = text.split(/\r?\n/u);
  let headerSeen = false;
  let environmentId: string | undefined;
  const entries: DeckCardEntry[] = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const lineNumber = index + 1;
    const withoutComment = (rawLines[index] ?? '').split('#')[0] ?? '';
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!headerSeen) {
      const match = HEADER_PATTERN.exec(trimmed);
      if (match === null) {
        addIssue('malformed', `第 ${lineNumber} 行：缺少格式版本行（应为 ${DECK_TEXT_HEADER}/${DECK_FORMAT_VERSION}）。`, lineNumber);
        headerSeen = true;
        continue;
      }
      const version = Number.parseInt(match[1] as string, 10);
      if (version !== DECK_FORMAT_VERSION) {
        addIssue('format-version', `第 ${lineNumber} 行：不支持的卡组文本版本 ${version}，需要 ${DECK_FORMAT_VERSION}。`, lineNumber);
      }
      headerSeen = true;
      continue;
    }
    if (trimmed.startsWith('ENV')) {
      const environment = trimmed.slice(3).trim();
      if (environment.length === 0) {
        addIssue('malformed', `第 ${lineNumber} 行：环境标识为空。`, lineNumber);
      } else if (environmentId !== undefined) {
        addIssue('malformed', `第 ${lineNumber} 行：重复的环境标识行。`, lineNumber);
      } else {
        environmentId = environment;
      }
      continue;
    }

    const tokens = trimmed.split(/\s+/u);
    const countToken = tokens[0] ?? '';
    if (!/^\d+$/u.test(countToken)) {
      addIssue('malformed', `第 ${lineNumber} 行：数量「${countToken}」不是整数。`, lineNumber);
      continue;
    }
    const count = Number.parseInt(countToken, 10);
    if (count < 1 || count > 99) {
      addIssue('malformed', `第 ${lineNumber} 行：数量 ${count} 超出 1-99。`, lineNumber);
      continue;
    }
    const reference = tokens[1];
    if (reference === undefined) {
      addIssue('malformed', `第 ${lineNumber} 行：缺少卡牌编号或名称。`, lineNumber);
      continue;
    }
    if (environmentId === undefined) {
      addIssue('malformed', `第 ${lineNumber} 行：卡牌行出现在环境标识之前。`, lineNumber);
      continue;
    }
    if (tokens.length > 4) {
      addIssue('malformed', `第 ${lineNumber} 行：多余的字段，每行应为「数量 编号 印刷身份 效果身份」。`, lineNumber);
      continue;
    }
    const printIdentity = tokens[2];
    const effectIdentity = tokens[3];
    if (printIdentity !== undefined && !printIdentity.startsWith('print:')) {
      addIssue('malformed', `第 ${lineNumber} 行：印刷身份应以 print: 开头。`, lineNumber);
      continue;
    }
    if (effectIdentity !== undefined && !effectIdentity.startsWith('fx:')) {
      addIssue('malformed', `第 ${lineNumber} 行：效果身份应以 fx: 开头。`, lineNumber);
      continue;
    }

    const byId = catalog.content.cards.find((card) => card.id === reference);
    let candidates = byId === undefined ? catalog.content.cards.filter((card) => card.nameZh === reference) : [byId];
    if (candidates.length === 0) {
      addIssue('unknown-card', `第 ${lineNumber} 行：目录中没有卡牌编号或名称「${reference}」。`, lineNumber);
      continue;
    }
    if (byId === undefined && candidates.length > 1) {
      addIssue(
        'ambiguous-card',
        `第 ${lineNumber} 行：「${reference}」匹配到 ${candidates.length} 张同名卡牌，请使用卡牌编号。`,
        lineNumber,
      );
      continue;
    }
    if (printIdentity !== undefined) {
      candidates = candidates.filter((card) => card.identities.printIdentity === printIdentity);
    }
    if (effectIdentity !== undefined) {
      candidates = candidates.filter((card) => card.identities.effectIdentity === effectIdentity);
    }
    if (candidates.length === 0) {
      addIssue(
        'identity-mismatch',
        `第 ${lineNumber} 行：卡牌「${reference}」的身份与当前目录不一致，可能来自其他目录版本。`,
        lineNumber,
      );
      continue;
    }
    if (candidates.length > 1) {
      addIssue(
        'ambiguous-card',
        `第 ${lineNumber} 行：「${reference}」仍匹配到 ${candidates.length} 张卡牌，请补充精确身份。`,
        lineNumber,
      );
      continue;
    }
    const card = candidates[0] as CatalogCard;
    const existing = entries.find((entry) => entry.cardId === card.id);
    if (existing === undefined) {
      entries.push({
        cardId: card.id,
        printIdentity: card.identities.printIdentity,
        effectIdentity: card.identities.effectIdentity,
        count,
      });
    } else {
      const position = entries.indexOf(existing);
      entries[position] = { ...existing, count: Math.min(99, existing.count + count) };
    }
  }

  if (environmentId !== undefined && environmentId !== catalog.content.environment.id) {
    addIssue(
      'environment-mismatch',
      `文本环境 ${environmentId} 与当前目录环境 ${catalog.content.environment.id} 不一致。`,
    );
  }
  if (issues.length === 0 && entries.length === 0) {
    addIssue('malformed', '卡组文本中没有任何卡牌。');
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    deck: {
      formatVersion: DECK_FORMAT_VERSION,
      environmentId: environmentId as string,
      cards: entries,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 校验响应解析（客户端读取服务端结果）                                */
/* ------------------------------------------------------------------ */

function parseProblem(value: unknown): DeckValidationProblem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value['code'] !== 'string' ||
    (value['kind'] !== 'legality' && value['kind'] !== 'readiness') ||
    typeof value['message'] !== 'string' ||
    !Array.isArray(value['cardIds']) ||
    !value['cardIds'].every((id) => typeof id === 'string')
  ) {
    return null;
  }
  return {
    code: value['code'] as DeckProblemCode,
    kind: value['kind'],
    message: value['message'],
    cardIds: value['cardIds'] as readonly string[],
  };
}

/** 解析服务端 `/decks/validate` 的响应；结构不符返回 null。 */
export function parseDeckValidationResponse(value: unknown): DeckValidationResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value['formatVersion'] !== DECK_FORMAT_VERSION ||
    !isNonEmptyString(value['environmentId']) ||
    !isNonEmptyString(value['catalogVersion']) ||
    !isNonEmptyString(value['dataRevision']) ||
    !Number.isInteger(value['totalCards']) ||
    typeof value['legal'] !== 'boolean' ||
    typeof value['ready'] !== 'boolean' ||
    !Array.isArray(value['problems'])
  ) {
    return null;
  }
  const problems: DeckValidationProblem[] = [];
  for (const problem of value['problems']) {
    const parsed = parseProblem(problem);
    if (parsed === null) {
      return null;
    }
    problems.push(parsed);
  }
  return {
    formatVersion: DECK_FORMAT_VERSION,
    environmentId: value['environmentId'],
    catalogVersion: value['catalogVersion'],
    dataRevision: value['dataRevision'],
    totalCards: value['totalCards'] as number,
    legal: value['legal'],
    ready: value['ready'],
    problems,
  };
}
