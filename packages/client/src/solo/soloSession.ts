import {
  computeCatalogVersion, SOLO_DATA_REVISION, SOLO_ROSTER_VERSION, SOLO_OPPONENTS, SOLO_PRESETS,
  soloDeckDocument, validateSoloRoster,
  type MatchResultView, type SoloOpponentId, type SoloPresetId,
} from '@ptcg/protocol';
import { localCatalog } from '../local/session.ts';
import { createLocalMatchHost, type LocalMatchHost, type LocalPlayerPort } from '../../../service/src/localMatch.ts';
import { exportLocalCheckpoint, restoreLocalCheckpoint, LOCAL_RULES_VERSION, type LocalMatchCheckpoint } from '../../../service/src/localCheckpoint.ts';
import { createSoloStorage, type SoloStorage, type SoloRawRecord } from './soloStorage.ts';

export interface SoloSummary {
  readonly sessionId: string;
  readonly presetId: SoloPresetId;
  readonly opponentId: SoloOpponentId;
  readonly humanSeat: 0;
  readonly aiSeat: 1;
  readonly strategyVersion: string;
  readonly updatedAt: number;
  readonly result: MatchResultView | null;
}
export type SoloStats = Record<SoloOpponentId, { wins: number; losses: number; draws: number }>;
export interface SoloInspection {
  readonly status: 'empty' | 'ready' | 'corrupt' | 'incompatible' | 'io-error';
  readonly summary: SoloSummary | null;
  readonly stats: SoloStats;
  readonly message: string | null;
}
/** Trusted assembly only: give each consumer just its own player port. */
export interface SavedSoloMatch {
  readonly players: readonly [LocalPlayerPort, LocalPlayerPort];
  readonly summary: SoloSummary;
  dispose(): void;
}
interface LedgerEntry { sessionId: string; opponentId: SoloOpponentId; outcome: 'win' | 'loss' | 'draw' }
interface Ledger { format: 1; entries: LedgerEntry[] }
interface Sealed { json: string; sha256: string }
interface Envelope { format: 1; generation: number; ledger: Sealed; active: Sealed | null }
interface ActiveSave {
  summary: SoloSummary;
  catalogVersion: string;
  dataRevision: string;
  rosterVersion: string;
  nickname: string;
  checkpoint: LocalMatchCheckpoint;
}
class SaveError extends Error {
  readonly status: 'corrupt' | 'incompatible' | 'io-error';
  constructor(status: 'corrupt' | 'incompatible' | 'io-error', message: string) { super(message); this.status = status; }
}
async function digest(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function seal(value: unknown): Promise<Sealed> {
  const json = JSON.stringify(value);
  return { json, sha256: await digest(json) };
}
async function unseal(value: Sealed): Promise<unknown> {
  if (!value || typeof value.json !== 'string' || typeof value.sha256 !== 'string' || await digest(value.json) !== value.sha256) throw new SaveError('corrupt', '单人存档校验失败，原档案已保留。');
  try { return JSON.parse(value.json); } catch { throw new SaveError('corrupt', '单人存档内容损坏，原档案已保留。'); }
}
function parseEnvelope(raw: string): Envelope {
  let value: Envelope;
  try { value = JSON.parse(raw); } catch { throw new SaveError('corrupt', '单人存档内容损坏，原档案已保留。'); }
  if (!value || value.format !== 1) throw new SaveError('incompatible', '单人存档格式与此版本不兼容，原档案已保留。');
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 || !value.ledger || !Object.hasOwn(value, 'active')) throw new SaveError('corrupt', '单人存档结构损坏，原档案已保留。');
  return value;
}
async function readLedger(envelope: Envelope): Promise<Ledger> {
  const value = await unseal(envelope.ledger) as Ledger;
  const ids = new Set<string>();
  if (!value || value.format !== 1 || !Array.isArray(value.entries)) throw new SaveError('corrupt', '胜负记录损坏，无法安全覆盖存档。');
  for (const item of value.entries) {
    if (!item || typeof item.sessionId !== 'string' || !item.sessionId || ids.has(item.sessionId)
      || !SOLO_OPPONENTS.some(opponent => opponent.id === item.opponentId) || !['win', 'loss', 'draw'].includes(item.outcome)) throw new SaveError('corrupt', '胜负记录损坏，无法安全覆盖存档。');
    ids.add(item.sessionId);
  }
  return value;
}
function statsFor(ledger: Ledger): SoloStats {
  const stats: SoloStats = { linyue: { wins: 0, losses: 0, draws: 0 }, canglan: { wins: 0, losses: 0, draws: 0 }, yansen: { wins: 0, losses: 0, draws: 0 } };
  for (const item of ledger.entries) stats[item.opponentId][item.outcome === 'win' ? 'wins' : item.outcome === 'loss' ? 'losses' : 'draws']++;
  return stats;
}

export function createSoloSessionManager(options: { readonly strategyVersion: string; readonly storage?: SoloStorage; readonly now?: () => number }) {
  if (!options.strategyVersion.trim()) throw new Error('缺少 AI 策略版本。');
  const storage = options.storage ?? createSoloStorage();
  const now = options.now ?? Date.now;
  const catalog = localCatalog();
  const catalogVersion = computeCatalogVersion(catalog);
  let running: LocalMatchHost | undefined;
  let epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }
  async function rawRead(): Promise<SoloRawRecord> {
    try {
      const raw = await storage.read();
      if (!raw || (raw.current !== null && typeof raw.current !== 'string') || (raw.previous !== null && typeof raw.previous !== 'string')
        || (raw.ledger !== null && typeof raw.ledger !== 'string')) throw new Error();
      return raw;
    } catch { throw new SaveError('io-error', '无法读取单人存档，请重试；没有创建或覆盖对局。'); }
  }
  async function commit(raw: SoloRawRecord, envelope: Envelope, preservePrevious = false): Promise<string> {
    const next = JSON.stringify(envelope);
    try { await storage.commit({ expected: raw.current, next, ledger: JSON.stringify(envelope.ledger), preservePrevious }); }
    catch { throw new SaveError('io-error', '单人存档写入失败，会话已暂停；请返回后重新读取存档。'); }
    return next;
  }
  async function runtime(presetId: SoloPresetId, opponentId: SoloOpponentId, nickname: string) {
    const opponent = SOLO_OPPONENTS.find(item => item.id === opponentId);
    const player = soloDeckDocument(presetId);
    const ai = opponent && soloDeckDocument(opponent.presetId);
    if (!opponent || !player || !ai || typeof nickname !== 'string' || !nickname.trim()) throw new SaveError('corrupt', '存档中的对手、预设或昵称无效。');
    const version = await catalogVersion;
    if (validateSoloRoster({ content: catalog, catalogVersion: version }).length) throw new SaveError('incompatible', '随包单人预设与目录版本不一致。');
    return { catalog, catalogVersion: version, decks: [player, ai] as const, nicknames: [nickname, opponent.nameZh] as const };
  }
  async function readActive(envelope: Envelope): Promise<ActiveSave | null> {
    if (envelope.active === null) return null;
    const active = await unseal(envelope.active) as ActiveSave;
    if (!active || !active.summary || !active.checkpoint) throw new SaveError('corrupt', '单人存档缺少完整会话。');
    if (active.catalogVersion !== await catalogVersion || active.dataRevision !== SOLO_DATA_REVISION
      || active.rosterVersion !== SOLO_ROSTER_VERSION || active.summary.strategyVersion !== options.strategyVersion
      || active.checkpoint.rulesVersion !== LOCAL_RULES_VERSION || active.checkpoint.format !== 1) throw new SaveError('incompatible', '存档的环境、规则或 AI 策略版本不兼容，原档案已保留。');
    const summary = active.summary;
    if (summary.sessionId !== active.checkpoint.sessionId || summary.humanSeat !== 0 || summary.aiSeat !== 1
      || !Number.isSafeInteger(summary.updatedAt) || summary.updatedAt < 0) throw new SaveError('corrupt', '存档摘要与会话不一致。');
    try {
      const host = restoreLocalCheckpoint(active.checkpoint, await runtime(summary.presetId, summary.opponentId, active.nickname));
      try { if (JSON.stringify(host.session.result) !== JSON.stringify(summary.result)) throw new Error(); }
      finally { host.dispose(); }
    } catch (error) {
      if (error instanceof SaveError) throw error;
      throw new SaveError('corrupt', '单人对局状态损坏，无法继续；原档案与胜负记录已保留。');
    }
    return active;
  }
  function stop(): void { epoch++; running?.dispose(); running = undefined; }
  async function attach(raw: SoloRawRecord, envelope: Envelope, ledger: Ledger, active: ActiveSave, isNew: boolean): Promise<SavedSoloMatch> {
    const ownEpoch = epoch;
    let latest = active;
    let currentRaw = raw;
    let generation = envelope.generation;
    let currentLedger = ledger;
    const persist = async (host: LocalMatchHost): Promise<void> => {
      if (epoch !== ownEpoch) throw new Error('本地会话已停止。');
      const checkpoint = exportLocalCheckpoint(host);
      const result = host.session.result;
      const entries = [...currentLedger.entries];
      if (result !== null && !['service-interruption', 'disconnect-timeout'].includes(result.reason) && !entries.some(item => item.sessionId === checkpoint.sessionId)) {
        entries.push({ sessionId: checkpoint.sessionId, opponentId: latest.summary.opponentId, outcome: result.winner === null ? 'draw' : result.winner === 0 ? 'win' : 'loss' });
      }
      const nextLedger: Ledger = { format: 1, entries };
      const nextActive: ActiveSave = { ...latest, checkpoint, summary: { ...latest.summary, updatedAt: now(), result } };
      const next: Envelope = { format: 1, generation: generation + 1, ledger: await seal(nextLedger), active: await seal(nextActive) };
      const stored = await commit(currentRaw, next);
      currentRaw = { current: stored, previous: currentRaw.current, ledger: JSON.stringify(next.ledger) }; generation = next.generation;
      currentLedger = nextLedger; latest = nextActive;
    };
    const config = await runtime(active.summary.presetId, active.summary.opponentId, active.nickname);
    const beforePublish = (host: LocalMatchHost) => serial(() => persist(host));
    const host = isNew ? createLocalMatchHost({ ...config, beforePublish }) : restoreLocalCheckpoint(active.checkpoint, { ...config, beforePublish });
    running = host;
    try {
      if (isNew) {
        latest = { ...latest, summary: { ...latest.summary, sessionId: host.session.sessionId } };
        await persist(host); // No player ports escape before the very first checkpoint commits.
      }
    } catch (error) { host.dispose(); running = undefined; throw error; }
    return Object.freeze({ players: host.players, get summary() { return structuredClone(latest.summary); }, dispose: () => host.dispose() });
  }
  return {
    inspect(): Promise<SoloInspection> {
      return serial(async () => {
        let ledger: Ledger = { format: 1, entries: [] };
        try {
          const raw = await rawRead();
          if (raw.current === null) return { status: 'empty', summary: null, stats: statsFor(ledger), message: null };
          if (raw.ledger !== null) ledger = await readLedger({ ledger: JSON.parse(raw.ledger) } as Envelope);
          const envelope = parseEnvelope(raw.current);
          ledger = await readLedger(envelope);
          const active = await readActive(envelope);
          return { status: active === null ? 'empty' : 'ready', summary: active?.summary ?? null, stats: statsFor(ledger), message: null };
        } catch (error) {
          const failure = error instanceof SaveError ? error : new SaveError('corrupt', '单人存档无法验证，原档案已保留。');
          return { status: failure.status, summary: null, stats: statsFor(ledger), message: failure.message };
        }
      });
    },
    start(input: { presetId: SoloPresetId; opponentId: SoloOpponentId; nickname: string }): Promise<SavedSoloMatch> {
      return serial(async () => {
        const raw = await rawRead();
        const envelope = raw.current === null ? { format: 1 as const, generation: 0, ledger: await seal({ format: 1, entries: [] }), active: null } : parseEnvelope(raw.current);
        const ledger = await readLedger(envelope);
        if (envelope.active !== null) throw new Error('已有单人存档，请继续，或明确确认放弃后再开局。');
        await runtime(input.presetId, input.opponentId, input.nickname);
        stop();
        const active: ActiveSave = { summary: { sessionId: '', presetId: input.presetId, opponentId: input.opponentId, humanSeat: 0, aiSeat: 1,
          strategyVersion: options.strategyVersion, updatedAt: now(), result: null }, catalogVersion: await catalogVersion,
          dataRevision: SOLO_DATA_REVISION, rosterVersion: SOLO_ROSTER_VERSION, nickname: input.nickname,
          checkpoint: null as unknown as LocalMatchCheckpoint };
        return attach(raw, envelope, ledger, active, true);
      });
    },
    continue(): Promise<SavedSoloMatch> {
      return serial(async () => {
        const raw = await rawRead();
        if (raw.current === null) throw new Error('没有可继续的单人存档。');
        const envelope = parseEnvelope(raw.current);
        const ledger = await readLedger(envelope);
        const active = await readActive(envelope);
        if (active === null) throw new Error('没有可继续的单人存档。');
        stop();
        return attach(raw, envelope, ledger, active, false);
      });
    },
    discard(confirmation: { confirmed: true }): Promise<void> {
      return serial(async () => {
        if (confirmation?.confirmed !== true) throw new Error('放弃单人存档需要明确确认。');
        const raw = await rawRead();
        if (raw.current === null) { stop(); return; }
        // A separately stored, same-transaction ledger survives even an unreadable match container.
        let envelope: Envelope;
        try { envelope = parseEnvelope(raw.current); }
        catch {
          if (raw.ledger === null) throw new SaveError('corrupt', '存档与胜负记录均无法验证，不能安全覆盖。');
          envelope = { format: 1, generation: 0, active: null, ledger: JSON.parse(raw.ledger) };
        }
        const ledger = await readLedger(raw.ledger === null ? envelope : { ...envelope, ledger: JSON.parse(raw.ledger) });
        let validActive = false;
        try { const original = parseEnvelope(raw.current); await readActive(original); validActive = true; } catch { /* Explicit abandon; preserve the prior usable backup. */ }
        stop();
        await commit(raw, { format: 1, generation: envelope.generation + 1, active: null, ledger: await seal(ledger) }, !validActive);
      });
    },
    dispose(): void { stop(); },
  };
}
