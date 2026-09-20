import { describe, expect, it } from 'vitest';
import { DECK_FORMAT_VERSION } from '@ptcg/protocol';
import {
  DECK_DRAFTS_KEY,
  createDeckDraftStore,
  createDraft,
  createMemoryDeckDraftStorage,
  createMemoryDeckDraftStore,
  parseStoredDrafts,
  type DeckDraft,
} from '../src/decks/draftStore.ts';

function document(environmentId = 'zh-cn-standard-2025-06-05') {
  return {
    formatVersion: DECK_FORMAT_VERSION,
    environmentId,
    cards: [
      {
        cardId: 'csv3c-043',
        printIdentity: 'print:CSV3C:043/130',
        effectIdentity: 'fx:pokemon:古剑豹ex:47bdd73235a0',
        count: 4,
      },
    ],
  } as const;
}

describe('卡组草稿存储', () => {
  it('写入后读取保留名称、身份与数量，重启（新 store 实例）仍可恢复', async () => {
    const storage = createMemoryDeckDraftStorage();
    const store = createDeckDraftStore(storage);
    const draft = createDraft({ name: '古剑豹测试', document: document(), id: 'draft-1', now: () => 1_700_000_000_000 });
    await store.write([draft]);

    const reopened = createDeckDraftStore(storage);
    const loaded = await reopened.read();
    expect(loaded).toEqual([draft]);
    expect(loaded[0]!.updatedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(storage.keys()).toContain(DECK_DRAFTS_KEY);
  });

  it('损坏的 JSON、非数组与坏条目分别回退为空列表/跳过', () => {
    expect(parseStoredDrafts(null)).toEqual([]);
    expect(parseStoredDrafts('not json')).toEqual([]);
    expect(parseStoredDrafts('{"not":"array"}')).toEqual([]);

    const valid = {
      id: 'ok',
      name: '可用草稿',
      updatedAt: '2026-09-20T00:00:00.000Z',
      document: document(),
    };
    const corrupted = { ...valid, id: 'bad', document: { formatVersion: 2, environmentId: '', cards: [] } };
    const longName = { ...valid, id: 'long', name: 'x'.repeat(40) };
    const parsed = parseStoredDrafts(JSON.stringify([valid, corrupted, longName]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('ok');
  });

  it('createDraft 校验名称长度；空名称直接拒绝', () => {
    expect(() => createDraft({ name: '   ', document: document() })).toThrow(/名称/u);
    expect(() => createDraft({ name: 'x'.repeat(25), document: document() })).toThrow(/名称/u);
    const draft = createDraft({ name: '  保留空格名称  ', document: document(), id: 'x' });
    expect(draft.name).toBe('保留空格名称');
  });

  it('内存草稿存储读取初始列表，写入相互隔离', async () => {
    const initial: DeckDraft = createDraft({ name: '初始', document: document(), id: 'start' });
    const first = createMemoryDeckDraftStore([initial]);
    const second = createMemoryDeckDraftStore();
    expect(await first.read()).toHaveLength(1);
    expect(await second.read()).toHaveLength(0);
    await second.write([initial]);
    expect(await second.read()).toHaveLength(1);
    expect(await first.read()).toHaveLength(1);
  });
});
