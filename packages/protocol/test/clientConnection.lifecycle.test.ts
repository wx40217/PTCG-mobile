import { describe, expect, it } from 'vitest';
import {
  connectToService,
  createDeviceIdentity,
  serializeMessage,
  type ConnectDependencies,
  type HealthPayload,
  type WebSocketLike,
} from '../src/index.ts';
import { SERVICE_NAME, SERVICE_VERSION } from '../src/contract.ts';
import { PROTOCOL_VERSION, supportedProtocolRange } from '../src/version.ts';

type Listener = (event: unknown) => void;

/** 手写的最小 WebSocket 替身，用来确定性地驱动握手与断线时序。 */
class FakeSocket implements WebSocketLike {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sent: string[] = [];
  closeCalls = 0;
  closeArgs: Array<{ code?: number; reason?: string }> = [];
  readyState = 1;

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
    // 收到 hello 后立刻回 welcome，模拟真实服务端。
    const parsed = JSON.parse(data) as { type?: unknown };
    if (parsed.type === 'hello') {
      queueMicrotask(() => {
        this.emit('message', {
          data: serializeMessage({
            type: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            serverVersion: SERVICE_VERSION,
            sessionId: 'session-test',
            deviceId: 'dev_ignored_by_test',
            nickname: '测试',
            registered: true,
          }),
        });
      });
    }
  }

  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    this.closeArgs.push(code === undefined && reason === undefined ? {} : { code, reason });
    this.readyState = 3;
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

const health: HealthPayload = {
  service: SERVICE_NAME,
  status: 'ok',
  protocolVersion: PROTOCOL_VERSION,
  supported: supportedProtocolRange(),
  serverVersion: SERVICE_VERSION,
};

async function openConnectedSocket(): Promise<{ socket: FakeSocket; dependencies: ConnectDependencies }> {
  const socket = new FakeSocket();
  const dependencies: ConnectDependencies = {
    probe: async () => ({ kind: 'ok', payload: health }),
    openSocket: () => {
      // 打开后先下发挑战；客户端在下一个微任务里注册 message 监听。
      queueMicrotask(() => {
        socket.emit('message', {
          data: serializeMessage({
            type: 'challenge',
            protocolVersion: PROTOCOL_VERSION,
            supported: supportedProtocolRange(),
            serverVersion: SERVICE_VERSION,
            nonce: 'nonce-lifecycle',
          }),
        });
      });
      return socket;
    },
    timeoutMs: 2_000,
  };
  return { socket, dependencies };
}

async function connectWith(socket: FakeSocket, dependencies: ConnectDependencies) {
  const identity = await createDeviceIdentity();
  return connectToService(
    {
      httpUrl: new URL('https://service.test/'),
      wsUrl: new URL('wss://service.test/'),
      identity,
      nickname: '测试',
    },
    dependencies,
  );
}

describe('连接生命周期：握手之后的持续通知', () => {
  it('服务端关闭 socket 时通知一次，并把句柄标记为已关闭', async () => {
    const { socket, dependencies } = await openConnectedSocket();
    const result = await connectWith(socket, dependencies);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const events: unknown[] = [];
    result.connection.onClosed((event) => events.push(event));
    expect(result.connection.closed).toBe(false);

    socket.emit('close', { code: 1006, reason: '服务端下线' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'disconnected' });
    expect(result.connection.closed).toBe(true);

    // 重复的 close/error 事件不会再次通知。
    socket.emit('close', { code: 1000, reason: '重复' });
    socket.emit('error', { message: '重复' });
    expect(events).toHaveLength(1);
  });

  it('socket 传输错误按断开通知，且携带可分类信号', async () => {
    const { socket, dependencies } = await openConnectedSocket();
    const result = await connectWith(socket, dependencies);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const events: Array<{ kind: string; signal?: { message?: string } }> = [];
    result.connection.onClosed((event) => events.push(event as never));
    socket.emit('error', { message: 'javax.net.ssl.SSLHandshakeException: trust anchor' });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('disconnected');
    expect(events[0]?.signal?.message).toContain('SSLHandshakeException');
  });

  it('主动 close 是幂等的，不触发断线通知，也不再发送数据', async () => {
    const { socket, dependencies } = await openConnectedSocket();
    const result = await connectWith(socket, dependencies);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const events: unknown[] = [];
    result.connection.onClosed((event) => events.push(event));

    result.connection.close();
    result.connection.close();

    expect(result.connection.closed).toBe(true);
    expect(socket.closeCalls).toBe(1);
    expect(events).toHaveLength(0);

    // 主动关闭后迟到的服务端 close 也不会补发事件。
    socket.emit('close', { code: 1006, reason: '迟到的关闭' });
    expect(events).toHaveLength(0);
  });

  it('订阅发生在断线之后时，会在微任务里补发一次', async () => {
    const { socket, dependencies } = await openConnectedSocket();
    const result = await connectWith(socket, dependencies);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    socket.emit('close', { code: 1006, reason: '已断开' });
    expect(result.connection.closed).toBe(true);

    const events: unknown[] = [];
    result.connection.onClosed((event) => events.push(event));
    expect(events).toHaveLength(0);

    await new Promise((resolve) => queueMicrotask(resolve));
    expect(events).toHaveLength(1);
  });

  it('退订后不再收到断线通知', async () => {
    const { socket, dependencies } = await openConnectedSocket();
    const result = await connectWith(socket, dependencies);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const events: unknown[] = [];
    const unsubscribe = result.connection.onClosed((event) => events.push(event));
    unsubscribe();

    socket.emit('close', { code: 1006, reason: '服务端下线' });
    expect(events).toHaveLength(0);
  });

  it('握手结束后 socket 已经关闭时立即标记断线', async () => {
    const socket = new FakeSocket();
    const dependencies: ConnectDependencies = {
      probe: async () => ({ kind: 'ok', payload: health }),
      openSocket: () => {
        queueMicrotask(() => {
          socket.emit('message', {
            data: serializeMessage({
              type: 'challenge',
              protocolVersion: PROTOCOL_VERSION,
              supported: supportedProtocolRange(),
              serverVersion: SERVICE_VERSION,
              nonce: 'nonce-closed',
            }),
          });
        });
        return socket;
      },
      timeoutMs: 2_000,
    };
    stackOverwriteReadyState(socket);
    const result = await connectWith(socket, dependencies);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.connection.closed).toBe(true);
    const events: unknown[] = [];
    result.connection.onClosed((event) => events.push(event));
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(events).toHaveLength(1);
  });
});

/**
 * 模拟「welcome 处理完后 socket 已经关闭、close 事件不会再送达」的竞态：
 * FakeSocket 的 close() 会把 readyState 置为 3，这里提前调用一次。
 */
function stackOverwriteReadyState(socket: FakeSocket): void {
  const original = socket.send.bind(socket);
  socket.send = (data: string) => {
    original(data);
    socket.readyState = 3;
  };
}
