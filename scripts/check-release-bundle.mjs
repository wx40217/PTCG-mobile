#!/usr/bin/env node
/**
 * 发布包检查：正式构建产物不得包含开发用地址、回环地址或明文网络协议。
 *
 * 这是「正式配置采用 HTTPS/WSS，不把 localhost 固定进正式包」的可执行验收，
 * 而不是靠人工检查。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 字面量级检查。 */
const FORBIDDEN_LITERALS = [
  { token: '10.0.2.2', why: 'Android 模拟器回环地址' },
  { token: 'localhost', why: '本机回环地址' },
  { token: '127.0.0.1', why: '本机回环地址' },
  { token: ':8787', why: '开发默认端口' },
];

/**
 * 协议级检查：出现 http/ws 明文 URL 即失败。
 *
 * XML 命名空间（如 React 内联 SVG 用到的 `http://www.w3.org/2000/svg`）不是网络
 * 端点，属于已知的合法例外，因此按主机名放行。
 */
const URL_PATTERN = /(?:https?|wss?):\/\/([a-z0-9.-]+)/giu;
const NAMESPACE_HOSTS = new Set(['www.w3.org']);

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(projectRoot, 'packages', 'client', 'dist');

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (/\.(?:js|css|html|json)$/u.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const files = await collectFiles(distDir);
const findings = [];

for (const file of files) {
  const text = await readFile(file, 'utf8');
  const relative = file.replace(projectRoot, '.');

  for (const { token, why } of FORBIDDEN_LITERALS) {
    if (text.includes(token)) {
      findings.push(`${relative} 含 ${token}（${why}）`);
    }
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const scheme = match[0].slice(0, match[0].indexOf(':')).toLowerCase();
    const host = (match[1] ?? '').toLowerCase();
    if (scheme === 'http' || scheme === 'ws') {
      if (!NAMESPACE_HOSTS.has(host)) {
        findings.push(`${relative} 含明文端点 ${match[0]}（正式配置只允许 https/wss）`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('发布包检查未通过：');
  for (const finding of new Set(findings)) {
    console.error(`  - ${finding}`);
  }
  process.exit(1);
}

console.log(`发布包检查通过：${files.length} 个产物文件中没有开发地址、回环地址或明文端点。`);
