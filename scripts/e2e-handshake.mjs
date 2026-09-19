#!/usr/bin/env node
/**
 * 端到端握手验收脚本。
 *
 * 用「服务端构建产物」+「客户端真实连接代码」跑通一条完整链路：
 *   健康检查 -> 协议版本协商 -> 设备身份签名 -> 会话建立，
 * 并逐项验证身份重连、无效身份拒绝、协议不兼容与日志不泄露凭据。
 *
 * 用法: node scripts/e2e-handshake.mjs [--port 0]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const serviceEntry = join(root, 'packages', 'service', 'dist', 'main.js');
const protocolEntry = join(root, 'packages', 'protocol', 'dist', 'index.js');

const {
  connectToService,
  createDeviceIdentity,
} = await import(new URL(`file://${protocolEntry.replace(/\\/gu, '/')}`));

const directory = mkdtempSync(join(tmpdir(), 'ptcg-e2e-'));
const port = 18787;
const service = spawn(process.execPath, [serviceEntry, '--host', '127.0.0.1', '--port', String(port), '--db', join(directory, 'e2e.sqlite')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const serviceLogs = [];
service.stdout.on('data', (chunk) => serviceLogs.push(chunk.toString('utf8')));
service.stderr.on('data', (chunk) => serviceLogs.push(chunk.toString('utf8')));

const failures = [];
const passes = [];

function check(name, condition, detail = '') {
  if (condition) {
    passes.push(name);
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return response.json();
      }
    } catch {
      /* 服务尚未就绪 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('服务未在超时时间内就绪');
}

try {
  console.log('== 端到端握手验收 ==');
  const health = await waitForHealth();
  check('健康检查返回协议版本', health.protocolVersion === 1, JSON.stringify(health));
  check('健康检查无需鉴权', health.status === 'ok');

  const identity = await createDeviceIdentity();
  const base = { httpUrl: new URL(`http://127.0.0.1:${port}/`), wsUrl: new URL(`ws://127.0.0.1:${port}/`) };

  const first = await connectToService({ ...base, identity, nickname: '小智' });
  check('有效恢复身份可完成握手', first.ok === true, first.ok ? '' : first.failure.message);
  if (first.ok) {
    check('首次连接被登记', first.session.registered === true);
    check('昵称回传一致', first.session.nickname === '小智');
    check('设备标识与本地推导一致', first.session.deviceId === identity.deviceId);
    first.close();
  }

  const second = await connectToService({ ...base, identity, nickname: '小茂' });
  check('同一身份重连不被重复登记', second.ok === true && second.session.registered === false);
  if (second.ok) {
    check('昵称是可变显示字段', second.session.nickname === '小茂');
    second.close();
  }

  const forged = await connectToService({
    ...base,
    identity: { ...identity, deviceId: 'dev_0000000000000000000000' },
    nickname: '小智',
  });
  check('无效恢复身份被拒绝', forged.ok === false && forged.failure.kind === 'identity-rejected');

  const incompatible = await connectToService({ ...base, identity, nickname: '小智', protocolVersion: 99 });
  check('协议不兼容被拒绝', incompatible.ok === false && incompatible.failure.kind === 'incompatible');

  const offline = await connectToService({
    httpUrl: new URL('http://127.0.0.1:1/'),
    wsUrl: new URL('ws://127.0.0.1:1/'),
    identity,
    nickname: '小智',
  });
  check('服务不可达被识别', offline.ok === false && offline.failure.kind === 'unreachable');

  const logText = serviceLogs.join('');
  check('日志不含私钥标量', !logText.includes(identity.privateKey.d));
  check('日志包含公开设备标识（可排障）', logText.includes(identity.deviceId));
} catch (error) {
  failures.push(`执行异常: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  service.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n通过 ${passes.length} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
