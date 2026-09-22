import { Capacitor, registerPlugin } from '@capacitor/core';

/** Raw trusted storage. A compare-and-swap transaction prevents concurrent hosts overwriting saves. */
export interface SoloRawRecord { readonly current: string | null; readonly previous: string | null; readonly ledger: string | null }
export interface SoloStorage {
  read(): Promise<SoloRawRecord>;
  commit(options: { expected: string | null; next: string; ledger: string; preservePrevious?: boolean }): Promise<void>;
}
const native = registerPlugin<SoloStorage>('SoloSave');

export function createSoloStorage(): SoloStorage {
  return Capacitor.isNativePlatform() ? native : createIndexedDbSoloStorage();
}

export function createIndexedDbSoloStorage(name = 'ptcg-solo-v1'): SoloStorage {
  let opening: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('save'); };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => { opening = undefined; reject(request.error); };
    request.onblocked = () => { opening = undefined; reject(new Error('存档数据库被其他页面占用。')); };
  });
  return {
    async read() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('save', 'readonly');
        const request = tx.objectStore('save').get('current');
        tx.oncomplete = () => resolve(request.result ?? { current: null, previous: null, ledger: null });
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('无法读取单人存档。'));
      });
    },
    async commit(options) {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction('save', 'readwrite', { durability: 'strict' });
        const store = tx.objectStore('save');
        const request = store.get('current');
        let conflict = false;
        request.onsuccess = () => {
          const old: SoloRawRecord = request.result ?? { current: null, previous: null, ledger: null };
          if (old.current !== options.expected) { conflict = true; tx.abort(); return; }
          store.put({ current: options.next, previous: options.preservePrevious ? old.previous : old.current, ledger: options.ledger }, 'current');
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error(conflict ? '存档已被另一会话更新，请重新读取。' : '单人存档提交失败，原档案已保留。'));
      });
    },
  };
}
