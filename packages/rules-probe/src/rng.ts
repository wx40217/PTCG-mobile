import { randomInt } from 'node:crypto';

/**
 * Server-side randomness boundary. The engine only ever sees this interface;
 * client payloads cannot carry a seed or a deck order.
 */
export interface RandomSource {
  nextInt(maxExclusive: number): number;
}

export function shuffleInPlace<T>(items: T[], random: RandomSource): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const position = random.nextInt(i + 1);
    const tmp = items[i]!;
    items[i] = items[position]!;
    items[position] = tmp;
  }
}

/** Cryptographically seeded source for the real server. */
export class CryptoRandomSource implements RandomSource {
  public nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt expects a positive integer, got ${maxExclusive}`);
    }
    return randomInt(maxExclusive);
  }
}

/** Deterministic source for tests and locally controlled input. */
export class SeededRandomSource implements RandomSource {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new Error(`seed must be an integer, got ${seed}`);
    }
    this.state = seed >>> 0;
    if (this.state === 0) {
      this.state = 0x9e3779b9;
    }
  }

  public nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt expects a positive integer, got ${maxExclusive}`);
    }
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(value * maxExclusive);
  }
}

/** Replays a previously recorded sequence of random outputs. */
export class ReplayRandomSource implements RandomSource {
  private index = 0;

  constructor(private readonly outputs: readonly number[]) {}

  public nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt expects a positive integer, got ${maxExclusive}`);
    }
    if (this.index >= this.outputs.length) {
      throw new Error('random stream exhausted during replay');
    }
    const value = this.outputs[this.index]!;
    this.index += 1;
    if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
      throw new Error(`recorded random value ${value} is invalid for nextInt(${maxExclusive})`);
    }
    return value;
  }
}

/** Wraps a source and records every output for a server-side replay record. */
export class RecordingRandomSource implements RandomSource {
  public readonly outputs: number[] = [];

  constructor(private readonly inner: RandomSource) {}

  public nextInt(maxExclusive: number): number {
    const value = this.inner.nextInt(maxExclusive);
    this.outputs.push(value);
    return value;
  }
}
