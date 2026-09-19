import { randomUUID } from 'node:crypto';
import type {
  Command,
  DeckEntry,
  MatchResult,
  PlayerView,
  RecordedCommand,
  ReplayRecord,
  Seat,
  SubmitResult,
} from './contract.js';
import {
  EngineError,
  ProbeEngine,
  createFixtureEngine,
  createMatchEngine,
  type FixtureEngineConfig,
} from './engine.js';
import { CryptoRandomSource, RecordingRandomSource, ReplayRandomSource, type RandomSource } from './rng.js';

export interface SeatHandle {
  readonly seat: Seat;
  readonly token: string;
}

export interface MatchConfig {
  readonly deckEntries: readonly [readonly DeckEntry[], readonly DeckEntry[]];
  readonly names?: readonly [string, string];
  /**
   * Server-side random source. Tests inject a seeded source; the real server
   * injects a cryptographic one. It is never part of client input.
   */
  readonly random?: RandomSource;
}

interface DedupEntry {
  readonly fingerprint: string;
  readonly result: Extract<SubmitResult, { ok: true }>;
}

export class MatchSession {
  public readonly seats: readonly [SeatHandle, SeatHandle];

  /**
   * Idempotency is scoped to the authenticated seat: one seat's command id can
   * never return another seat's cached result or private view.
   */
  private readonly dedup: readonly [Map<string, DedupEntry>, Map<string, DedupEntry>] = [
    new Map<string, DedupEntry>(),
    new Map<string, DedupEntry>(),
  ];
  private readonly accepted: RecordedCommand[] = [];

  constructor(
    public readonly engine: ProbeEngine,
    private readonly recorder: RecordingRandomSource,
    private readonly deckEntries: readonly [readonly DeckEntry[], readonly DeckEntry[]] | null,
    private readonly names: readonly [string, string] | null,
  ) {
    this.seats = [
      { seat: 0, token: randomUUID() },
      { seat: 1, token: randomUUID() },
    ];
  }

  public get version(): number {
    return this.engine.version;
  }

  public submit(handle: SeatHandle, command: Command): SubmitResult {
    if (!this.isValidHandle(handle)) {
      return {
        ok: false,
        version: this.engine.version,
        code: 'NOT_AUTHENTICATED_SEAT',
        message: 'the seat handle is not valid for this session',
      };
    }
    const seat = handle.seat;

    const seatDedup = this.dedup[seat];
    const existing = seatDedup.get(command.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint(command)) {
        return {
          ok: false,
          version: this.engine.version,
          code: 'COMMAND_ID_REUSED',
          message: `command id ${command.commandId} was already used with a different payload`,
        };
      }
      return { ...existing.result, duplicate: true };
    }

    if (typeof command.commandId !== 'string' || command.commandId.length === 0) {
      return {
        ok: false,
        version: this.engine.version,
        code: 'ACTION_NOT_ALLOWED',
        message: 'commandId is required',
      };
    }

    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion !== this.engine.version) {
      return {
        ok: false,
        version: this.engine.version,
        code: 'STALE_VERSION',
        message: `expected version ${command.expectedVersion}, current version ${this.engine.version}`,
      };
    }

    try {
      this.engine.execute(seat, command, this.recorder);
    } catch (error) {
      if (error instanceof EngineError) {
        return { ok: false, version: this.engine.version, code: error.code, message: error.message };
      }
      throw error;
    }

    this.accepted.push({ seat, command });
    const result: Extract<SubmitResult, { ok: true }> = {
      ok: true,
      duplicate: false,
      version: this.engine.version,
      view: this.engine.viewFor(seat),
    };
    seatDedup.set(command.commandId, { fingerprint: fingerprint(command), result });
    return result;
  }

  public viewFor(handle: SeatHandle): PlayerView {
    if (!this.isValidHandle(handle)) {
      throw new Error('the seat handle is not valid for this session');
    }
    return this.engine.viewFor(handle.seat);
  }

  public isFinished(): boolean {
    return this.engine.state.phase === 'finished';
  }

  public result(): MatchResult | null {
    return this.engine.state.result;
  }

  /** Server-side replay record; never sent to clients. */
  public record(): ReplayRecord {
    if (this.deckEntries === null || this.names === null) {
      throw new Error('fixture sessions do not carry a match replay record');
    }
    return {
      deckEntries: [this.deckEntries[0].map(entry => ({ ...entry })), this.deckEntries[1].map(entry => ({ ...entry }))],
      names: [this.names[0], this.names[1]],
      randomOutputs: [...this.recorder.outputs],
      commands: this.accepted.map(entry => ({ seat: entry.seat, command: entry.command })),
    };
  }

  private isValidHandle(handle: SeatHandle): boolean {
    if (handle === null || typeof handle !== 'object' || typeof handle.token !== 'string') {
      return false;
    }
    if (handle.seat !== 0 && handle.seat !== 1) {
      return false;
    }
    return this.seats[handle.seat].token === handle.token;
  }
}

export function createMatch(config: MatchConfig): MatchSession {
  const recorder = new RecordingRandomSource(config.random ?? new CryptoRandomSource());
  const names = config.names ?? (['玩家1', '玩家2'] as const);
  const engine = createMatchEngine({
    deckEntries: config.deckEntries,
    names,
    random: recorder,
  });
  return new MatchSession(engine, recorder, config.deckEntries, names);
}

export function createFixtureMatch(config: FixtureEngineConfig): MatchSession {
  const recorder = new RecordingRandomSource(config.random);
  const engine = createFixtureEngine({ ...config, random: recorder });
  return new MatchSession(engine, recorder, null, null);
}

export interface ReplayStep {
  readonly version: number;
  readonly views: readonly [PlayerView, PlayerView];
  readonly result: MatchResult | null;
}

export interface ReplayOutcome {
  readonly session: MatchSession;
  readonly steps: readonly ReplayStep[];
}

export function captureStep(session: MatchSession): ReplayStep {
  return {
    version: session.version,
    views: [session.viewFor(session.seats[0]), session.viewFor(session.seats[1])],
    result: session.result(),
  };
}

/**
 * Recreates a match from a server-side replay record and re-applies every
 * accepted command. Any divergence is a hard failure.
 */
export function replayMatch(record: ReplayRecord): ReplayOutcome {
  const session = createMatch({
    deckEntries: record.deckEntries,
    names: record.names,
    random: new ReplayRandomSource(record.randomOutputs),
  });
  const steps: ReplayStep[] = [captureStep(session)];
  for (const entry of record.commands) {
    const result = session.submit(session.seats[entry.seat], entry.command);
    if (!result.ok) {
      throw new Error(
        `replay diverged at command ${entry.command.commandId}: ${result.code} (${result.message})`,
      );
    }
    steps.push(captureStep(session));
  }
  return { session, steps };
}

/* ------------------------------------------------------------------ */
/* Fingerprinting                                                      */
/* ------------------------------------------------------------------ */

function fingerprint(command: Command): string {
  const copy: Record<string, unknown> = { ...command };
  delete copy.commandId;
  return stableJson(copy);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
