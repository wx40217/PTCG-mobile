import { sha256, utf8 } from '@ptcg/protocol';

/**
 * 卡图按需缓存（T15 / #16）。
 *
 * 目标行为：
 *   - 只有在用户打开某张卡/某个资源样本时才下载（按需），不预取整包；
 *   - 下载后先核对服务端声明的 SHA-256 与大小，再以「临时文件 + 改名」原子写入；
 *   - 缓存条目按内容哈希存文件，同一张卡保留有限个版本：更新失败时旧图仍可显示，
 *     更新成功后才让新版本成为当前值；
 *   - 缓存文件损坏（大小或哈希不符）时删除损坏版本并回退到上一完整版本；
 *   - 自动重试有上限，跨启动不重下：已缓存的期望哈希直接命中，不触碰网络；
 *   - 占用统计与清理只覆盖本模块的命名空间，不会删除身份、卡组或其他偏好。
 *
 * 存储抽象让 Android 用 Capacitor Filesystem（应用私有目录），测试与 Web 用
 * 内存实现；`clear()` 只清理该命名空间。
 */

export const IMAGE_CACHE_SCHEMA = 'ptcg.image-cache/v1';
export const IMAGE_CACHE_INDEX = 'index.json';

export interface ImageCacheEntry {
  readonly sha256: string;
  readonly bytes: number;
  readonly storedAt: string;
  readonly file: string;
}

export interface ImageCacheUsage {
  /** 实际文件数（同一图片字节被多张卡共享时只算一次）。 */
  readonly count: number;
  readonly bytes: number;
}

export interface CachedImage {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** true 表示该版本不是目录当前声明的哈希，只是更新失败时的旧图。 */
  readonly stale: boolean;
}

export interface ImageCacheStorage {
  read(name: string): Promise<Uint8Array | undefined>;
  /** 必须以「先写临时文件再改名」的方式原子提交。 */
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<readonly string[]>;
  /** 只清理本存储命名空间。 */
  clear(): Promise<void>;
}

export interface ImageFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ImageFetch = (url: string, init?: { readonly signal?: AbortSignal; readonly cache?: RequestCache }) => Promise<ImageFetchResponse>;

export type ImageCacheFailureKind = 'network' | 'http' | 'integrity' | 'storage' | 'too-large' | 'aborted';

export interface ImageCacheFailure {
  readonly kind: ImageCacheFailureKind;
  readonly message: string;
  /** aborted（调用方主动取消）与不可重试的 http 404 不计入自动重试。 */
  readonly retryable: boolean;
}

export type EnsureImageResult =
  | { readonly ok: true; readonly image: CachedImage }
  | { readonly ok: false; readonly failure: ImageCacheFailure; readonly cached?: CachedImage };

export interface ImageCacheOptions {
  readonly fetchImage?: ImageFetch;
  readonly now?: () => number;
  readonly maxBytesPerImage?: number;
  /** 同一 key 在自动路径上的失败上限；达到后只有显式重试才会再次下载。 */
  readonly maxAutoAttempts?: number;
  /** 每张卡保留的版本数（含当前）；默认 2，保证更新失败可回退。 */
  readonly keepVersions?: number;
  readonly timeoutMs?: number;
}

export interface ImageCache {
  /**
   * 读取本机缓存。`expectedSha256` 为 null 表示服务端/目录当前没有声明该图片
   * （运行期覆盖被移除或 URL 不可用），此时返回最新一份完整缓存供离线阅读。
   */
  get(key: string, expectedSha256: string | null): Promise<CachedImage | undefined>;
  ensure(
    key: string,
    expectedSha256: string,
    url: string,
    options?: { readonly signal?: AbortSignal; readonly force?: boolean },
  ): Promise<EnsureImageResult>;
  usage(): Promise<ImageCacheUsage>;
  clear(): Promise<void>;
  /** 给定 key 失败的自动尝试次数（诊断与测试用）。 */
  attemptCount(key: string): number;
}

const DEFAULT_MAX_BYTES_PER_IMAGE = 32 * 1024 * 1024;
const DEFAULT_MAX_AUTO_ATTEMPTS = 2;
const DEFAULT_KEEP_VERSIONS = 2;
const DEFAULT_TIMEOUT_MS = 20_000;

interface CacheIndex {
  readonly schema: string;
  readonly entries: Readonly<Record<string, readonly ImageCacheEntry[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): ImageCacheEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const { sha256: digest, bytes, storedAt, file } = value;
  if (
    typeof digest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(digest) ||
    typeof bytes !== 'number' ||
    !Number.isInteger(bytes) ||
    bytes <= 0 ||
    typeof storedAt !== 'string' ||
    typeof file !== 'string' ||
    file !== `${digest}.png`
  ) {
    return null;
  }
  return { sha256: digest, bytes, storedAt, file };
}

function parseIndex(raw: Uint8Array | undefined): CacheIndex | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['schema'] !== IMAGE_CACHE_SCHEMA || !isRecord(parsed['entries'])) {
    return undefined;
  }
  const entries: Record<string, ImageCacheEntry[]> = {};
  for (const [key, versions] of Object.entries(parsed['entries'])) {
    if (!Array.isArray(versions)) {
      return undefined;
    }
    const parsedVersions: ImageCacheEntry[] = [];
    for (const version of versions) {
      const entry = parseEntry(version);
      if (entry === null) {
        return undefined;
      }
      parsedVersions.push(entry);
    }
    entries[key] = parsedVersions;
  }
  return { schema: IMAGE_CACHE_SCHEMA, entries };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('aborted', 'AbortError');
  }
}

const ABORTED: ImageCacheFailure = {
  kind: 'aborted',
  message: '卡图下载已取消。',
  retryable: false,
};

export function createImageCache(storage: ImageCacheStorage, options: ImageCacheOptions = {}): ImageCache {
  const fetchImage: ImageFetch =
    options.fetchImage ?? ((url, init) => fetch(url, init) as unknown as Promise<ImageFetchResponse>);
  const now = options.now ?? (() => Date.now());
  const maxBytes = options.maxBytesPerImage ?? DEFAULT_MAX_BYTES_PER_IMAGE;
  const maxAutoAttempts = options.maxAutoAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;
  const keepVersions = Math.max(1, options.keepVersions ?? DEFAULT_KEEP_VERSIONS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let index: CacheIndex | undefined;
  let indexLoaded = false;
  const attempts = new Map<string, number>();
  /**
   * 缓存清空代数：`clear()` 成功后递增。下载开始时的代数与提交时不一致，
   * 说明下载期间用户清空了缓存，提交必须放弃，不能把已清空的缓存“写回来”。
   */
  let generation = 0;
  /**
   * 存储读改写事务队列。索引的读-合并-写、删除损坏文件与 prune 必须串行，
   * 否则并发写入不同 key 时，后提交者会基于旧索引覆盖或把对方已写入的
   * 完整文件当孤儿删除。网络下载仍可并发，只有提交事务排队。
   */
  let mutationTail: Promise<void> = Promise.resolve();

  function runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function loadIndex(): Promise<CacheIndex> {
    if (indexLoaded && index !== undefined) {
      return index;
    }
    let raw: Uint8Array | undefined;
    try {
      raw = await storage.read(IMAGE_CACHE_INDEX);
    } catch {
      raw = undefined;
    }
    const parsed = parseIndex(raw);
    if (parsed === undefined && raw !== undefined) {
      // 索引损坏：无法把文件安全映射回 key，清空本命名空间重建，避免使用未知数据。
      try {
        await storage.clear();
      } catch {
        /* 清理失败也继续以空索引运行 */
      }
    }
    index = parsed ?? { schema: IMAGE_CACHE_SCHEMA, entries: {} };
    indexLoaded = true;
    return index;
  }

  async function saveIndex(next: CacheIndex): Promise<void> {
    await storage.write(IMAGE_CACHE_INDEX, utf8(JSON.stringify(next)));
    index = next;
    indexLoaded = true;
  }

  /** 删除没有任何索引条目引用的文件；索引文件与临时文件另行处理。 */
  async function pruneUnreferenced(current: CacheIndex): Promise<void> {
    let names: readonly string[];
    try {
      names = await storage.list();
    } catch {
      return;
    }
    const referenced = new Set<string>();
    for (const versions of Object.values(current.entries)) {
      for (const entry of versions) {
        referenced.add(entry.file);
      }
    }
    for (const name of names) {
      if (name === IMAGE_CACHE_INDEX || referenced.has(name)) {
        continue;
      }
      await storage.remove(name).catch(() => undefined);
    }
  }

  async function verifyFile(entry: ImageCacheEntry): Promise<Uint8Array | undefined> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await storage.read(entry.file);
    } catch {
      return undefined;
    }
    if (bytes === undefined || bytes.length !== entry.bytes) {
      await storage.remove(entry.file).catch(() => undefined);
      return undefined;
    }
    // 每次读取都核对实际字节的摘要：同进程写入过的文件字节仍可能被外部替换，
    // 只凭“本实例写过”的记忆会把同长度的损坏文件当成有效缓存。
    const digest = bytesToHex(await sha256(bytes));
    if (digest !== entry.sha256) {
      await storage.remove(entry.file).catch(() => undefined);
      return undefined;
    }
    return bytes;
  }

  /**
   * 在事务队列内完成「写图片文件 + 合并索引 + 落盘 + prune」。文件写入也放在
   * 事务内，确保 prune 不会在文件被索引引用之前把它当孤儿删除。
   * 返回 false 表示下载期间缓存被清空，本次提交被放弃（不写文件、不写索引）。
   */
  async function writeEntry(
    key: string,
    expectedSha256: string,
    bytes: Uint8Array,
    startedGeneration: number,
  ): Promise<boolean> {
    const file = `${expectedSha256}.png`;
    return runMutation(async () => {
      if (startedGeneration !== generation) {
        return false;
      }
      await storage.write(file, bytes);
      const current = await loadIndex();
      const existing = (current.entries[key] ?? []).filter((entry) => entry.sha256 !== expectedSha256);
      const entry: ImageCacheEntry = {
        sha256: expectedSha256,
        bytes: bytes.length,
        storedAt: new Date(now()).toISOString(),
        file,
      };
      const next: CacheIndex = {
        schema: IMAGE_CACHE_SCHEMA,
        entries: { ...current.entries, [key]: [entry, ...existing].slice(0, keepVersions) },
      };
      try {
        await saveIndex(next);
      } catch (error) {
        // 索引未提交：本项目的新文件可能无人引用，尽力删除；旧索引与旧文件保持完整。
        if (!(current.entries[key] ?? []).some((item) => item.sha256 === expectedSha256)) {
          await storage.remove(file).catch(() => undefined);
        }
        throw error;
      }
      await pruneUnreferenced(next);
      return true;
    });
  }

  async function lookup(key: string, expectedSha256: string | null): Promise<CachedImage | undefined> {
    return runMutation(async () => {
      const current = await loadIndex();
      const versions = current.entries[key] ?? [];
      let fallback: CachedImage | undefined;
      let changed = false;
      const kept: ImageCacheEntry[] = [];
      for (const entry of versions) {
        const bytes = await verifyFile(entry);
        if (bytes === undefined) {
          changed = true;
          continue;
        }
        kept.push(entry);
        // expectedSha256 为 null 表示目录/服务当前没有声明该图片：显示最新一份
        // 本机完整缓存，不把它标成更新失败的旧图。
        if (expectedSha256 === null || entry.sha256 === expectedSha256) {
          if (changed) {
            await saveIndex({ ...current, entries: { ...current.entries, [key]: kept } }).catch(() => undefined);
          }
          return { bytes, sha256: entry.sha256, stale: expectedSha256 !== null && entry.sha256 !== expectedSha256 };
        }
        fallback ??= { bytes, sha256: entry.sha256, stale: true };
      }
      if (changed) {
        await saveIndex({ ...current, entries: { ...current.entries, [key]: kept } }).catch(() => undefined);
      }
      return fallback;
    });
  }

  async function download(
    key: string,
    expectedSha256: string,
    url: string,
    externalSignal: AbortSignal | undefined,
    startedGeneration: number,
  ): Promise<EnsureImageResult> {
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      abortIfNeeded(externalSignal);
      // 目录哈希可以随目录更新而变化，但图片 URL 不变；HTTP 缓存不得代替本模块的
      // 内容哈希缓存，否则同一 URL 的旧响应会被当成新图。（服务端图片也改为 no-cache。）
      const response = await fetchImage(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) {
        return {
          ok: false,
          failure:
            response.status === 404
              ? { kind: 'http', message: '服务端没有这张卡图（HTTP 404）。', retryable: false }
              : { kind: 'http', message: `卡图接口返回 HTTP ${response.status}。`, retryable: true },
        };
      }
      const declaredLength = response.headers?.get('content-length');
      if (declaredLength !== null && declaredLength !== undefined) {
        const parsedLength = Number.parseInt(declaredLength, 10);
        if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
          return { ok: false, failure: { kind: 'too-large', message: '卡图文件超过本机缓存上限。', retryable: false } };
        }
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        if (externalSignal?.aborted === true) {
          return { ok: false, failure: ABORTED };
        }
        return { ok: false, failure: { kind: 'network', message: '卡图下载中断，未写入缓存。', retryable: true } };
      }
      if (bytes.length === 0 || bytes.length > maxBytes) {
        return { ok: false, failure: { kind: 'too-large', message: '卡图文件大小不在允许范围内。', retryable: false } };
      }
      const digest = bytesToHex(await sha256(bytes));
      if (digest !== expectedSha256) {
        return {
          ok: false,
          failure: { kind: 'integrity', message: '卡图摘要与目录声明不一致，已拒绝写入缓存。', retryable: true },
        };
      }
      await writeEntry(key, expectedSha256, bytes, startedGeneration);
      return { ok: true, image: { bytes, sha256: expectedSha256, stale: false } };
    } catch (error) {
      if (externalSignal?.aborted === true) {
        return { ok: false, failure: ABORTED };
      }
      if (controller.signal.aborted) {
        return { ok: false, failure: { kind: 'network', message: '卡图下载超时。', retryable: true } };
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, failure: ABORTED };
      }
      return {
        ok: false,
        failure: {
          kind: error instanceof Error && /存储|空间|quota|storage/iu.test(error.message) ? 'storage' : 'network',
          message: `卡图下载失败：${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    async get(key, expectedSha256) {
      return lookup(key, expectedSha256);
    },

    async ensure(key, expectedSha256, url, ensureOptions) {
      const force = ensureOptions?.force === true;
      if (force) {
        attempts.delete(key);
      }
      const startedGeneration = generation;
      const existing = await lookup(key, expectedSha256);
      if (existing !== undefined && !existing.stale) {
        return { ok: true, image: existing };
      }
      const attemptCount = attempts.get(key) ?? 0;
      if (!force && attemptCount >= maxAutoAttempts) {
        return {
          ok: false,
          failure: {
            kind: 'network',
            message: `已达到自动重试上限（${maxAutoAttempts} 次）；请手动重试。`,
            retryable: false,
          },
          ...(existing === undefined ? {} : { cached: existing }),
        };
      }
      try {
        abortIfNeeded(ensureOptions?.signal);
      } catch {
        return { ok: false, failure: ABORTED };
      }
      const result = await download(key, expectedSha256, url, ensureOptions?.signal, startedGeneration);
      if (result.ok || result.failure.kind === 'aborted') {
        if (result.ok) {
          attempts.delete(key);
        }
        return result;
      }
      attempts.set(key, attemptCount + 1);
      if (existing !== undefined) {
        return { ...result, cached: existing };
      }
      return result;
    },

    async usage() {
      return runMutation(async () => {
        const current = await loadIndex();
        const files = new Map<string, number>();
        for (const versions of Object.values(current.entries)) {
          for (const entry of versions) {
            if (!files.has(entry.file)) {
              files.set(entry.file, entry.bytes);
            }
          }
        }
        // 以实际存在的文件为准统计：清理部分失败或外部删除后，占用显示仍准确。
        let present: ReadonlySet<string>;
        try {
          present = new Set(await storage.list());
        } catch {
          present = new Set(files.keys());
        }
        let count = 0;
        let bytes = 0;
        for (const [file, size] of files) {
          if (present.has(file)) {
            count += 1;
            bytes += size;
          }
        }
        return { count, bytes };
      });
    },

    async clear() {
      await runMutation(async () => {
        // 底层清理失败会抛出并保留以下状态：索引仍指向剩余文件，占用可继续查看，
        // 已缓存图片仍可复读，用户可以重试清理而不是把缓存误报为已空。
        await storage.clear();
        generation += 1;
        index = { schema: IMAGE_CACHE_SCHEMA, entries: {} };
        indexLoaded = true;
        attempts.clear();
      });
    },

    attemptCount(key) {
      return attempts.get(key) ?? 0;
    },
  };
}

export interface MemoryImageCacheStorage extends ImageCacheStorage {
  /** 注入下一次写入失败（例如磁盘空间不足）；执行一次后恢复。 */
  failNextWrite(error?: Error): void;
  failNextRead(error?: Error): void;
  failNextClear(error?: Error): void;
  keys(): readonly string[];
}

export function createMemoryImageCacheStorage(initial: Readonly<Record<string, Uint8Array>> = {}): MemoryImageCacheStorage {
  const values = new Map<string, Uint8Array>(Object.entries(initial));
  let writeFailure: Error | undefined;
  let readFailure: Error | undefined;
  let clearFailure: Error | undefined;
  return {
    async read(name) {
      if (readFailure !== undefined) {
        const error = readFailure;
        readFailure = undefined;
        throw error;
      }
      const value = values.get(name);
      return value === undefined ? undefined : Uint8Array.from(value);
    },
    async write(name, bytes) {
      if (writeFailure !== undefined) {
        const error = writeFailure;
        writeFailure = undefined;
        throw error;
      }
      values.set(name, Uint8Array.from(bytes));
    },
    async remove(name) {
      values.delete(name);
    },
    async list() {
      return [...values.keys()];
    },
    async clear() {
      if (clearFailure !== undefined) {
        const error = clearFailure;
        clearFailure = undefined;
        throw error;
      }
      values.clear();
    },
    failNextWrite(error = new Error('磁盘空间不足')) {
      writeFailure = error;
    },
    failNextRead(error = new Error('读取失败')) {
      readFailure = error;
    },
    failNextClear(error = new Error('清理失败')) {
      clearFailure = error;
    },
    keys() {
      return [...values.keys()];
    },
  };
}
