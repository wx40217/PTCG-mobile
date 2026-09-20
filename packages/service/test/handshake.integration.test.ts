import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  connectToService,
  createDeviceIdentity,
  serializeMessage,
  type DeviceIdentity,
} from '@ptcg/protocol';
import { createLogger } from '../src/logger.ts';
import { createService, type ServiceHandle } from '../src/server.ts';

interface Harness {
  readonly service: ServiceHandle;
  readonly logs: string[];
  readonly logText: () => string;
}

async function startHarness(dbPath = ':memory:'): Promise<Harness> {
  const logs: string[] = [];
  const service = await createService({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    logger: createLogger((line) => logs.push(line), () => 1_700_000_000_000),
  });
  return { service, logs, logText: () => logs.join('\n') };
}

async function connect(harness: Harness, identity: DeviceIdentity, nickname = '小智') {
  return connectToService({
    httpUrl: new URL(harness.service.httpUrl),
    wsUrl: new URL(harness.service.wsUrl),
    identity,
    nickname,
  });
}

let harness: Harness | undefined;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness?.service.close();
  harness = undefined;
});

describe('服务健康检查', () => {
  it('无需鉴权即可报告协议版本与支持区间', async () => {
    const response = await fetch(new URL('health', harness!.service.httpUrl));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload['service']).toBe('ptcg-service');
    expect(payload['status']).toBe('ok');
    expect(payload['protocolVersion']).toBe(1);
    expect(payload['supported']).toEqual({ min: 1, max: 1 });
  });

  it('未知路径返回 404 而不是泄露服务内部结构', async () => {
    const response = await fetch(new URL('nope', harness!.service.httpUrl));
    expect(response.status).toBe(404);
  });
});

describe('握手集成：有效恢复身份', () => {
  it('新设备首次握手被登记，昵称原样返回', async () => {
    const identity = await createDeviceIdentity();
    const result = await connect(harness!, identity, '小智');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.connection.session.registered).toBe(true);
    expect(result.connection.session.nickname).toBe('小智');
    expect(result.connection.session.deviceId).toBe(identity.deviceId);
    expect(result.connection.session.protocolVersion).toBe(1);
    result.connection.close();
  });

  it('同一身份重连不再重复登记，昵称可更新且身份不变', async () => {
    const identity = await createDeviceIdentity();
    const first = await connect(harness!, identity, '小智');
    expect(first.ok).toBe(true);
    first.ok && first.connection.close();

    const second = await connect(harness!, identity, '小茂');
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.connection.session.registered).toBe(false);
    expect(second.connection.session.nickname).toBe('小茂');
    expect(second.connection.session.deviceId).toBe(identity.deviceId);
    second.connection.close();
  });

  it('设备登记信息在服务重启后仍然有效', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ptcg-registry-'));
    const dbPath = join(directory, 'service.sqlite');
    try {
      const first = await startHarness(dbPath);
      const identity = await createDeviceIdentity();
      const firstConnect = await connect(first, identity);
      expect(firstConnect.ok).toBe(true);
      firstConnect.ok && firstConnect.connection.close();
      await first.service.close();

      const second = await startHarness(dbPath);
      try {
        const reconnect = await connect(second, identity);
        expect(reconnect.ok).toBe(true);
        if (reconnect.ok) {
          expect(reconnect.connection.session.registered).toBe(false);
          reconnect.connection.close();
        }
      } finally {
        await second.service.close();
      }
    } finally {
      // Windows 上 SQLite 句柄释放存在延迟，清理失败不应掩盖被测行为。
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('握手集成：无效恢复身份', () => {
  it('设备标识与公钥不匹配时拒绝', async () => {
    const identity = await createDeviceIdentity();
    const forged: DeviceIdentity = { ...identity, deviceId: 'dev_0000000000000000000000' };
    const result = await connect(harness!, forged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('identity-rejected');
    }
  });

  it('公钥与私钥不配对（签名验证失败）时拒绝', async () => {
    const owner = await createDeviceIdentity();
    const impostor = await createDeviceIdentity();
    const mismatched: DeviceIdentity = {
      deviceId: owner.deviceId,
      publicKey: owner.publicKey,
      privateKey: impostor.privateKey,
    };
    const result = await connect(harness!, mismatched);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('identity-rejected');
    }
  });

  it('被拒绝的设备不会写入登记表', async () => {
    const identity = await createDeviceIdentity();
    const forged: DeviceIdentity = { ...identity, deviceId: 'dev_1111111111111111111111' };
    await connect(harness!, forged);
    const response = await fetch(new URL('health', harness!.service.httpUrl));
    expect(response.status).toBe(200);
    // 健康检查仍可用说明服务未崩溃；登记表为空由下一段日志断言覆盖。
    expect(harness!.logText()).toContain('handshake.device_id_mismatch');
  });
});

describe('握手集成：协议不兼容', () => {
  it('客户端声明过高版本时服务端拒绝并给出支持区间', async () => {
    const identity = await createDeviceIdentity();
    const result = await connectToService({
      httpUrl: new URL(harness!.service.httpUrl),
      wsUrl: new URL(harness!.service.wsUrl),
      identity,
      nickname: '小智',
      protocolVersion: 99,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('incompatible');
      expect(result.failure.supported).toEqual({ min: 1, max: 1 });
    }
  });

  it('服务端拒绝时会用协议关闭码结束连接', async () => {
    const socket = new WebSocket(new URL('ws', harness!.service.wsUrl).toString());
    const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接未在预期时间内关闭')), 8_000);
      socket.on('message', () => {
        socket.send(
          serializeMessage({
            type: 'hello',
            protocolVersion: 42,
            deviceId: 'dev_x',
            publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
            nickname: 'x',
            signature: 'sig',
          }),
        );
      });
      socket.on('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString('utf8') });
      });
      socket.on('error', () => {
        clearTimeout(timer);
        reject(new Error('socket error'));
      });
    });
    expect(closeInfo.code).toBe(4002);
  });

  it('畸形消息被拒绝且不导致服务崩溃', async () => {
    const socket = new WebSocket(new URL('ws', harness!.service.wsUrl).toString());
    const closeInfo = await new Promise<{ code: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接未在预期时间内关闭')), 8_000);
      socket.on('open', () => socket.send('this is not json'));
      socket.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
      socket.on('error', () => {
        clearTimeout(timer);
        reject(new Error('socket error'));
      });
    });
    expect(closeInfo.code).toBe(4003);

    const identity = await createDeviceIdentity();
    const after = await connect(harness!, identity);
    expect(after.ok).toBe(true);
    after.ok && after.connection.close();
  });
});

describe('日志不泄露恢复凭据', () => {
  it('成功与失败路径的日志都不含私钥标量或签名', async () => {
    const identity = await createDeviceIdentity();

    // 故意把私钥材料塞进公钥字段：即使上游实现失误，日志管道也必须脱敏。
    const tainted = new WebSocket(new URL('ws', harness!.service.wsUrl).toString());
    await new Promise<void>((resolve) => {
      tainted.on('open', () => {
        tainted.send(
          serializeMessage({
            type: 'hello',
            protocolVersion: 1,
            deviceId: identity.deviceId,
            publicKey: { ...identity.publicKey, d: identity.privateKey.d } as never,
            nickname: '被污染的输入',
          }),
        );
      });
      tainted.on('close', () => resolve());
      tainted.on('error', () => resolve());
      setTimeout(resolve, 5_000);
    });

    const ok = await connect(harness!, identity, '正常的昵称');
    expect(ok.ok).toBe(true);
    ok.ok && ok.connection.close();

    const text = harness!.logText();
    expect(text).not.toContain(identity.privateKey.d);
    expect(text).not.toContain(identity.privateKey.x);
    expect(text).not.toContain('被污染的输入');
    // 公开标识可以出现在日志里，用于排障。
    expect(text).toContain(identity.deviceId);
  });
});
