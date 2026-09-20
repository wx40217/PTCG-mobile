import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildResourceBundle,
  checkResourceBundle,
  parsePng,
  resolveInputFile,
  ResourceBundleError,
  writeResourceBundle,
} from './build-resource-bundle.mjs';
import { isResourceBundleVersionValid, parseResourceBundle } from '../../packages/protocol/src/index.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const REAL_CATALOG = join(ROOT, 'data', 'catalog', 'zh-cn-standard-2025-06-05-catalog.json');

/** 构造最小但结构完整的 PNG（不校验 CRC）：测试只关心类型、尺寸与字节哈希。 */
function pngBytes(width, height, seed = 0) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // RGBA
  ihdr[18] = 0;
  ihdr[19] = 0;
  ihdr[20] = 0;
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const payload = Buffer.from(`fixture-${seed}`.repeat(8), 'utf8');
  return Buffer.concat([signature, ihdr, payload, iend]);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ptcg-resource-bundle-'));
  const inputs = join(dir, 'inputs');
  const out = join(dir, 'out');
  mkdirSync(inputs, { recursive: true });
  return { dir, inputs, out, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 真实目录产物 + 两张测试卡图的哈希覆盖：映射来源仍是 T01 目录结构。 */
function catalogFixture(fixtures) {
  const document = JSON.parse(readFileSync(REAL_CATALOG, 'utf8'));
  for (const [cardId, digest] of Object.entries(fixtures)) {
    const card = document.cards.find((entry) => entry.id === cardId);
    assert.ok(card, `目录夹具缺少 ${cardId}`);
    card.imageSource = {
      sha256: digest,
      labelZh: '测试卡图',
      provenanceZh: `T01 测试夹具 ${digest}`,
      articleUrl: 'https://www.pokemon.cn/tcg/product/15551.html',
    };
  }
  return document;
}

test('parsePng 接受竖版 PNG，拒绝截断与横版', () => {
  const portrait = pngBytes(868, 1212);
  assert.deepEqual(parsePng(portrait), { width: 868, height: 1212 });
  assert.equal(parsePng(portrait.subarray(0, 40)), null);
  assert.equal(parsePng(Buffer.from('not-a-png')), null);
});

test('构建资源包：映射来自 T01 目录，记录版本/大小/摘要/印刷身份并保持确定性', async () => {
  const workspace = makeWorkspace();
  try {
    const a = pngBytes(868, 1212, 1);
    const b = pngBytes(868, 1207, 2);
    writeFileSync(join(workspace.inputs, 'csve1-035.png'), a);
    writeFileSync(join(workspace.inputs, 'csv3c-043.png'), b);
    const catalogPath = join(workspace.dir, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify(catalogFixture({ 'csve1-035': sha256(a), 'csv3c-043': sha256(b) })));

    const built = await buildResourceBundle({ inputsDir: workspace.inputs, catalogPath });
    assert.equal(built.manifest.schema, 'ptcg.resource-bundle/v1');
    assert.equal(built.manifest.entryCount, 2);
    assert.equal(built.manifest.totalBytes, a.length + b.length);
    assert.deepEqual(
      built.manifest.entries.map((entry) => entry.cardId),
      ['csv3c-043', 'csve1-035'],
    );
    const csv = built.manifest.entries.find((entry) => entry.cardId === 'csv3c-043');
    assert.equal(csv.sha256, sha256(b));
    assert.equal(csv.bytes, b.length);
    assert.equal(csv.width, 868);
    assert.equal(csv.height, 1207);
    assert.equal(csv.printIdentity, 'print:CSV3C:043/130');
    assert.equal(csv.file, 'images/csv3c-043.png');
    assert.match(csv.articleUrl, /^https:\/\/www\.pokemon\.cn\//u);
    assert.ok(await isResourceBundleVersionValid(built.manifest));

    const again = await buildResourceBundle({ inputsDir: workspace.inputs, catalogPath });
    assert.equal(again.manifest.bundleVersion, built.manifest.bundleVersion);

    writeResourceBundle(workspace.out, built);
    const stored = parseResourceBundle(JSON.parse(readFileSync(join(workspace.out, 'manifest.json'), 'utf8')));
    assert.ok(stored);
    assert.deepEqual(readFileSync(join(workspace.out, 'images', 'csv3c-043.png')), b);
    assert.deepEqual(await checkResourceBundle(workspace.out, built), []);
  } finally {
    workspace.cleanup();
  }
});

test('哈希不一致或未映射卡牌时拒绝，整包不产生半成品', async () => {
  const workspace = makeWorkspace();
  try {
    const bytes = pngBytes(868, 1207, 3);
    writeFileSync(join(workspace.inputs, 'csve1-035.png'), bytes);
    const catalogPath = join(workspace.dir, 'catalog.json');
    // 目录声明一个与文件不同的哈希，模拟“图片被换过/来源不对”。
    writeFileSync(catalogPath, JSON.stringify(catalogFixture({ 'csve1-035': 'f'.repeat(64) })));
    await assert.rejects(
      () => buildResourceBundle({ inputsDir: workspace.inputs, catalogPath }),
      (error) => error instanceof ResourceBundleError && /不一致/u.test(error.message),
    );
    await assert.rejects(
      () =>
        buildResourceBundle({
          inputsDir: workspace.inputs,
          catalogPath,
          entries: ['not-a-card=csve1-035.png'],
        }),
      /不在目录的 T01 已核实卡图中/u,
    );
  } finally {
    workspace.cleanup();
  }
});

test('非 PNG、横版、尺寸超限与目录穿越输入都被拒绝', async () => {
  const workspace = makeWorkspace();
  try {
    const catalogPath = join(workspace.dir, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify(catalogFixture({ 'csve1-035': sha256(pngBytes(868, 1207)) })));
    writeFileSync(join(workspace.inputs, 'csve1-035.png'), Buffer.from('PK\u0003\u0004zip'));
    const bogus = Buffer.from('PK\u0003\u0004zip');
    const bogusCatalog = join(workspace.dir, 'catalog-bogus.json');
    writeFileSync(bogusCatalog, JSON.stringify(catalogFixture({ 'csve1-035': sha256(bogus) })));
    await assert.rejects(
      () => buildResourceBundle({ inputsDir: workspace.inputs, catalogPath: bogusCatalog }),
      /不是结构完整的 PNG/u,
    );

    const landscape = pngBytes(1212, 868);
    writeFileSync(join(workspace.inputs, 'csve1-035.png'), landscape);
    const landscapeCatalog = join(workspace.dir, 'catalog-landscape.json');
    writeFileSync(landscapeCatalog, JSON.stringify(catalogFixture({ 'csve1-035': sha256(landscape) })));
    await assert.rejects(() => buildResourceBundle({ inputsDir: workspace.inputs, catalogPath: landscapeCatalog }), /不是竖版卡面/u);

    const big = pngBytes(868, 1212);
    writeFileSync(join(workspace.inputs, 'csve1-035.png'), big);
    const bigCatalog = join(workspace.dir, 'catalog-big.json');
    writeFileSync(bigCatalog, JSON.stringify(catalogFixture({ 'csve1-035': sha256(big) })));
    await assert.rejects(
      () => buildResourceBundle({ inputsDir: workspace.inputs, catalogPath: bigCatalog, maxImageBytes: big.length - 1 }),
      /超出/u,
    );

    assert.throws(() => resolveInputFile(workspace.inputs, '../secret.png'), /安全的相对路径/u);
    assert.throws(() => resolveInputFile(workspace.inputs, '/etc/passwd'), /安全的相对路径/u);
  } finally {
    workspace.cleanup();
  }
});

test('未映射文件只被忽略不被猜测；check 能发现被篡改的图片与多余文件', async () => {
  const workspace = makeWorkspace();
  try {
    const bytes = pngBytes(868, 1207, 4);
    writeFileSync(join(workspace.inputs, 'csve1-035.png'), bytes);
    writeFileSync(join(workspace.inputs, 'sv1_en_170.png'), pngBytes(1024, 1024, 9));
    writeFileSync(join(workspace.inputs, 'README.txt'), 'not an image');
    const catalogPath = join(workspace.dir, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify(catalogFixture({ 'csve1-035': sha256(bytes) })));

    const built = await buildResourceBundle({ inputsDir: workspace.inputs, catalogPath });
    assert.equal(built.manifest.entryCount, 1);
    assert.ok(built.skipped.includes('sv1_en_170.png'));
    assert.ok(built.skipped.includes('README.txt'));

    writeResourceBundle(workspace.out, built);
    // 篡改资源包图片
    writeFileSync(join(workspace.out, 'images', 'csve1-035.png'), pngBytes(868, 1207, 99));
    const problems = await checkResourceBundle(workspace.out, built);
    assert.ok(problems.some((problem) => /文件大小|哈希/u.test(problem)));
    // 多余图片
    writeResourceBundle(workspace.out, built);
    writeFileSync(join(workspace.out, 'images', 'extra.png'), bytes);
    const extraProblems = await checkResourceBundle(workspace.out, built);
    assert.ok(extraProblems.some((problem) => /未映射的多余图片/u.test(problem)));
  } finally {
    workspace.cleanup();
  }
});

test('真实冻结目录下，--entry 显式指定资源样本会被映射规则拒绝（默认目录不含该样本卡图）', async () => {
  const workspace = makeWorkspace();
  try {
    const bytes = pngBytes(868, 1207, 5);
    writeFileSync(join(workspace.inputs, 'whatever.png'), bytes);
    await assert.rejects(
      () =>
        buildResourceBundle({
          inputsDir: workspace.inputs,
          catalogPath: REAL_CATALOG,
          entries: ['sv1_en_170=whatever.png'],
        }),
      /不在目录的 T01 已核实卡图中/u,
    );
  } finally {
    workspace.cleanup();
  }
});
