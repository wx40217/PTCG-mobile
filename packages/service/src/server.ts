import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import {
  HEALTH_PATH,
  HANDSHAKE_PATH,
  PROTOCOL_VERSION,
  SERVICE_NAME,
  SERVICE_VERSION,
  serializeMessage,
  supportedProtocolRange,
  type HealthPayload,
} from '@ptcg/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { acceptHello, createChallenge } from './handshake.ts';
import { createLogger, createSilentLogger, type ServiceLogger } from './logger.ts';
import { createDeviceRegistry, type DeviceRegistry } from './registry.ts';

export interface ServiceTlsOptions {
  readonly cert: string | Buffer;
  readonly key: string | Buffer;
}

export interface ServiceOptions {
  /** 默认只绑回环地址；局域网对战需要显式指定。 */
  readonly host?: string;
  readonly port?: number;
  readonly dbPath?: string;
  readonly logger?: ServiceLogger;
  readonly tls?: ServiceTlsOptions;
  readonly handshakeTimeoutMs?: number;
  readonly now?: () => number;
}

export interface ServiceHandle {
  readonly host: string;
  readonly port: number;
  /** HTTP(S) 基地址，始终以 `/` 结尾。 */
  readonly httpUrl: string;
  /** WebSocket 基地址。 */
  readonly wsUrl: string;
  readonly protocolVersion: number;
  readonly secure: boolean;
  close(): Promise<void>;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

function normalizePath(raw: string | undefined): string {
  if (raw === undefined) {
    return '/';
  }
  const withoutQuery = raw.split('?')[0] ?? '/';
  return withoutQuery.endsWith('/') && withoutQuery.length > 1 ? withoutQuery.slice(0, -1) : withoutQuery;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/**
 * 启动最小对战服务。
 *
 * 职责边界：健康检查（无鉴权，用于连接前分类）+ WebSocket 协议握手（带协议版本
 * 与设备身份验证）。它不包含卡牌或对战内核。
 */
export async function createService(options: ServiceOptions = {}): Promise<ServiceHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? (() => Date.now());
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const registry: DeviceRegistry = createDeviceRegistry(options.dbPath ?? ':memory:');
  const secure = options.tls !== undefined;

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    const path = normalizePath(request.url);
    if (request.method === 'GET' && path === `/${HEALTH_PATH}`) {
      const payload: HealthPayload = {
        service: SERVICE_NAME,
        status: 'ok',
        protocolVersion: PROTOCOL_VERSION,
        supported: supportedProtocolRange(),
        serverVersion: SERVICE_VERSION,
      };
      sendJson(response, 200, payload);
      return;
    }
    sendJson(response, 404, { error: 'not_found', path });
  };

  const server: Server = secure
    ? (createHttpsServer({ cert: options.tls?.cert, key: options.tls?.key }, requestHandler) as unknown as Server)
    : createHttpServer(requestHandler);

  const webSocketServer = new WebSocketServer({ noServer: true, clientTracking: true });

  server.on('upgrade', (request: IncomingMessage, socket: TLSSocket, head: Buffer) => {
    if (normalizePath(request.url) !== `/${HANDSHAKE_PATH}`) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request);
    });
  });

  webSocketServer.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const challenge = createChallenge(SERVICE_VERSION);
    const context = { registry, logger, serverVersion: SERVICE_VERSION, now, nonce: challenge.nonce };
    let settled = false;
    let timer: NodeJS.Timeout;

    const address = request.socket.remoteAddress ?? 'unknown';
    logger.info('connection.opened', { address });

    const finishWithError = (message: unknown, closeCode: number): void => {
      settled = true;
      clearTimeout(timer);
      const text = serializeMessage(message as never);
      if (socket.readyState === socket.OPEN) {
        socket.send(text);
        socket.close(closeCode, 'handshake rejected');
      } else {
        socket.terminate();
      }
    };

    const armTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        logger.warn('handshake.timeout', {});
        finishWithError({ type: 'error', code: 'invalid_message', message: '握手超时。' }, 4003);
      }, handshakeTimeoutMs);
    };

    // 先下发挑战：客户端据此判定协议兼容性，再提交带签名的 hello。
    socket.send(serializeMessage(challenge));
    armTimer();

    socket.on('message', (data) => {
      if (settled) {
        return;
      }
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      void acceptHello(raw, context).then((outcome) => {
        if (outcome.kind === 'error') {
          logger.warn('handshake.rejected', { code: outcome.message.code });
          finishWithError(outcome.message, outcome.closeCode);
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.send(serializeMessage(outcome.message));
      });
    });

    socket.on('close', () => {
      clearTimeout(timer);
      logger.info('connection.closed', {});
    });

    socket.on('error', (error: Error) => {
      clearTimeout(timer);
      logger.warn('connection.error', { name: error.name });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const addressInfo = server.address();
  if (addressInfo === null || typeof addressInfo === 'string') {
    throw new Error('无法确定服务监听地址');
  }
  const boundPort = addressInfo.port;
  const scheme = secure ? 'https' : 'http';
  const wsScheme = secure ? 'wss' : 'ws';
  const authority = host.includes(':') ? `[${host}]` : host;

  let closed = false;
  return {
    host,
    port: boundPort,
    httpUrl: `${scheme}://${authority}:${boundPort}/`,
    wsUrl: `${wsScheme}://${authority}:${boundPort}/`,
    protocolVersion: PROTOCOL_VERSION,
    secure,
    async close(): Promise<void> {
      // 幂等：停机信号、测试清理、异常路径可能重复调用。
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve) => {
        for (const client of webSocketServer.clients) {
          client.terminate();
        }
        webSocketServer.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      registry.close();
    },
  };
}

export { createLogger };
