import { beforeEach, describe, expect, it } from 'vitest';
import { Preferences } from '@capacitor/preferences';
import type { MatchClientMessage, RoomClientMessage } from '@ptcg/protocol';
import {
  createMemoryRecoveryStore,
  createPreferencesRecoveryStore,
  type MatchRecoveryRecord,
} from '../src/recovery/recoveryStore.ts';

const matchCommand: MatchClientMessage = {
  type: 'choose-turn-order',
  commandId: 'cmd-match-1',
  sessionId: 'session-1',
  expectedVersion: 3,
  choiceId: 'choice-2',
  goFirst: true,
};

const roomCommand: RoomClientMessage = {
  type: 'select-deck',
  commandId: 'cmd-room-1',
  roomId: 'room-instance-1',
  expectedVersion: 4,
  deck: { formatVersion: 1, environmentId: 'zh-cn-standard-2025-06-05', cards: [] },
};

function record(overrides: Partial<MatchRecoveryRecord> = {}): MatchRecoveryRecord {
  return {
    version: 1,
    serviceAddress: 'http://127.0.0.1:8787',
    serviceInstanceId: 'instance-1',
    roomId: 'room-instance-1',
    code: '042000',
    sessionId: 'session-1',
    pending: null,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('可恢复对局引用持久化（#15）', () => {
  beforeEach(async () => {
    await Preferences.clear();
  });

  it('真实 Preferences 往返：房间/实例/会话与未确认命令逐字段保留', async () => {
    const store = createPreferencesRecoveryStore();
    await store.write(record({ pending: matchCommand }));
    const reloaded = await createPreferencesRecoveryStore().read();
    expect(reloaded).toEqual(record({ pending: matchCommand }));
  });

  it('等待中的房间（尚未开局）sessionId 为 null 也能恢复', async () => {
    const store = createPreferencesRecoveryStore();
    await store.write(record({ sessionId: null, pending: roomCommand }));
    const reloaded = await store.read();
    expect(reloaded?.sessionId).toBeNull();
    expect(reloaded?.pending).toEqual(roomCommand);
  });

  it('损坏或结构非法的记录按“无记录”处理，不阻断启动', async () => {
    await Preferences.set({ key: 'ptcg.matchRecovery.v1', value: '{ 不是 JSON' });
    expect(await createPreferencesRecoveryStore().read()).toBeUndefined();
    await Preferences.set({ key: 'ptcg.matchRecovery.v1', value: JSON.stringify({ version: 2, roomId: 'x' }) });
    expect(await createPreferencesRecoveryStore().read()).toBeUndefined();
  });

  it('结构合法但命令非法的未确认命令被丢弃，不把假命令重放给服务端', async () => {
    await Preferences.set({
      key: 'ptcg.matchRecovery.v1',
      value: JSON.stringify(record({ pending: { type: 'choose-turn-order', commandId: 'x' } as unknown as MatchClientMessage })),
    });
    const reloaded = await createPreferencesRecoveryStore().read();
    expect(reloaded?.pending).toBeNull();
    expect(reloaded?.roomId).toBe('room-instance-1');
  });

  it('清除后不再恢复', async () => {
    const store = createPreferencesRecoveryStore();
    await store.write(record());
    await store.clear();
    expect(await store.read()).toBeUndefined();
  });

  it('内存存储用于自动化注入，行为与持久化实现一致', async () => {
    const store = createMemoryRecoveryStore();
    expect(await store.read()).toBeUndefined();
    await store.write(record({ pending: roomCommand }));
    expect((await store.read())?.pending).toEqual(roomCommand);
    await store.clear();
    expect(await store.read()).toBeUndefined();
  });
});
