import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DECK_FORMAT_VERSION,
  DECK_VALIDATE_PATH,
  exportDeckText,
  importDeckText,
  parseServiceCatalog,
  presetDeckDocument,
  validateDeck,
  type DeckDocument,
  type DeckValidationResponse,
  type ServiceCatalog,
} from '@ptcg/protocol';
import { defaultCatalogPath } from '../src/catalog.ts';
import { createLogger } from '../src/logger.ts';
import { createService, type ServiceHandle } from '../src/server.ts';

const catalog = parseServiceCatalog(JSON.parse(readFileSync(defaultCatalogPath(), 'utf8'))) as ServiceCatalog;

function silentLogger() {
  return createLogger(() => undefined, () => 1_700_000_000_000);
}

function preset(code: string): DeckDocument {
  const source = catalog.content.decks.find((deck) => deck.code === code);
  if (source === undefined) {
    throw new Error(`缺少预设卡组 ${code}`);
  }
  const document = presetDeckDocument(source, catalog.content);
  if (document === null) {
    throw new Error(`预设卡组 ${code} 无法转换`);
  }
  return document;
}

async function postDeck(service: ServiceHandle, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${service.httpUrl}${DECK_VALIDATE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as unknown };
}

describe('卡组校验接口（真实服务 + 冻结目录）', () => {
  let service: ServiceHandle | undefined;

  beforeAll(async () => {
    service = await createService({ host: '127.0.0.1', port: 0, logger: silentLogger() });
  });

  afterAll(async () => {
    await service?.close();
  });

  it('预设卡组通过规则合法性，但因为效果未接入一律不就绪', async () => {
    const response = validateDeck(preset('A'), { content: catalog.content, catalogVersion: catalog.catalogVersion });
    const { status, json } = await postDeck(service!, preset('A'));
    expect(status).toBe(200);
    const result = json as DeckValidationResponse;
    expect(result).toMatchObject({
      formatVersion: DECK_FORMAT_VERSION,
      environmentId: catalog.content.environment.id,
      catalogVersion: catalog.catalogVersion,
      totalCards: 60,
      legal: true,
      ready: false,
    });
    expect(result.dataRevision).toBe(catalog.content.dataRevision.sourceDigest);
    expect(result.problems).toEqual(response.problems);
  });

  it('文本导出的卡组经导入后提交，结果与直接提交一致', async () => {
    const text = exportDeckText(preset('D'), catalog);
    const imported = importDeckText(text, { content: catalog.content, catalogVersion: catalog.catalogVersion });
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    const { status, json } = await postDeck(service!, imported.deck);
    expect(status).toBe(200);
    const result = json as DeckValidationResponse;
    expect(result.legal).toBe(true);
    // T13 / #14：D 预设（含基本能量）已全部接入，独立于整份目录是否可玩。
    expect(result.ready).toBe(true);
    expect(result.totalCards).toBe(60);
  });

  it('客户端伪造的 legal/ready 字段被忽略，61 张与非 60 张都按服务端结果拒绝', async () => {
    const base = preset('A');
    const energy = base.cards.find((entry) => entry.cardId === 'cbb2c-1102');
    if (energy === undefined) {
      throw new Error('缺少基本能量');
    }
    const over = {
      ...base,
      legal: true,
      ready: true,
      cards: base.cards.map((entry) => (entry === energy ? { ...entry, count: entry.count + 1 } : entry)),
    };
    const { status, json } = await postDeck(service!, over);
    expect(status).toBe(200);
    const result = json as DeckValidationResponse;
    expect(result.legal).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.totalCards).toBe(61);
    expect(result.problems.some((problem) => problem.code === 'deck-size')).toBe(true);
  });

  it('未知编号、身份不符与旧环境都由服务端独立识别', async () => {
    const base = preset('A');
    const unknown = {
      ...base,
      cards: base.cards.map((entry, index) => (index === 0 ? { ...entry, cardId: 'forged-001' } : entry)),
    };
    const unknownResult = (await postDeck(service!, unknown)).json as DeckValidationResponse;
    expect(unknownResult.legal).toBe(false);
    expect(unknownResult.problems.find((problem) => problem.code === 'unknown-card')?.cardIds).toContain('forged-001');

    const mismatch = {
      ...base,
      cards: base.cards.map((entry, index) => (index === 0 ? { ...entry, effectIdentity: 'fx:pokemon:伪造:0000' } : entry)),
    };
    const mismatchResult = (await postDeck(service!, mismatch)).json as DeckValidationResponse;
    expect(mismatchResult.legal).toBe(false);
    expect(mismatchResult.problems.some((problem) => problem.code === 'identity-mismatch')).toBe(true);

    const old = { ...base, environmentId: 'zh-cn-standard-2020-01-01' };
    const oldResult = (await postDeck(service!, old)).json as DeckValidationResponse;
    expect(oldResult.legal).toBe(false);
    expect(oldResult.problems.some((problem) => problem.code === 'environment-mismatch')).toBe(true);
  });

  it('结构错误返回 400 且说明具体字段；超大提交返回 413；非 POST 返回 405', async () => {
    const bad = await postDeck(service!, { formatVersion: 1, environmentId: catalog.content.environment.id, cards: 'nope' });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toBe('invalid_deck');

    const tooLarge = await postDeck(service!, JSON.stringify({ ...preset('A'), padding: 'x'.repeat(70 * 1024) }));
    expect(tooLarge.status).toBe(413);

    const wrongMethod = await fetch(`${service!.httpUrl}${DECK_VALIDATE_PATH}`);
    expect(wrongMethod.status).toBe(405);
    await wrongMethod.json();
  });

  it('CORS 预检允许 POST，响应带允许来源；未知路径仍是 404', async () => {
    const preflight = await fetch(`${service!.httpUrl}${DECK_VALIDATE_PATH}`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    await preflight.text();

    const posted = await fetch(`${service!.httpUrl}${DECK_VALIDATE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(preset('A')),
    });
    expect(posted.headers.get('access-control-allow-origin')).toBe('*');
    await posted.json();

    const missing = await fetch(`${service!.httpUrl}decks/nope`, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(404);
    await missing.json();
  });
});
