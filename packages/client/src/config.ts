/**
 * 构建期配置。
 *
 * 关键约束：正式包不得内置 localhost / 模拟器地址，也不得允许明文传输。
 *
 * 两者都由 Vite 的 `define` 在**构建期**注入（见 vite.config.ts），而不是读取
 * 运行时可覆盖的环境变量：正式构建注入空地址与 `allowInsecure: false`，因此
 * `.env.local` 之类的本地文件无法把明文放行带进发布包。
 * `npm run check:release-bundle` 会对产物做可执行检查。
 */
declare const __DEV_DEFAULT_SERVICE_ADDRESS__: string;
declare const __ALLOW_INSECURE__: boolean;

export interface BuildFlags {
  /** 仅开发构建注入模拟器回环地址；正式构建为空串。 */
  readonly devDefaultAddress: string;
  /** 仅非 production 构建注入 true。 */
  readonly allowInsecure: boolean;
}

export interface BuildConfig {
  /** 是否允许 http/ws 明文（仅开发配置为 true）。 */
  readonly allowInsecure: boolean;
  /** 服务地址输入框的初始值；正式包为空字符串。 */
  readonly defaultServiceAddress: string;
  readonly appVersion: string;
}

export interface BuildEnv {
  readonly VITE_APP_VERSION?: string;
}

/** 纯函数形式便于单测；函数体内不出现任何具体地址字面量。 */
export function readBuildConfig(flags: BuildFlags, env: BuildEnv): BuildConfig {
  return {
    allowInsecure: flags.allowInsecure,
    defaultServiceAddress: flags.devDefaultAddress,
    appVersion: env.VITE_APP_VERSION ?? '0.1.0',
  };
}

export const buildConfig: BuildConfig = readBuildConfig(
  { devDefaultAddress: __DEV_DEFAULT_SERVICE_ADDRESS__, allowInsecure: __ALLOW_INSECURE__ },
  import.meta.env as BuildEnv,
);
