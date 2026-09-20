import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  CATALOG_SCHEMA,
  computeCatalogVersion,
  isCardImageAvailable,
  isCatalogVersionValid,
  isResourceAvailable,
  parseCatalogContent,
  parseServiceCatalog,
  type ServiceCatalog,
} from '../src/catalog.ts';

const ARTIFACT_URL = new URL('../../../data/catalog/zh-cn-standard-2025-06-05-catalog.json', import.meta.url);

function readArtifact(): Record<string, unknown> {
  return JSON.parse(readFileSync(ARTIFACT_URL, 'utf8')) as Record<string, unknown>;
}

function cloneArtifact(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(readArtifact())) as Record<string, unknown>;
}

describe('规范 JSON 与目录版本', () => {
  it('对象键排序后哈希稳定，与键顺序无关', async () => {
    const first = { b: 1, a: [{ y: true, x: null }], c: '中' };
    const second = { c: '中', a: [{ x: null, y: true }], b: 1 };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(await computeCatalogVersion(first)).toBe(await computeCatalogVersion(second));
    expect(await computeCatalogVersion(first)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('数组顺序参与哈希', async () => {
    expect(await computeCatalogVersion([1, 2])).not.toBe(await computeCatalogVersion([2, 1]));
  });

  it('版本一致性校验：完整内容为真，内容被改或版本陈旧为假', async () => {
    const catalog = parseServiceCatalog(readArtifact()) as ServiceCatalog;
    expect(await isCatalogVersionValid(catalog)).toBe(true);

    expect(
      await isCatalogVersionValid({
        content: { ...catalog.content, generatedBy: 'tampered' },
        catalogVersion: catalog.catalogVersion,
      }),
    ).toBe(false);
    expect(
      await isCatalogVersionValid({
        content: catalog.content,
        catalogVersion: 'f'.repeat(64),
      }),
    ).toBe(false);
  });

  it('无法规范化的内容不得因校验异常而放行', async () => {
    expect(await isCatalogVersionValid({ content: undefined, catalogVersion: 'f'.repeat(64) })).toBe(false);
  });
});

describe('冻结目录产物', () => {
  it('产物可解析且 catalogVersion 可由内容重算', async () => {
    const artifact = readArtifact();
    const parsed = parseServiceCatalog(artifact);
    expect(parsed).not.toBeNull();
    const catalog = parsed as ServiceCatalog;
    expect(catalog.content.schema).toBe(CATALOG_SCHEMA);
    expect(catalog.content.cards).toHaveLength(47);
    expect(catalog.content.decks).toHaveLength(4);
    expect(catalog.content.resources).toHaveLength(1);
    expect(await computeCatalogVersion(catalog.content)).toBe(catalog.catalogVersion);
  });

  it('每个条目都有中文名称、完整文字与三个身份引用', () => {
    const catalog = parseServiceCatalog(readArtifact()) as ServiceCatalog;
    for (const card of catalog.content.cards) {
      expect(card.nameZh.length).toBeGreaterThan(0);
      expect(card.fullTextZh.length).toBeGreaterThan(0);
      expect(card.identities.effectIdentity).toMatch(/^fx:/u);
      expect(card.identities.printIdentity).toContain(card.print.printCode);
      expect(card.identities.nameGroupKey).toMatch(/^name:/u);
      expect(card.print.displayNumber).toContain(card.print.printCode);
    }
  });

  it('环境合法、效果支持、图片来源三者独立', () => {
    const catalog = parseServiceCatalog(readArtifact()) as ServiceCatalog;
    let supported = 0;
    for (const card of catalog.content.cards) {
      expect(card.flags.environmentLegal).toBe(true);
      // T10 / #11 与 T11 / #12 只接入逐张验证的效果；未接入的卡不得被标为可对战。
      if (card.flags.effectSupported) {
        supported += 1;
        expect(['pokemon', 'trainer', 'energy']).toContain(card.cardClass);
      }
      expect(catalog.content.supportPolicy.playable).toBe(false);
      expect(card.imageSource?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(supported).toBe(22);
    expect(catalog.content.supportPolicy.engineIntegration).toBe('integrated');
  });

  it('同名分组与印刷身份不混为一谈', () => {
    const catalog = parseServiceCatalog(readArtifact()) as ServiceCatalog;
    const byNameGroup = new Map<string, Set<string>>();
    for (const card of catalog.content.cards) {
      const variants = byNameGroup.get(card.identities.nameGroupKey) ?? new Set<string>();
      variants.add(card.identities.effectIdentity);
      byNameGroup.set(card.identities.nameGroupKey, variants);
    }
    // 每个同名组目前只有一个效果身份；若未来出现同名异效果，身份集合会大于 1，
    // 该数据结构仍能区分，而不是按名称合并。
    for (const variants of byNameGroup.values()) {
      expect(variants.size).toBeGreaterThanOrEqual(1);
    }
    const printIds = new Set(catalog.content.cards.map((card) => card.identities.printIdentity));
    expect(printIds.size).toBe(catalog.content.cards.length);
  });

  it('资料修订绑定源文件哈希', () => {
    const catalog = parseServiceCatalog(readArtifact()) as ServiceCatalog;
    expect(catalog.content.dataRevision.environment).toBe(catalog.content.environment.id);
    expect(catalog.content.dataRevision.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(catalog.content.dataRevision.sourceFiles.length).toBeGreaterThanOrEqual(7);
    for (const file of catalog.content.dataRevision.sourceFiles) {
      expect(file.path.startsWith('data/')).toBe(true);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('产物不携带本机路径或私有输入痕迹', () => {
    const serialized = JSON.stringify(readArtifact());
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/u);
    expect(serialized).not.toContain('.scratch');
    expect(serialized).not.toContain('Z:');
    expect(serialized).not.toContain('auth_key');
  });
});

describe('目录解析失败保护', () => {
  it('缺失或错误的 schema 直接拒绝', () => {
    const artifact = cloneArtifact();
    artifact['schema'] = 'ptcg.other/v9';
    expect(parseServiceCatalog(artifact)).toBeNull();
  });

  it('非法 catalogVersion 直接拒绝', () => {
    const artifact = cloneArtifact();
    artifact['catalogVersion'] = 'not-a-hash';
    expect(parseServiceCatalog(artifact)).toBeNull();
  });

  it('条目缺字段时整份拒绝，不返回半份目录', () => {
    const artifact = cloneArtifact();
    const cards = artifact['cards'] as Array<Record<string, unknown>>;
    cards[0] = { ...(cards[0] as Record<string, unknown>) };
    delete cards[0]!['fullTextZh'];
    expect(parseServiceCatalog(artifact)).toBeNull();
  });

  it('重复条目 id 会被内容校验挡下', () => {
    const artifact = cloneArtifact();
    const cards = artifact['cards'] as Array<Record<string, unknown>>;
    (cards[0] as Record<string, unknown>)['id'] = (cards[1] as Record<string, unknown>)['id'];
    expect(parseCatalogContent(artifact)).toBeNull();
  });
});

describe('运行期覆盖', () => {
  it('解析资源与卡图可用状态', () => {
    const artifact = cloneArtifact();
    artifact['runtime'] = {
      servedAt: '2026-09-20T00:00:00.000Z',
      resources: {
        'asar-sample-sv1-en-170': {
          available: true,
          path: 'catalog/resources/asar-sample-sv1-en-170',
          sha256: 'a'.repeat(64),
          labelZh: '样本',
          provenanceZh: '测试',
        },
      },
      cardImages: {
        'csve1-063': {
          available: true,
          path: 'catalog/card-images/csve1-063',
          sha256: 'b'.repeat(64),
          labelZh: '官方图',
          provenanceZh: '测试',
        },
      },
    };
    const catalog = parseServiceCatalog(artifact) as ServiceCatalog;
    expect(catalog.runtime.resources['asar-sample-sv1-en-170']?.available).toBe(true);
    expect(isResourceAvailable(catalog, 'asar-sample-sv1-en-170')).toBe(true);
    expect(isResourceAvailable(catalog, 'missing')).toBe(false);
    expect(isCardImageAvailable(catalog, 'csve1-063')).toBe(true);
    expect(isCardImageAvailable(catalog, 'csve1-062')).toBe(false);
  });

  it('runtime 结构错误时整份拒绝', () => {
    const artifact = cloneArtifact();
    artifact['runtime'] = { servedAt: 1, resources: {}, cardImages: {} };
    expect(parseServiceCatalog(artifact)).toBeNull();
  });
});
