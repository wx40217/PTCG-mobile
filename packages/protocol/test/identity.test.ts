import { describe, expect, it } from 'vitest';
import {
  AUTH_PAYLOAD_DOMAIN,
  DEVICE_ID_PREFIX,
  authPayload,
  createDeviceIdentity,
  createNonce,
  deriveDeviceId,
  signAuthPayload,
  verifyAuthSignature,
  type PublicKeyJwk,
} from '../src/index.ts';

describe('设备恢复身份', () => {
  it('设备 ID 由公钥确定性推导，且不含私钥材料', async () => {
    const identity = await createDeviceIdentity();
    const again = await deriveDeviceId(identity.publicKey);
    expect(identity.deviceId).toBe(again);
    expect(identity.deviceId.startsWith(DEVICE_ID_PREFIX)).toBe(true);
    // 公开标识不得能反推私钥标量。
    expect(identity.deviceId).not.toContain(identity.privateKey.d);
    expect(identity.deviceId).toHaveLength(DEVICE_ID_PREFIX.length + 22);
  });

  it('不同设备的 ID 不相同', async () => {
    const first = await createDeviceIdentity();
    const second = await createDeviceIdentity();
    expect(first.deviceId).not.toBe(second.deviceId);
    expect(first.privateKey.d).not.toBe(second.privateKey.d);
  });

  it('待签名内容精确绑定协议版本、设备 ID 与随机数', () => {
    const payload = new TextDecoder().decode(authPayload(1, 'dev_abc', 'nonce123'));
    expect(payload).toBe(`${AUTH_PAYLOAD_DOMAIN}\n1\ndev_abc\nnonce123`);
  });

  it('签名可被对应公钥验证，且对篡改内容失效', async () => {
    const identity = await createDeviceIdentity();
    const nonce = createNonce();
    const signature = await signAuthPayload(identity, nonce, 1);

    expect(await verifyAuthSignature(identity.publicKey, 1, identity.deviceId, nonce, signature)).toBe(true);
    // 换了 nonce：应失败（防重放）。
    expect(await verifyAuthSignature(identity.publicKey, 1, identity.deviceId, createNonce(), signature)).toBe(false);
    // 换了协议版本：应失败（防跨协议重放）。
    expect(await verifyAuthSignature(identity.publicKey, 1, identity.deviceId, nonce, signature)).toBe(true);
    expect(await verifyAuthSignature(identity.publicKey, 2, identity.deviceId, nonce, signature)).toBe(false);
    // 换了设备 ID：应失败。
    expect(await verifyAuthSignature(identity.publicKey, 1, 'dev_other', nonce, signature)).toBe(false);
  });

  it('伪造的公钥无法验证他人签名', async () => {
    const victim = await createDeviceIdentity();
    const attacker = await createDeviceIdentity();
    const nonce = createNonce();
    const signature = await signAuthPayload(attacker, nonce, 1);
    expect(await verifyAuthSignature(victim.publicKey, 1, victim.deviceId, nonce, signature)).toBe(false);
  });

  it('畸形签名输入返回 false 而不是抛错', async () => {
    const identity = await createDeviceIdentity();
    const nonce = createNonce();
    expect(await verifyAuthSignature(identity.publicKey, 1, identity.deviceId, nonce, '***not-base64***')).toBe(false);
    expect(await verifyAuthSignature(identity.publicKey, 1, identity.deviceId, nonce, 'AAAA')).toBe(false);
    const broken = { ...identity.publicKey, x: 'not-a-point' } as PublicKeyJwk;
    expect(await verifyAuthSignature(broken, 1, identity.deviceId, nonce, 'A'.repeat(86))).toBe(false);
  });

  it('每次挑战的随机数都不相同', () => {
    const nonces = new Set(Array.from({ length: 32 }, () => createNonce()));
    expect(nonces.size).toBe(32);
    expect(createNonce().length).toBeGreaterThanOrEqual(43);
  });
});
