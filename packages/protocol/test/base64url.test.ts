import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url,
  encodeBase64Url,
  randomBytes,
  sha256,
} from '../src/base64url.ts';

describe('base64url 编解码', () => {
  it('与已知向量一致', () => {
    // RFC 4648 §10 测试向量（去掉填充）。
    expect(encodeBase64Url(new TextEncoder().encode(''))).toBe('');
    expect(encodeBase64Url(new TextEncoder().encode('f'))).toBe('Zg');
    expect(encodeBase64Url(new TextEncoder().encode('fo'))).toBe('Zm8');
    expect(encodeBase64Url(new TextEncoder().encode('foo'))).toBe('Zm9v');
    expect(encodeBase64Url(new TextEncoder().encode('foob'))).toBe('Zm9vYg');
    expect(encodeBase64Url(new TextEncoder().encode('fooba'))).toBe('Zm9vYmE');
    expect(encodeBase64Url(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy');
  });

  it('使用 URL 安全字符集而不是标准 base64 字符', () => {
    // 0xFF 0xFF 0xFF -> 标准 base64 "////"，URL 安全应为 "____"。
    expect(encodeBase64Url(new Uint8Array([0xff, 0xff, 0xff]))).toBe('____');
  });

  it('解码可还原任意字节，且接受标准 base64 字符与填充', () => {
    const original = randomBytes(64);
    expect(Array.from(decodeBase64Url(encodeBase64Url(original)))).toEqual(Array.from(original));
    expect(Array.from(decodeBase64Url('____'))).toEqual([0xff, 0xff, 0xff]);
    expect(Array.from(decodeBase64Url('Zg=='))).toEqual(Array.from(new TextEncoder().encode('f')));
    expect(Array.from(decodeBase64Url('//8='))).toEqual([0xff, 0xff]);
  });

  it('非法字符会抛错而不是静默出错', () => {
    expect(() => decodeBase64Url('a*b')).toThrow(/非法/u);
  });

  it('sha256 与已知摘要一致', async () => {
    const digest = await sha256(new TextEncoder().encode('abc'));
    expect(encodeBase64Url(digest)).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('randomBytes 长度正确且具备随机性', () => {
    expect(randomBytes(32)).toHaveLength(32);
    expect(encodeBase64Url(randomBytes(32))).not.toBe(encodeBase64Url(randomBytes(32)));
  });
});
