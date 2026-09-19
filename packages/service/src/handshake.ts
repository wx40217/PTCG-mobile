import {
  NICKNAME_MAX_LENGTH,
  PROTOCOL_VERSION,
  createNonce,
  deriveDeviceId,
  isProtocolCompatible,
  isValidNickname,
  normalizeNickname,
  parseClientMessage,
  supportedProtocolRange,
  verifyAuthSignature,
  type ServerChallenge,
  type ServerError,
  type ServerWelcome,
} from '@ptcg/protocol';
import type { ServiceLogger } from './logger.ts';
import type { DeviceRegistry } from './registry.ts';

/** 握手阶段的 WebSocket 关闭码：让对端不用解析文本就知道拒绝类别。 */
export const CLOSE_IDENTITY_REJECTED = 4001;
export const CLOSE_PROTOCOL_INCOMPATIBLE = 4002;
export const CLOSE_INVALID_MESSAGE = 4003;

export interface HandshakeContext {
  readonly registry: DeviceRegistry;
  readonly logger: ServiceLogger;
  readonly serverVersion: string;
  readonly now: () => number;
  /** 连接建立时下发的挑战随机数；客户端必须对它签名。 */
  readonly nonce: string;
}

export type HelloOutcome =
  | { readonly kind: 'welcome'; readonly message: ServerWelcome }
  | { readonly kind: 'error'; readonly message: ServerError; readonly closeCode: number };

/** 连接建立后立即下发的挑战；不含任何凭据信息。 */
export function createChallenge(serverVersion: string): ServerChallenge {
  return {
    type: 'challenge',
    protocolVersion: PROTOCOL_VERSION,
    supported: supportedProtocolRange(),
    serverVersion,
    nonce: createNonce(),
  };
}

function reject(message: string, closeCode: number, code: ServerError['code'] = 'identity_rejected'): HelloOutcome {
  return { kind: 'error', message: { type: 'error', code, message }, closeCode };
}

/**
 * 处理客户端的 `hello`。
 *
 * 校验顺序刻意从「不涉及身份」到「涉及身份」：协议版本 → 消息结构 → 昵称 →
 * 设备 ID 与公钥的绑定 → 签名。任何一步失败都只回错误类别，绝不回显收到的内容，
 * 避免把凭据材料写进错误文本或日志。
 */
export async function acceptHello(raw: string, context: HandshakeContext): Promise<HelloOutcome> {
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    return {
      kind: 'error',
      message: { type: 'error', code: 'invalid_message', message: `无法解析握手消息：${parsed.error}` },
      closeCode: CLOSE_INVALID_MESSAGE,
    };
  }
  const hello = parsed.message;

  if (!isProtocolCompatible(hello.protocolVersion)) {
    context.logger.warn('handshake.protocol_incompatible', {
      received: hello.protocolVersion,
      supported: supportedProtocolRange(),
    });
    return {
      kind: 'error',
      message: {
        type: 'error',
        code: 'protocol_incompatible',
        message: `服务支持协议版本 ${PROTOCOL_VERSION}，收到 ${hello.protocolVersion}。`,
        supported: supportedProtocolRange(),
      },
      closeCode: CLOSE_PROTOCOL_INCOMPATIBLE,
    };
  }

  if (!isValidNickname(hello.nickname)) {
    return reject(
      `昵称不合法：长度需为 1-${NICKNAME_MAX_LENGTH} 且不含控制字符。`,
      CLOSE_INVALID_MESSAGE,
      'invalid_message',
    );
  }

  // 设备 ID 必须由公钥推导得到，否则客户端可以冒用他人的公开标识。
  const expectedDeviceId = await deriveDeviceId(hello.publicKey);
  if (expectedDeviceId !== hello.deviceId) {
    context.logger.warn('handshake.device_id_mismatch', { deviceId: hello.deviceId });
    return reject('设备标识与公钥不匹配，请重置本机身份后重试。', CLOSE_IDENTITY_REJECTED);
  }

  const verified = await verifyAuthSignature(
    hello.publicKey,
    hello.protocolVersion,
    hello.deviceId,
    context.nonce,
    hello.signature,
  );
  if (!verified) {
    context.logger.warn('handshake.identity_rejected', { deviceId: hello.deviceId });
    return reject('身份验证失败：签名与服务端挑战不匹配。', CLOSE_IDENTITY_REJECTED);
  }

  const nickname = normalizeNickname(hello.nickname);
  const upsert = context.registry.upsert({
    deviceId: hello.deviceId,
    publicKey: hello.publicKey,
    nickname,
    now: context.now(),
  });
  if (!upsert.ok) {
    context.logger.error('handshake.public_key_conflict', { deviceId: hello.deviceId });
    return reject('设备已登记为另一把公钥，拒绝以新公钥接管。', CLOSE_IDENTITY_REJECTED);
  }

  context.logger.info('handshake.accepted', {
    deviceId: hello.deviceId,
    registered: upsert.registered,
    nicknameLength: nickname.length,
  });

  return {
    kind: 'welcome',
    message: {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: context.serverVersion,
      sessionId: createNonce(),
      deviceId: hello.deviceId,
      nickname: upsert.device.nickname,
      registered: upsert.registered,
    },
  };
}
