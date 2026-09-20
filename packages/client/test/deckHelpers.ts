import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeCatalogVersion,
  parseServiceCatalog,
  presetDeckDocument,
  type DeckDocument,
  type ServiceCatalog,
} from '@ptcg/protocol';

const ARTIFACT_PATH = resolve(process.cwd(), '../../data/catalog/zh-cn-standard-2025-06-05-catalog.json');

function readArtifact(): Record<string, unknown> {
  return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Record<string, unknown>;
}

export function realCatalog(): ServiceCatalog {
  const document = readArtifact();
  document['runtime'] = { servedAt: '2026-09-20T00:00:00.000Z', resources: {}, cardImages: {} };
  const catalog = parseServiceCatalog(document);
  if (catalog === null) {
    throw new Error('测试目录夹具无法解析');
  }
  return catalog;
}

/**
 * 全部效果标记为已支持、目录声明可对战的变体；用于验证“正式就绪”界面路径。
 * 重新计算内容哈希，保证缓存写入同样通过版本校验。
 */
export async function supportedCatalog(): Promise<{ readonly document: Record<string, unknown>; readonly catalog: ServiceCatalog }> {
  const document = readArtifact();
  document['supportPolicy'] = { engineIntegration: 'integrated', playable: true, noteZh: '测试：所有效果均标记为已支持' };
  const cards = document['cards'] as Array<Record<string, unknown>>;
  for (const card of cards) {
    (card['flags'] as Record<string, unknown>)['effectSupported'] = true;
  }
  const { catalogVersion: _declared, ...content } = document;
  document['catalogVersion'] = await computeCatalogVersion(content);
  document['runtime'] = { servedAt: '2026-09-20T00:00:00.000Z', resources: {}, cardImages: {} };
  const catalog = parseServiceCatalog(document);
  if (catalog === null) {
    throw new Error('测试用已支持目录无法解析');
  }
  return { document, catalog };
}

export function deckDocumentOf(code: string, catalog: ServiceCatalog): DeckDocument {
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
