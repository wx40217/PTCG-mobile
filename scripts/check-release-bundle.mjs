#!/usr/bin/env node
/**
 * 发布包检查：正式构建产物里不得出现开发用的明文地址或本机回环地址。
 *
 * 这是「不把 localhost 固定进正式包」的可执行验收，而不是靠人工检查。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = [
  { token: '10.0.2.2', why: 'Android 模拟器回环地址' },
  { token: 'localhost', why: '本机回环地址' },
  { token: '127.0.0.1', why: '本机回环地址' },
  { token: ':8787', why: '开发默认端口' },
];

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
  for (const { token, why } of FORBIDDEN) {
    if (text.includes(token)) {
      findings.push(`${file.replace(projectRoot, '.')} 含 ${token}（${why}）`);
    }
  }
}

if (findings.length > 0) {
  console.error('发布包检查未通过：');
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
  process.exit(1);
}

console.log(`发布包检查通过：${files.length} 个产物文件中没有明文地址或回环地址。`);
