import { sha256, utf8 } from './base64url.ts';
import { canonicalJson } from './catalog.ts';

/**
 * 可导入卡图资源包（T15）的公共契约。
 *
 * 资源包由独立于 APK 的资源准备流程（`tools/card-resources/build-resource-bundle.mjs`）
 * 从 T01 已核实资料生成本机目录产物：每个条目只包含元数据（版本、大小、摘要、
 * 出处、印刷身份映射）与相对文件名，图片字节仍由部署者本机持有，不提交仓库。
 * 服务可用 `--resource-bundle <目录>` 直接装载该目录，逐条校验哈希与大小；
 * 客户端则按目录中声明的 `sha256` 按需下载并缓存在自己的图片命名空间里。
 *
 * `bundleVersion` 覆盖「映射与元数据」的规范 JSON 哈希；加入或替换图片必须产生
 * 新版本，否则部署者无法仅凭哈希判断本机目录是否就是被验收的那一份。
 */

export const RESOURCE_BUNDLE_SCHEMA = 'ptcg.resource-bundle/v1';

export interface ResourceBundleEntry {
  /** 目录卡牌 id；与 T01 印刷身份映射绑定。 */
  readonly cardId: string;
  /** 印刷身份（商品 + 编号），用于人工核对映射不是猜出来的。 */
  readonly printIdentity: string;
  /** 资源包根目录下的相对文件名；必须是单一路径段序列，禁止绝对路径。 */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly mediaType: string;
  /** T01 已核实的官方商品文章地址。 */
  readonly articleUrl: string;
  readonly provenanceZh: string;
}

export interface ResourceBundleSource {
  readonly kind: string;
  readonly noteZh: string;
}

export interface ResourceBundle {
  readonly schema: string;
  readonly bundleId: string;
  readonly environment: string;
  /** 规范 JSON（schema/bundleId/environment/entries）的 SHA-256。 */
  readonly bundleVersion: string;
  readonly generatedBy: string;
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly entries: readonly ResourceBundleEntry[];
  readonly source: ResourceBundleSource;
  readonly redistributionZh: string;
}

/** 参与 `bundleVersion` 计算的规范核心：图片映射与元数据，不含统计冗余字段。 */
export interface ResourceBundleCore {
  readonly schema: string;
  readonly bundleId: string;
  readonly environment: string;
  readonly entries: readonly ResourceBundleEntry[];
}

function encodeHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

export async function computeBundleVersion(core: ResourceBundleCore): Promise<string> {
  return encodeHex(await sha256(utf8(canonicalJson(core))));
}

export async function isResourceBundleVersionValid(bundle: {
  readonly schema: string;
  readonly bundleId: string;
  readonly environment: string;
  readonly entries: readonly ResourceBundleEntry[];
  readonly bundleVersion: string;
}): Promise<boolean> {
  try {
    const computed = await computeBundleVersion({
      schema: bundle.schema,
      bundleId: bundle.bundleId,
      environment: bundle.environment,
      entries: bundle.entries,
    });
    return computed === bundle.bundleVersion;
  } catch {
    return false;
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * 资源包内文件名的安全校验：允许 `images/x.png` 这类相对路径段，禁止绝对路径、
 * `..`、反斜杠、空段与控制字符；服务与工具都以此拒绝目录穿越。
 */
export function isSafeBundlePath(name: string): boolean {
  if (name.length === 0 || name.length > 256 || name.includes('\\') || name.includes('\0')) {
    return false;
  }
  if (name.startsWith('/') || name.startsWith('~')) {
    return false;
  }
  const segments = name.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function parseEntry(value: unknown): ResourceBundleEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const { cardId, printIdentity, file, sha256: digest, bytes, width, height, mediaType, articleUrl, provenanceZh } = value;
  if (
    !isString(cardId) ||
    cardId.length === 0 ||
    !isString(printIdentity) ||
    printIdentity.length === 0 ||
    !isString(file) ||
    !isSafeBundlePath(file) ||
    !isString(digest) ||
    !HEX64.test(digest) ||
    !isPositiveInteger(bytes) ||
    !isPositiveInteger(width) ||
    !isPositiveInteger(height) ||
    !isString(mediaType) ||
    !isString(articleUrl) ||
    !isString(provenanceZh)
  ) {
    return null;
  }
  return { cardId, printIdentity, file, sha256: digest, bytes, width, height, mediaType, articleUrl, provenanceZh };
}

/** 解析资源包清单；结构或统计字段不一致时返回 null。 */
export function parseResourceBundle(value: unknown): ResourceBundle | null {
  if (!isRecord(value)) {
    return null;
  }
  const { schema, bundleId, environment, bundleVersion, generatedBy, entryCount, totalBytes, entries, source, redistributionZh } =
    value;
  if (
    schema !== RESOURCE_BUNDLE_SCHEMA ||
    !isString(bundleId) ||
    bundleId.length === 0 ||
    !isString(environment) ||
    !isString(bundleVersion) ||
    !HEX64.test(bundleVersion) ||
    !isString(generatedBy) ||
    !isPositiveInteger(entryCount) ||
    !isPositiveInteger(totalBytes) ||
    !Array.isArray(entries) ||
    entries.length === 0 ||
    !isRecord(source) ||
    !isString(source['kind']) ||
    !isString(source['noteZh']) ||
    !isString(redistributionZh)
  ) {
    return null;
  }
  const parsedEntries: ResourceBundleEntry[] = [];
  const seen = new Set<string>();
  let summed = 0;
  for (const entry of entries) {
    const parsed = parseEntry(entry);
    if (parsed === null || seen.has(parsed.cardId)) {
      return null;
    }
    seen.add(parsed.cardId);
    summed += parsed.bytes;
    parsedEntries.push(parsed);
  }
  if (entryCount !== parsedEntries.length || totalBytes !== summed) {
    return null;
  }
  return {
    schema,
    bundleId,
    environment,
    bundleVersion,
    generatedBy,
    entryCount,
    totalBytes,
    entries: parsedEntries,
    source: { kind: source['kind'], noteZh: source['noteZh'] },
    redistributionZh,
  };
}
