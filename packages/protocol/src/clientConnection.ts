import { classifyTransportFailure, type TransportFailureSignal } from './connectionFailure.ts';
import { HEALTH_PATH, HANDSHAKE_PATH, parseHealthPayload, type HealthPayload } from './contract.ts';
import { isProtocolCompatible, describeProtocolIncompatibility, PROTOCOL_VERSION } from './version.ts';
import { signAuthPayload, type DeviceIdentity } from './identity.ts';
import { parseServerMessage, serializeMessage, type ServerMessage } from './messages.ts';
import { joinPath } from './serviceAddress.ts';

/** 连接结果面向界面分类；每类对应不同的用户处置方式。 */
export type ConnectionFailureKind =
  | 'invalid-address'
  | 'unreachable'
  | 'certificate'
  | 'incompatible'
  | 'identity-rejected'
  | 'server-error';

export interface ConnectionFailure {
  readonly kind: ConnectionFailureKind;
  readonly message: string;
  /** 服务端声明的支持区间，用于把不兼容讲清楚。 */
  readonly supported?: { readonly min: number; readonly max: number };
}

export interface ConnectedSession {
  readonly protocolVersion: number;
  readonly serverVersion: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly nickname: string;
  readonly registered: boolean;
}

export type ConnectResult =
  | { readonly ok: true; readonly session: ConnectedSession; readonly close: () => void }
  | { readonly ok: false; readonly failure: ConnectionFailure };

export type ProbeOutcome =
  | { readonly kind: 'ok'; readonly payload: HealthPayload }
  | { readonly kind: 'http-error'; readonly status: number }
  | { readonly kind: 'transport-error'; readonly signal: TransportFailureSignal };

export type HealthProbe = (url: URL, timeoutMs: number) => Promise<ProbeOutcome>;

/** 最小 WebSocket 接口；DOM WebSocket 与 Node 全局 WebSocket 均满足。 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface ConnectDependencies {
  readonly probe?: HealthProbe;
  readonly openSocket?: (url: string) => WebSocketLike;
  readonly timeoutMs?: number;
}

export interface ConnectRequest {
  readonly httpUrl: URL;
  readonly wsUrl: URL;
  readonly identity: DeviceIdentity;
  readonly nickname: string;
  readonly protocolVersion?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

function failure(kind: ConnectionFailureKind, message: string, supported?: { min: number; max: number }): ConnectResult {
  return { ok: false, failure: { kind, message, ...(supported === undefined ? {} : { supported }) } };
}

function asSignal(error: unknown): TransportFailureSignal {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const signal: TransportFailureSignal = { name: error.name, message: error.message };
    if (cause instanceof Error) {
      const code = (cause as { code?: unknown }).code;
      return {
        ...signal,
        cause: { name: cause.name, message: cause.message, ...(typeof code === 'string' ? { code } : {}) },
      };
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? { ...signal, code } : signal;
  }
  return { message: String(error) };
}

/** 默认健康检查：使用平台的 `fetch`。原生端由客户端注入 Capacitor 实现。 */
export const fetchHealthProbe: HealthProbe = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'http-error', status: response.status };
    }
    const payload = parseHealthPayload(body);
    if (payload === null) {
      return { kind: 'http-error', status: response.status };
    }
    return { kind: 'ok', payload };
  } catch (error) {
    return { kind: 'transport-error', signal: asSignal(error) };
  } finally {
    clearTimeout(timer);
  }
};

const defaultOpenSocket = (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike;

type SocketOutcome =
  | { readonly kind: 'message'; readonly data: string }
  | { readonly kind: 'closed'; readonly signal: TransportFailureSignal };

/**
 * 建立与对战服务的连接并完成握手。
 *
 * 顺序刻意分成两步：先做健康检查（能拿到证书/协议层面的真实信号），再升级到
 * WebSocket 做身份握手。这样界面才能区分「服务不可达」「证书问题」「协议不兼容」。
 */
export async function connectToService(
  request: ConnectRequest,
  dependencies: ConnectDependencies = {},
): Promise<ConnectResult> {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probe = dependencies.probe ?? fetchHealthProbe;
  const openSocket = dependencies.openSocket ?? defaultOpenSocket;
  const protocolVersion = request.protocolVersion ?? PROTOCOL_VERSION;

  const health = await probe(joinPath(request.httpUrl, HEALTH_PATH), timeoutMs);
  if (health.kind === 'transport-error') {
    const kind = classifyTransportFailure(health.signal);
    if (kind === 'certificate') {
      return failure('certificate', `无法验证 ${request.httpUrl.origin} 的 TLS 证书，请检查证书或改用受信任的地址。`);
    }
    return failure('unreachable', `无法连接 ${request.httpUrl.origin}，请确认服务已启动且地址正确。`);
  }
  if (health.kind === 'http-error') {
    if (health.status >= 500) {
      return failure('server-error', `服务返回错误状态 ${health.status}。`);
    }
    return failure('incompatible', `地址 ${request.httpUrl.origin} 指向的不是本协议服务（HTTP ${health.status}）。`);
  }
  if (!isProtocolCompatible(health.payload.protocolVersion)) {
    return failure(
      'incompatible',
      describeProtocolIncompatibility(health.payload.protocolVersion),
      health.payload.supported,
    );
  }

  let socket: WebSocketLike;
  let socketUrl: URL;
  try {
    socketUrl = joinPath(request.wsUrl, HANDSHAKE_PATH);
    socket = openSocket(socketUrl.toString());
  } catch {
    return failure('unreachable', `无法连接 ${request.wsUrl.origin}。`);
  }

  const closeQuietly = (): void => {
    try {
      socket.close();
    } catch {
      /* 关闭失败不影响用户可见结果 */
    }
  };

  const first = await nextMessage(socket, timeoutMs);
  if (first.kind === 'closed') {
    closeQuietly();
    const kind = classifyTransportFailure(first.signal);
    if (kind === 'certificate') {
      return failure('certificate', `无法验证 ${socketUrl.origin} 的 TLS 证书。`);
    }
    return failure('unreachable', `无法与 ${socketUrl.origin} 建立会话。`);
  }

  const parsedChallenge = parseServerMessage(first.data);
  if (!parsedChallenge.ok) {
    closeQuietly();
    return failure('incompatible', `服务发来的消息不符合本协议：${parsedChallenge.error}`);
  }
  if (parsedChallenge.message.type === 'error') {
    closeQuietly();
    return fromServerError(parsedChallenge.message);
  }
  if (parsedChallenge.message.type !== 'challenge') {
    closeQuietly();
    return failure('incompatible', '服务未按本协议发起挑战。');
  }
  const challenge = parsedChallenge.message;
  if (!isProtocolCompatible(challenge.protocolVersion)) {
    closeQuietly();
    return failure('incompatible', describeProtocolIncompatibility(challenge.protocolVersion), challenge.supported);
  }

  // 一次性随机数由服务端在连接建立时下发，客户端对它签名以证明持有私钥。
  try {
    const signature = await signAuthPayload(request.identity, challenge.nonce, protocolVersion);
    socket.send(
      serializeMessage({
        type: 'hello',
        protocolVersion,
        deviceId: request.identity.deviceId,
        publicKey: request.identity.publicKey,
        nickname: request.nickname,
        signature,
      }),
    );
  } catch {
    closeQuietly();
    return failure('unreachable', '会话在握手过程中中断。');
  }

  const second = await nextMessage(socket, timeoutMs);
  if (second.kind === 'closed') {
    closeQuietly();
    return failure('unreachable', '服务在验证身份前关闭了连接。');
  }
  const parsedWelcome = parseServerMessage(second.data);
  if (!parsedWelcome.ok) {
    closeQuietly();
    return failure('incompatible', `服务发来的消息不符合本协议：${parsedWelcome.error}`);
  }
  if (parsedWelcome.message.type === 'error') {
    closeQuietly();
    return fromServerError(parsedWelcome.message);
  }
  if (parsedWelcome.message.type !== 'welcome') {
    closeQuietly();
    return failure('incompatible', '服务未按本协议确认会话。');
  }

  const welcome = parsedWelcome.message;
  return {
    ok: true,
    close: closeQuietly,
    session: {
      protocolVersion: welcome.protocolVersion,
      serverVersion: welcome.serverVersion,
      sessionId: welcome.sessionId,
      deviceId: welcome.deviceId,
      nickname: welcome.nickname,
      registered: welcome.registered,
    },
  };
}

function fromServerError(message: Extract<ServerMessage, { type: 'error' }>): ConnectResult {
  switch (message.code) {
    case 'protocol_incompatible':
      return failure('incompatible', message.message, message.supported);
    case 'identity_rejected':
      return failure('identity-rejected', message.message);
    case 'invalid_message':
      return failure('incompatible', `服务拒绝了本客户端的消息：${message.message}`);
    default:
      return failure('server-error', message.message);
  }
}

function nextMessage(socket: WebSocketLike, timeoutMs: number): Promise<SocketOutcome> {
  return new Promise<SocketOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SocketOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      resolve(outcome);
    };
    const onMessage = (event: unknown): void => {
      const data = (event as { data?: unknown }).data;
      finish({ kind: 'message', data: typeof data === 'string' ? data : '' });
    };
    const onError = (event: unknown): void => {
      finish({ kind: 'closed', signal: { name: 'SocketError', message: 'socket error' } });
    };
    const onClose = (event: unknown): void => {
      const reason = (event as { reason?: unknown }).reason;
      const code = (event as { code?: unknown }).code;
      finish({
        kind: 'closed',
        signal: {
          name: 'SocketClosed',
          message: typeof reason === 'string' && reason.length > 0 ? reason : 'socket closed',
          ...(typeof code === 'number' ? { code: String(code) } : {}),
        },
      });
    };
    const timer = setTimeout(() => {
      finish({ kind: 'closed', signal: { name: 'TimeoutError', message: `在 ${timeoutMs}ms 内未收到服务响应` } });
    }, timeoutMs);

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}
