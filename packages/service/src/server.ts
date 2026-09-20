import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import {
  CATALOG_CARD_IMAGE_PREFIX,
  CATALOG_PATH,
  CATALOG_RESOURCE_PREFIX,
  DECK_VALIDATE_PATH,
  HEALTH_PATH,
  HANDSHAKE_PATH,
  PROTOCOL_VERSION,
  SERVICE_NAME,
  SERVICE_VERSION,
  parseDeckDocument,
  serializeMessage,
  supportedProtocolRange,
  validateDeck,
  type HealthPayload,
  type ServerError,
} from '@ptcg/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadCatalogStore, type CatalogStore, type ServiceCatalogOptions } from './catalog.ts';
import { acceptHello, createChallenge } from './handshake.ts';
import { createSilentLogger, type ServiceLogger } from './logger.ts';
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
  /** 冻结卡牌目录与本地图片资源；缺省使用仓库内产物、不配置图片目录。 */
  readonly catalog?: ServiceCatalogOptions;
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

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  response.end(text);
}

function sendText(response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  response.end(text);
}

function notModified(request: IncomingMessage, response: ServerResponse, etag: string, cacheControl: string): boolean {
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { etag, 'cache-control': cacheControl, 'access-control-allow-origin': '*' });
    response.end();
    return true;
  }
  return false;
}

function sendCatalogJson(request: IncomingMessage, response: ServerResponse, text: string, etag: string): void {
  if (notModified(request, response, etag, 'no-cache')) {
    return;
  }
  sendText(response, 200, text, { etag, 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
}

function sendImage(request: IncomingMessage, response: ServerResponse, bytes: Buffer, sha256: string): void {
  const etag = `"${sha256}"`;
  if (notModified(request, response, etag, 'public, max-age=31536000, immutable')) {
    return;
  }
  response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': bytes.length,
    etag,
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
  });
  response.end(bytes);
}

function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 卡组提交体积上限；一副 60 张的文档远小于此值。 */
const MAX_DECK_BODY_BYTES = 64 * 1024;

type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too-large' | 'read-error' };

function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (result: BodyReadResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        // 继续排空请求体，让 413 能正常返回而不是粗暴断开连接。
        request.resume();
        finish({ ok: false, reason: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    request.on('error', () => finish({ ok: false, reason: 'read-error' }));
  });
}

/**
 * `POST /decks/validate`：服务端用当前目录独立校验提交。
 *
 * 请求体只允许卡组文档本身；客户端自行声明的合法性/就绪字段不会被读取，
 * 响应完全由服务端重新计算，因此伪造提交无法绕过校验。
 */
async function handleDeckValidation(
  request: IncomingMessage,
  response: ServerResponse,
  store: CatalogStore,
  logger: ServiceLogger,
): Promise<void> {
  const cors = { 'access-control-allow-origin': '*' };
  if (store.content === null || store.version === null) {
    sendJson(response, 503, { error: 'catalog_unavailable', reason: store.problem ?? '目录未加载。' }, cors);
    return;
  }
  const body = await readJsonBody(request, MAX_DECK_BODY_BYTES);
  if (!body.ok) {
    if (body.reason === 'too-large') {
      sendJson(response, 413, { error: 'payload_too_large', message: `卡组提交不能超过 ${MAX_DECK_BODY_BYTES} 字节。` }, cors);
    } else {
      sendJson(response, 400, { error: 'invalid_request', message: '读取请求体失败。' }, cors);
    }
    return;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.text);
  } catch {
    sendJson(response, 400, { error: 'invalid_request', message: '请求体不是合法 JSON。' }, cors);
    return;
  }
  const parsed = parseDeckDocument(decoded);
  if (!parsed.ok) {
    sendJson(
      response,
      400,
      { error: 'invalid_deck', message: parsed.errors[0] ?? '卡组结构无效。', errors: parsed.errors },
      cors,
    );
    return;
  }
  const result = validateDeck(parsed.deck, { content: store.content, catalogVersion: store.version });
  logger.info('deck.validated', {
    legal: result.legal,
    ready: result.ready,
    totalCards: result.totalCards,
    problems: result.problems.length,
  });
  sendJson(response, 200, result, cors);
}

type CatalogImageLookup = readonly [
  prefix: string,
  read: (id: string) => Buffer | null,
  sha256: (id: string) => string | null,
];

/** 图片路径解析；返回 undefined 表示不是图片路由，null 表示已知路由但资源不可用。 */
function resolveCatalogImage(
  store: CatalogStore,
  path: string,
): { readonly bytes: Buffer; readonly sha256: string } | null | undefined {
  const routes: readonly CatalogImageLookup[] = [
    [CATALOG_RESOURCE_PREFIX, (id) => store.readResource(id), (id) => store.resourceSha256(id)],
    [CATALOG_CARD_IMAGE_PREFIX, (id) => store.readCardImage(id), (id) => store.cardImageSha256(id)],
  ];
  for (const [prefix, read, sha256] of routes) {
    if (!path.startsWith(`/${prefix}/`)) {
      continue;
    }
    const id = decodePathSegment(path.slice(prefix.length + 2));
    const bytes = id === null ? null : read(id);
    const digest = id === null ? null : sha256(id);
    return bytes === null || digest === null ? null : { bytes, sha256: digest };
  }
  return undefined;
}

/**
 * 启动最小对战服务。
 *
 * 职责边界：健康检查（无鉴权，用于连接前分类）+ WebSocket 协议握手（带协议版本
 * 与设备身份验证）+ 卡组校验（按当前目录独立裁定，供房间准备复用）。它不包含
 * 对战内核。
 */
export async function createService(options: ServiceOptions = {}): Promise<ServiceHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? (() => Date.now());
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const registry: DeviceRegistry = createDeviceRegistry(options.dbPath ?? ':memory:');
  const secure = options.tls !== undefined;
  const catalogStore: CatalogStore = await loadCatalogStore(options.catalog ?? {}, logger, now);

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
    if (request.method === 'GET' && path === `/${CATALOG_PATH}`) {
      const body = catalogStore.servedJson();
      const etag = catalogStore.etag;
      if (body === null || etag === null) {
        sendJson(response, 503, { error: 'catalog_unavailable', reason: catalogStore.problem ?? '目录序列化失败。' });
        return;
      }
      sendCatalogJson(request, response, body, `"${etag}"`);
      return;
    }
    if (path === `/${DECK_VALIDATE_PATH}`) {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST, OPTIONS', 'access-control-allow-origin': '*' });
        return;
      }
      void handleDeckValidation(request, response, catalogStore, logger);
      return;
    }
    if (request.method === 'GET') {
      const image = resolveCatalogImage(catalogStore, path);
      if (image !== undefined) {
        if (image === null) {
          sendJson(response, 404, { error: 'not_found' });
          return;
        }
        sendImage(request, response, image.bytes, image.sha256);
        return;
      }
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

    const finishWithError = (message: ServerError, closeCode: number): void => {
      settled = true;
      clearTimeout(timer);
      const text = serializeMessage(message);
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
