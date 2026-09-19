const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const REVERSE = (() => {
  const map = new Map<string, number>();
  for (let index = 0; index < ALPHABET.length; index += 1) {
    map.set(ALPHABET[index] as string, index);
  }
  map.set('+', 62);
  map.set('/', 63);
  return map;
})();

/** 无填充 base64url 编码，Node 与 WebView 行为一致。 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += ALPHABET[first >> 2] as string;
    out += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)] as string;
    if (second === undefined) break;
    out += ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)] as string;
    if (third === undefined) break;
    out += ALPHABET[third & 0x3f] as string;
  }
  return out;
}

/** 解码 base64url（也接受标准 base64 字符与填充）。 */
export function decodeBase64Url(text: string): Uint8Array {
  let clean = text;
  while (clean.endsWith('=')) {
    clean = clean.slice(0, -1);
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const value = REVERSE.get(character);
    if (value === undefined) {
      throw new Error(`非法的 base64url 字符: ${JSON.stringify(character)}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** 生成密码学安全的随机字节。 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomToken(length = 32): string {
  return encodeBase64Url(randomBytes(length));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
