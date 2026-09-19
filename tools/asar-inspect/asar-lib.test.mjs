// Regression tests for the asar reader.  Run with:
//   node --test tools/asar-inspect
//
// The key regression is the payloadBase boundary: payloadBase already
// includes the JSON bytes, so a valid empty archive (28 bytes: 16-byte
// prefix + 12-byte `{"files":{}}`) must open instead of being rejected as
// "archive header is larger than the file".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeAsar, findEntry, listFiles, openAsar, readEntry } from './asar-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-lib-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writeArchive(name, files) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, buildAsar(files));
  return file;
}

/** Build the exact electron/asar layout: sizePickle | headerPickle | payloads. */
function buildAsar(files) {
  const entries = {};
  const payloads = [];
  let offset = 0;
  for (const [entryName, bytes] of Object.entries(files)) {
    const buffer = Buffer.from(bytes);
    entries[entryName] = { size: buffer.length, offset };
    payloads.push(buffer);
    offset += buffer.length;
  }
  const jsonBytes = Buffer.from(JSON.stringify({ files: entries }), 'utf8');
  const padding = (4 - ((4 + jsonBytes.length) % 4)) % 4;
  const headerPayload = Buffer.alloc(4 + jsonBytes.length + padding);
  headerPayload.writeUInt32LE(jsonBytes.length, 0);
  jsonBytes.copy(headerPayload, 4);
  const headerBuf = Buffer.alloc(4 + headerPayload.length);
  headerBuf.writeUInt32LE(headerPayload.length, 0);
  headerPayload.copy(headerBuf, 4);
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(4, 0);
  sizeBuf.writeUInt32LE(headerBuf.length, 4);
  return Buffer.concat([sizeBuf, headerBuf, ...payloads]);
}

test('empty 28-byte archive is accepted (regression)', () => {
  const archive = writeArchive('empty.asar', {});
  assert.equal(fs.statSync(archive).size, 28, 'empty archive is exactly 28 bytes');
  const handle = openAsar(archive);
  try {
    assert.equal(handle.payloadBase, 28);
    assert.deepEqual(listFiles(handle), []);
  } finally {
    closeAsar(handle);
  }
});

test('small archive reads its payload', () => {
  const archive = writeArchive('tiny.asar', { 'hello.txt': Buffer.from('hello') });
  const handle = openAsar(archive);
  try {
    const files = listFiles(handle);
    assert.deepEqual(files, [{ path: 'hello.txt', size: 5, offset: 0 }]);
    assert.equal(readEntry(handle, findEntry(handle, 'hello.txt')).toString('utf8'), 'hello');
  } finally {
    closeAsar(handle);
  }
});

test('cli list works on a small archive', () => {
  const archive = writeArchive('cli.asar', { 'hello.txt': Buffer.from('hello') });
  const stdout = execFileSync(process.execPath, [path.join(HERE, 'cli.mjs'), 'list', archive], {
    encoding: 'utf8',
  });
  assert.match(stdout, /hello\.txt\t5/);
});

test('truncated header is rejected', () => {
  const archive = writeArchive('truncated.asar', { 'hello.txt': Buffer.from('hello') });
  const full = fs.readFileSync(archive);
  const truncated = path.join(TMP, 'truncated-10.asar');
  fs.writeFileSync(truncated, full.subarray(0, 10));
  assert.throws(() => openAsar(truncated), /unexpected end of archive/);
});

test('header that claims to extend past the file is rejected', () => {
  const file = path.join(TMP, 'bad-header.asar');
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(108, 4); // header pickle length
  prefix.writeUInt32LE(104, 8);
  prefix.writeUInt32LE(100, 12); // json length (consistent with 108 - 8)
  fs.writeFileSync(file, Buffer.concat([prefix, Buffer.from('x'.repeat(20))]));
  assert.throws(() => openAsar(file), /archive header is larger than the file/);
});

test('inconsistent header length fields are rejected', () => {
  const file = path.join(TMP, 'bad-lengths.asar');
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(108, 4);
  prefix.writeUInt32LE(104, 8);
  prefix.writeUInt32LE(50, 12); // padding would be 50 bytes, impossible
  fs.writeFileSync(file, Buffer.concat([prefix, Buffer.alloc(200)]));
  assert.throws(() => openAsar(file), /length fields are inconsistent/);
});

test('real @electron/asar output is accepted (empty and small payload)', () => {
  const emptyBytes = Buffer.from('BAAAABQAAAAQAAAADAAAAHsiZmlsZXMiOnt9fQ==', 'base64');
  assert.equal(emptyBytes.length, 28, 'real empty archive is 28 bytes');
  const empty = path.join(TMP, 'real-empty.asar');
  fs.writeFileSync(empty, emptyBytes);
  const emptyHandle = openAsar(empty);
  try {
    assert.equal(emptyHandle.payloadBase, 28);
    assert.deepEqual(listFiles(emptyHandle), []);
  } finally {
    closeAsar(emptyHandle);
  }

  // Generated by @electron/asar; its header has the real 2-byte padding and
  // an integrity block in the index entry.
  const tinyBytes = Buffer.from(
    'BAAAAAgBAAAEAQAA/gAAAHsiZmlsZXMiOnsiaGVsbG8udHh0Ijp7InNpemUiOjUsIm9mZnNldCI6IjAiLCJpbnRlZ3JpdHkiOnsiYWxnb3JpdGhtIjoiU0hBMjU2IiwiaGFzaCI6IjJjZjI0ZGJhNWZiMGEzMGUyNmU4M2IyYWM1YjllMjllMWIxNjFlNWMxZmE3NDI1ZTczMDQzMzYyOTM4Yjk4MjQiLCJibG9ja1NpemUiOjQxOTQzMDQsImJsb2NrcyI6WyIyY2YyNGRiYTVmYjBhMzBlMjZlODNiMmFjNWI5ZTI5ZTFiMTYxZTVjMWZhNzQyNWU3MzA0MzM2MjkzOGI5ODI0Il19fX19AABoZWxsbw==',
    'base64',
  );
  const tiny = path.join(TMP, 'real-tiny.asar');
  fs.writeFileSync(tiny, tinyBytes);
  const tinyHandle = openAsar(tiny);
  try {
    const files = listFiles(tinyHandle);
    assert.deepEqual(files, [{ path: 'hello.txt', size: 5, offset: '0' }]);
    assert.equal(readEntry(tinyHandle, findEntry(tinyHandle, 'hello.txt')).toString('utf8'), 'hello');
  } finally {
    closeAsar(tinyHandle);
  }
});

test('entry whose payload is missing is rejected by readEntry', () => {
  const full = buildAsar({ 'hello.txt': Buffer.from('hello') });
  const headerOnly = path.join(TMP, 'header-only.asar');
  fs.writeFileSync(headerOnly, full.subarray(0, full.length - 5));
  const handle = openAsar(headerOnly);
  try {
    assert.throws(
      () => readEntry(handle, findEntry(handle, 'hello.txt')),
      /extends past end of archive/,
    );
  } finally {
    closeAsar(handle);
  }
});
