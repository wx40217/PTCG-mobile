import {
  CATALOG_PATH,
  joinPath,
  parseServiceAddress,
  parseServiceCatalog,
  type ServiceAddressPolicy,
  type ServiceCatalog,
} from '@ptcg/protocol';

/**
 * 在线目录数据源。
 *
 * 地址解析与连接设置共用同一策略（发布配置拒绝明文）；目录响应必须能通过
 * `parseServiceCatalog` 全量校验，否则视为读取失败并保留已有缓存。
 */

export interface CatalogSourceInput {
  readonly serviceAddress: string;
  readonly policy: ServiceAddressPolicy;
  readonly timeoutMs?: number;
}

export type CatalogFailureKind = 'invalid-address' | 'unreachable' | 'http' | 'invalid-payload';

export type CatalogFetchResult =
  | { readonly ok: true; readonly document: unknown; readonly catalog: ServiceCatalog }
  | { readonly ok: false; readonly kind: CatalogFailureKind; readonly message: string };

export interface CatalogSource {
  fetchCatalog(signal?: AbortSignal): Promise<CatalogFetchResult>;
  /** 把运行期相对路径解析为服务上的绝对 URL；地址无效时返回空串。 */
  resolveAssetUrl(path: string): string;
}

const DEFAULT_TIMEOUT_MS = 12_000;

export function createHttpCatalogSource(input: CatalogSourceInput): CatalogSource {
  const address = parseServiceAddress(input.serviceAddress, input.policy);
  if (!address.ok) {
    return {
      async fetchCatalog() {
        return { ok: false, kind: 'invalid-address', message: address.message };
      },
      resolveAssetUrl: () => '',
    };
  }
  const url = joinPath(address.httpUrl, CATALOG_PATH).toString();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetchCatalog(externalSignal?: AbortSignal): Promise<CatalogFetchResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = (): void => controller.abort();
      externalSignal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          return { ok: false, kind: 'http', message: `目录接口返回 HTTP ${response.status}。` };
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return { ok: false, kind: 'invalid-payload', message: '目录响应不是有效 JSON。' };
        }
        const catalog = parseServiceCatalog(body);
        if (catalog === null) {
          return { ok: false, kind: 'invalid-payload', message: '目录响应结构无效，已保留本机缓存。' };
        }
        return { ok: true, document: body, catalog };
      } catch {
        return { ok: false, kind: 'unreachable', message: '无法读取在线卡牌目录。' };
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abort);
      }
    },
    resolveAssetUrl(path: string): string {
      return path.length === 0 ? '' : joinPath(address.httpUrl, path).toString();
    },
  };
}
