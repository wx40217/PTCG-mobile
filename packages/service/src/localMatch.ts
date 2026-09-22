import {
  parseDeckDocument, parseMatchClientMessage, validateDeck,
  type CatalogContent, type DeckDocument, type MatchClientMessage, type MatchView,
} from '@ptcg/protocol';
import { MatchSession, type MatchSubmitResult } from './match.ts';
import { BufferedCryptoRandomSource } from './localRandom.ts';
import { randomUUID } from './platformRandom.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from './trainerEffects.ts';
import { PRODUCTION_ABILITY_EFFECTS, PRODUCTION_ATTACK_EFFECTS, PRODUCTION_TOOL_EFFECTS } from './pokemonEffects.ts';

/** The only capability passed to a UI or AI. It contains no host, tokens or RNG. */
export interface LocalPlayerPort {
  view(): MatchView;
  submit(command: MatchClientMessage): Promise<MatchSubmitResult>;
  /** Change notifications contain no state; read this seat's view afterwards. */
  subscribe(listener: () => void): () => void;
}

/** Trusted host only. Never pass this object to strategy or presentation code. */
export interface LocalMatchHost {
  readonly session: MatchSession;
  readonly random: BufferedCryptoRandomSource;
  readonly players: readonly [LocalPlayerPort, LocalPlayerPort];
  dispose(): void;
}

export interface LocalMatchHostOptions {
  readonly catalog: CatalogContent;
  readonly catalogVersion: string;
  readonly decks: readonly [DeckDocument, DeckDocument];
  readonly nicknames: readonly [string, string];
  /** #22 saves engine, dedup and RNG atomically before acknowledgement/notification. */
  readonly beforePublish?: (host: LocalMatchHost) => Promise<void>;
}

/** Platform-neutral host, with the same MatchSession and effects as friend rooms. */
export function createLocalMatchHost(options: LocalMatchHostOptions): LocalMatchHost {
  const catalog = structuredClone(options.catalog);
  const decks = options.decks.map((deck) => {
    const parsed = parseDeckDocument(structuredClone(deck));
    if (!parsed.ok) throw new Error('本地卡组格式无效。');
    const validation = validateDeck(parsed.deck, { content: catalog, catalogVersion: options.catalogVersion });
    if (!validation.ready) throw new Error(`本地卡组不可对战：${validation.problems.map((p) => p.message).join('；')}`);
    return parsed.deck;
  }) as [DeckDocument, DeckDocument];
  const random = new BufferedCryptoRandomSource();
  const session = new MatchSession({
    sessionId: randomUUID(), catalog, decks, nicknames: [...options.nicknames], random,
    attackEffects: PRODUCTION_ATTACK_EFFECTS, abilityEffects: PRODUCTION_ABILITY_EFFECTS,
    trainerEffects: PRODUCTION_TRAINER_EFFECTS, stadiumEffects: PRODUCTION_STADIUM_EFFECTS,
    toolEffects: PRODUCTION_TOOL_EFFECTS,
  });
  return bindLocalMatchHost(session, random, options.beforePublish);
}

/** Trusted restoration seam: bind an already restored session without creating a game. */
export function bindLocalMatchHost(
  session: MatchSession,
  random: BufferedCryptoRandomSource,
  beforePublish?: (host: LocalMatchHost) => Promise<void>,
): LocalMatchHost {
  let disposed = false;
  let publishing = false;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = [new Set<() => void>(), new Set<() => void>()] as const;
  const assertUsable = (): void => {
    if (disposed) throw new Error('本地会话已停止，请恢复或重新开局。');
  };
  const players = ([0, 1] as const).map((seat): LocalPlayerPort => {
    const handle = session.handleFor(seat);
    return Object.freeze({
      view: () => {
        assertUsable();
        if (publishing) throw new Error('本地会话正在提交，请等待状态通知。');
        // Deep copies prevent mutation of events and dedup results through returned references.
        return structuredClone(session.viewFor(handle));
      },
      submit: (command: MatchClientMessage) => {
        // Copy immediately so a queued request cannot change while another is saving.
        const parsed = parseMatchClientMessage(structuredClone(command));
        const run = queue.then(async (): Promise<MatchSubmitResult> => {
          assertUsable();
          if (parsed === null || !parsed.ok) {
            return { ok: false, code: 'action-not-allowed', message: '对局命令格式无效。', version: session.version };
          }
          const result = session.submit(handle, parsed.message);
          if (result.ok && !result.duplicate) {
            publishing = true;
            try {
              await beforePublish?.(host);
            } catch (error) {
              // Fail closed: an uncommitted state must not be used for the next AI action.
              host.dispose();
              throw error;
            } finally {
              publishing = false;
            }
            if (!disposed) {
              for (const group of listeners) for (const listener of [...group]) {
                try { listener(); } catch { /* A UI observer cannot undo an accepted command. */ }
              }
            }
          }
          return structuredClone(result);
        });
        queue = run.catch(() => undefined);
        return run;
      },
      subscribe: (listener: () => void) => {
        assertUsable();
        listeners[seat].add(listener);
        return () => { listeners[seat].delete(listener); };
      },
    });
  }) as [LocalPlayerPort, LocalPlayerPort];
  const host: LocalMatchHost = Object.freeze({
    session, random, players: Object.freeze(players),
    dispose: () => { disposed = true; listeners[0].clear(); listeners[1].clear(); },
  });
  return host;
}
