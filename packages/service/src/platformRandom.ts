/** Web Crypto is available in Node 24 and the HTTPS Capacitor WebView. */
export function randomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
    throw new Error('Random bound must be an integer in 1..2^32.');
  }
  // Rejection sampling avoids modulo bias (including non-power-of-two deck sizes).
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const word = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(word);
  } while (word[0]! >= limit);
  return word[0]! % maxExclusive;
}

export function randomUUID(): string {
  // getRandomValues also supports older Android WebViews without crypto.randomUUID.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
