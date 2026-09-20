/// <reference types="vite/client" />

/**
 * 由 vite.config.ts 的 define 注入，取值只取决于构建 mode：
 * - `__DEV_DEFAULT_SERVICE_ADDRESS__`：开发为模拟器回环地址，正式为空串。
 * - `__ALLOW_INSECURE__`：仅非 production 构建为 true。
 */
declare const __DEV_DEFAULT_SERVICE_ADDRESS__: string;
declare const __ALLOW_INSECURE__: boolean;
