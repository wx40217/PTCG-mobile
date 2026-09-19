import { Preferences } from '@capacitor/preferences';
import { deriveDeviceId, type DeviceIdentity, type PrivateKeyJwk, type PublicKeyJwk } from '@ptcg/protocol';

/** 本机持久化的资料：昵称与地址只影响显示，身份才决定“我是谁”。 */
export interface StoredProfile {
  readonly nickname: string;
  readonly serviceAddress: string;
  readonly identity?: DeviceIdentity;
}

export interface ProfileStore {
  read(): Promise<StoredProfile>;
  write(profile: StoredProfile): Promise<void>;
}

const IDENTITY_KEY = 'ptcg.identity.v1';
const NICKNAME_KEY = 'ptcg.nickname.v1';
const ADDRESS_KEY = 'ptcg.serviceAddress.v1';

export function createMemoryProfileStore(initial: StoredProfile = { nickname: '', serviceAddress: '' }): ProfileStore {
  let current = initial;
  return {
    read: async () => current,
    write: async (profile) => {
      current = profile;
    },
  };
}

function parseIdentity(raw: string | null): DeviceIdentity | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
    if (
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.publicKey?.x !== 'string' ||
      typeof parsed.publicKey?.y !== 'string' ||
      typeof parsed.privateKey?.d !== 'string'
    ) {
      return undefined;
    }
    return {
      deviceId: parsed.deviceId,
      publicKey: parsed.publicKey as PublicKeyJwk,
      privateKey: parsed.privateKey as PrivateKeyJwk,
    };
  } catch {
    return undefined;
  }
}

/**
 * Android 上用 SharedPreferences，Web 上退回 localStorage。
 *
 * 私钥材料只保存在设备本地；它不会出现在日志、错误信息或服务端。
 */
export function createPreferencesProfileStore(): ProfileStore {
  return {
    async read(): Promise<StoredProfile> {
      const [identity, nickname, address] = await Promise.all([
        Preferences.get({ key: IDENTITY_KEY }),
        Preferences.get({ key: NICKNAME_KEY }),
        Preferences.get({ key: ADDRESS_KEY }),
      ]);
      const parsed = parseIdentity(identity.value);
      return {
        nickname: nickname.value ?? '',
        serviceAddress: address.value ?? '',
        ...(parsed === undefined ? {} : { identity: parsed }),
      };
    },
    async write(profile: StoredProfile): Promise<void> {
      const writes = [
        Preferences.set({ key: NICKNAME_KEY, value: profile.nickname }),
        Preferences.set({ key: ADDRESS_KEY, value: profile.serviceAddress }),
      ];
      if (profile.identity !== undefined) {
        writes.push(Preferences.set({ key: IDENTITY_KEY, value: JSON.stringify(profile.identity) }));
      }
      await Promise.all(writes);
    },
  };
}

/**
 * 载入或首次生成设备恢复身份。
 *
 * 私钥只写入本地存储；设备 ID 由公钥推导，可以与日志、界面安全共享。
 */
export async function loadOrCreateIdentity(store: ProfileStore): Promise<DeviceIdentity> {
  const profile = await store.read();
  if (profile.identity !== undefined) {
    return profile.identity;
  }
  const created = await createAndPersistIdentity(store);
  return created;
}

async function createAndPersistIdentity(store: ProfileStore): Promise<DeviceIdentity> {
  const { createDeviceIdentity } = await import('@ptcg/protocol');
  const identity = await createDeviceIdentity();
  const derived = await deriveDeviceId(identity.publicKey);
  if (derived !== identity.deviceId) {
    throw new Error('设备身份生成异常：标识与公钥不一致');
  }
  const profile = await store.read();
  await store.write({ ...profile, identity });
  return identity;
}
