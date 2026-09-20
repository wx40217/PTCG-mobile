#!/usr/bin/env node
/**
 * 独立资源准备流程：把 T01 已核实的官方商品文章图整理成可导入、可核验的卡图
 * 资源包（T15 / #16）。
 *
 * 这个工具与玩家的 APK、规则代码完全分离：它只读取部署者显式指定的本机目录，
 * 逐张核对文件哈希必须等于冻结目录中 T01 记录的 `imageSource.sha256`，解析
 * PNG 头确认是竖版卡面，然后输出「元数据清单 + 图片字节目录」。清单含版本、
 * 大小、摘要、出处与规则/印刷身份映射；图片字节不进入仓库，也不上传到任何
 * 地方。玩家端不需要运行这个工具，更不需要私服工具或 NAS。
 *
 * 用法：
 *   node tools/card-resources/build-resource-bundle.mjs \
 *     --inputs <本机图片目录> --out <输出资源包目录> [--catalog <目录产物>]
 *   node tools/card-resources/build-resource-bundle.mjs \
 *     --inputs <本机图片目录> --out <输出目录> --entry csv3c-043=exports/image-a.png
 *   node tools/card-resources/build-resource-bundle.mjs --inputs <目录> --out <目录> --check
 *
 * 输入选择规则（不允许猜测）：
 *   - 默认只收集输入目录下文件名等于某个目录卡牌 id 的 `*.png`；
 *   - `--entry <cardId>=<相对路径>` 可以显式指定文件名，但仍然按卡牌 id 映射；
 *   - 目录里没有对应卡牌的文件会被明确列为“忽略”，不会被当成任何卡的图；
 *   - 任何一张图与 T01 记录哈希不一致即失败，整包不产生半成品。
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_BUNDLE_SCHEMA,
  canonicalJson,
  computeBundleVersion,
  isSafeBundlePath,
  isResourceBundleVersionValid,
  parseCatalogContent,
  parseResourceBundle,
} from '../../packages/protocol/src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DEFAULT_CATALOG = join(ROOT, 'data', 'catalog', 'zh-cn-standard-2025-06-05-catalog.json');
const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 4096;

/** PNG 签名与 IHDR/IEND 结构；工具不解码像素，只确认文件类型与卡面方向。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export class ResourceBundleError extends Error {}

function fail(message) {
  throw new ResourceBundleError(message);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`无法读取 JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 解析 PNG 头并返回尺寸。要求：PNG 签名、13 字节 IHDR、合法位深/颜色类型、
 * 结尾 IEND 完整。这样截断或伪装扩展名的文件不会进入资源包。
 */
export function parsePng(bytes) {
  if (bytes.length < PNG_SIGNATURE.length + 25 + PNG_IEND.length) {
    return null;
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.toString('ascii', 12, 16);
  if (ihdrLength !== 13 || ihdrType !== 'IHDR') {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  if (width === 0 || height === 0) {
    return null;
  }
  if (![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)) {
    return null;
  }
  if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
    return null;
  }
  if (!bytes.subarray(bytes.length - PNG_IEND.length).equals(PNG_IEND)) {
    return null;
  }
  return { width, height };
}

/** 在输入目录内解析相对路径，拒绝目录穿越与符号链接逃逸。 */
export function resolveInputFile(inputsDir, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    fail('输入文件名不能为空。');
  }
  if (!isSafeBundlePath(relativePath)) {
    fail(`输入文件名不是安全的相对路径: ${JSON.stringify(relativePath)}`);
  }
  const root = resolve(inputsDir);
  const candidate = resolve(root, ...relativePath.split('/'));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    fail(`输入文件越出 --inputs 目录: ${JSON.stringify(relativePath)}`);
  }
  try {
    if (lstatSync(candidate).isSymbolicLink()) {
      fail(`拒绝符号链接输入: ${relativePath}`);
    }
  } catch (error) {
    fail(`输入文件不存在: ${relativePath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  return candidate;
}

function cardImageMap(catalogPath) {
  let parsed;
  try {
    parsed = parseCatalogContent(JSON.parse(readFileSync(catalogPath, 'utf8')));
  } catch (error) {
    fail(`无法读取目录产物 ${catalogPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null) {
    fail(`目录产物结构无效: ${relative(ROOT, catalogPath)}`);
  }
  const byId = new Map();
  for (const card of parsed.cards) {
    if (card.imageSource === null) {
      continue;
    }
    if (byId.has(card.id)) {
      fail(`目录中出现重复卡牌 id: ${card.id}`);
    }
    byId.set(card.id, {
      cardId: card.id,
      printIdentity: card.identities.printIdentity,
      sha256: card.imageSource.sha256,
      articleUrl: card.imageSource.articleUrl,
      provenanceZh: card.imageSource.provenanceZh,
    });
  }
  if (byId.size === 0) {
    fail('目录产物没有声明任何 T01 已核实卡图。');
  }
  return { environment: parsed.environment.id, byId, cardCount: parsed.cards.length };
}

/**
 * 为显式选择的输入构建资源包清单。
 *
 * @returns {{manifest: object, files: Map<string, Buffer>, skipped: string[]}}
 */
export async function buildResourceBundle(options) {
  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG;
  const inputsDir = resolve(options.inputsDir);
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  if (!statSync(inputsDir).isDirectory()) {
    fail(`--inputs 不是目录: ${inputsDir}`);
  }
  const catalog = cardImageMap(catalogPath);

  const selection = new Map();
  if (options.entries !== undefined && options.entries.length > 0) {
    for (const item of options.entries) {
      const separator = item.indexOf('=');
      if (separator <= 0 || separator === item.length - 1) {
        fail(`--entry 需要用 cardId=相对路径 的形式，收到 ${JSON.stringify(item)}`);
      }
      const cardId = item.slice(0, separator);
      const file = item.slice(separator + 1);
      if (!catalog.byId.has(cardId)) {
        fail(`--entry 的卡牌 ${cardId} 不在目录的 T01 已核实卡图中，不猜测映射。`);
      }
      if (selection.has(cardId)) {
        fail(`--entry 重复指定卡牌 ${cardId}`);
      }
      selection.set(cardId, file);
    }
  } else {
    for (const name of readdirSync(inputsDir).sort()) {
      if (!name.toLowerCase().endsWith('.png')) {
        continue;
      }
      const cardId = name.slice(0, -4);
      if (!catalog.byId.has(cardId)) {
        continue;
      }
      selection.set(cardId, name);
    }
    if (selection.size === 0) {
      fail(
        `--inputs 目录里没有文件名等于目录卡牌 id 的 PNG；可用 --entry cardId=相对路径 显式指定。目录共有 ${catalog.byId.size} 张 T01 已核实卡图。`,
      );
    }
  }

  const skipped = [];
  const entries = [];
  const files = new Map();
  const seenSha = new Map();
  for (const [cardId, relativePath] of [...selection.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const expected = catalog.byId.get(cardId);
    const path = resolveInputFile(inputsDir, relativePath);
    const stats = statSync(path);
    if (!stats.isFile()) {
      fail(`输入不是普通文件: ${relativePath}`);
    }
    if (stats.size === 0 || stats.size > maxImageBytes) {
      fail(`图片 ${relativePath} 大小 ${stats.size} 字节超出 1..${maxImageBytes} 范围。`);
    }
    const bytes = readFileSync(path);
    const digest = sha256Bytes(bytes);
    if (digest !== expected.sha256) {
      fail(
        `图片 ${relativePath}（卡牌 ${cardId}）SHA-256 为 ${digest}，与 T01 目录记录的 ${expected.sha256} 不一致；拒绝把不匹配的图片当作该卡。`,
      );
    }
    const png = parsePng(bytes);
    if (png === null) {
      fail(`图片 ${relativePath}（卡牌 ${cardId}）不是结构完整的 PNG。`);
    }
    if (png.width > maxDimension || png.height > maxDimension) {
      fail(`图片 ${relativePath} 尺寸 ${png.width}×${png.height} 超出 ${maxDimension} 上限。`);
    }
    if (png.height <= png.width) {
      fail(`图片 ${relativePath} 尺寸 ${png.width}×${png.height} 不是竖版卡面；拒绝横版/方图冒充卡图。`);
    }
    const file = `images/${cardId}.png`;
    entries.push({
      cardId,
      printIdentity: expected.printIdentity,
      file,
      sha256: digest,
      bytes: bytes.length,
      width: png.width,
      height: png.height,
      mediaType: 'image/png',
      articleUrl: expected.articleUrl,
      provenanceZh: expected.provenanceZh,
    });
    files.set(file, bytes);
    const duplicate = seenSha.get(digest);
    if (duplicate !== undefined) {
      // 同一图片字节出现在两张卡上不一定是错误（重印），但要记录出来供人工核对。
      skipped.push(`note:${cardId}=same-bytes-as:${duplicate}`);
    } else {
      seenSha.set(digest, cardId);
    }
  }

  for (const name of readdirSync(inputsDir).sort()) {
    const candidate = name.toLowerCase().endsWith('.png') ? name.slice(0, -4) : null;
    if (candidate !== null && catalog.byId.has(candidate)) {
      continue;
    }
    if (options.entries === undefined || options.entries.length === 0) {
      skipped.push(name);
    }
  }

  const bundleId = `${catalog.environment}-card-images`;
  const core = { schema: RESOURCE_BUNDLE_SCHEMA, bundleId, environment: catalog.environment, entries };
  const bundleVersion = await computeBundleVersion(core);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const manifest = {
    ...core,
    bundleVersion,
    generatedBy: 'tools/card-resources/build-resource-bundle.mjs',
    entryCount: entries.length,
    totalBytes,
    source: {
      kind: 't01-verified-official-article-images',
      noteZh:
        '条目只来自 T01 目录中记录 imageSource.sha256 的官方商品文章图；每张图片的字节哈希必须与目录记录一致，未映射的文件不会被采用。',
    },
    redistributionZh:
      '图片字节仅由部署者本机保存与部署，不提交仓库、不外传；卡牌图像版权归原权利人。',
  };
  return { manifest, files, skipped, catalogCards: catalog.cardCount };
}

/** 原子写入单个文件：先写临时文件再改名，避免半成品进入资源包。 */
function writeFileAtomic(path, bytes) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, bytes);
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* 尽力清理 */
    }
    throw error;
  }
}

export function writeResourceBundle(outDir, built) {
  mkdirSync(join(outDir, 'images'), { recursive: true });
  for (const [file, bytes] of built.files) {
    writeFileAtomic(join(outDir, ...file.split('/')), bytes);
  }
  writeFileAtomic(join(outDir, 'manifest.json'), `${JSON.stringify(built.manifest, null, 2)}\n`);
}

/**
 * 校验已有资源包与输入是否一致：清单结构与版本、每个文件的大小与哈希、
 * 目录里没有未映射的多余图片。返回问题列表，空数组表示通过。
 */
export async function checkResourceBundle(outDir, built) {
  const problems = [];
  let existing;
  try {
    existing = parseResourceBundle(readJson(join(outDir, 'manifest.json')));
  } catch (error) {
    return [`资源包清单不存在或不可读: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (existing === null) {
    return ['资源包清单结构无效。'];
  }
  if (!(await isResourceBundleVersionValid(existing))) {
    problems.push('资源包 bundleVersion 与内容不一致。');
  }
  if (canonicalJson(existing) !== canonicalJson(built.manifest)) {
    problems.push('资源包清单与当前输入构建结果不一致（图片、映射或元数据已变化）。');
  }
  for (const entry of existing.entries) {
    if (!isSafeBundlePath(entry.file)) {
      problems.push(`条目 ${entry.cardId} 的文件名不安全。`);
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(join(outDir, ...entry.file.split('/')));
    } catch {
      problems.push(`条目 ${entry.cardId} 的图片文件缺失: ${entry.file}`);
      continue;
    }
    if (bytes.length !== entry.bytes) {
      problems.push(`条目 ${entry.cardId} 文件大小 ${bytes.length} != 清单 ${entry.bytes}。`);
    }
    if (sha256Bytes(bytes) !== entry.sha256) {
      problems.push(`条目 ${entry.cardId} 文件哈希与清单不一致。`);
    }
  }
  const expectedFiles = new Set(existing.entries.map((entry) => entry.file));
  let actualFiles = [];
  try {
    actualFiles = readdirSync(join(outDir, 'images')).map((name) => `images/${name}`);
  } catch {
    problems.push('资源包缺少 images 目录。');
  }
  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) {
      problems.push(`资源包存在未映射的多余图片: ${file}`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

function readFlag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`--${name} 需要一个值。`);
  }
  return value;
}

function readRepeated(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}`) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`--${name} 需要一个值。`);
      }
      values.push(value);
    }
  }
  return values;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputsDir = readFlag(argv, 'inputs');
  const outDir = readFlag(argv, 'out');
  if (inputsDir === undefined || outDir === undefined) {
    fail('用法: node tools/card-resources/build-resource-bundle.mjs --inputs <目录> --out <目录> [--entry cardId=相对路径] [--check]');
  }
  const checkOnly = argv.includes('--check');
  const catalogPath = readFlag(argv, 'catalog');
  const maxImageBytesRaw = readFlag(argv, 'max-image-bytes');
  const built = await buildResourceBundle({
    inputsDir,
    ...(catalogPath === undefined ? {} : { catalogPath }),
    ...(maxImageBytesRaw === undefined ? {} : { maxImageBytes: Number.parseInt(maxImageBytesRaw, 10) }),
    entries: readRepeated(argv, 'entry'),
  });

  if (built.skipped.length > 0) {
    const ignored = built.skipped.filter((item) => !item.startsWith('note:'));
    const notes = built.skipped.filter((item) => item.startsWith('note:'));
    if (ignored.length > 0) {
      console.log(`build-resource-bundle: 忽略 ${ignored.length} 个未映射文件：${ignored.join('、')}`);
    }
    for (const note of notes) {
      console.log(`build-resource-bundle: 提示 ${note}`);
    }
  }

  if (checkOnly) {
    const problems = await checkResourceBundle(resolve(outDir), built);
    if (problems.length > 0) {
      for (const problem of problems) {
        console.error(`build-resource-bundle: ${problem}`);
      }
      process.exit(1);
    }
    console.log(
      `build-resource-bundle: 校验通过（bundleVersion=${built.manifest.bundleVersion}，${built.manifest.entryCount} 张，${built.manifest.totalBytes} 字节）`,
    );
    return;
  }

  writeResourceBundle(resolve(outDir), built);
  console.log(
    `build-resource-bundle: 已写入 ${relative(ROOT, resolve(outDir)) || '.'}（bundleVersion=${built.manifest.bundleVersion}，${built.manifest.entryCount} 张，${built.manifest.totalBytes} 字节）`,
  );
}

const isMainEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainEntry) {
  main().catch((error) => {
    if (error instanceof ResourceBundleError) {
      console.error(`build-resource-bundle: ${error.message}`);
    } else {
      console.error(`build-resource-bundle: 未处理错误：${error instanceof Error ? error.stack : String(error)}`);
    }
    process.exit(1);
  });
}
