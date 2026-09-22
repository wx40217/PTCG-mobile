import type { CheckpointGraph } from './checkpointGraph.ts';
import { MatchSession } from './match.ts';
import { bindLocalMatchHost, type LocalMatchHost, type LocalMatchHostOptions } from './localMatch.ts';
import { BufferedCryptoRandomSource, type LocalRandomCheckpoint } from './localRandom.ts';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from './trainerEffects.ts';
import { PRODUCTION_ABILITY_EFFECTS, PRODUCTION_ATTACK_EFFECTS, PRODUCTION_TOOL_EFFECTS } from './pokemonEffects.ts';

/** Bump when rules, private state shape, or effect semantics change. No hot migration. */
export const LOCAL_RULES_VERSION = 'shared-rules-checkpoint-v1';
export interface LocalMatchCheckpoint {
  readonly format: 1;
  readonly rulesVersion: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly session: CheckpointGraph;
  readonly random: LocalRandomCheckpoint;
}
export function exportLocalCheckpoint(host: LocalMatchHost): LocalMatchCheckpoint {
  return { format: 1, rulesVersion: LOCAL_RULES_VERSION, sessionId: host.session.sessionId,
    sessionVersion: host.session.version, session: host.session.exportCheckpoint(), random: host.random.snapshot() };
}
export function restoreLocalCheckpoint(checkpoint: LocalMatchCheckpoint, options: LocalMatchHostOptions): LocalMatchHost {
  if (!checkpoint || checkpoint.format !== 1 || checkpoint.rulesVersion !== LOCAL_RULES_VERSION) throw new Error('存档规则版本不兼容。');
  if (typeof checkpoint.sessionId !== 'string' || !checkpoint.sessionId || !Number.isSafeInteger(checkpoint.sessionVersion) || checkpoint.sessionVersion < 1) throw new Error('对局存档身份损坏。');
  const random = BufferedCryptoRandomSource.restore(checkpoint.random);
  const session = MatchSession.restoreCheckpoint(checkpoint.session, {
    sessionId: checkpoint.sessionId, catalog: options.catalog, decks: options.decks, nicknames: options.nicknames, random,
    attackEffects: PRODUCTION_ATTACK_EFFECTS, abilityEffects: PRODUCTION_ABILITY_EFFECTS,
    trainerEffects: PRODUCTION_TRAINER_EFFECTS, stadiumEffects: PRODUCTION_STADIUM_EFFECTS, toolEffects: PRODUCTION_TOOL_EFFECTS,
  });
  if (session.version !== checkpoint.sessionVersion) throw new Error('存档会话版本不一致。');
  return bindLocalMatchHost(session, random, options.beforePublish);
}
