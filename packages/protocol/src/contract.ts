import type { ProtocolRange } from './version.ts';

/** 服务端与客户端约定的固定路径。 */
export const HEALTH_PATH = 'health';
export const HANDSHAKE_PATH = 'ws';
/** 卡组校验接口：服务端按当前目录独立校验，供房间准备复用。 */
export const DECK_VALIDATE_PATH = 'decks/validate';
export const SERVICE_NAME = 'ptcg-service';
export const SERVICE_VERSION = '0.1.0';

/** `GET /health` 的响应体；握手前用它区分不可达、证书问题与协议不兼容。 */
export interface HealthPayload {
  readonly service: string;
  readonly status: 'ok';
  readonly protocolVersion: number;
  readonly supported: ProtocolRange;
  readonly serverVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析健康检查响应。
 *
 * 返回 `null` 表示这不是本协议的服务或响应结构不对 —— 调用方应据此判定为
 * 协议不兼容，而不是「服务正常但功能缺失」。
 */
export function parseHealthPayload(value: unknown): HealthPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['service'] !== SERVICE_NAME || value['status'] !== 'ok') {
    return null;
  }
  if (!Number.isInteger(value['protocolVersion'])) {
    return null;
  }
  const supported = value['supported'];
  if (!isRecord(supported) || !Number.isInteger(supported['min']) || !Number.isInteger(supported['max'])) {
    return null;
  }
  if (typeof value['serverVersion'] !== 'string') {
    return null;
  }
  return {
    service: value['service'],
    status: 'ok',
    protocolVersion: value['protocolVersion'] as number,
    supported: { min: supported['min'] as number, max: supported['max'] as number },
    serverVersion: value['serverVersion'],
  };
}
