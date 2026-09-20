import { useCallback, useEffect, useState } from 'react';
import type { ImageCache } from './imageCache.ts';

/**
 * 卡图/资源样本的按需加载状态。
 *
 * 打开详情或资源查看器时才创建请求：先查本机缓存，命中期望哈希就直接显示
 * （断网也可读、不重复下载）；未命中或目录哈希已更新才下载并校验。更新失败
 * 但存在旧版本时显示旧图并标注 stale；下载取消不产生错误状态。
 */

export interface CardImageRequest {
  /** 缓存命名空间里的 key，例如 `card:csv3c-043` 或 `resource:asar-sample-sv1-en-170`。 */
  readonly cacheKey: string;
  /** 目录声明的期望 SHA-256；null 表示目录没有可分发卡图。 */
  readonly expectedSha256: string | null;
  readonly url: string;
  readonly enabled: boolean;
}

export type CardImageStatus = 'unavailable' | 'loading' | 'ready' | 'stale' | 'error';

export interface CardImageState {
  readonly status: CardImageStatus;
  readonly src: string;
  readonly message: string | undefined;
  retry(): void;
}

const EMPTY: CardImageState = {
  status: 'unavailable',
  src: '',
  message: undefined,
  retry: () => undefined,
};

interface ObjectUrl {
  readonly url: string;
  readonly revoke: () => void;
}

function createImageObjectUrl(bytes: Uint8Array): ObjectUrl {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
    try {
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }));
      return {
        url,
        revoke: () => {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* 撤消失败不影响显示 */
          }
        },
      };
    } catch {
      // jsdom / vitest 的 createObjectURL 兼容层对 Uint8Array Blob 不完整：退回 data URL。
    }
  }
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return { url: `data:image/png;base64,${btoa(binary)}`, revoke: () => undefined };
}

export function useCardImage(cache: ImageCache, request: CardImageRequest): CardImageState {
  const { cacheKey, enabled, expectedSha256, url } = request;
  const [state, setState] = useState<CardImageState>(EMPTY);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const force = attempt > 0;

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    let objectUrl: ObjectUrl | undefined;
    setState({ status: 'loading', src: '', message: undefined, retry });

    const show = (bytes: Uint8Array, status: CardImageStatus, message?: string): void => {
      objectUrl?.revoke();
      objectUrl = createImageObjectUrl(bytes);
      if (!cancelled) {
        setState({ status, src: objectUrl.url, message, retry });
      }
    };

    void (async () => {
      let cached;
      try {
        cached = await cache.get(cacheKey, expectedSha256);
      } catch {
        cached = undefined;
      }
      if (cancelled) {
        return;
      }
      if (cached !== undefined && !cached.stale) {
        show(cached.bytes, 'ready');
        return;
      }
      // 下载才依赖服务端可用性：缓存读取已先做，断网或服务端移除图片配置时
      // 仍显示本机已缓存的完整版本。
      if (expectedSha256 === null || url.length === 0) {
        if (cached !== undefined) {
          show(cached.bytes, 'stale', '服务端当前未提供可下载的卡图；正在显示本机已缓存的完整版本。');
          return;
        }
        setState(EMPTY);
        return;
      }
      const result = await cache.ensure(cacheKey, expectedSha256, url, { signal: controller.signal, force });
      if (cancelled) {
        return;
      }
      if (result.ok) {
        show(result.image.bytes, 'ready');
        return;
      }
      if (result.cached !== undefined) {
        show(result.cached.bytes, 'stale', `卡图更新失败：${result.failure.message}正在显示已缓存旧图。`);
        return;
      }
      if (result.failure.kind === 'aborted') {
        setState(EMPTY);
        return;
      }
      setState({ status: 'error', src: '', message: result.failure.message, retry });
    })();

    return () => {
      cancelled = true;
      controller.abort();
      objectUrl?.revoke();
    };
  }, [attempt, cache, cacheKey, enabled, expectedSha256, force, retry, url]);

  return state;
}
