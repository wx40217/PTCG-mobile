import { Preferences } from '@capacitor/preferences';
import { parseClientMessage, type ClientMessage } from '@ptcg/protocol';

/**
 * 可恢复对局引用（#15）。
 *
 * 只保存“去哪里恢复”的引用与尚未确认的原命令，不保存任何对局私有状态
 * （手牌、奖赏、牌库都不在本机）。服务端确认座位归属后，客户端用 `roomId`
 * 精确重入原实例，并原样重发 `pending`（相同 `commandId`）以获得同一结果。
 *
 * `serviceInstanceId` 用于识别服务重启：不同实例意味着旧对局的内存状态已经
 * 不存在，客户端必须显示“服务中断，无胜负”，不得假装恢复。
 */
export interface MatchRecoveryRecord {
  readonly version: 1;
  /** 建立记录时的服务地址；冷启动自动恢复的目标。 */
  readonly serviceAddress: string;
  /** 建立记录时的服务进程实例。 */
  readonly serviceInstanceId: string;
  readonly roomId: string;
  readonly code: string;
  /** 已建立对局时是会话 ID；仅在房间等待中为 null。 */
  readonly sessionId: string | null;
  /** 已发出、尚未确认的命令；重连后必须原样重发（含原 commandId）。 */
  readonly pending: ClientMessage | null;
  readonly updatedAt: number;
}

export interface RecoveryStore {
  read(): Promise<MatchRecoveryRecord | undefined>;
  write(record: MatchRecoveryRecord): Promise<void>;
  clear(): Promise<void>;
}

const RECOVERY_KEY = 'ptcg.matchRecovery.v1';

function parsePending(value: unknown): ClientMessage | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = parseClientMessage(JSON.stringify(value));
  return parsed.ok && parsed.message.type !== 'hello' ? parsed.message : null;
}

function parseRecord(raw: string | null): MatchRecoveryRecord | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return undefined;
  }
  const record = decoded as Record<string, unknown>;
  if (
    record['version'] !== 1 ||
    typeof record['serviceAddress'] !== 'string' ||
    record['serviceAddress'].length === 0 ||
    typeof record['serviceInstanceId'] !== 'string' ||
    record['serviceInstanceId'].length === 0 ||
    typeof record['roomId'] !== 'string' ||
    record['roomId'].length === 0 ||
    typeof record['code'] !== 'string' ||
    typeof record['updatedAt'] !== 'number' ||
    (record['sessionId'] !== null && typeof record['sessionId'] !== 'string')
  ) {
    return undefined;
  }
  return {
    version: 1,
    serviceAddress: record['serviceAddress'],
    serviceInstanceId: record['serviceInstanceId'],
    roomId: record['roomId'],
    code: record['code'],
    sessionId: (record['sessionId'] as string | null) ?? null,
    pending: parsePending(record['pending']),
    updatedAt: record['updatedAt'],
  };
}

/** Capacitor Preferences 实现；损坏记录按“无记录”处理，不阻断启动。 */
export function createPreferencesRecoveryStore(): RecoveryStore {
  return {
    async read(): Promise<MatchRecoveryRecord | undefined> {
      const stored = await Preferences.get({ key: RECOVERY_KEY });
      return parseRecord(stored.value);
    },
    async write(record: MatchRecoveryRecord): Promise<void> {
      await Preferences.set({ key: RECOVERY_KEY, value: JSON.stringify(record) });
    },
    async clear(): Promise<void> {
      await Preferences.remove({ key: RECOVERY_KEY });
    },
  };
}

export function createMemoryRecoveryStore(initial?: MatchRecoveryRecord): RecoveryStore {
  let current = initial;
  return {
    read: async () => current,
    write: async (record) => {
      current = record;
    },
    clear: async () => {
      current = undefined;
    },
  };
}
