import { Preferences } from '@capacitor/preferences';
import { parseDeckDocument, type DeckDocument } from '@ptcg/protocol';

/**
 * 本机卡组草稿存储。
 *
 * 草稿独立于服务连接保存在设备上：离线可以继续编辑，应用重启后恢复。
 * 读取时逐条校验结构，坏掉的条目被丢弃而不是让整个列表不可用。
 */

export const DECK_DRAFTS_KEY = 'ptcg.decks.drafts.v1';
export const DRAFT_NAME_MAX_LENGTH = 24;

export interface DeckDraft {
  readonly id: string;
  readonly name: string;
  readonly document: DeckDocument;
  /** ISO 时间戳；仅用于显示与排序。 */
  readonly updatedAt: string;
}

export interface DeckDraftStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface DeckDraftStore {
  read(): Promise<DeckDraft[]>;
  write(drafts: readonly DeckDraft[]): Promise<void>;
}

function parseStoredDraft(value: unknown): DeckDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const name = record['name'];
  const updatedAt = record['updatedAt'];
  if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || typeof updatedAt !== 'string') {
    return null;
  }
  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > DRAFT_NAME_MAX_LENGTH) {
    return null;
  }
  const parsed = parseDeckDocument(record['document']);
  if (!parsed.ok) {
    return null;
  }
  return { id, name: trimmedName, document: parsed.deck, updatedAt };
}

/** 解析整个草稿列表；非数组或不可解析的条目按空列表/跳过处理。 */
export function parseStoredDrafts(raw: string | null): DeckDraft[] {
  if (raw === null || raw.length === 0) {
    return [];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) {
    return [];
  }
  const drafts: DeckDraft[] = [];
  for (const entry of decoded) {
    const draft = parseStoredDraft(entry);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
  return drafts;
}

export function createDeckDraftStore(storage: DeckDraftStorage): DeckDraftStore {
  return {
    async read() {
      return parseStoredDrafts(await storage.get(DECK_DRAFTS_KEY));
    },
    async write(drafts) {
      await storage.set(DECK_DRAFTS_KEY, JSON.stringify(drafts));
    },
  };
}

export function createPreferencesDeckDraftStore(): DeckDraftStore {
  return createDeckDraftStore({
    async get(key) {
      return (await Preferences.get({ key })).value;
    },
    async set(key, value) {
      await Preferences.set({ key, value });
    },
  });
}

export interface MemoryDeckDraftStorage extends DeckDraftStorage {
  keys(): readonly string[];
}

export function createMemoryDeckDraftStorage(initial: Readonly<Record<string, string>> = {}): MemoryDeckDraftStorage {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    keys() {
      return [...values.keys()];
    },
  };
}

export function createMemoryDeckDraftStore(initial: readonly DeckDraft[] = []): DeckDraftStore {
  const storage = createMemoryDeckDraftStorage(
    initial.length === 0 ? {} : { [DECK_DRAFTS_KEY]: JSON.stringify(initial) },
  );
  return createDeckDraftStore(storage);
}

/** 本机显示用草稿 ID；不使用身份或密钥材料。 */
export function newDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDraft(input: {
  readonly name: string;
  readonly document: DeckDocument;
  readonly id?: string;
  readonly now?: () => number;
}): DeckDraft {
  const name = input.name.trim();
  if (name.length === 0 || name.length > DRAFT_NAME_MAX_LENGTH) {
    throw new Error(`草稿名称需为 1-${DRAFT_NAME_MAX_LENGTH} 个字符`);
  }
  return {
    id: input.id ?? newDraftId(),
    name,
    document: input.document,
    updatedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
  };
}
