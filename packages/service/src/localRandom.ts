import type { RandomSource } from './match.ts';

/** Trusted save data. Never give this object to a player, AI, or public view. */
export interface LocalRandomCheckpoint {
  readonly algorithm: 'webcrypto-pool-v1';
  readonly words: readonly number[];
  readonly cursor: number;
}

/** Buffered cryptographic entropy; restoring preserves every already generated future draw. */
export class BufferedCryptoRandomSource implements RandomSource {
  #words: number[] = [];
  #cursor = 0;

  public nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
      throw new Error('Random bound must be an integer in 1..2^32.');
    }
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    let word: number;
    do {
      if (this.#cursor === this.#words.length) {
        this.#words = Array.from(globalThis.crypto.getRandomValues(new Uint32Array(256)));
        this.#cursor = 0;
      }
      word = this.#words[this.#cursor++]!;
    } while (word >= limit);
    return word % maxExclusive;
  }

  public snapshot(): LocalRandomCheckpoint {
    return { algorithm: 'webcrypto-pool-v1', words: [...this.#words], cursor: this.#cursor };
  }

  public static restore(checkpoint: LocalRandomCheckpoint): BufferedCryptoRandomSource {
    if (checkpoint?.algorithm !== 'webcrypto-pool-v1' || !Array.isArray(checkpoint.words)
      || (checkpoint.words.length !== 0 && checkpoint.words.length !== 256)
      || !checkpoint.words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff_ffff)
      || !Number.isInteger(checkpoint.cursor) || checkpoint.cursor < 0 || checkpoint.cursor > checkpoint.words.length) {
      throw new Error('Invalid local random checkpoint.');
    }
    const random = new BufferedCryptoRandomSource();
    random.#words = [...checkpoint.words];
    random.#cursor = checkpoint.cursor;
    return random;
  }
}
