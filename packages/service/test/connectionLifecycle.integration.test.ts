import { describe, expect, it } from 'vitest';
import { connectToService, createDeviceIdentity, type LiveConnection } from '@ptcg/protocol';
import { createLogger } from '../src/logger.ts';
import { createService, type ServiceHandle } from '../src/server.ts';

interface Harness {
  readonly service: ServiceHandle;
  readonly logs: string[];
  readonly logText: () => string;
}

async function startHarness(): Promise<Harness> {
  const logs: string[] = [];
  const service = await createService({
    host: '127.0.0.1',
    port: 0,
    dbPath: ':memory:',
    logger: createLogger((line) => logs.push(line), () => 1_700_000_000_000),
  });
  return { service, logs, logText: () => logs.join('\n') };
}

async function connect(harness: Harness, nickname = '小智'): Promise<LiveConnection> {
  const identity = await createDeviceIdentity();
  const result = await connectToService({
    httpUrl: new URL(harness.service.httpUrl),
    wsUrl: new URL(harness.service.wsUrl),
    identity,
    nickname,
  });
  if (!result.ok) {
    throw new Error(`连接失败: ${result.failure.kind} ${result.failure.message}`);
  }
  return result.connection;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs))]);
}

describe('连接生命周期集成：真实 socket 行为', () => {
  it('客户端主动断开后，服务端观察到 socket 关闭', async () => {
    const harness = await startHarness();
    try {
      const connection = await connect(harness);
      connection.close();
      const observed = await waitFor(() => harness.logText().includes('connection.closed'));
      expect(observed).toBe(true);
      expect(connection.closed).toBe(true);
    } finally {
      await harness.service.close();
    }
  });

  it('服务端关闭后，客户端收到一次断线通知', async () => {
    const harness = await startHarness();
    try {
      const connection = await connect(harness);
      const events: unknown[] = [];
      const closed = new Promise<void>((resolve) => {
        connection.onClosed((event) => {
          events.push(event);
          resolve();
        });
      });

      await harness.service.close();

      await expect(withTimeout(closed)).resolves.toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'disconnected' });
      expect(connection.closed).toBe(true);
    } finally {
      await harness.service.close();
    }
  });

  it('主动断开的连接不会在服务端关闭时再收到断线通知', async () => {
    const harness = await startHarness();
    try {
      const connection = await connect(harness);
      const events: unknown[] = [];
      connection.onClosed((event) => events.push(event));
      connection.close();
      // 等一帧确认主动关闭不触发通知。
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toHaveLength(0);

      await harness.service.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events).toHaveLength(0);
    } finally {
      await harness.service.close();
    }
  });

  it('两条连接互不串扰：一条断开不影响另一条', async () => {
    const harness = await startHarness();
    try {
      const first = await connect(harness, '小智');
      const second = await connect(harness, '小茂');

      const firstEvents: unknown[] = [];
      const secondEvents: unknown[] = [];
      first.onClosed((event) => firstEvents.push(event));
      second.onClosed((event) => secondEvents.push(event));

      first.close();
      const observed = await waitFor(() => harness.logText().split('connection.closed').length - 1 >= 1);
      expect(observed).toBe(true);
      // 另一条连接仍然存活，不会被对端断开事件串扰。
      expect(second.closed).toBe(false);
      expect(secondEvents).toHaveLength(0);
      expect(firstEvents).toHaveLength(0);

      second.close();
    } finally {
      await harness.service.close();
    }
  });
});
