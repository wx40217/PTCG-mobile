import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DECK_FORMAT_VERSION,
  DECK_TEXT_HEADER,
  deckCardTotal,
  exportDeckText,
  importDeckText,
  parseDeckDocument,
  parseDeckValidationResponse,
  presetDeckDocument,
  validateDeck,
  type CatalogCard,
  type CatalogContent,
  type DeckCardEntry,
  type DeckDocument,
  type ServiceCatalog,
} from '../src/index.ts';
import { parseServiceCatalog } from '../src/catalog.ts';

const ARTIFACT_URL = new URL('../../../data/catalog/zh-cn-standard-2025-06-05-catalog.json', import.meta.url);

function realCatalog(): ServiceCatalog {
  const parsed = parseServiceCatalog(JSON.parse(readFileSync(ARTIFACT_URL, 'utf8')));
  if (parsed === null) {
    throw new Error('测试用真实目录无法解析');
  }
  return parsed;
}

function cloneContent(catalog: ServiceCatalog): CatalogContent {
  return JSON.parse(JSON.stringify(catalog.content)) as CatalogContent;
}

function cloneCard(base: CatalogCard, overrides: Partial<CatalogCard> & { identities?: Partial<CatalogCard['identities']>; flags?: Partial<CatalogCard['flags']> }): CatalogCard {
  return {
    ...base,
    ...overrides,
    identities: { ...base.identities, ...(overrides.identities ?? {}) },
    flags: { ...base.flags, ...(overrides.flags ?? {}) },
    subtypes: overrides.subtypes ?? base.subtypes,
  };
}

function view(content: CatalogContent, catalogVersion = 'test-version') {
  return { content, catalogVersion };
}

function presetDocument(catalog: ServiceCatalog, code: string): DeckDocument {
  const preset = catalog.content.decks.find((deck) => deck.code === code);
  if (preset === undefined) {
    throw new Error(`缺少预设卡组 ${code}`);
  }
  const document = presetDeckDocument(preset, catalog.content);
  if (document === null) {
    throw new Error(`预设卡组 ${code} 无法转换`);
  }
  return document;
}

function energyEntry(catalog: ServiceCatalog, count: number): DeckCardEntry {
  const energy = catalog.content.cards.find((card) => card.effectiveCategory === '基本能量');
  if (energy === undefined) {
    throw new Error('目录中缺少基本能量');
  }
  return {
    cardId: energy.id,
    printIdentity: energy.identities.printIdentity,
    effectIdentity: energy.identities.effectIdentity,
    count,
  };
}

function problemCodes(document: DeckDocument, content: CatalogContent): readonly string[] {
  return validateDeck(document, view(content)).problems.map((problem) => problem.code);
}

describe('卡组文档结构解析', () => {
  it('接受合法文档并保留身份字段；允许空卡牌列表（编辑中的草稿）', () => {
    const parsed = parseDeckDocument({
      formatVersion: DECK_FORMAT_VERSION,
      environmentId: 'zh-cn-standard-2025-06-05',
      cards: [{ cardId: 'a', printIdentity: 'print:A:1', effectIdentity: 'fx:a', count: 4 }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.deck.cards).toEqual([{ cardId: 'a', printIdentity: 'print:A:1', effectIdentity: 'fx:a', count: 4 }]);
    }
    expect(parseDeckDocument({ formatVersion: 1, environmentId: 'e', cards: [] }).ok).toBe(true);
  });

  it('拒绝错误版本、缺失身份与非整数数量，并给出字段级说明', () => {
    const parsed = parseDeckDocument({
      formatVersion: 2,
      environmentId: '',
      cards: [
        { cardId: '', printIdentity: '', effectIdentity: '', count: 0 },
        { cardId: 'a', printIdentity: 'print:A', effectIdentity: 'fx:a', count: 1.5 },
        'nope',
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join('\n')).toMatch(/格式版本/u);
      expect(parsed.errors.join('\n')).toMatch(/环境标识/u);
      expect(parsed.errors.join('\n')).toMatch(/数量/u);
      expect(parsed.errors.join('\n')).toMatch(/卡牌必须是对象/u);
    }
  });
});

describe('合法性与就绪校验（真实冻结目录）', () => {
  const catalog = realCatalog();

  it('四套预设都是 60 张、规则合法，但因效果未接入一律不就绪', () => {
    for (const preset of catalog.content.decks) {
      const result = validateDeck(presetDocument(catalog, preset.code), view(catalog.content, catalog.catalogVersion));
      expect(result.totalCards).toBe(60);
      expect(result.legal).toBe(true);
      expect(result.ready).toBe(false);
      expect(result.problems.every((problem) => problem.kind === 'readiness')).toBe(true);
      const unsupported = result.problems.find((problem) => problem.code === 'effect-unsupported');
      expect(unsupported).toBeDefined();
      expect(unsupported!.cardIds.length).toBeGreaterThan(0);
      expect(result.catalogVersion).toBe(catalog.catalogVersion);
      expect(result.dataRevision).toBe(catalog.content.dataRevision.sourceDigest);
    }
  });

  it('预设复制走同一校验：把预设身份当作“已就绪”也不能通过', () => {
    const document = presetDocument(catalog, 'A');
    // 伪造一个额外字段不能改变服务端结果。
    const forged = { ...document, legal: true, ready: true } as unknown as DeckDocument;
    const result = validateDeck(forged, view(catalog.content, catalog.catalogVersion));
    expect(result.legal).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.problems.some((problem) => problem.code === 'effect-unsupported')).toBe(true);
  });

  it('所有卡牌效果已接入且目录声明可对战时才就绪', () => {
    const content = cloneContent(catalog);
    const supported: CatalogContent = {
      ...content,
      supportPolicy: { engineIntegration: 'integrated', playable: true, noteZh: '测试：效果全部接入' },
      cards: content.cards.map((card) => ({ ...card, flags: { ...card.flags, effectSupported: true } })),
    };
    const result = validateDeck(presetDocument(catalog, 'A'), view(supported));
    expect(result.legal).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('59 张与 61 张都报精确张数', () => {
    const base = presetDocument(catalog, 'A');
    const energy = base.cards.find((entry) => entry.cardId === 'cbb2c-1102');
    expect(energy).toBeDefined();
    const short = {
      ...base,
      cards: base.cards.map((entry) => (entry === energy ? { ...entry, count: entry.count - 1 } : entry)),
    };
    const long = {
      ...base,
      cards: base.cards.map((entry) => (entry === energy ? { ...entry, count: entry.count + 1 } : entry)),
    };
    const shortResult = validateDeck(short, view(catalog.content, catalog.catalogVersion));
    const longResult = validateDeck(long, view(catalog.content, catalog.catalogVersion));
    expect(shortResult.totalCards).toBe(59);
    expect(shortResult.problems.find((problem) => problem.code === 'deck-size')?.message).toContain('59');
    expect(longResult.totalCards).toBe(61);
    expect(longResult.problems.find((problem) => problem.code === 'deck-size')?.message).toContain('61');
  });

  it('没有基础宝可梦时给出专门错误', () => {
    const trainerNames = [
      '精灵球',
      '超级球',
      '高级球',
      '等级球',
      '鼓励信',
      '勇气护符',
      '坚硬束带',
      '莎莉娜',
      '莉佳的邀请',
      '藤树',
      '珠贝',
      '营火专家',
      '捩木',
      '深钵镇',
      '熔岩瀑布之渊',
    ];
    const cards: DeckCardEntry[] = trainerNames.map((name) => {
      const card = catalog.content.cards.find((candidate) => candidate.nameZh === name);
      if (card === undefined) {
        throw new Error(`缺少卡牌 ${name}`);
      }
      return {
        cardId: card.id,
        printIdentity: card.identities.printIdentity,
        effectIdentity: card.identities.effectIdentity,
        count: 4,
      };
    });
    const document: DeckDocument = { formatVersion: DECK_FORMAT_VERSION, environmentId: catalog.content.environment.id, cards };
    const result = validateDeck(document, view(catalog.content, catalog.catalogVersion));
    expect(result.totalCards).toBe(60);
    expect(result.problems.some((problem) => problem.code === 'no-basic-pokemon')).toBe(true);
    expect(result.problems.some((problem) => problem.code === 'name-limit')).toBe(false);
  });

  it('同名异画合计超过 4 张也被拒绝，并列出涉及的印刷身份', () => {
    const content = cloneContent(catalog);
    const mew = content.cards.find((card) => card.id === 'csve1-056');
    expect(mew).toBeDefined();
    const alt = cloneCard(mew!, {
      id: 'alt-mew-ex',
      print: { ...mew!.print, displayNumber: 'ALT 001/100' },
      identities: { printIdentity: 'print:ALT:001/100', effectIdentity: 'fx:pokemon:梦幻ex:alt0000000000' },
    });
    content.cards.push(alt);

    const base = presetDocument(catalog, 'A');
    const energy = base.cards.find((entry) => entry.cardId === 'cbb2c-1102')!;
    const document: DeckDocument = {
      ...base,
      cards: [
        ...base.cards.map((entry) => (entry === energy ? { ...entry, count: entry.count - 3 } : entry)),
        { cardId: alt.id, printIdentity: alt.identities.printIdentity, effectIdentity: alt.identities.effectIdentity, count: 3 },
      ],
    };
    const result = validateDeck(document, view(content));
    expect(result.totalCards).toBe(60);
    const nameProblem = result.problems.find((problem) => problem.code === 'name-limit');
    expect(nameProblem).toBeDefined();
    expect(nameProblem!.message).toContain('同名卡共 5 张');
    expect(nameProblem!.cardIds).toEqual(['alt-mew-ex', 'csve1-056']);
  });

  it('基本能量不受同名上限约束', () => {
    const document = presetDocument(catalog, 'A');
    const result = validateDeck(document, view(catalog.content, catalog.catalogVersion));
    expect(result.problems.some((problem) => problem.code === 'name-limit')).toBe(false);
  });

  it('棱镜之星同名最多 1 张、王牌与光辉整副最多 1 张', () => {
    const content = cloneContent(catalog);
    const mew = content.cards.find((card) => card.id === 'csve1-056')!;
    content.cards.push(
      cloneCard(mew, {
        id: 'test-prism',
        nameZh: '测试棱镜',
        subtypes: ['基础', '棱镜之星'],
        identities: { printIdentity: 'print:TEST:prism', effectIdentity: 'fx:pokemon:测试棱镜:1', nameGroupKey: 'name:测试棱镜' },
      }),
      cloneCard(mew, {
        id: 'test-ace-1',
        nameZh: '测试王牌甲',
        subtypes: ['基础', 'ACE SPEC', 'ex'],
        identities: { printIdentity: 'print:TEST:ace1', effectIdentity: 'fx:pokemon:测试王牌甲:1', nameGroupKey: 'name:测试王牌甲' },
      }),
      cloneCard(mew, {
        id: 'test-ace-2',
        nameZh: '测试王牌乙',
        subtypes: ['基础', 'ACE SPEC', 'ex'],
        identities: { printIdentity: 'print:TEST:ace2', effectIdentity: 'fx:pokemon:测试王牌乙:1', nameGroupKey: 'name:测试王牌乙' },
      }),
      cloneCard(mew, {
        id: 'test-radiant-1',
        nameZh: '测试光辉甲',
        subtypes: ['基础', '光辉'],
        identities: { printIdentity: 'print:TEST:r1', effectIdentity: 'fx:pokemon:测试光辉甲:1', nameGroupKey: 'name:测试光辉甲' },
      }),
      cloneCard(mew, {
        id: 'test-radiant-2',
        nameZh: '测试光辉乙',
        subtypes: ['基础', '光辉'],
        identities: { printIdentity: 'print:TEST:r2', effectIdentity: 'fx:pokemon:测试光辉乙:1', nameGroupKey: 'name:测试光辉乙' },
      }),
    );
    const energy = content.cards.find((card) => card.effectiveCategory === '基本能量')!;
    const entryOf = (card: CatalogCard, count: number): DeckCardEntry => ({
      cardId: card.id,
      printIdentity: card.identities.printIdentity,
      effectIdentity: card.identities.effectIdentity,
      count,
    });
    const environmentId = content.environment.id;
    const make = (entries: DeckCardEntry[]): DeckDocument => ({
      formatVersion: DECK_FORMAT_VERSION,
      environmentId,
      cards: [...entries, entryOf(energy, 60 - entries.reduce((sum, entry) => sum + entry.count, 0))],
    });

    expect(
      problemCodes(make([entryOf(content.cards.find((card) => card.id === 'test-prism')!, 2)]), content),
    ).toContain('special-limit');
    expect(
      problemCodes(
        make([
          entryOf(content.cards.find((card) => card.id === 'test-ace-1')!, 1),
          entryOf(content.cards.find((card) => card.id === 'test-ace-2')!, 1),
        ]),
        content,
      ),
    ).toContain('special-limit');
    expect(
      problemCodes(
        make([
          entryOf(content.cards.find((card) => card.id === 'test-radiant-1')!, 1),
          entryOf(content.cards.find((card) => card.id === 'test-radiant-2')!, 1),
        ]),
        content,
      ),
    ).toContain('special-limit');
  });

  it('旧环境、未知编号与身份不符分别给出精确问题', () => {
    const base = presetDocument(catalog, 'A');
    const oldEnvironment: DeckDocument = { ...base, environmentId: 'zh-cn-standard-2020-01-01' };
    expect(problemCodes(oldEnvironment, catalog.content)).toContain('environment-mismatch');

    const unknown: DeckDocument = {
      ...base,
      cards: base.cards.map((entry, index) => (index === 0 ? { ...entry, cardId: 'nope-999' } : entry)),
    };
    const unknownResult = validateDeck(unknown, view(catalog.content));
    expect(unknownResult.problems.find((problem) => problem.code === 'unknown-card')?.cardIds).toContain('nope-999');

    const mismatched: DeckDocument = {
      ...base,
      cards: base.cards.map((entry, index) => (index === 0 ? { ...entry, printIdentity: 'print:OTHER:000' } : entry)),
    };
    expect(problemCodes(mismatched, catalog.content)).toContain('identity-mismatch');
  });

  it('缺少进化前置不构成构筑非法：卡组仍有基础宝可梦时保持规则合法', () => {
    const base = presetDocument(catalog, 'A');
    const vmax = base.cards.find((entry) => entry.cardId === 'csve1-063')!;
    const preEvolution = base.cards.find((entry) => entry.cardId === 'csve1-062')!;
    const energy = base.cards.find((entry) => entry.cardId === 'cbb2c-1102')!;
    const document: DeckDocument = {
      ...base,
      cards: base.cards
        .filter((entry) => entry !== preEvolution)
        .map((entry) => (entry === energy ? { ...entry, count: entry.count + preEvolution.count } : entry)),
    };
    const result = validateDeck(document, view(catalog.content, catalog.catalogVersion));
    expect(vmax).toBeDefined();
    expect(document.cards.some((entry) => entry.cardId === vmax.cardId)).toBe(true);
    expect(result.totalCards).toBe(60);
    expect(result.problems.some((problem) => problem.kind === 'legality')).toBe(false);
    expect(result.legal).toBe(true);
    expect(result.ready).toBe(false);
  });

  it('环境外的卡牌被明确标出', () => {
    const content = cloneContent(catalog);
    const mew = content.cards.find((card) => card.id === 'csve1-056')!;
    content.cards.push(
      cloneCard(mew, {
        id: 'test-rotated',
        nameZh: '测试退环境卡',
        flags: { environmentLegal: false, legalityNoteZh: '测试用退环境' },
        identities: { printIdentity: 'print:TEST:rot', effectIdentity: 'fx:pokemon:测试退环境卡:1', nameGroupKey: 'name:测试退环境卡' },
      }),
    );
    const rotated = content.cards.find((card) => card.id === 'test-rotated')!;
    const energy = content.cards.find((card) => card.effectiveCategory === '基本能量')!;
    const document: DeckDocument = {
      formatVersion: DECK_FORMAT_VERSION,
      environmentId: content.environment.id,
      cards: [
        { cardId: rotated.id, printIdentity: rotated.identities.printIdentity, effectIdentity: rotated.identities.effectIdentity, count: 4 },
        {
          cardId: energy.id,
          printIdentity: energy.identities.printIdentity,
          effectIdentity: energy.identities.effectIdentity,
          count: 56,
        },
      ],
    };
    expect(problemCodes(document, content)).toContain('environment-illegal');
  });
});

describe('版本化文本导入导出', () => {
  const catalog = realCatalog();

  it('往返保持构筑、环境与精确身份', () => {
    const document = presetDocument(catalog, 'B');
    const text = exportDeckText(document, catalog);
    expect(text.startsWith(`${DECK_TEXT_HEADER}/${DECK_FORMAT_VERSION}`)).toBe(true);
    expect(text).toContain(`ENV ${catalog.content.environment.id}`);
    const garchomp = document.cards[0]!;
    expect(text).toContain(`${garchomp.count} ${garchomp.cardId} ${garchomp.printIdentity} ${garchomp.effectIdentity}`);

    const imported = importDeckText(text, view(catalog.content, catalog.catalogVersion));
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.deck).toEqual(document);
      expect(deckCardTotal(imported.deck)).toBe(60);
    }
  });

  it('全部 47 张真实卡牌逐张导出后都能原样导入，含空格的规则身份不被空格列数误判', () => {
    const document: DeckDocument = {
      formatVersion: DECK_FORMAT_VERSION,
      environmentId: catalog.content.environment.id,
      cards: catalog.content.cards.map((card) => ({
        cardId: card.id,
        printIdentity: card.identities.printIdentity,
        effectIdentity: card.identities.effectIdentity,
        count: 1,
      })),
    };
    const text = exportDeckText(document, catalog);
    // 真实卡牌「一击卷轴 愤怒之卷」的效果身份含空格，规范导出必须转义成单个令牌。
    expect(text).toContain('print:CSVE1C:127 fx:trainer:一击卷轴\\s愤怒之卷:32657d07d913');
    const imported = importDeckText(text, view(catalog.content, catalog.catalogVersion));
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.deck).toEqual(document);
      expect(imported.deck.cards).toHaveLength(47);
    }
  });

  it('导入仍接受旧式未转义写法，并按 print:/fx: 标记保留含空格的效果身份', () => {
    const legacy = `${DECK_TEXT_HEADER}/1\nENV ${catalog.content.environment.id}\n1 csve1-127 print:CSVE1C:127 fx:trainer:一击卷轴 愤怒之卷:32657d07d913`;
    const imported = importDeckText(legacy, view(catalog.content, catalog.catalogVersion));
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.deck.cards).toEqual([
        {
          cardId: 'csve1-127',
          printIdentity: 'print:CSVE1C:127',
          effectIdentity: 'fx:trainer:一击卷轴 愤怒之卷:32657d07d913',
          count: 1,
        },
      ]);
    }

    const legacyByName = importDeckText(
      `${DECK_TEXT_HEADER}/1\nENV ${catalog.content.environment.id}\n1 一击卷轴 愤怒之卷`,
      view(catalog.content, catalog.catalogVersion),
    );
    expect(legacyByName.ok).toBe(true);
    if (legacyByName.ok) {
      expect(legacyByName.deck.cards[0]!.cardId).toBe('csve1-127');
    }
  });

  it('重复行的数量合并超过单条目上限时整体失败，不静默截断', () => {
    const energy = catalog.content.cards.find((card) => card.effectiveCategory === '基本能量')!;
    const line = `60 ${energy.id} ${energy.identities.printIdentity} ${energy.identities.effectIdentity}`;
    const repeated = `${DECK_TEXT_HEADER}/1\nENV ${catalog.content.environment.id}\n${line}\n${line}`;
    const imported = importDeckText(repeated, view(catalog.content, catalog.catalogVersion));
    expect(imported.ok).toBe(false);
    if (!imported.ok) {
      const overflow = imported.issues.find((issue) => issue.code === 'invalid-count');
      expect(overflow).toBeDefined();
      expect(overflow!.message).toContain('120');
    }

    const withinCapacity = importDeckText(
      `${DECK_TEXT_HEADER}/1\nENV ${catalog.content.environment.id}\n40 ${energy.id} ${energy.identities.printIdentity} ${energy.identities.effectIdentity}\n40 ${energy.id} ${energy.identities.printIdentity} ${energy.identities.effectIdentity}`,
      view(catalog.content, catalog.catalogVersion),
    );
    expect(withinCapacity.ok).toBe(true);
    if (withinCapacity.ok) {
      expect(withinCapacity.deck.cards[0]!.count).toBe(80);
    }
  });

  it('简化行支持唯一卡名与卡牌编号；同名不同效果时要求精确编号', () => {
    const byName = importDeckText(`${DECK_TEXT_HEADER}/1\nENV ${catalog.content.environment.id}\n2 古剑豹ex`, view(catalog.content));
    expect(byName.ok).toBe(true);
    if (byName.ok) {
      expect(byName.deck.cards).toEqual([
        {
          cardId: 'csv3c-043',
          printIdentity: 'print:CSV3C:043/130',
          effectIdentity: 'fx:pokemon:古剑豹ex:47bdd73235a0',
          count: 2,
        },
      ]);
    }

    const content = cloneContent(catalog);
    const mew = content.cards.find((card) => card.id === 'csve1-056')!;
    content.cards.push(
      cloneCard(mew, {
        id: 'alt-mew',
        identities: { printIdentity: 'print:ALT:056', effectIdentity: 'fx:pokemon:梦幻ex:alt', nameGroupKey: mew.identities.nameGroupKey },
      }),
    );
    const ambiguous = importDeckText(`${DECK_TEXT_HEADER}/1\nENV ${content.environment.id}\n2 梦幻ex`, view(content));
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.issues[0]).toMatchObject({ code: 'ambiguous-card', line: 3 });
    }
  });

  it('空白、缺版本、旧版本、缺环境、未知编号、身份不符与旧环境都明确报错', () => {
    expect(importDeckText('   \n', view(catalog.content))).toMatchObject({
      ok: false,
      issues: [{ code: 'empty' }],
    });
    const missingHeader = importDeckText('4 csve1-062 print:CSVE1C:062 fx:x', view(catalog.content));
    expect(missingHeader.ok).toBe(false);
    if (!missingHeader.ok) {
      expect(missingHeader.issues[0]!.code).toBe('malformed');
      expect(missingHeader.issues[0]!.message).toContain('缺少格式版本行');
    }
    const oldVersion = importDeckText(`${DECK_TEXT_HEADER}/0\nENV ${catalog.content.environment.id}\n4 csve1-062 print:CSVE1C:062 fx:pokemon:仙子伊布V:82add47b1578`, view(catalog.content));
    expect(oldVersion.ok).toBe(false);
    if (!oldVersion.ok) {
      expect(oldVersion.issues[0]!.code).toBe('format-version');
    }
    const missingEnvironment = importDeckText(`${DECK_TEXT_HEADER}/1\n4 csve1-062`, view(catalog.content));
    expect(missingEnvironment.ok).toBe(false);
    if (!missingEnvironment.ok) {
      expect(missingEnvironment.issues.some((issue) => issue.message.includes('环境标识之前'))).toBe(true);
    }
    const unknown = importDeckText(`${DECK_TEXT_HEADER}/1\nENV ${catalog.content.environment.id}\n4 nope-999`, view(catalog.content));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.issues[0]!.code).toBe('unknown-card');
    }
    const mismatched = importDeckText(
      `${DECK_TEXT_HEADER}/1\nENV ${catalog.content.environment.id}\n4 csve1-062 print:OTHER:000 fx:pokemon:仙子伊布V:82add47b1578`,
      view(catalog.content),
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.issues[0]!.code).toBe('identity-mismatch');
    }
    const oldEnvironment = importDeckText(`${DECK_TEXT_HEADER}/1\nENV zh-cn-standard-2020-01-01\n4 csve1-062`, view(catalog.content));
    expect(oldEnvironment.ok).toBe(false);
    if (!oldEnvironment.ok) {
      expect(oldEnvironment.issues[0]!.code).toBe('environment-mismatch');
    }
  });

  it('导出文本对未知编号不崩溃，导入按行给出错误', () => {
    const document: DeckDocument = {
      formatVersion: DECK_FORMAT_VERSION,
      environmentId: catalog.content.environment.id,
      cards: [{ cardId: 'ghost', printIdentity: 'print:g', effectIdentity: 'fx:g', count: 1 }],
    };
    const text = exportDeckText(document, catalog);
    expect(text).toContain('1 ghost print:g fx:g');
    const imported = importDeckText(text, view(catalog.content));
    expect(imported.ok).toBe(false);
  });
});

describe('服务端校验响应解析', () => {
  const catalog = realCatalog();

  it('合法响应可往返解析；缺字段或错误 kind 返回 null', () => {
    const response = validateDeck(presetDocument(catalog, 'C'), view(catalog.content, catalog.catalogVersion));
    const parsed = parseDeckValidationResponse(JSON.parse(JSON.stringify(response)));
    expect(parsed).toEqual(response);
    expect(parseDeckValidationResponse({ ...response, problems: [{ code: 'x', kind: 'nope', message: 'm', cardIds: [] }] })).toBeNull();
    expect(parseDeckValidationResponse({ ...response, legal: 'yes' })).toBeNull();
    expect(parseDeckValidationResponse(null)).toBeNull();
  });
});
