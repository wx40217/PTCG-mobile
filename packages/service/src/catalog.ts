import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_CARD_IMAGE_PREFIX,
  CATALOG_RESOURCE_PREFIX,
  computeCatalogVersion,
  parseServiceCatalog,
  type CatalogContent,
  type CatalogRuntime,
  type CatalogRuntimeCardImage,
  type CatalogRuntimeResource,
  type ServiceCatalog,
} from '@ptcg/protocol';
import type { ServiceLogger } from './logger.ts';

/**
 * 卡牌目录的运行时装载。
 *
 * 资料内容来自提交入库的规范产物（`tools/card-catalog/build-catalog.mjs`），
 * 服务启动时：
 *   1. 校验结构并重算 `catalogVersion`，防止产物被悄悄改坏；
 *   2. 按本机配置目录检查图片文件是否存在且哈希一致；
 *   3. 生成运行期覆盖（资源/卡图可用性 + 实际请求路径）。
 *
 * 图片字节不进入仓库、也不进入日志；文件缺失或哈希不符时对应条目保持
 * “不可用”，目录与文字兜底仍然完整。
 */

const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export interface ServiceCatalogOptions {
  /** 目录产物路径；缺省为仓库 `data/catalog/` 下的冻结产物。 */
  readonly catalogPath?: string;
  /** T01 asar 资源样本的导出目录（只含图片字节，文件名来自目录清单）。 */
  readonly resourceDir?: string;
  /** 官方商品图的本地目录，文件名为 `<cardId>.png`。 */
  readonly cardImageDir?: string;
  readonly maxImageBytes?: number;
}

export interface CatalogStore {
  /** 解析后的目录内容；卡组校验直接读取它，不信任客户端声明。 */
  readonly content: CatalogContent | null;
  /** 装载成功时为 64 位十六进制版本；失败为 null。 */
  readonly version: string | null;
  /**
   * 整份响应体（内容 + 运行期覆盖）的 SHA-256；用于 HTTP `ETag`。
   *
   * 不能只用 `version`：同一份内容在不同本机图片配置下运行期覆盖不同，
   * 若沿用内容版本做 ETag，条件请求会返回 304 而让客户端继续使用旧的
   * 图片可用性。失败为 null。
   */
  readonly etag: string | null;
  /** 失败原因（对部署者可见，不含本机敏感路径之外的秘密）。 */
  readonly problem: string | null;
  readonly cardCount: number;
  readonly availableResourceIds: readonly string[];
  readonly availableCardImageIds: readonly string[];
  /** 完整 JSON（内容 + 版本 + 运行期覆盖）；失败时为 null。 */
  servedJson(): string | null;
  readResource(resourceId: string): Buffer | null;
  readCardImage(cardId: string): Buffer | null;
  resourceSha256(resourceId: string): string | null;
  cardImageSha256(cardId: string): string | null;
}

export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function defaultCatalogPath(): string {
  return join(REPO_ROOT, 'data', 'catalog', 'zh-cn-standard-2025-06-05-catalog.json');
}

interface VerifiedFile {
  readonly path: string;
  readonly sha256: string;
  readonly contentType: string;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isSafeBareName(name: string): boolean {
  return name.length > 0 && name === basename(name) && name !== '.' && name !== '..' && !name.includes('\0');
}

function emptyStore(problem: string): CatalogStore {
  return {
    content: null,
    version: null,
    etag: null,
    problem,
    cardCount: 0,
    availableResourceIds: [],
    availableCardImageIds: [],
    servedJson: () => null,
    readResource: () => null,
    readCardImage: () => null,
    resourceSha256: () => null,
    cardImageSha256: () => null,
  };
}

/**
 * 载入目录；任何失败都只让 `/catalog` 返回 503，不阻断健康检查与握手，
 * 因此客户端仍能理解“服务在、目录读取失败”这一状态。
 */
export async function loadCatalogStore(
  options: ServiceCatalogOptions,
  logger: ServiceLogger,
  now: () => number = Date.now,
): Promise<CatalogStore> {
  const catalogPath = options.catalogPath ?? defaultCatalogPath();
  const maxBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  let parsed: ServiceCatalog | null;
  try {
    parsed = parseServiceCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('catalog.load_failed', { reason: message });
    return emptyStore(`无法读取目录产物：${message}`);
  }
  if (parsed === null) {
    logger.warn('catalog.invalid', {});
    return emptyStore('目录产物结构无效。');
  }

  const recomputed = await computeCatalogVersion(parsed.content);
  if (recomputed !== parsed.catalogVersion) {
    logger.warn('catalog.version_mismatch', { declared: parsed.catalogVersion, recomputed });
    return emptyStore('目录版本与内容不一致，已拒绝加载。');
  }

  const resources: Record<string, CatalogRuntimeResource> = {};
  const resourceFiles = new Map<string, VerifiedFile>();
  for (const resource of parsed.content.resources) {
    const fallback: CatalogRuntimeResource = {
      available: false,
      path: null,
      sha256: resource.sha256,
      labelZh: resource.labelZh,
      provenanceZh: resource.provenanceZh,
    };
    if (options.resourceDir === undefined) {
      resources[resource.resourceId] = fallback;
      continue;
    }
    if (!isSafeBareName(resource.file)) {
      logger.warn('catalog.resource_name_rejected', { resourceId: resource.resourceId });
      resources[resource.resourceId] = fallback;
      continue;
    }
    const candidate = join(resolve(options.resourceDir), resource.file);
    const verified = verifyImage(candidate, resource.sha256, maxBytes);
    if (verified === null) {
      logger.warn('catalog.resource_unavailable', { resourceId: resource.resourceId });
      resources[resource.resourceId] = fallback;
      continue;
    }
    resourceFiles.set(resource.resourceId, verified);
    resources[resource.resourceId] = {
      available: true,
      path: `${CATALOG_RESOURCE_PREFIX}/${resource.resourceId}`,
      sha256: resource.sha256,
      labelZh: resource.labelZh,
      provenanceZh: resource.provenanceZh,
    };
  }

  const cardImages: Record<string, CatalogRuntimeCardImage> = {};
  const cardImageFiles = new Map<string, VerifiedFile>();
  for (const card of parsed.content.cards) {
    if (card.imageSource === null) {
      continue;
    }
    const fallback: CatalogRuntimeCardImage = {
      available: false,
      path: null,
      sha256: card.imageSource.sha256,
      labelZh: card.imageSource.labelZh,
      provenanceZh: card.imageSource.provenanceZh,
    };
    if (options.cardImageDir === undefined) {
      cardImages[card.id] = fallback;
      continue;
    }
    if (!isSafeBareName(card.id)) {
      cardImages[card.id] = fallback;
      continue;
    }
    const candidate = join(resolve(options.cardImageDir), `${card.id}.png`);
    const verified = verifyImage(candidate, card.imageSource.sha256, maxBytes);
    if (verified === null) {
      cardImages[card.id] = fallback;
      continue;
    }
    cardImageFiles.set(card.id, verified);
    cardImages[card.id] = {
      available: true,
      path: `${CATALOG_CARD_IMAGE_PREFIX}/${card.id}`,
      sha256: card.imageSource.sha256,
      labelZh: card.imageSource.labelZh,
      provenanceZh: card.imageSource.provenanceZh,
    };
  }

  const runtime: CatalogRuntime = { servedAt: new Date(now()).toISOString(), resources, cardImages };
  const served = JSON.stringify({ ...parsed.content, catalogVersion: parsed.catalogVersion, runtime });
  // ETag 覆盖整份响应体：内容相同但图片配置不同（或重启时间不同）时也必须变化。
  const etag = createHash('sha256').update(served).digest('hex');
  const availableResourceIds = Object.entries(resources)
    .filter(([, entry]) => entry.available)
    .map(([id]) => id);
  const availableCardImageIds = Object.entries(cardImages)
    .filter(([, entry]) => entry.available)
    .map(([id]) => id);

  logger.info('catalog.loaded', {
    version: parsed.catalogVersion,
    cards: parsed.content.cards.length,
    resources: availableResourceIds.length,
    cardImages: availableCardImageIds.length,
  });

  return {
    content: parsed.content,
    version: parsed.catalogVersion,
    etag,
    problem: null,
    cardCount: parsed.content.cards.length,
    availableResourceIds,
    availableCardImageIds,
    servedJson: () => served,
    readResource: (resourceId) => readVerified(resourceFiles.get(resourceId)),
    readCardImage: (cardId) => readVerified(cardImageFiles.get(cardId)),
    resourceSha256: (resourceId) => resourceFiles.get(resourceId)?.sha256 ?? null,
    cardImageSha256: (cardId) => cardImageFiles.get(cardId)?.sha256 ?? null,
  };
}

function verifyImage(path: string, expectedSha256: string, maxBytes: number): VerifiedFile | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) {
      return null;
    }
    const digest = sha256File(path);
    if (digest !== expectedSha256) {
      return null;
    }
    return { path, sha256: digest, contentType: 'image/png' };
  } catch {
    return null;
  }
}

function readVerified(file: VerifiedFile | undefined): Buffer | null {
  if (file === undefined) {
    return null;
  }
  try {
    return existsSync(file.path) ? readFileSync(file.path) : null;
  } catch {
    return null;
  }
}
