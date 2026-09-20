import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseServiceCatalog, type CatalogCard, type ServiceCatalog } from '@ptcg/protocol';
import {
  ALL_TAG_ID,
  availableTags,
  buildCardHaystack,
  cardMatchesTag,
  identityRelation,
  identityRelationLabel,
  normalizeSearchText,
  searchCards,
} from '../src/catalog/search.ts';

const ARTIFACT = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../data/catalog/zh-cn-standard-2025-06-05-catalog.json'), 'utf8'),
) as Record<string, unknown>;
const CATALOG = parseServiceCatalog(ARTIFACT) as ServiceCatalog;
const CARDS = CATALOG.content.cards;

function cardNamed(cards: readonly CatalogCard[], name: string): CatalogCard {
  const found = cards.find((card) => card.nameZh === name);
  if (found === undefined) {
    throw new Error(`missing card ${name}`);
  }
  return found;
}

function query(overrides: Partial<{ text: string; tagId: string; presetOnly: boolean }> = {}) {
  return { text: '', tagId: ALL_TAG_ID, presetOnly: false, ...overrides };
}

describe('搜索归一化', () => {
  it('NFKC 折叠全角与空白，大小写无关', () => {
    expect(normalizeSearchText('  ＣＳＶＥ１Ｃ\t0 3 5 ')).toBe('csve1c 0 3 5');
  });

  it('可搜索简中名称、印刷编号、商品与类别', () => {
    const gob = cardNamed(CARDS, '古剑豹ex');
    const haystack = buildCardHaystack(gob);
    expect(haystack).toContain('古剑豹ex');
    expect(haystack).toContain('csv3c');
    expect(haystack).toContain('043/130');
    expect(haystack).toContain('无畏太晶');
    expect(haystack).toContain('宝可梦');
  });
});

describe('目录检索', () => {
  it('按简中名称子串搜索', () => {
    const results = searchCards(CARDS, query({ text: '古剑豹' }));
    expect(results).toHaveLength(1);
    expect(results[0]?.nameZh).toBe('古剑豹ex');
  });

  it('按商品/卡牌编号搜索，支持部分数字与代码', () => {
    const byCode = searchCards(CARDS, query({ text: 'CSVE1C 143' }));
    expect(byCode.map((card) => card.id)).toEqual(['csve1-143']);
    const byNumber = searchCards(CARDS, query({ text: '143/177' }));
    expect(byNumber.map((card) => card.id)).toEqual(['csve1-143']);
    const byProductCode = searchCards(CARDS, query({ text: 'cbb2c' }));
    expect(byProductCode.map((card) => card.id).sort()).toEqual(['cbb2c-1002', 'cbb2c-1102']);
  });

  it('多个关键词按 AND 匹配', () => {
    const results = searchCards(CARDS, query({ text: '宝可梦 ex' }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((card) => card.nameZh.includes('ex'))).toBe(true);
  });

  it('按类别筛选：支援者只返回支援者', () => {
    const results = searchCards(CARDS, query({ tagId: '支援者' }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((card) => card.effectiveCategory === '支援者')).toBe(true);
  });

  it('标签只包含目录中真实存在的类别', () => {
    const tags = availableTags(CARDS);
    const ids = tags.map((tag) => tag.id);
    expect(ids).toContain('pokemon');
    expect(ids).toContain('trainer');
    expect(ids).toContain('energy');
    expect(ids).toContain('宝可梦道具');
    expect(ids).not.toContain('对不存在的类别');
  });

  it('只看预设卡组时结果都带卡组归属，数量为 28', () => {
    const results = searchCards(CARDS, query({ presetOnly: true }));
    expect(results).toHaveLength(28);
    expect(results.every((card) => card.decks.length > 0)).toBe(true);
  });

  it('空结果不抛错，可被界面识别', () => {
    expect(searchCards(CARDS, query({ text: '不存在的卡牌名xyz' }))).toHaveLength(0);
  });

  it('结果顺序稳定：按商品代码与编号数字序', () => {
    const results = searchCards(CARDS, query({ tagId: 'pokemon' }));
    const codes = results.map((card) => `${card.print.printCode}-${card.print.number}`);
    const sorted = [...codes].sort();
    expect(codes).toEqual(sorted);
  });
});

describe('身份关系区分', () => {
  it('当前证据集内无同名异效果或重印时显示 unique', () => {
    const card = cardNamed(CARDS, '古剑豹ex');
    expect(identityRelation(card, CARDS)).toBe('unique');
    expect(identityRelationLabel('unique')).toBe('');
  });

  it('同名不同效果必须识别为不同条目而不是合并', () => {
    const base = cardNamed(CARDS, '精灵球');
    const variant: CatalogCard = {
      ...base,
      id: 'variant-1',
      identities: { ...base.identities, effectIdentity: 'fx:trainer:精灵球:different0000' },
    };
    const withVariant = [...CARDS, variant];
    expect(identityRelation(base, withVariant)).toBe('same-name-different-effect');
    expect(identityRelation(variant, withVariant)).toBe('same-name-different-effect');
    expect(identityRelationLabel('same-name-different-effect')).toContain('同名不同效果');
    // 两条同名不同效果是不同印刷身份，检索结果不会去重成一条。
    const results = searchCards([base, variant], query({ text: '精灵球' }));
    expect(results).toHaveLength(2);
  });

  it('同效果不同印刷识别为重印', () => {
    const base = cardNamed(CARDS, '精灵球');
    const reprint: CatalogCard = {
      ...base,
      id: 'reprint-1',
      print: { ...base.print, printCode: 'CBB9C', number: '999' },
      identities: { ...base.identities, printIdentity: 'print:CBB9C:999' },
    };
    const withReprint = [...CARDS, reprint];
    expect(identityRelation(base, withReprint)).toBe('same-effect-reprint');
    expect(identityRelationLabel('same-effect-reprint')).toContain('重印');
  });

  it('类别标签匹配大类、实际类别与进化阶段', () => {
    const eevee = cardNamed(CARDS, '仙子伊布V');
    expect(cardMatchesTag(eevee, 'pokemon')).toBe(true);
    expect(cardMatchesTag(eevee, '基础')).toBe(true);
    expect(cardMatchesTag(eevee, 'V')).toBe(true);
    expect(cardMatchesTag(eevee, '支援者')).toBe(false);
  });
});
