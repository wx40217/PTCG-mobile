import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCatalogVersion,
  connectToService,
  createDeviceIdentity,
  parseServiceCatalog,
  presetDeckDocument,
  type CatalogContent,
  type ClientMessage,
  type DeckDocument,
  type DeviceIdentity,
  type LiveConnection,
  type ServerMessage,
  type ServiceCatalog,
  type WebSocketLike,
} from '@ptcg/protocol';
import { defaultCatalogPath } from '../../src/catalog.ts';
import { createLogger } from '../../src/logger.ts';
import { createService, type ServiceHandle, type ServiceOptions } from '../../src/server.ts';

/**
 * 房间集成测试的测试环境夹具。
 *
 * 发行目录（`data/catalog/...`）永远保持“全部效果未接入”，因此不能在真实
 * 服务上走通准备→开局。测试在临时目录里从发行目录生成一份“效果已接入”的
 * 夹具目录：内容哈希重新计算，只存在于临时目录，不进入仓库、不进入发行包，
 * 也不改变发行目录；服务通过 `catalog.catalogPath` 指向它。
 */

export interface PlayableFixture {
  readonly path: string;
  readonly content: CatalogContent;
  readonly catalogVersion: string;
}

export function loadReleaseCatalog(): ServiceCatalog {
  return parseServiceCatalog(JSON.parse(readFileSync(defaultCatalogPath(), 'utf8'))) as ServiceCatalog;
}

export function releasePreset(code: string): DeckDocument {
  const catalog = loadReleaseCatalog();
  const preset = catalog.content.decks.find((deck) => deck.code === code);
  if (preset === undefined) {
    throw new Error(`发行目录缺少预设 ${code}`);
  }
  const document = presetDeckDocument(preset, catalog.content);
  if (document === null) {
    throw new Error(`预设 ${code} 无法转换`);
  }
  return document;
}

/** 从发行目录派生“全部效果已接入”的测试夹具目录，写入临时 JSON。 */
export async function writePlayableFixture(directory: string): Promise<PlayableFixture> {
  const release = loadReleaseCatalog();
  const content: CatalogContent = {
    ...release.content,
    supportPolicy: {
      engineIntegration: 'integrated',
      playable: true,
      noteZh: '测试夹具：所有条目效果支持仅用于自动化验证，不进入发行目录。',
    },
    cards: release.content.cards.map((card) => ({
      ...card,
      flags: {
        ...card.flags,
        effectSupported: true,
        effectNoteZh: '测试夹具：效果支持在测试环境内模拟。',
      },
    })),
  };
  const catalogVersion = await computeCatalogVersion(content);
  const path = join(directory, `playable-fixture-${catalogVersion.slice(0, 12)}.json`);
  writeFileSync(path, JSON.stringify({ ...content, catalogVersion }), 'utf8');
  return { path, content, catalogVersion };
}

export interface TestService {
  readonly service: ServiceHandle;
  readonly logs: string[];
  readonly logText: () => string;
  close(): Promise<void>;
}

export async function startTestService(
  options: Partial<ServiceOptions> = {},
  logSink?: (line: string) => void,
): Promise<TestService> {
  const logs: string[] = [];
  const service = await createService({
    host: '127.0.0.1',
    port: 0,
    logger: createLogger((line) => {
      logs.push(line);
      logSink?.(line);
    }),
    ...options,
  });
  return {
    service,
    logs,
    logText: () => logs.join('\n'),
    async close() {
      await service.close();
    },
  };
}

export interface TestClient {
  readonly identity: DeviceIdentity;
  readonly connection: LiveConnection;
  readonly messages: ServerMessage[];
  /** 服务端发来的原始 JSON（用于隐私断言：对手载荷里不得出现卡表内容）。 */
  readonly rawPayloads: string[];
  send(message: ClientMessage): void;
  /** 最近一条房间快照（未收到任何快照时为 undefined）。 */
  latestRoom(): Extract<ServerMessage, { type: 'room' }>['room'] | undefined;
  waitFor(predicate: (message: ServerMessage) => boolean, label?: string): Promise<ServerMessage>;
  waitForRoom(predicate: (room: Extract<ServerMessage, { type: 'room' }>['room']) => boolean, label?: string): Promise<Extract<ServerMessage, { type: 'room' }>['room']>;
  /** 只匹配调用之后收到的房间快照（用于断言“又收到一条新快照”）。 */
  waitForNextRoom(predicate: (room: Extract<ServerMessage, { type: 'room' }>['room']) => boolean, label?: string): Promise<Extract<ServerMessage, { type: 'room' }>['room']>;
  close(): void;
}

/** 从房间快照生成按稳定实例与预期版本路由的命令目标。 */
export function routed(room: { readonly roomId: string; readonly version: number }): {
  readonly roomId: string;
  readonly expectedVersion: number;
} {
  return { roomId: room.roomId, expectedVersion: room.version };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectTestClient(
  service: ServiceHandle,
  nickname: string,
  identity?: DeviceIdentity,
  /** 可选套接字工厂；模拟半开连接时注入不回 pong 的 `ws` 客户端。 */
  openSocket?: (url: string) => WebSocketLike,
): Promise<TestClient> {
  const clientIdentity = identity ?? (await createDeviceIdentity());
  const rawPayloads: string[] = [];
  const result = await connectToService(
    {
      httpUrl: new URL(service.httpUrl),
      wsUrl: new URL(service.wsUrl),
      identity: clientIdentity,
      nickname,
    },
    {
      openSocket: (url) => {
        // Node 24 的全局 WebSocket 与浏览器接口一致；这里额外记录原始载荷。
        const socket = openSocket === undefined ? (new WebSocket(url) as unknown as WebSocketLike) : openSocket(url);
        socket.addEventListener('message', (event) => {
          const data = (event as { data?: unknown }).data;
          if (typeof data === 'string') {
            rawPayloads.push(data);
          }
        });
        return socket;
      },
    },
  );
  if (!result.ok) {
    throw new Error(`测试客户端连接失败: ${result.failure.message}`);
  }
  const connection = result.connection;
  const messages: ServerMessage[] = [];
  connection.onMessage((message) => messages.push(message));

  async function waitFor(
    predicate: (message: ServerMessage) => boolean,
    label = 'message',
  ): Promise<ServerMessage> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found !== undefined) {
        return found;
      }
      await sleep(10);
    }
    throw new Error(`等待 ${label} 超时；已收到：${JSON.stringify(messages)}`);
  }

  async function waitForRoom(
    predicate: (room: Extract<ServerMessage, { type: 'room' }>['room']) => boolean,
    label = 'room snapshot',
  ): Promise<Extract<ServerMessage, { type: 'room' }>['room']> {
    const found = await waitFor((message) => message.type === 'room' && predicate(message.room), label);
    return (found as Extract<ServerMessage, { type: 'room' }>).room;
  }

  async function waitForNextRoom(
    predicate: (room: Extract<ServerMessage, { type: 'room' }>['room']) => boolean,
    label = 'next room snapshot',
  ): Promise<Extract<ServerMessage, { type: 'room' }>['room']> {
    const since = messages.length;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      for (let index = since; index < messages.length; index += 1) {
        const message = messages[index] as ServerMessage;
        if (message.type === 'room' && predicate(message.room)) {
          return message.room;
        }
      }
      await sleep(10);
    }
    throw new Error(`等待 ${label} 超时；已收到：${JSON.stringify(messages)}`);
  }

  return {
    identity: clientIdentity,
    connection,
    messages,
    rawPayloads,
    send(message) {
      connection.send(message);
    },
    latestRoom() {
      const message = [...messages].reverse().find((entry) => entry.type === 'room');
      return message?.type === 'room' ? message.room : undefined;
    },
    waitFor,
    waitForRoom,
    waitForNextRoom,
    close() {
      connection.close();
    },
  };
}

let commandSeq = 0;
export function nextCommandId(): string {
  commandSeq += 1;
  return `test-cmd-${commandSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface TempDirectory {
  readonly path: string;
  cleanup(): void;
}

export function createTempDirectory(prefix: string): TempDirectory {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
