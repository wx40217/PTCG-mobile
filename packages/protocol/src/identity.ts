import { decodeBase64Url, encodeBase64Url, randomToken, sha256, utf8 } from './base64url.ts';
import type { PrivateKeyJwk, PublicKeyJwk } from './messages.ts';

/**
 * 设备恢复身份。
 *
 * 客户端在首次启动时生成一对 ECDSA P-256 密钥；私钥保存在设备存储中，是唯一
 * 的恢复凭据，永不离开设备。设备 ID 由公钥推导，是公开标识，可以安全写入日志。
 */
export const DEVICE_ID_PREFIX = 'dev_';
export const DEVICE_ID_DOMAIN = 'ptcg/device-id/v1';
export const AUTH_PAYLOAD_DOMAIN = 'ptcg/auth/v1';

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly publicKey: PublicKeyJwk;
  readonly privateKey: PrivateKeyJwk;
}

/**
 * 公钥的规范序列化。
 *
 * 设备 ID 推导与服务端登记表必须共用这一份实现：字段顺序一旦不一致，同一把
 * 公钥会得到不同的哈希，身份绑定会静默失效。
 */
export function canonicalPublicKey(publicKey: PublicKeyJwk): string {
  return JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y });
}

export async function deriveDeviceId(publicKey: PublicKeyJwk): Promise<string> {
  const digest = await sha256(utf8(`${DEVICE_ID_DOMAIN}\n${canonicalPublicKey(publicKey)}`));
  return `${DEVICE_ID_PREFIX}${encodeBase64Url(digest).slice(0, 22)}`;
}

export async function createDeviceIdentity(): Promise<DeviceIdentity> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as unknown as PublicKeyJwk;
  const privateKey = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as unknown as PrivateKeyJwk;
  const deviceId = await deriveDeviceId(publicKey);
  return { deviceId, publicKey, privateKey };
}

/** 待签名内容：绑定协议版本、设备 ID 与服务端一次性随机数，防止跨协议重放。 */
export function authPayload(protocolVersion: number, deviceId: string, nonce: string): Uint8Array {
  return utf8(`${AUTH_PAYLOAD_DOMAIN}\n${protocolVersion}\n${deviceId}\n${nonce}`);
}

export async function signAuthPayload(identity: DeviceIdentity, nonce: string, protocolVersion: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    identity.privateKey as unknown as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const payload = authPayload(protocolVersion, identity.deviceId, nonce);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload as unknown as ArrayBuffer);
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyAuthSignature(
  publicKey: PublicKeyJwk,
  protocolVersion: number,
  deviceId: string,
  nonce: string,
  signature: string,
): Promise<boolean> {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = decodeBase64Url(signature);
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) {
    return false;
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      publicKey as unknown as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signatureBytes as unknown as ArrayBuffer,
      authPayload(protocolVersion, deviceId, nonce) as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

/** 生成新的服务端一次性挑战随机数。 */
export function createNonce(): string {
  return randomToken(32);
}
