/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 注入：开发构建为模拟器回环地址，正式构建为空串。 */
declare const __DEV_DEFAULT_SERVICE_ADDRESS__: string;
