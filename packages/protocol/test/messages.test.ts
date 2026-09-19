import { describe, expect, it } from 'vitest';
import {
  isValidNickname,
  normalizeNickname,
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
  supportedProtocolRange,
} from '../src/index.ts';

const publicKey = { crv: 'P-256', kty: 'EC', x: 'abc', y: 'def' };

describe('昵称契约（只用于显示）', () => {
  it('规范化空白并限制长度', () => {
    expect(normalizeNickname('  Ash   Ketchum  ')).toBe('Ash Ketchum');
    expect(isValidNickname('小智')).toBe(true);
    expect(isValidNickname('   ')).toBe(false);
    expect(isValidNickname('a'.repeat(24))).toBe(true);
    expect(isValidNickname('a'.repeat(25))).toBe(false);
  });

  it('拒绝控制字符与零宽字符', () => {
    expect(isValidNickname('bad\u0000name')).toBe(false);
    expect(isValidNickname('bad\u200bname')).toBe(false);
    expect(isValidNickname('bad\nname')).toBe(false);
  });
});

describe('客户端消息解析', () => {
  it('接受合法 hello 并保留字段', () => {
    const raw = JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      deviceId: 'dev_abc',
      publicKey,
      nickname: '小智',
      signature: 'sig',
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('hello');
    }
  });

  it('拒绝非 JSON、缺字段与错误公钥', () => {
    expect(parseClientMessage('not json').ok).toBe(false);
    expect(parseClientMessage('[]').ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'hello' })).ok).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          deviceId: 'dev_abc',
          // 缺失 y 坐标
          publicKey: { crv: 'P-256', kty: 'EC', x: 'abc' },
          nickname: 'x',
          signature: 'sig',
        }),
      ).ok,
    ).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'nope' })).ok).toBe(false);
  });

  it('拒绝把私钥材料当公钥提交', () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        deviceId: 'dev_abc',
        publicKey: { ...publicKey, d: 'private-scalar' },
        nickname: 'x',
        signature: 'sig',
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('hello 必须携带非空签名', () => {
    const base = {
      type: 'hello',
      protocolVersion: 1,
      deviceId: 'dev_abc',
      publicKey,
      nickname: 'x',
    };
    expect(parseClientMessage(JSON.stringify({ ...base, signature: 'sig' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ ...base, signature: '' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify(base)).ok).toBe(false);
  });
});

describe('服务端消息解析', () => {
  it('接受 challenge 并保留协议区间', () => {
    const raw = serializeMessage({
      type: 'challenge',
      protocolVersion: 1,
      supported: supportedProtocolRange(),
      serverVersion: '0.1.0',
      nonce: 'nonce-value',
    });
    const result = parseServerMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'challenge') {
      expect(result.message.nonce).toBe('nonce-value');
      expect(result.message.supported).toEqual(supportedProtocolRange());
    }
  });

  it('接受 welcome 并保留 registered 标志', () => {
    const result = parseServerMessage(
      serializeMessage({
        type: 'welcome',
        protocolVersion: 1,
        serverVersion: '0.1.0',
        sessionId: 's1',
        deviceId: 'dev_abc',
        nickname: '小智',
        registered: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'welcome') {
      expect(result.message.registered).toBe(true);
    }
  });

  it('拒绝未知错误码与缺字段的 welcome', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'error', code: 'made_up', message: 'x' })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ type: 'welcome', protocolVersion: 1 })).ok).toBe(false);
  });

  it('error 消息可携带服务端支持区间', () => {
    const result = parseServerMessage(
      JSON.stringify({
        type: 'error',
        code: 'protocol_incompatible',
        message: '版本不兼容',
        supported: { min: 2, max: 3 },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'error') {
      expect(result.message.supported).toEqual({ min: 2, max: 3 });
    }
  });
});
