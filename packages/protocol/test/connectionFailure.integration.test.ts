import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from 'selfsigned';
import { WebSocketServer } from 'ws';
import {
  connectToService,
  createDeviceIdentity,
  PROTOCOL_VERSION,
  SERVICE_NAME,
  SERVICE_VERSION,
  supportedProtocolRange,
  type HealthPayload,
} from '../src/index.ts';

/** 取一个确认无人监听的端口：先绑定再释放。 */
async function closedPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startServer(handler: (url: string | undefined, response: import('node:http').ServerResponse) => void, secure = false) {
  let server: Server;
  if (secure) {
    const pems = await generate([{ name: 'commonName', value: '127.0.0.1' }], { days: 1, keySize: 2048, algorithm: 'sha256' });
    server = createHttpsServer({ cert: pems.cert, key: pems.private }, (request, response) => handler(request.url, response)) as unknown as Server;
  } else {
    server = createHttpServer((request, response) => handler(request.url, response));
  }
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { httpUrl: new URL(`http://127.0.0.1:${port}/`), wsUrl: new URL(`ws://127.0.0.1:${port}/`) };
}

const health = (protocolVersion: number): HealthPayload => ({
  service: SERVICE_NAME,
  status: 'ok',
  protocolVersion,
  supported: protocolVersion === PROTOCOL_VERSION ? supportedProtocolRange() : { min: protocolVersion, max: protocolVersion },
  serverVersion: SERVICE_VERSION,
});

describe('连接失败分类（真实服务端行为）', () => {
  it('端口无人监听时判定为不可达', async () => {
    const port = await closedPort();
    const identity = await createDeviceIdentity();
    const result = await connectToService({
      httpUrl: new URL(`http://127.0.0.1:${port}/`),
      wsUrl: new URL(`ws://127.0.0.1:${port}/`),
      identity,
      nickname: '小智',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('unreachable');
    }
  });

  it('自签名证书导致真实的 TLS 失败时判定为证书问题', async () => {
    // 健康检查走 https，Node 的 fetch 会因为不受信任的自签名证书而失败。
    const pems = await generate([{ name: 'commonName', value: '127.0.0.1' }], { days: 1, keySize: 2048, algorithm: 'sha256' });
    const server = createHttpsServer({ cert: pems.cert, key: pems.private }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(health(PROTOCOL_VERSION)));
    });
    servers.push(server as unknown as Server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const identity = await createDeviceIdentity();
    const result = await connectToService({
      httpUrl: new URL(`https://127.0.0.1:${port}/`),
      wsUrl: new URL(`wss://127.0.0.1:${port}/`),
      identity,
      nickname: '小智',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('certificate');
      expect(result.failure.message).toContain('证书');
    }
  });

  it('服务健康检查报告更高协议版本时判定为不兼容', async () => {
    const address = await startServer((_url, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(health(PROTOCOL_VERSION + 1)));
    });
    const identity = await createDeviceIdentity();
    const result = await connectToService({ ...address, identity, nickname: '小智' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('incompatible');
      expect(result.failure.supported).toEqual({ min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 });
    }
  });

  it('地址指向的不是本协议服务时判定为不兼容', async () => {
    const address = await startServer((_url, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>某个无关的网站</html>');
    });
    const identity = await createDeviceIdentity();
    const result = await connectToService({ ...address, identity, nickname: '小智' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('incompatible');
    }
  });

  it('服务端在 WebSocket 挑战中声明不兼容版本时判定为不兼容', async () => {
    const address = await startServer((url, response) => {
      if (url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(health(PROTOCOL_VERSION)));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const wsServer = new WebSocketServer({ server: servers[servers.length - 1] as Server, path: '/ws' });
    wsServer.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'challenge',
          protocolVersion: PROTOCOL_VERSION + 1,
          supported: { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 },
          serverVersion: SERVICE_VERSION,
          nonce: 'nonce-from-future',
        }),
      );
    });

    const identity = await createDeviceIdentity();
    const result = await connectToService({ ...address, identity, nickname: '小智' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('incompatible');
    }
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  });
});
