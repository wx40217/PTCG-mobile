import { Directory, Filesystem } from '@capacitor/filesystem';
import { decodeBase64Url, encodeBase64Url } from '@ptcg/protocol';
import type { ImageCacheStorage } from './imageCache.ts';

/**
 * Android 侧的图片缓存存储：Capacitor Filesystem 的应用私有 Data 目录。
 *
 * 这一命名空间（默认 `ptcg-image-cache/v1`）与 Capacitor Preferences 中的身份、
 * 昵称、地址以及后续卡组存储完全分离，`clear()` 只删除本目录下的文件。
 * 所有写入都先落到临时文件名，再原子替换目标；已有完整版本在替换失败时保持
 * 不变。部分原生实现不允许 `rename` 覆盖已存在目标，因此覆盖时先用备份名
 * 挪开旧文件、再改名新文件、最后删除备份；任何一步失败都会尽力恢复旧文件。
 */

export const IMAGE_CACHE_NAMESPACE = 'ptcg-image-cache/v1';

/** 仅包含本模块使用的方法，便于测试注入假实现。 */
export interface FilesystemLike {
  readFile(options: { path: string; directory: Directory }): Promise<{ data: string | Blob }>;
  writeFile(options: { path: string; data: string; directory: Directory; recursive?: boolean }): Promise<unknown>;
  deleteFile(options: { path: string; directory: Directory }): Promise<void>;
  mkdir(options: { path: string; directory: Directory; recursive?: boolean }): Promise<unknown>;
  stat(options: { path: string; directory: Directory }): Promise<unknown>;
  readdir(options: { path: string; directory: Directory }): Promise<{ files: Array<{ name?: string }> }>;
  rename(options: { from: string; to: string; directory: Directory; toDirectory: Directory }): Promise<void>;
  rmdir(options: { path: string; directory: Directory; recursive?: boolean }): Promise<void>;
}

function toStandardBase64(bytes: Uint8Array): string {
  let text = encodeBase64Url(bytes).replace(/-/gu, '+').replace(/_/gu, '/');
  while (text.length % 4 !== 0) {
    text += '=';
  }
  return text;
}

function toBytes(data: string | Blob): Uint8Array {
  if (typeof data !== 'string') {
    throw new Error('Web 端图片读取返回 Blob，应由调用方处理。');
  }
  return decodeBase64Url(data);
}

function tempName(name: string): string {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return `${name}.tmp-${suffix}`;
}

export function createFilesystemImageCacheStorage(
  namespace: string = IMAGE_CACHE_NAMESPACE,
  filesystem: FilesystemLike = Filesystem,
): ImageCacheStorage {
  const base = namespace.replace(/^\/+|\/+$/gu, '');
  const pathOf = (name: string): string => `${base}/${name}`;

  async function ensureNamespace(): Promise<void> {
    try {
      await filesystem.mkdir({ path: base, directory: Directory.Data, recursive: true });
    } catch (error) {
      // 目录已存在时插件可能抛错；只要后续操作能成功就不算失败。
      if (error instanceof Error && /exist/iu.test(error.message)) {
        return;
      }
      try {
        await filesystem.stat({ path: base, directory: Directory.Data });
      } catch {
        throw error;
      }
    }
  }

  async function deleteQuietly(path: string): Promise<void> {
    try {
      await filesystem.deleteFile({ path, directory: Directory.Data });
    } catch {
      /* 目标不存在或删除失败都继续尝试下一步 */
    }
  }

  /**
   * 复核命名空间下实际剩余的文件。与 list() 不同：读目录失败时不假装空目录，
   * 而是先看目录是否已不存在；否则向上报错，让 clear 能发现“无法确认已清空”。
   */
  async function listRemainingStrict(): Promise<readonly string[]> {
    try {
      const result = await filesystem.readdir({ path: base, directory: Directory.Data });
      return result.files.map((entry) => entry.name).filter((name): name is string => typeof name === 'string');
    } catch (error) {
      try {
        await filesystem.stat({ path: base, directory: Directory.Data });
      } catch {
        // 目录不存在：缓存已清空。
        return [];
      }
      throw error;
    }
  }

  /**
   * 用 `from` 替换 `to`。优先直接 rename；原生实现拒绝覆盖时，先把旧目标挪到
   * 备份名、再改名新文件、成功后删备份，失败则尽力把旧文件挪回去。
   */
  async function replaceFile(from: string, to: string): Promise<void> {
    try {
      await filesystem.rename({ from: pathOf(from), to: pathOf(to), directory: Directory.Data, toDirectory: Directory.Data });
      return;
    } catch (renameError) {
      const backup = `${to}.bak-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      let movedToBackup = false;
      try {
        await filesystem.rename({
          from: pathOf(to),
          to: pathOf(backup),
          directory: Directory.Data,
          toDirectory: Directory.Data,
        });
        movedToBackup = true;
      } catch {
        throw renameError;
      }
      try {
        await filesystem.rename({ from: pathOf(from), to: pathOf(to), directory: Directory.Data, toDirectory: Directory.Data });
      } catch (error) {
        if (movedToBackup) {
          // 新文件改名失败：把旧文件恢复回原位置，保证缓存仍完整。
          await filesystem
            .rename({ from: pathOf(backup), to: pathOf(to), directory: Directory.Data, toDirectory: Directory.Data })
            .catch(() => undefined);
        }
        throw error;
      }
      await deleteQuietly(pathOf(backup));
    }
  }

  return {
    async read(name) {
      try {
        const result = await filesystem.readFile({ path: pathOf(name), directory: Directory.Data });
        if (result.data instanceof Blob) {
          return new Uint8Array(await result.data.arrayBuffer());
        }
        return toBytes(result.data);
      } catch {
        return undefined;
      }
    },

    async write(name, bytes) {
      await ensureNamespace();
      const temp = tempName(name);
      try {
        await filesystem.writeFile({
          path: pathOf(temp),
          data: toStandardBase64(bytes),
          directory: Directory.Data,
          recursive: true,
        });
        await replaceFile(temp, name);
      } catch (error) {
        await deleteQuietly(pathOf(temp));
        throw error;
      }
    },

    async remove(name) {
      await deleteQuietly(pathOf(name));
    },

    async list() {
      return listRemainingStrict();
    },

    async clear() {
      const names = await this.list();
      const failures: unknown[] = [];
      for (const name of names) {
        try {
          await filesystem.deleteFile({ path: pathOf(name), directory: Directory.Data });
        } catch (error) {
          failures.push(error);
        }
      }
      // 递归删除目录本身：部分原生实现会连带清理上面单个删除失败的文件。
      try {
        await filesystem.rmdir({ path: base, directory: Directory.Data, recursive: true });
      } catch (error) {
        failures.push(error);
      }
      // 以实际剩余文件为准复核：只剩空目录不算缓存未清；仍有文件则必须报错，
      // 让上层保留索引与占用信息，而不是把未清空的缓存误报为已空。
      const remaining = await listRemainingStrict();
      if (remaining.length > 0) {
        const detail = failures.length === 0 ? '' : `（${failures.length} 次删除操作报错）`;
        throw new Error(`清除图片缓存失败：仍有 ${remaining.length} 个文件未能删除${detail}。`);
      }
    },
  };
}
