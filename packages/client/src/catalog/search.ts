import type { CatalogCard } from '@ptcg/protocol';

/**
 * 卡牌目录的本地检索。
 *
 * 目录条目以“印刷版本”为单位；同名不同效果、同效果不同印刷都必须能区分。
 * 搜索覆盖简中名称、商品/印刷编号、类别与类型；结果顺序稳定（商品代码 +
 * 印刷编号数字序），保证测试与界面不会因数据顺序变化而抖动。
 */

export interface CatalogQuery {
  readonly text: string;
  /** 类别筛选 id；`all` 表示不筛选。 */
  readonly tagId: string;
  /** 只看四套预设卡组使用的印刷版本。 */
  readonly presetOnly: boolean;
}

export const ALL_TAG_ID = 'all';

export interface CatalogTag {
  readonly id: string;
  readonly labelZh: string;
  /** class = 宝可梦/训练家/能量；detail = 具体类别或进化阶段。 */
  readonly group: 'class' | 'detail';
}

/** 展示顺序固定；只有目录里真实存在的标签才会渲染。 */
export const CATALOG_TAGS: readonly CatalogTag[] = [
  { id: 'pokemon', labelZh: '宝可梦', group: 'class' },
  { id: 'trainer', labelZh: '训练家', group: 'class' },
  { id: 'energy', labelZh: '能量', group: 'class' },
  { id: '基础', labelZh: '基础', group: 'detail' },
  { id: '1阶进化', labelZh: '1阶进化', group: 'detail' },
  { id: '2阶进化', labelZh: '2阶进化', group: 'detail' },
  { id: 'V', labelZh: 'V', group: 'detail' },
  { id: 'VMAX', labelZh: 'VMAX', group: 'detail' },
  { id: 'VSTAR', labelZh: 'VSTAR', group: 'detail' },
  { id: 'ex', labelZh: 'ex', group: 'detail' },
  { id: '物品', labelZh: '物品', group: 'detail' },
  { id: '支援者', labelZh: '支援者', group: 'detail' },
  { id: '宝可梦道具', labelZh: '宝可梦道具', group: 'detail' },
  { id: '竞技场', labelZh: '竞技场', group: 'detail' },
  { id: '基本能量', labelZh: '基本能量', group: 'detail' },
  { id: '特殊能量', labelZh: '特殊能量', group: 'detail' },
];

/** NFKC 归一化（全角转半角等）、小写与空白折叠；中英文混排也能搜到。 */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** 单个条目的可搜索文本；检索时对整串做子串匹配。 */
export function buildCardHaystack(card: CatalogCard): string {
  return normalizeSearchText(
    [
      card.nameZh,
      card.print.printCode,
      card.print.number,
      card.print.total,
      card.print.displayNumber,
      `${card.print.printCode}${card.print.number}`,
      card.productCode,
      card.productNameZh,
      card.classLabelZh,
      card.categoryLabelZh,
      card.effectiveCategory ?? '',
      card.subtypes.join(' '),
      card.type ?? '',
      card.effectSummaryZh,
      card.mechanics.join(' '),
      card.identities.printIdentity,
      card.identities.effectIdentity,
      card.identities.nameGroupKey,
    ].join(' '),
  );
}

export function cardMatchesTag(card: CatalogCard, tagId: string): boolean {
  if (tagId === ALL_TAG_ID) {
    return true;
  }
  if (card.cardClass === tagId) {
    return true;
  }
  if (card.effectiveCategory === tagId) {
    return true;
  }
  return card.subtypes.includes(tagId);
}

/** 只保留目录中至少匹配一张卡的标签，避免界面出现永远为空的筛选项。 */
export function availableTags(cards: readonly CatalogCard[]): readonly CatalogTag[] {
  return CATALOG_TAGS.filter((tag) => cards.some((card) => cardMatchesTag(card, tag.id)));
}

function compareCards(left: CatalogCard, right: CatalogCard): number {
  const byCode = left.print.printCode.localeCompare(right.print.printCode);
  if (byCode !== 0) {
    return byCode;
  }
  const leftNumber = Number.parseInt(left.print.number, 10);
  const rightNumber = Number.parseInt(right.print.number, 10);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.print.number.localeCompare(right.print.number);
}

export function searchCards(cards: readonly CatalogCard[], query: CatalogQuery): readonly CatalogCard[] {
  const tokens = normalizeSearchText(query.text).split(' ').filter((token) => token.length > 0);
  return cards
    .filter((card) => {
      if (query.presetOnly && card.decks.length === 0) {
        return false;
      }
      if (!cardMatchesTag(card, query.tagId)) {
        return false;
      }
      if (tokens.length === 0) {
        return true;
      }
      const haystack = buildCardHaystack(card);
      return tokens.every((token) => haystack.includes(token));
    })
    .slice()
    .sort(compareCards);
}

export type IdentityRelation = 'unique' | 'same-name-different-effect' | 'same-effect-reprint';

/**
 * 与目录内其他条目的身份关系。
 *
 * - `same-name-different-effect`：同名组里存在不同效果身份 —— 不能按名字合并；
 * - `same-effect-reprint`：效果身份相同但印刷身份不同 —— 是重印，不是重复条目；
 * - `unique`：该证据集内没有同名异效果或同效果重印。
 */
export function identityRelation(card: CatalogCard, allCards: readonly CatalogCard[]): IdentityRelation {
  const others = allCards.filter((entry) => entry.id !== card.id);
  const sameNameDifferentEffect = others.some(
    (entry) =>
      entry.identities.nameGroupKey === card.identities.nameGroupKey &&
      entry.identities.effectIdentity !== card.identities.effectIdentity,
  );
  if (sameNameDifferentEffect) {
    return 'same-name-different-effect';
  }
  const sameEffectDifferentPrint = others.some(
    (entry) => entry.identities.effectIdentity === card.identities.effectIdentity,
  );
  if (sameEffectDifferentPrint) {
    return 'same-effect-reprint';
  }
  return 'unique';
}

export function identityRelationLabel(relation: IdentityRelation): string {
  switch (relation) {
    case 'same-name-different-effect':
      return '同名不同效果（未按名称合并）';
    case 'same-effect-reprint':
      return '同效果重印（印刷身份不同）';
    default:
      return '';
  }
}
