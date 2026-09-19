#!/usr/bin/env node
// Bounded, read-only language screen for card images stored in an .asar pack.
//
// For each requested entry this extracts the bundle into a scratch directory,
// decodes its Texture2D with UnityPy, OCRs the PNG with the Windows OCR engine,
// and classifies the visible script as Simplified Chinese / Traditional Chinese
// / Latin. It is deliberately bounded: pass an explicit --entry list; there is
// no directory walking inside the archive and no bulk extraction.
//
//   node tools/card-image-export/screen_evidence.mjs \
//     --asar <pack.asar> --work <scratchdir> \
//     --entry files/sv1_en_001 --entry files/sm10_en_001
//
// Requires the UnityPy virtualenv used by export_textures.py (see its README)
// and Windows PowerShell for the OCR step. Set UNITYPY_PYTHON to override the
// interpreter path; it defaults to <work>/venv/Scripts/python.exe.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openAsar, closeAsar, findEntry, readEntry } from '../asar-inspect/asar-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Simplified/Traditional discriminators, written as escapes so this file stays
// pure ASCII. Each pair is [simplified, traditional]; both forms appear in
// ordinary card text, so the dominant script is a stable signal.
const SCRIPT_PAIRS = [
  ['\u5b9d', '\u5bf6'], // 宝 / 寶
  ['\u68a6', '\u5922'], // 梦 / 夢
  ['\u7840', '\u790e'], // 础 / 礎
  ['\u56fd', '\u570b'], // 国 / 國
  ['\u56fe', '\u5716'], // 图 / 圖
  ['\u9274', '\u9451'], // 鉴 / 鑑
  ['\u4f24', '\u50b7'], // 伤 / 傷
  ['\u5bf9', '\u5c0d'], // 对 / 對
  ['\u573a', '\u5834'], // 场 / 場
  ['\u4e2a', '\u500b'], // 个 / 個
  ['\u8fd9', '\u9019'], // 这 / 這
  ['\u4eec', '\u5011'], // 们 / 們
  ['\u65f6', '\u6642'], // 时 / 時
  ['\u4ece', '\u5f9e'], // 从 / 從
  ['\u7ec3', '\u7df4'], // 练 / 練
  ['\u70b9', '\u9ede'], // 点 / 點
  ['\u4e8e', '\u65bc'], // 于 / 於
  ['\u968f', '\u96a8'], // 随 / 隨
  ['\u9009', '\u9078'], // 选 / 選
  ['\u62e9', '\u64c7'], // 择 / 擇
  ['\u8f93', '\u8f38'], // 输 / 輸
  ['\u5f00', '\u958b'], // 开 / 開
  ['\u4e50', '\u6a02'], // 乐 / 樂
  ['\u7ebf', '\u7dda'], // 线 / 線
];

function count(text, needle) {
  return text.split(needle).length - 1;
}

function classify(text) {
  let simplified = 0;
  let traditional = 0;
  for (const [hans, hant] of SCRIPT_PAIRS) {
    simplified += count(text, hans);
    traditional += count(text, hant);
  }
  const latin = (text.match(/[A-Za-z]{3,}/g) ?? []).length;
  let verdict = 'unknown';
  if (simplified > traditional) verdict = 'zh-Hans';
  else if (traditional > simplified) verdict = 'zh-Hant';
  else if (latin > 4) verdict = 'en';
  return { verdict, simplified, traditional, latin };
}

function parseArgs(argv) {
  const opts = { asar: '', work: '', entries: [], lang: 'zh-Hans-CN' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--asar') opts.asar = argv[++i];
    else if (arg === '--work') opts.work = argv[++i];
    else if (arg === '--entry') opts.entries.push(argv[++i]);
    else if (arg === '--lang') opts.lang = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.asar || !opts.work || !opts.entries.length) {
    throw new Error('usage: screen_evidence.mjs --asar <pack> --work <dir> --entry <name> [...]');
  }
  return opts;
}

function runOcr(script, png, lang, outFile) {
  // Write the JSON to a file: piping CJK through the PowerShell console encoding
  // mangles it on this machine.
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', png, '-Lang', lang, '-Out', outFile],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const venvPython = process.env.UNITYPY_PYTHON ?? path.join(opts.work, 'venv', 'Scripts', 'python.exe');
  const exportScript = path.join(here, 'export_textures.py');
  const ocrScript = path.join(here, '..', 'ocr', 'ocr-windows.ps1');
  const handle = openAsar(opts.asar);
  const report = [];
  try {
    for (const entry of opts.entries) {
      const found = findEntry(handle, entry);
      if (!found || found.files) throw new Error(`entry not found: ${entry}`);
      const bundleDir = path.join(opts.work, 'bundles');
      fs.mkdirSync(bundleDir, { recursive: true });
      const bundlePath = path.join(bundleDir, `${entry.replace(/\//g, '_')}.bundle`);
      fs.writeFileSync(bundlePath, readEntry(handle, found));
      const pngDir = path.join(opts.work, 'png', entry.replace(/\//g, '_'));
      const exported = JSON.parse(
        execFileSync(venvPython, [exportScript, bundlePath, '--out', pngDir, '--json'], {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        }),
      );
      const card = exported.textures.find((t) => t.width === 1024) ?? exported.textures[0];
      const png = path.join(pngDir, card.png);
      const ocrResult = runOcr(ocrScript, png, opts.lang, path.join(pngDir, 'ocr.json'));
      const text = (ocrResult.lines ?? []).join('');
      const row = {
        entry,
        bundle_sha256: exported.bundle_sha256,
        png_sha256: card.png_sha256,
        width: card.width,
        height: card.height,
        asset_path: exported.material_manifest?.asset_path ?? null,
        script: classify(text),
        ocr_text: text,
      };
      report.push(row);
      process.stderr.write(`${entry}\t${row.script.verdict}\n`);
    }
  } finally {
    closeAsar(handle);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
