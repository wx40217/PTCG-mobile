import { beforeEach, describe, expect, it } from 'vitest';
import { Preferences } from '@capacitor/preferences';
import { createDeviceIdentity, deriveDeviceId } from '@ptcg/protocol';
import { createPreferencesProfileStore, loadOrCreateIdentity } from '../src/storage/profileStore.ts';

/**
 * 身份持久化用真实 Preferences 实现（jsdom 下是 localStorage 后端）验证，
 * 而不是内存替身：这是「重新启动客户端保留昵称、地址和身份」的核心路径。
 */
describe('本机资料持久化（真实 Preferences 实现）', () => {
  beforeEach(async () => {
    await Preferences.clear();
  });

  it('写入后可读回昵称、地址与完整设备身份', async () => {
    const store = createPreferencesProfileStore();
    const identity = await createDeviceIdentity();
    await store.write({ nickname: '小智', serviceAddress: 'https://example.test:8787', identity });

    const reloaded = await createPreferencesProfileStore().read();
    expect(reloaded.nickname).toBe('小智');
    expect(reloaded.serviceAddress).toBe('https://example.test:8787');
    expect(reloaded.identity?.deviceId).toBe(identity.deviceId);
    expect(reloaded.identity?.privateKey.d).toBe(identity.privateKey.d);
    expect(reloaded.identity?.publicKey.x).toBe(identity.publicKey.x);
  });

  it('首次载入生成身份并落盘；再次载入复用同一身份', async () => {
    const first = await loadOrCreateIdentity(createPreferencesProfileStore());
    expect(first.deviceId).toBe(await deriveDeviceId(first.publicKey));

    const second = await loadOrCreateIdentity(createPreferencesProfileStore());
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.privateKey.d).toBe(first.privateKey.d);
  });

  it('损坏的身份数据会被丢弃并重新生成，而不是让启动失败', async () => {
    await Preferences.set({ key: 'ptcg.identity.v1', value: '{ 不是合法 JSON' });
    const identity = await loadOrCreateIdentity(createPreferencesProfileStore());
    expect(identity.deviceId).toMatch(/^dev_/u);

    const stored = await Preferences.get({ key: 'ptcg.identity.v1' });
    expect(stored.value).toContain(identity.deviceId);
  });

  it('私钥材料只出现在本机存储，不会被写成昵称或地址', async () => {
    const identity = await createDeviceIdentity();
    const store = createPreferencesProfileStore();
    await store.write({ nickname: '小智', serviceAddress: 'https://example.test', identity });

    const nickname = await Preferences.get({ key: 'ptcg.nickname.v1' });
    const address = await Preferences.get({ key: 'ptcg.serviceAddress.v1' });
    expect(nickname.value).toBe('小智');
    expect(address.value).toBe('https://example.test');
    expect(nickname.value).not.toContain(identity.privateKey.d);
    expect(address.value).not.toContain(identity.privateKey.d);
  });
});
