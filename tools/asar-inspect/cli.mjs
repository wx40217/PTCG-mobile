#!/usr/bin/env node
// Bounded, read-only inspection of a card-image `.asar` package.
//
// Usage:
//   node tools/asar-inspect/cli.mjs list    <archive.asar> [--prefix files/] [--limit N]
//   node tools/asar-inspect/cli.mjs stat    <archive.asar> [--prefix files/]
//   node tools/asar-inspect/cli.mjs extract <archive.asar> --out <dir> [--entry <name> ...]
//   node tools/asar-inspect/cli.mjs extract <archive.asar> --out <dir> --manifest <file.jsonl>
//
// `extract` refuses to write outside --out and skips any entry whose relative
// path escapes it. The archive itself is only ever opened read-only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openAsar, closeAsar, listFiles, findEntry, readEntry } from './asar-lib.mjs';

function parseArgs(argv) {
  const [command, archive, ...rest] = argv;
  const opts = { prefix: '', limit: Infinity, out: '', entries: [], manifest: '' };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--prefix') opts.prefix = rest[++i];
    else if (arg === '--limit') opts.limit = Number(rest[++i]);
    else if (arg === '--out') opts.out = rest[++i];
    else if (arg === '--entry') opts.entries.push(rest[++i]);
    else if (arg === '--manifest') opts.manifest = rest[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { command, archive, opts };
}

function main() {
  const { command, archive, opts } = parseArgs(process.argv.slice(2));
  if (!command || !archive) {
    console.error('usage: cli.mjs <list|stat|extract> <archive.asar> [options]');
    process.exit(2);
  }
  const handle = openAsar(archive);
  try {
    if (command === 'list') {
      const files = listFiles(handle).filter((f) => f.path.startsWith(opts.prefix));
      for (const f of files.slice(0, opts.limit)) console.log(`${f.path}\t${f.size}`);
      console.error(`# ${Math.min(files.length, opts.limit)} of ${files.length} matching entries`);
      return;
    }
    if (command === 'stat') {
      const files = listFiles(handle).filter((f) => f.path.startsWith(opts.prefix));
      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      console.log(JSON.stringify({ entries: files.length, bytes, payloadBase: handle.payloadBase }, null, 2));
      return;
    }
    if (command === 'extract') {
      if (!opts.out) throw new Error('--out is required');
      let requested = opts.entries;
      if (opts.manifest) {
        requested = fs
          .readFileSync(opts.manifest, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      }
      if (!requested.length) throw new Error('no --entry or --manifest given');
      const outRoot = path.resolve(opts.out);
      fs.mkdirSync(outRoot, { recursive: true });
      const report = [];
      for (const entryPath of requested) {
        const entry = findEntry(handle, entryPath);
        if (!entry || entry.files) throw new Error(`entry not found or is a directory: ${entryPath}`);
        const bytes = readEntry(handle, entry);
        const target = path.resolve(outRoot, entryPath);
        if (!target.startsWith(outRoot + path.sep)) throw new Error(`refusing to write outside --out: ${entryPath}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        report.push({
          entry: entryPath,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
      for (const row of report) console.log(JSON.stringify(row));
      return;
    }
    throw new Error(`unknown command: ${command}`);
  } finally {
    closeAsar(handle);
  }
}

main();
