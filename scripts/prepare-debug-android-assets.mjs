#!/usr/bin/env node
/**
 * 为 debug 变体准备仅开发环境的 Android 资产。
 *
 * 背景：客户端调试连接的是局域网明文地址（http://10.0.2.2:8787 → ws://…）。
 * WebView 的页面源是 https://localhost（androidScheme=https，WebCrypto 需要安全
 * 上下文），因此 DOM WebSocket 的 ws:// 属于混合内容，会被 WebView 拦截 ——
 * 即使 Android network_security_config（debug 变体）允许明文、原生 CapacitorHttp
 * 健康检查也能成功。
 *
 * 方案：`cap sync` 生成的 `app/src/main/assets/capacitor.config.json` 保持
 * `android.allowMixedContent = false`（release 用），这里再生成一份 debug 源集
 * 专属的 `app/src/debug/assets/capacitor.config.json`，把 allowMixedContent 置为
 * true。Android 资产合并时 debug 构建类型的同名文件优先于 main，因此：
 *   - debug APK：允许 ws://（仅开发）；
 *   - release APK：物理上不包含 debug 源集，仍严格 HTTPS/WSS。
 *
 * 必须在 `cap sync android` 之后运行（main 资产由它生成）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mainConfigPath = join(root, 'packages', 'client', 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json');
const debugConfigPath = join(root, 'packages', 'client', 'android', 'app', 'src', 'debug', 'assets', 'capacitor.config.json');

let raw;
try {
  raw = await readFile(mainConfigPath, 'utf8');
} catch {
  throw new Error(`找不到 cap sync 生成的配置：${mainConfigPath}，请先运行 cap sync android`);
}

const config = JSON.parse(raw);
if (typeof config !== 'object' || config === null || typeof config.server?.androidScheme !== 'string') {
  throw new Error(`配置格式不符合预期：${mainConfigPath}`);
}
if (config.server.androidScheme !== 'https') {
  throw new Error(`页面源必须是 https（WebCrypto 安全上下文），实际为 ${config.server.androidScheme}`);
}

config.android = { ...(config.android ?? {}), allowMixedContent: true };

await mkdir(dirname(debugConfigPath), { recursive: true });
await writeFile(debugConfigPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
console.log(`已生成 debug 专属配置（allowMixedContent=true）：${debugConfigPath}`);
