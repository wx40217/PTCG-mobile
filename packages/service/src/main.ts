import { readFileSync } from 'node:fs';
import { SERVICE_NAME, SERVICE_VERSION, PROTOCOL_VERSION } from '@ptcg/protocol';
import type { ServiceCatalogOptions } from './catalog.ts';
import { createLogger } from './logger.ts';
import { createService, type ServiceOptions, type ServiceTlsOptions } from './server.ts';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_PONG_TIMEOUT_MS, heartbeatDetectionBoundMs } from './heartbeat.ts';

interface CliOptions {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly tls?: ServiceTlsOptions;
  readonly catalog: ServiceCatalogOptions;
  /** 断线预算毫秒；测试部署可用短预算验证临界行为，默认 180000。 */
  readonly disconnectBudgetMs?: number;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function parseCli(argv: readonly string[]): CliOptions {
  const host = readFlag(argv, 'host') ?? process.env['PTCG_HOST'] ?? '127.0.0.1';
  const rawPort = readFlag(argv, 'port') ?? process.env['PTCG_PORT'] ?? '8787';
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口不合法: ${rawPort}`);
  }
  const dbPath = readFlag(argv, 'db') ?? process.env['PTCG_DB'] ?? 'ptcg-service.sqlite';
  const catalogPath = readFlag(argv, 'catalog') ?? process.env['PTCG_CATALOG'];
  const resourceDir = readFlag(argv, 'resource-dir') ?? process.env['PTCG_RESOURCE_DIR'];
  const cardImageDir = readFlag(argv, 'card-image-dir') ?? process.env['PTCG_CARD_IMAGE_DIR'];
  const resourceBundle = readFlag(argv, 'resource-bundle') ?? process.env['PTCG_RESOURCE_BUNDLE'];
  if (cardImageDir !== undefined && resourceBundle !== undefined) {
    throw new Error('--card-image-dir 与 --resource-bundle 只能配置一个卡图来源');
  }
  const catalog: ServiceCatalogOptions = {
    ...(catalogPath === undefined ? {} : { catalogPath }),
    ...(resourceDir === undefined ? {} : { resourceDir }),
    ...(cardImageDir === undefined ? {} : { cardImageDir }),
    ...(resourceBundle === undefined ? {} : { resourceBundle }),
  };
  const certPath = readFlag(argv, 'tls-cert') ?? process.env['PTCG_TLS_CERT'];
  const keyPath = readFlag(argv, 'tls-key') ?? process.env['PTCG_TLS_KEY'];
  const rawDisconnectBudget = readFlag(argv, 'disconnect-budget-ms') ?? process.env['PTCG_DISCONNECT_BUDGET_MS'];
  let disconnectBudgetMs: number | undefined;
  if (rawDisconnectBudget !== undefined) {
    disconnectBudgetMs = Number.parseInt(rawDisconnectBudget, 10);
    if (!Number.isInteger(disconnectBudgetMs) || disconnectBudgetMs <= 0) {
      throw new Error(`断线预算不合法: ${rawDisconnectBudget}`);
    }
  }
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new Error('TLS 需要同时提供 --tls-cert 与 --tls-key');
  }
  const extra = disconnectBudgetMs === undefined ? {} : { disconnectBudgetMs };
  if (certPath !== undefined && keyPath !== undefined) {
    return { host, port, dbPath, tls: { cert: readFileSync(certPath), key: readFileSync(keyPath) }, catalog, ...extra };
  }
  return { host, port, dbPath, catalog, ...extra };
}

async function main(): Promise<void> {
  const logger = createLogger((line) => process.stdout.write(`${line}\n`));
  const options = parseCli(process.argv.slice(2));
  const serviceOptions: ServiceOptions = {
    host: options.host,
    port: options.port,
    dbPath: options.dbPath,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    catalog: options.catalog,
    ...(options.disconnectBudgetMs === undefined
      ? {}
      : { rooms: { limits: { disconnectBudgetMs: options.disconnectBudgetMs } } }),
    logger,
  };
  const service = await createService(serviceOptions);

  // 供管理者核查：PID、端口、协议版本一次性写入标准输出。
  logger.info('service.listening', {
    pid: process.pid,
    host: service.host,
    port: service.port,
    protocolVersion: PROTOCOL_VERSION,
    service: SERVICE_NAME,
    serviceVersion: SERVICE_VERSION,
    serviceInstanceId: service.serviceInstanceId,
    secure: service.secure,
    db: options.dbPath,
    catalog: 'configured',
    resourceSampleDir: options.catalog.resourceDir === undefined ? 'none' : 'configured',
    cardImageDir: options.catalog.cardImageDir === undefined ? 'none' : 'configured',
    resourceBundle: options.catalog.resourceBundle === undefined ? 'none' : 'configured',
    disconnectBudgetMs: options.disconnectBudgetMs ?? 180_000,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatPongTimeoutMs: DEFAULT_HEARTBEAT_PONG_TIMEOUT_MS,
    heartbeatDetectionBoundMs: heartbeatDetectionBoundMs(DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_PONG_TIMEOUT_MS),
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('service.shutdown', { signal });
    void service.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`服务启动失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
