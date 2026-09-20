import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateDeck, type ServiceAddressPolicy } from '@ptcg/protocol';
import { createHttpDeckValidator } from '../src/decks/validatorSource.ts';
import { deckDocumentOf, realCatalog } from './deckHelpers.ts';

const DEV_POLICY: ServiceAddressPolicy = { allowInsecure: true };
const catalog = realCatalog();

const VALID_RESPONSE = validateDeck(deckDocumentOf('A', catalog), {
  content: catalog.content,
  catalogVersion: catalog.catalogVersion,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('服务端卡组校验来源（HTTP 契约）', () => {
  it('向 /decks/validate POST 卡组文档并解析服务端结果', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => VALID_RESPONSE };
    });

    const validator = createHttpDeckValidator({ serviceAddress: 'http://127.0.0.1:8787', policy: DEV_POLICY });
    const document = deckDocumentOf('A', catalog);
    const result = await validator.validate(document);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toEqual(VALID_RESPONSE);
      expect(result.response.ready).toBe(false);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8787/decks/validate');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe(JSON.stringify(document));
    expect((calls[0]!.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('地址无效时不发起请求；HTTP 错误、无效 JSON 与网络失败分别归类', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const invalid = createHttpDeckValidator({ serviceAddress: '', policy: DEV_POLICY });
    expect(invalid.available).toBe(false);
    const invalidResult = await invalid.validate(deckDocumentOf('A', catalog));
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) {
      expect(invalidResult.kind).toBe('invalid-address');
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const http = createHttpDeckValidator({ serviceAddress: 'http://127.0.0.1:8787', policy: DEV_POLICY });
    const httpResult = await http.validate(deckDocumentOf('A', catalog));
    expect(httpResult.ok).toBe(false);
    if (!httpResult.ok) {
      expect(httpResult.kind).toBe('http');
      expect(httpResult.message).toContain('503');
    }

    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) }));
    const payload = createHttpDeckValidator({ serviceAddress: 'http://127.0.0.1:8787', policy: DEV_POLICY });
    const payloadResult = await payload.validate(deckDocumentOf('A', catalog));
    expect(payloadResult.ok).toBe(false);
    if (!payloadResult.ok) {
      expect(payloadResult.kind).toBe('invalid-payload');
    }

    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    const network = createHttpDeckValidator({ serviceAddress: 'http://127.0.0.1:8787', policy: DEV_POLICY });
    const networkResult = await network.validate(deckDocumentOf('A', catalog));
    expect(networkResult.ok).toBe(false);
    if (!networkResult.ok) {
      expect(networkResult.kind).toBe('unreachable');
    }
  });

  it('发布配置拒绝明文地址，界面入口不可用', async () => {
    const validator = createHttpDeckValidator({ serviceAddress: 'http://127.0.0.1:8787', policy: { allowInsecure: false } });
    expect(validator.available).toBe(false);
    const result = await validator.validate(deckDocumentOf('A', catalog));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('invalid-address');
      expect(result.message).toMatch(/https/u);
    }
  });
});
