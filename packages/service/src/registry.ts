import { DatabaseSync } from 'node:sqlite';
import { canonicalPublicKey, type PublicKeyJwk } from '@ptcg/protocol';

export interface StoredDevice {
  readonly deviceId: string;
  readonly publicKey: PublicKeyJwk;
  readonly nickname: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface DeviceUpsert {
  readonly deviceId: string;
  readonly publicKey: PublicKeyJwk;
  readonly nickname: string;
  readonly now: number;
}

export type UpsertResult =
  | { readonly ok: true; readonly registered: boolean; readonly device: StoredDevice }
  | { readonly ok: false; readonly reason: 'public_key_mismatch' };

export interface DeviceRegistry {
  upsert(input: DeviceUpsert): UpsertResult;
  close(): void;
}

interface DeviceRow {
  device_id: string;
  public_key: string;
  nickname: string;
  created_at: number;
  last_seen_at: number;
}

function toStored(row: DeviceRow): StoredDevice {
  return {
    deviceId: row.device_id,
    publicKey: JSON.parse(row.public_key) as PublicKeyJwk,
    nickname: row.nickname,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * 设备登记表。
 *
 * 只保存公开材料：设备 ID、公钥、显示昵称与时间戳。昵称是显示用的可变字段，
 * 不参与身份判定；公钥一旦登记即不可被替换，替换视为身份冲突。
 */
export function createDeviceRegistry(dbPath: string): DeviceRegistry {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      nickname TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
  `);

  const selectOne = database.prepare('SELECT * FROM devices WHERE device_id = ?');
  const insert = database.prepare(
    'INSERT INTO devices (device_id, public_key, nickname, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  );
  const updateNickname = database.prepare('UPDATE devices SET nickname = ?, last_seen_at = ? WHERE device_id = ?');

  return {
    upsert(input: DeviceUpsert): UpsertResult {
      const existing = selectOne.get(input.deviceId) as DeviceRow | undefined;
      const publicKey = canonicalPublicKey(input.publicKey);
      if (existing === undefined) {
        insert.run(input.deviceId, publicKey, input.nickname, input.now, input.now);
        return {
          ok: true,
          registered: true,
          device: {
            deviceId: input.deviceId,
            publicKey: input.publicKey,
            nickname: input.nickname,
            createdAt: input.now,
            lastSeenAt: input.now,
          },
        };
      }
      if (existing.public_key !== publicKey) {
        return { ok: false, reason: 'public_key_mismatch' };
      }
      updateNickname.run(input.nickname, input.now, input.deviceId);
      return {
        ok: true,
        registered: false,
        device: { ...toStored(existing), nickname: input.nickname, lastSeenAt: input.now },
      };
    },

    close(): void {
      database.close();
    },
  };
}
