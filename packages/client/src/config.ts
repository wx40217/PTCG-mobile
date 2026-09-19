/**
 * 构建期配置。
 *
 * 关键约束：正式包不得内置 localhost / 模拟器地址，也不得允许明文传输。
 *
 * 开发用的默认地址由 Vite 的 `define` 在构建期注入（见 vite.config.ts）：正式构建
 * 注入空字符串，字符串字面量根本不会进入产物，`npm run check:release-bundle`
 * 会对此做可执行检查。
 */
declare const __DEV_DEFAULT_SERVICE_ADDRESS__: string;

export interface BuildConfig {
  /** 是否允许 http/ws 明文（仅开发配置为 true）。 */
  readonly allowInsecure: boolean;
  /** 服务地址输入框的初始值；正式包为空字符串。 */
  readonly defaultServiceAddress: string;
  readonly appVersion: string;
}

export interface BuildEnv {
  readonly DEV?: boolean;
  readonly VITE_ALLOW_INSECURE?: string;
  readonly VITE_APP_VERSION?: string;
}

/**
 * 纯函数形式便于单测；`devDefaultAddress` 由构建期注入，函数体内不出现
 * 任何具体地址字面量。
 */
export function readBuildConfig(env: BuildEnv, devDefaultAddress: string): BuildConfig {
  const isDev = env.DEV === true;
  return {
    allowInsecure: isDev || env.VITE_ALLOW_INSECURE === 'true',
    // 开发期预填模拟器回环地址便于联调；发布包必须让用户自行填写。
    defaultServiceAddress: isDev ? devDefaultAddress : '',
    appVersion: env.VITE_APP_VERSION ?? '0.1.0',
  };
}

export const buildConfig: BuildConfig = readBuildConfig(
  import.meta.env as BuildEnv,
  __DEV_DEFAULT_SERVICE_ADDRESS__,
);
