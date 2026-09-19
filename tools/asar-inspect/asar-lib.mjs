// Read-only reader for Electron `asar` archives.
//
// The format (https://github.com/electron/asar) is a small pickle header
// followed by a JSON directory index, then the concatenated file payloads:
//
//   offset 0   u32le = 4                      (payload size of the size pickle)
//   offset 4   u32le = headerPickleLength     (length of the header pickle)
//   offset 8   u32le = headerPickleLength - 4 (payload size of the header pickle)
//   offset 12  u32le = jsonByteLength         (size of the index JSON)
//   offset 16  utf8 JSON index
//   offset 16 + jsonByteLength + padding    file payload area
//
// Electron pads the header pickle payload to a 4-byte boundary, so there can
// be 0..3 padding bytes after the JSON.  `payloadBase` (8 +
// headerPickleLength) already contains the JSON and its padding, so the
// boundary check must compare it against the file size directly.  Adding
// jsonByteLength again rejects small but perfectly valid archives.
//
// In the index, an entry is either a directory (`files`) or a file
// (`size` and `offset`, where `offset` is relative to the payload area,
// matching Electron's own asar implementation).
import fs from 'node:fs';

const PREFIX_BYTES = 16;

function readExact(fd, buffer, length, position) {
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buffer, read, length - read, position + read);
    if (n === 0) throw new Error(`unexpected end of archive at ${position + read}`);
    read += n;
  }
  return buffer;
}

export function openAsar(filePath) {
  const fileSize = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  try {
    const prefix = readExact(fd, Buffer.alloc(PREFIX_BYTES), PREFIX_BYTES, 0);
    const jsonByteLength = prefix.readUInt32LE(12);
    // Layout of the prefix: `sizePickle` (8 bytes: u32 payload size + u32
    // value) followed by `headerPickle` whose u32 payload size sits at
    // offset 4.  Electron resolves paths as `8 + headerPickle.length +
    // entry.offset`, so read the header pickle length straight out of the
    // prefix instead of re-deriving the pickle padding rules.
    const headerPickleLength = prefix.readUInt32LE(4);
    const payloadBase = 8 + headerPickleLength;
    if (payloadBase > fileSize) {
      throw new Error('archive header is larger than the file; not an asar archive?');
    }
    // Electron pads the header pickle payload to a 4-byte boundary, so the
    // JSON may be followed by 0..3 padding bytes before the payload area.
    const padding = headerPickleLength - 8 - jsonByteLength;
    if (padding < 0 || padding > 3) {
      throw new Error('archive header length fields are inconsistent; not an asar archive?');
    }
    const index = JSON.parse(
      readExact(fd, Buffer.alloc(jsonByteLength), jsonByteLength, PREFIX_BYTES).toString('utf8'),
    );
    return { fd, index, payloadBase, fileSize };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function closeAsar(handle) {
  fs.closeSync(handle.fd);
}

/** Depth-first walk of the index. `visit(path, entry, isDirectory)`. */
export function walkIndex(handle, visit) {
  const rec = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      const isDirectory = Boolean(entry.files);
      visit(path, entry, isDirectory);
      if (isDirectory) rec(entry, path);
    }
  };
  rec(handle.index, '');
}

export function listFiles(handle) {
  const out = [];
  walkIndex(handle, (path, entry, isDirectory) => {
    if (!isDirectory) out.push({ path, size: entry.size, offset: entry.offset });
  });
  return out;
}

export function readEntry(handle, entry) {
  const offset = Number(entry.offset);
  const size = Number(entry.size);
  if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0) {
    throw new Error(`invalid asar entry bounds: offset=${entry.offset} size=${entry.size}`);
  }
  if (handle.payloadBase + offset + size > handle.fileSize) {
    throw new Error(`asar entry extends past end of archive: ${offset}+${size}`);
  }
  const buffer = Buffer.alloc(size);
  return readExact(handle.fd, buffer, size, handle.payloadBase + offset);
}

export function findEntry(handle, path) {
  let node = handle.index;
  for (const part of path.split('/')) {
    const next = node.files?.[part];
    if (!next) return undefined;
    node = next;
  }
  return node;
}
