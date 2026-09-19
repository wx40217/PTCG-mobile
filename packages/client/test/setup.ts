import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';

// 未开启 vitest globals 时 RTL 不会自动清理，多次 render 会同时留在文档里。
afterEach(() => {
  cleanup();
});

// jsdom 不实现 WebCrypto 的 SubtleCrypto，而设备身份依赖 ECDSA P-256。
// 把 Node 的实现装进来，让测试跑真实的密码学代码而不是替身。
if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

// 清掉可能在用例之间残留的 Capacitor 偏好数据。
if (typeof localStorage !== 'undefined') {
  localStorage.clear();
}
