import { Preferences } from '@capacitor/preferences';

export interface SoloPreferences { readonly nickname: string; readonly dialogue: boolean }
export interface SoloPreferencesStore {
  read(): Promise<SoloPreferences>;
  write(value: SoloPreferences): Promise<void>;
}
/** Small preferences only; full matches remain in the native transactional save store. */
export function createSoloPreferencesStore(): SoloPreferencesStore {
  return {
    async read() {
      const { value } = await Preferences.get({ key: 'ptcg.solo.preferences.v1' });
      if (value === null) return { nickname: '玩家', dialogue: true };
      const parsed = JSON.parse(value) as Partial<SoloPreferences>;
      if (typeof parsed.nickname !== 'string' || typeof parsed.dialogue !== 'boolean') throw new Error('单人偏好无法读取。');
      return { nickname: parsed.nickname, dialogue: parsed.dialogue };
    },
    async write(value) { await Preferences.set({ key: 'ptcg.solo.preferences.v1', value: JSON.stringify(value) }); },
  };
}
