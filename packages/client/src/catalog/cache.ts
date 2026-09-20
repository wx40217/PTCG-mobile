import { Preferences } from '@capacitor/preferences';
import { isCatalogVersionValid, parseServiceCatalog, type ServiceCatalog } from '@ptcg/protocol';

/**
 * 目录的离线缓存。
 *
 * 设计目标是“更新失败不损坏已有完整缓存”：
 *   1. 写入前先校验新文档能完整解析，且重算的内容哈希与 `catalogVersion` 一致；
 *   2. 旧的有效缓存先复制到备份槽，再写当前槽；
 *   3. 写入后回读校验，不一致时用备份恢复。
 * 读取时当前槽损坏则回退备份槽；只有两份都损坏才视为没有缓存。
 *
 * 目录文档中的 `runtime.servedAt` 与图片可用性会一起缓存；断网时文字资料
 * 与版本号仍然可读，图片加载失败由界面回退为文字卡面。
 */

export const CATALOG_CACHE_KEY = 'ptcg.catalog.cache.v1';
export const CATALOG_CACHE_BACKUP_KEY = 'ptcg.catalog.cache.backup.v1';

export interface CatalogCacheStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface LoadedCatalogCache {
  readonly raw: unknown;
  readonly catalog: ServiceCatalog;
}

export interface CatalogCache {
  load(): Promise<LoadedCatalogCache | undefined>;
  save(document: unknown): Promise<void>;
}

function parseCachedStructure(raw: string | null): { readonly raw: unknown; readonly catalog: ServiceCatalog } | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const catalog = parseServiceCatalog(parsed);
  if (catalog === null) {
    return undefined;
  }
  return { raw: parsed, catalog };
}

/** 结构之外再重算 catalogVersion：内容被改坏/截断的缓存不得冒充完整缓存。 */
async function parseCached(raw: string | null): Promise<LoadedCatalogCache | undefined> {
  const parsed = parseCachedStructure(raw);
  if (parsed === undefined) {
    return undefined;
  }
  if (!(await isCatalogVersionValid(parsed.catalog))) {
    return undefined;
  }
  return parsed;
}

export function createCatalogCache(storage: CatalogCacheStorage): CatalogCache {
  return {
    async load(): Promise<LoadedCatalogCache | undefined> {
      const current = await parseCached(await storage.get(CATALOG_CACHE_KEY));
      if (current !== undefined) {
        return current;
      }
      const backup = await parseCached(await storage.get(CATALOG_CACHE_BACKUP_KEY));
      if (backup === undefined) {
        return undefined;
      }
      // 当前槽损坏、备份仍完整：尽力恢复当前槽；恢复失败也仍返回备份。
      try {
        await storage.set(CATALOG_CACHE_KEY, JSON.stringify(backup.raw));
      } catch {
        /* 恢复失败不影响本次读取 */
      }
      return backup;
    },

    async save(document: unknown): Promise<void> {
      const catalog = parseServiceCatalog(document);
      if (catalog === null) {
        throw new Error('拒绝写入无法完整解析的目录缓存');
      }
      if (!(await isCatalogVersionValid(catalog))) {
        // 在触碰任何槽位之前拒绝：结构合法但版本不符的文档不得替换完整缓存。
        throw new Error('拒绝写入版本与内容不一致的目录缓存');
      }
      const serialized = JSON.stringify(document);
      const currentRaw = await storage.get(CATALOG_CACHE_KEY);
      if ((await parseCached(currentRaw)) !== undefined && currentRaw !== null) {
        await storage.set(CATALOG_CACHE_BACKUP_KEY, currentRaw);
      }
      await storage.set(CATALOG_CACHE_KEY, serialized);
      const readback = await storage.get(CATALOG_CACHE_KEY);
      if (readback !== serialized) {
        const backupRaw = await storage.get(CATALOG_CACHE_BACKUP_KEY);
        if ((await parseCached(backupRaw)) !== undefined && backupRaw !== null) {
          try {
            await storage.set(CATALOG_CACHE_KEY, backupRaw);
          } catch {
            /* 恢复失败：至少备份槽仍是旧的有效缓存 */
          }
        }
        throw new Error('目录缓存写入校验失败，已保留上一份完整缓存');
      }
    },
  };
}

export interface MemoryCatalogStorage extends CatalogCacheStorage {
  /** 注入写入失败；返回 null 表示恢复正常。 */
  failNextSet(key: string): void;
  keys(): readonly string[];
}

export function createMemoryCatalogStorage(initial: Readonly<Record<string, string>> = {}): MemoryCatalogStorage {
  const values = new Map<string, string>(Object.entries(initial));
  let failingKey: string | null = null;
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      if (failingKey === key) {
        failingKey = null;
        throw new Error(`测试注入的写入失败：${key}`);
      }
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
    failNextSet(key) {
      failingKey = key;
    },
    keys() {
      return [...values.keys()];
    },
  };
}

/** Android 上用 SharedPreferences；Web 上 @capacitor/preferences 自动退回 localStorage。 */
export function createPreferencesCatalogStorage(): CatalogCacheStorage {
  return {
    async get(key) {
      const result = await Preferences.get({ key });
      return result.value;
    },
    async set(key, value) {
      await Preferences.set({ key, value });
    },
    async remove(key) {
      await Preferences.remove({ key });
    },
  };
}

export function createPreferencesCatalogCache(): CatalogCache {
  return createCatalogCache(createPreferencesCatalogStorage());
}
