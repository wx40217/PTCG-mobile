import {
  DECK_VALIDATE_PATH,
  joinPath,
  parseDeckValidationResponse,
  parseServiceAddress,
  type DeckDocument,
  type DeckValidationResponse,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';

/**
 * 服务端卡组校验数据源。
 *
 * 正式开局以服务端当前目录为准：客户端只提交卡组文档，不提交任何
 * “合法/就绪”声明，结果完全由服务端重算。地址策略与连接设置共用，
 * 发布配置下明文地址不会发起请求。
 */

export type DeckValidatorFailureKind = 'invalid-address' | 'unreachable' | 'http' | 'invalid-payload';

export type DeckValidatorResult =
  | { readonly ok: true; readonly response: DeckValidationResponse }
  | { readonly ok: false; readonly kind: DeckValidatorFailureKind; readonly message: string };

export interface DeckValidatorSource {
  validate(deck: DeckDocument, signal?: AbortSignal): Promise<DeckValidatorResult>;
  /** 服务地址是否可用；不可用时界面不应展示“服务端校验”入口。 */
  readonly available: boolean;
}

export interface DeckValidatorInput {
  readonly serviceAddress: string;
  readonly policy: ServiceAddressPolicy;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

export function createHttpDeckValidator(input: DeckValidatorInput): DeckValidatorSource {
  const address = parseServiceAddress(input.serviceAddress, input.policy);
  if (!address.ok) {
    return {
      available: false,
      async validate() {
        return { ok: false, kind: 'invalid-address', message: address.message };
      },
    };
  }
  const url = joinPath(address.httpUrl, DECK_VALIDATE_PATH).toString();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    available: true,
    async validate(deck: DeckDocument, externalSignal?: AbortSignal): Promise<DeckValidatorResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = (): void => controller.abort();
      externalSignal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(deck),
          signal: controller.signal,
        });
        if (!response.ok) {
          return { ok: false, kind: 'http', message: `卡组校验接口返回 HTTP ${response.status}。` };
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return { ok: false, kind: 'invalid-payload', message: '卡组校验响应不是有效 JSON。' };
        }
        const parsed = parseDeckValidationResponse(body);
        if (parsed === null) {
          return { ok: false, kind: 'invalid-payload', message: '卡组校验响应结构无效。' };
        }
        return { ok: true, response: parsed };
      } catch {
        return { ok: false, kind: 'unreachable', message: '无法连接服务端进行卡组校验。' };
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abort);
      }
    },
  };
}
