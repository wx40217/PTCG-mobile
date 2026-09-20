/**
 * 协议版本契约。
 *
 * 版本号是整数。服务与客户端各自声明自己实现的主版本，只有在双方共同支持的
 * 区间内握手才会继续；不兼容必须在传输任何身份材料之前判定。
 */
export const PROTOCOL_VERSION = 1;

/** 服务端与客户端当前实现共同支持的主版本区间。 */
export const PROTOCOL_MIN_SUPPORTED = 1;
export const PROTOCOL_MAX_SUPPORTED = 1;

export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

export function supportedProtocolRange(): ProtocolRange {
  return { min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_MAX_SUPPORTED };
}

export function isProtocolCompatible(version: number): boolean {
  return Number.isInteger(version) && version >= PROTOCOL_MIN_SUPPORTED && version <= PROTOCOL_MAX_SUPPORTED;
}

/** 面向界面的不兼容说明；不含任何凭据。 */
export function describeProtocolIncompatibility(version: number): string {
  if (!Number.isInteger(version)) {
    return `协议版本无效（收到 ${String(version)}），本端支持 ${PROTOCOL_MIN_SUPPORTED}-${PROTOCOL_MAX_SUPPORTED}。`;
  }
  if (version > PROTOCOL_MAX_SUPPORTED) {
    return `服务协议版本 ${version} 高于本客户端支持的 ${PROTOCOL_MAX_SUPPORTED}，请更新客户端。`;
  }
  return `服务协议版本 ${version} 低于本客户端支持的 ${PROTOCOL_MIN_SUPPORTED}，请更新服务。`;
}
