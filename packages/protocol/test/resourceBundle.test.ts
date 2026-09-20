import { describe, expect, it } from 'vitest';
import {
  RESOURCE_BUNDLE_SCHEMA,
  computeBundleVersion,
  isResourceBundleVersionValid,
  isSafeBundlePath,
  parseResourceBundle,
} from '../src/index.ts';

const ENTRY = {
  cardId: 'csv3c-043',
  printIdentity: 'print:CSV3C:043/130',
  file: 'images/csv3c-043.png',
  sha256: 'a'.repeat(64),
  bytes: 1234,
  width: 868,
  height: 1212,
  mediaType: 'image/png',
  articleUrl: 'https://www.pokemon.cn/tcg/product/15582.html',
  provenanceZh: 'T01 已核实。',
};

async function bundle(entries: readonly (typeof ENTRY)[] = [ENTRY]) {
  const core = { schema: RESOURCE_BUNDLE_SCHEMA, bundleId: 'test-bundle', environment: 'test-env', entries };
  const bundleVersion = await computeBundleVersion(core);
  return {
    ...core,
    bundleVersion,
    generatedBy: 'tools/card-resources/build-resource-bundle.mjs',
    entryCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    source: { kind: 'test', noteZh: '测试来源' },
    redistributionZh: '仅测试',
  };
}

describe('资源包清单契约', () => {
  it('合法清单可解析且版本可复核', async () => {
    const manifest = await bundle();
    const parsed = parseResourceBundle(manifest);
    expect(parsed).not.toBeNull();
    expect(parsed?.entries).toHaveLength(1);
    expect(parsed?.totalBytes).toBe(1234);
    expect(await isResourceBundleVersionValid(parsed!)).toBe(true);
  });

  it('条目被篡改后版本校验失败', async () => {
    const manifest = await bundle();
    const tampered = { ...manifest, entries: [{ ...ENTRY, sha256: 'b'.repeat(64) }] };
    const parsed = parseResourceBundle(tampered);
    expect(parsed).not.toBeNull();
    expect(await isResourceBundleVersionValid(parsed!)).toBe(false);
  });

  it('拒绝目录穿越文件名与重复卡牌', async () => {
    expect(isSafeBundlePath('images/a.png')).toBe(true);
    expect(isSafeBundlePath('../a.png')).toBe(false);
    expect(isSafeBundlePath('/a.png')).toBe(false);
    expect(isSafeBundlePath('a\\b.png')).toBe(false);
    expect(parseResourceBundle(await bundle([{ ...ENTRY, file: '../secret.png' }]))).toBeNull();
    expect(parseResourceBundle(await bundle([ENTRY, { ...ENTRY, file: 'images/other.png' }]))).toBeNull();
  });

  it('统计字段必须与条目一致', async () => {
    const manifest = await bundle();
    expect(parseResourceBundle({ ...manifest, entryCount: 2 })).toBeNull();
    expect(parseResourceBundle({ ...manifest, totalBytes: 1 })).toBeNull();
    expect(parseResourceBundle({ ...manifest, entries: [] })).toBeNull();
    expect(parseResourceBundle({ ...manifest, schema: 'other' })).toBeNull();
  });
});
