import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseServiceCatalog, type ServiceCatalog } from '@ptcg/protocol';
import type { CatalogFetchResult, CatalogSource } from '../src/catalog/source.ts';

const ARTIFACT_PATH = resolve(process.cwd(), '../../data/catalog/zh-cn-standard-2025-06-05-catalog.json');

/** 真实冻结目录（提交产物）+ 测试用的运行期覆盖。 */
export function catalogDocumentWithRuntime(
  mutate?: (document: Record<string, unknown>) => void,
): { readonly document: Record<string, unknown>; readonly catalog: ServiceCatalog } {
  const document = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Record<string, unknown>;
  document['runtime'] = {
    servedAt: '2026-09-20T00:00:00.000Z',
    resources: {},
    cardImages: {},
  };
  mutate?.(document);
  const catalog = parseServiceCatalog(document);
  if (catalog === null) {
    throw new Error('测试目录夹具无法解析');
  }
  return { document, catalog };
}

export interface FakeCatalogSource extends CatalogSource {
  failNext(message?: string): void;
  fetchCount(): number;
}

/** 可控目录数据源：按需注入下一次读取失败。 */
export function createFakeCatalogSource(
  build: () => { readonly document: unknown; readonly catalog: ServiceCatalog },
): FakeCatalogSource {
  let failures = 0;
  let failureMessage = '无法读取在线卡牌目录。';
  let fetches = 0;
  return {
    async fetchCatalog(): Promise<CatalogFetchResult> {
      fetches += 1;
      if (failures > 0) {
        failures -= 1;
        return { ok: false, kind: 'unreachable', message: failureMessage };
      }
      const { document, catalog } = build();
      return { ok: true, document, catalog };
    },
    resolveAssetUrl(path: string): string {
      return `https://service.test/${path}`;
    },
    failNext(message = '无法读取在线卡牌目录。') {
      failures += 1;
      failureMessage = message;
    },
    fetchCount() {
      return fetches;
    },
  };
}
