import type { ProtocolRange } from './version.ts';
import {
  parseMatchClientMessage,
  parseMatchServerMessage,
  type MatchClientMessage,
  type MatchServerMessage,
} from './match.ts';
import {
  parseRoomClientMessage,
  parseRoomServerMessage,
  type RoomClientMessage,
  type RoomServerMessage,
} from './room.ts';

/** 昵称只用于显示：长度受限、不允许控制字符，且不参与身份判定。 */
export const NICKNAME_MAX_LENGTH = 24;

export function normalizeNickname(raw: string): string {
  return raw.replace(/\s+/gu, ' ').trim();
}

/** 禁止 C0/C1 控制字符与零宽字符，避免日志注入与显示欺骗。 */
const FORBIDDEN_NICKNAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029]/u;

export function isValidNickname(raw: string): boolean {
  // 必须在规范化之前检查：规范化会把换行、制表符折叠成空格从而掩盖它们。
  if (FORBIDDEN_NICKNAME_CHARACTERS.test(raw)) {
    return false;
  }
  const normalized = normalizeNickname(raw);
  return normalized.length >= 1 && normalized.length <= NICKNAME_MAX_LENGTH;
}

export interface PublicKeyJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
}

export interface PrivateKeyJwk extends PublicKeyJwk {
  readonly d: string;
}

export interface ClientHello {
  readonly type: 'hello';
  readonly protocolVersion: number;
  readonly deviceId: string;
  readonly publicKey: PublicKeyJwk;
  readonly nickname: string;
  /** 对服务端一次性随机数的 ECDSA P-256 签名，证明持有私钥。 */
  readonly signature: string;
}

export type ClientMessage = ClientHello | RoomClientMessage | MatchClientMessage;

export interface ServerChallenge {
  readonly type: 'challenge';
  readonly protocolVersion: number;
  readonly supported: ProtocolRange;
  readonly serverVersion: string;
  readonly nonce: string;
}

export interface ServerWelcome {
  readonly type: 'welcome';
  readonly protocolVersion: number;
  readonly serverVersion: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly nickname: string;
  /** 本次连接是否在服务端首次登记该设备。 */
  readonly registered: boolean;
}

/** 协议错误码：类型与运行时校验共用同一个列表，避免新增码时漏改一处。 */
export const PROTOCOL_ERROR_CODES = [
  'protocol_incompatible',
  'identity_rejected',
  'invalid_message',
  'internal_error',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && (PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}

export interface ServerError {
  readonly type: 'error';
  readonly code: ProtocolErrorCode;
  /** 面向界面的说明，禁止包含任何凭据材料。 */
  readonly message: string;
  readonly supported?: ProtocolRange;
}

export type ServerMessage = ServerChallenge | ServerWelcome | ServerError | RoomServerMessage | MatchServerMessage;

export type ParseResult<T> = { readonly ok: true; readonly message: T } | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPublicKeyJwk(value: unknown): value is PublicKeyJwk {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['kty'] === 'EC' &&
    value['crv'] === 'P-256' &&
    typeof value['x'] === 'string' &&
    typeof value['y'] === 'string' &&
    !('d' in value)
  );
}

function isProtocolRange(value: unknown): value is ProtocolRange {
  return isRecord(value) && Number.isInteger(value['min']) && Number.isInteger(value['max']);
}

export function serializeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: '消息不是合法 JSON' };
  }
  if (!isRecord(decoded)) {
    return { ok: false, error: '消息必须是 JSON 对象' };
  }
  const type = decoded['type'];
  const roomMessage = parseRoomClientMessage(decoded);
  if (roomMessage !== null) {
    return roomMessage;
  }
  const matchMessage = parseMatchClientMessage(decoded);
  if (matchMessage !== null) {
    return matchMessage;
  }
  if (type === 'hello') {
    if (!Number.isInteger(decoded['protocolVersion'])) {
      return { ok: false, error: 'hello.protocolVersion 必须是整数' };
    }
    if (typeof decoded['deviceId'] !== 'string' || decoded['deviceId'].length === 0) {
      return { ok: false, error: 'hello.deviceId 缺失' };
    }
    if (!isPublicKeyJwk(decoded['publicKey'])) {
      return { ok: false, error: 'hello.publicKey 不是 P-256 公钥' };
    }
    if (typeof decoded['nickname'] !== 'string') {
      return { ok: false, error: 'hello.nickname 缺失' };
    }
    if (typeof decoded['signature'] !== 'string' || decoded['signature'].length === 0) {
      return { ok: false, error: 'hello.signature 缺失' };
    }
    return {
      ok: true,
      message: {
        type: 'hello',
        protocolVersion: decoded['protocolVersion'] as number,
        deviceId: decoded['deviceId'],
        publicKey: decoded['publicKey'],
        nickname: decoded['nickname'],
        signature: decoded['signature'],
      },
    };
  }
  return { ok: false, error: `未知的客户端消息类型: ${String(type)}` };
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: '消息不是合法 JSON' };
  }
  if (!isRecord(decoded)) {
    return { ok: false, error: '消息必须是 JSON 对象' };
  }
  const type = decoded['type'];
  const roomMessage = parseRoomServerMessage(decoded);
  if (roomMessage !== null) {
    return roomMessage;
  }
  const matchMessage = parseMatchServerMessage(decoded);
  if (matchMessage !== null) {
    return matchMessage;
  }
  if (type === 'challenge') {
    if (!Number.isInteger(decoded['protocolVersion'])) {
      return { ok: false, error: 'challenge.protocolVersion 必须是整数' };
    }
    if (!isProtocolRange(decoded['supported'])) {
      return { ok: false, error: 'challenge.supported 缺失' };
    }
    if (typeof decoded['nonce'] !== 'string' || decoded['nonce'].length === 0) {
      return { ok: false, error: 'challenge.nonce 缺失' };
    }
    if (typeof decoded['serverVersion'] !== 'string') {
      return { ok: false, error: 'challenge.serverVersion 缺失' };
    }
    return {
      ok: true,
      message: {
        type: 'challenge',
        protocolVersion: decoded['protocolVersion'] as number,
        supported: decoded['supported'],
        serverVersion: decoded['serverVersion'],
        nonce: decoded['nonce'],
      },
    };
  }
  if (type === 'welcome') {
    for (const field of ['protocolVersion', 'sessionId', 'deviceId', 'nickname'] as const) {
      if (field === 'protocolVersion' ? !Number.isInteger(decoded[field]) : typeof decoded[field] !== 'string') {
        return { ok: false, error: `welcome.${field} 缺失或类型错误` };
      }
    }
    if (typeof decoded['serverVersion'] !== 'string' || typeof decoded['registered'] !== 'boolean') {
      return { ok: false, error: 'welcome.serverVersion/registered 缺失' };
    }
    return {
      ok: true,
      message: {
        type: 'welcome',
        protocolVersion: decoded['protocolVersion'] as number,
        serverVersion: decoded['serverVersion'],
        sessionId: decoded['sessionId'] as string,
        deviceId: decoded['deviceId'] as string,
        nickname: decoded['nickname'] as string,
        registered: decoded['registered'],
      },
    };
  }
  if (type === 'error') {
    const code = decoded['code'];
    if (!isProtocolErrorCode(code)) {
      return { ok: false, error: `未知的错误码: ${String(code)}` };
    }
    if (typeof decoded['message'] !== 'string') {
      return { ok: false, error: 'error.message 缺失' };
    }
    const supported = decoded['supported'];
    const error: ServerError = {
      type: 'error',
      code,
      message: decoded['message'],
      ...(isProtocolRange(supported) ? { supported } : {}),
    };
    return { ok: true, message: error };
  }
  return { ok: false, error: `未知的服务端消息类型: ${String(type)}` };
}
