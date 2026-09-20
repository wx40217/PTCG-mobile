import { describe, expect, it } from 'vitest';
import { readBuildConfig } from '../src/config.ts';

const DEV_ADDRESS = 'http://10.0.2.2:8787';

describe('构建期配置', () => {
  it('正式构建不预填地址且不允许明文', () => {
    const config = readBuildConfig({ devDefaultAddress: '', allowInsecure: false }, {});
    expect(config.defaultServiceAddress).toBe('');
    expect(config.allowInsecure).toBe(false);
  });

  it('开发构建预填模拟器地址并允许局域网明文', () => {
    const config = readBuildConfig({ devDefaultAddress: DEV_ADDRESS, allowInsecure: true }, {});
    expect(config.defaultServiceAddress).toBe(DEV_ADDRESS);
    expect(config.allowInsecure).toBe(true);
  });

  it('版本号来自构建环境，缺省有回退值', () => {
    expect(readBuildConfig({ devDefaultAddress: '', allowInsecure: false }, { VITE_APP_VERSION: '9.9.9' }).appVersion).toBe(
      '9.9.9',
    );
    expect(readBuildConfig({ devDefaultAddress: '', allowInsecure: false }, {}).appVersion).toBe('0.1.0');
  });

  it('明文与地址只能由构建标志决定，读不到运行时可覆盖的开关', () => {
    // 即使环境里塞进 VITE_ALLOW_INSECURE，配置也不会据此放开明文。
    const config = readBuildConfig(
      { devDefaultAddress: '', allowInsecure: false },
      { VITE_ALLOW_INSECURE: 'true' } as never,
    );
    expect(config.allowInsecure).toBe(false);
  });
});
