import { useCallback, useEffect, useState } from 'react';
import type { ServiceCatalog } from '@ptcg/protocol';
import type { CatalogCache } from './cache.ts';
import type { CatalogSource } from './source.ts';

/**
 * 目录读取状态机：先读缓存立即显示，再在线更新。
 *
 * - 在线成功：替换为服务版本并写入缓存；
 * - 在线失败：若有完整缓存则继续显示缓存并给出原因；否则进入错误页；
 * - 缓存写入失败：显示在线数据，但明确标注“本次更新未写入缓存”。
 */
export type CatalogPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface CatalogState {
  readonly phase: CatalogPhase;
  readonly catalog: ServiceCatalog | undefined;
  readonly fromCache: boolean;
  /** 在线读取失败但仍显示缓存时的说明。 */
  readonly staleReason: string | undefined;
  readonly errorMessage: string | undefined;
  readonly cacheWriteFailed: boolean;
}

const IDLE: CatalogState = {
  phase: 'idle',
  catalog: undefined,
  fromCache: false,
  staleReason: undefined,
  errorMessage: undefined,
  cacheWriteFailed: false,
};

export interface UseCatalogInput {
  readonly enabled: boolean;
  readonly source: CatalogSource | undefined;
  readonly cache: CatalogCache;
  /** 变化时重新走一次读取流程。 */
  readonly reloadToken: number;
}

export interface UseCatalogResult {
  readonly state: CatalogState;
  reload(): void;
}

export function useCatalog(input: UseCatalogInput): UseCatalogResult {
  const [state, setState] = useState<CatalogState>(IDLE);
  const [internalToken, setInternalToken] = useState(0);
  const reload = useCallback(() => setInternalToken((token) => token + 1), []);
  const { enabled, source, cache, reloadToken } = input;

  useEffect(() => {
    if (!enabled || source === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      let cached: Awaited<ReturnType<CatalogCache['load']>>;
      try {
        cached = await cache.load();
      } catch {
        cached = undefined;
      }
      if (cancelled) {
        return;
      }
      if (cached !== undefined) {
        setState({ ...IDLE, phase: 'ready', catalog: cached.catalog, fromCache: true });
      } else {
        setState({ ...IDLE, phase: 'loading' });
      }

      const result = await source.fetchCatalog();
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setState({ ...IDLE, phase: 'ready', catalog: result.catalog });
        // 版本未变化时不重写缓存：避免无意义的备份轮换。
        const unchanged = cached !== undefined && cached.catalog.catalogVersion === result.catalog.catalogVersion;
        if (!unchanged) {
          try {
            await cache.save(result.document);
          } catch {
            if (!cancelled) {
              setState((previous) =>
                previous.catalog === undefined ? previous : { ...previous, cacheWriteFailed: true },
              );
            }
          }
        }
        return;
      }
      if (cached !== undefined) {
        setState({ ...IDLE, phase: 'ready', catalog: cached.catalog, fromCache: true, staleReason: result.message });
      } else {
        setState({ ...IDLE, phase: 'error', errorMessage: result.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cache, enabled, internalToken, reloadToken, source]);

  return { state, reload };
}
