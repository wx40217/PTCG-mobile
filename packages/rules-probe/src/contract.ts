/**
 * Public contract for the bounded rule-engine probe (issue #3 / T02).
 *
 * This module is the only surface the future server and client code should depend
 * on. It deliberately contains no engine internals, no random seed, no deck order
 * and no hidden card instance identifiers.
 */

export type Seat = 0 | 1;

export interface DeckEntry {
  /** Frozen effect identity, e.g. `fx:pokemon:古剑豹ex:47bdd73235a0`. */
  readonly cardKey: string;
  readonly count: number;
}

export type CardKind = 'pokemon' | 'trainer' | 'energy';

export interface CardView {
  readonly cardKey: string;
  readonly nameZh: string;
  readonly kind: CardKind;
  /** Effective category: 物品 / 支援者 / 宝可梦道具 / 竞技场 / 基本能量 / null. */
  readonly category: string | null;
}

export interface PokemonInPlayView {
  /** Stable slot label inside the owner's view only. */
  readonly slot: 'active' | number;
  readonly cardKey: string;
  readonly nameZh: string;
  readonly type: string;
  readonly maxHp: number;
  readonly damage: number;
  readonly energies: CardView[];
  readonly tools: CardView[];
}

export interface HiddenZoneView {
  readonly count: number;
}

/** Pending choice visible only to the seat that must resolve it. */
export type PendingChoiceView =
  | {
      readonly choiceId: string;
      readonly seat: Seat;
      readonly kind: 'search-deck';
      readonly purpose:
        | 'search-pokemon'
        | 'search-basic-water-energy'
        | 'search-water-pokemon-and-item';
      readonly min: number;
      readonly max: number;
      readonly candidates: SearchCandidateView[];
    }
  | {
      readonly choiceId: string;
      readonly seat: Seat;
      readonly kind: 'discard-energy';
      readonly min: number;
      readonly max: number;
      readonly energies: AttachedEnergyView[];
    }
  | {
      readonly choiceId: string;
      readonly seat: Seat;
      readonly kind: 'promote-active';
      readonly min: 1;
      readonly max: 1;
      readonly candidates: SearchCandidateView[];
    }
  | {
      readonly choiceId: string;
      readonly seat: Seat;
      readonly kind: 'turn-order';
    };

export interface SearchCandidateView {
  /** Ephemeral reference, valid only for this choice id. */
  readonly ref: string;
  readonly cardKey: string;
  readonly nameZh: string;
  readonly kind: CardKind;
  readonly category: string | null;
  readonly hp?: number;
  readonly type?: string;
  /** Which role in a two-card search this candidate can fill. */
  readonly roles: readonly ('pokemon' | 'water-pokemon' | 'item' | 'basic-water-energy')[];
}

export interface AttachedEnergyView {
  readonly ref: string;
  readonly cardKey: string;
  readonly nameZh: string;
  /** Slot label of the owning Pokémon, e.g. `active` or `bench:0`. */
  readonly attachedTo: string;
}

export type PublicEvent =
  | { readonly seq: number; readonly type: 'match-created'; readonly seats: readonly [string, string] }
  | { readonly seq: number; readonly type: 'mulligan'; readonly seat: Seat; readonly count: number }
  | { readonly seq: number; readonly type: 'setup-pokemon-placed'; readonly seat: Seat }
  | { readonly seq: number; readonly type: 'turn-order-flip'; readonly winner: Seat }
  | { readonly seq: number; readonly type: 'turn-order-chosen'; readonly seat: Seat; readonly goFirst: boolean }
  | { readonly seq: number; readonly type: 'turn-started'; readonly seat: Seat; readonly turn: number }
  | { readonly seq: number; readonly type: 'turn-ended'; readonly seat: Seat }
  | {
      readonly seq: number;
      readonly type: 'energy-attached';
      readonly seat: Seat;
      readonly cardKey: string;
      readonly nameZh: string;
      readonly target: string;
    }
  | { readonly seq: number; readonly type: 'trainer-played'; readonly seat: Seat; readonly cardKey: string; readonly nameZh: string }
  | { readonly seq: number; readonly type: 'ability-used'; readonly seat: Seat; readonly name: string }
  | { readonly seq: number; readonly type: 'coin-flip'; readonly seat: Seat; readonly result: 'heads' | 'tails' }
  | {
      readonly seq: number;
      readonly type: 'cards-revealed';
      readonly seat: Seat;
      readonly cards: readonly { readonly cardKey: string; readonly nameZh: string }[];
    }
  | { readonly seq: number; readonly type: 'deck-shuffled'; readonly seat: Seat }
  | {
      readonly seq: number;
      readonly type: 'attack-used';
      readonly seat: Seat;
      readonly name: string;
      readonly damage: number;
      readonly targetCardKey: string;
    }
  | {
      readonly seq: number;
      readonly type: 'pokemon-knocked-out';
      readonly seat: Seat;
      readonly cardKey: string;
      readonly nameZh: string;
    }
  | { readonly seq: number; readonly type: 'prizes-taken'; readonly seat: Seat; readonly count: number; readonly remaining: number }
  | { readonly seq: number; readonly type: 'conceded'; readonly seat: Seat }
  | {
      readonly seq: number;
      readonly type: 'match-finished';
      readonly winner: Seat | null;
      readonly reason: TerminalReason;
    };

export type TerminalReason = 'prizes' | 'no-pokemon' | 'deck-out' | 'concede';

export interface MatchResult {
  readonly winner: Seat | null;
  readonly reason: TerminalReason;
}

export interface PlayerView {
  readonly seat: Seat;
  readonly version: number;
  readonly turn: number;
  readonly phase: 'setup' | 'turn-order' | 'playing' | 'finished';
  readonly activeSeat: Seat | null;
  readonly self: {
    readonly hand: readonly { readonly handIndex: number; readonly card: CardView }[];
    readonly deck: HiddenZoneView;
    readonly prizes: HiddenZoneView;
    readonly discard: readonly CardView[];
    readonly active: PokemonInPlayView | null;
    readonly bench: readonly PokemonInPlayView[];
    readonly setupPlaced: boolean;
  };
  readonly opponent: {
    readonly hand: HiddenZoneView;
    readonly deck: HiddenZoneView;
    readonly prizes: HiddenZoneView;
    readonly discard: readonly CardView[];
    readonly active: PokemonInPlayView | null;
    readonly bench: readonly PokemonInPlayView[];
    readonly setupPlaced: boolean;
  };
  readonly pendingChoice: PendingChoiceView | null;
  readonly waitingForOpponentChoice: boolean;
  readonly events: readonly PublicEvent[];
  readonly result: MatchResult | null;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

export interface CommandBase {
  /**
   * Client-generated unique id. The server must return the same outcome for a
   * repeated id and must never execute the command twice.
   */
  readonly commandId: string;
  /** State version the client last observed. Mismatch is rejected. */
  readonly expectedVersion: number;
}

export type PokemonSlotRef = { readonly slot: 'active' } | { readonly slot: 'bench'; readonly index: number };

export interface PlaceSetupPokemonCommand extends CommandBase {
  readonly type: 'place-setup-pokemon';
  readonly active: number;
  readonly bench: readonly number[];
}

export interface ChooseTurnOrderCommand extends CommandBase {
  readonly type: 'choose-turn-order';
  readonly goFirst: boolean;
}

export interface AttachEnergyCommand extends CommandBase {
  readonly type: 'attach-energy';
  readonly handIndex: number;
  readonly target: PokemonSlotRef;
}

export interface PlayTrainerCommand extends CommandBase {
  readonly type: 'play-trainer';
  readonly handIndex: number;
  /** Cost selection for cards such as 高级球 (exactly 2 hand cards). */
  readonly discardHandIndices?: readonly number[];
}

export interface UseAbilityCommand extends CommandBase {
  readonly type: 'use-ability';
  readonly name: string;
}

export interface AttackCommand extends CommandBase {
  readonly type: 'attack';
  readonly name: string;
}

export interface ResolveChoiceCommand extends CommandBase {
  readonly type: 'resolve-choice';
  readonly choiceId: string;
  /** Ephemeral candidate references from the matching pending choice. */
  readonly picks: readonly string[];
}

export interface EndTurnCommand extends CommandBase {
  readonly type: 'end-turn';
}

export interface ConcedeCommand extends CommandBase {
  readonly type: 'concede';
}

export type Command =
  | PlaceSetupPokemonCommand
  | ChooseTurnOrderCommand
  | AttachEnergyCommand
  | PlayTrainerCommand
  | UseAbilityCommand
  | AttackCommand
  | ResolveChoiceCommand
  | EndTurnCommand
  | ConcedeCommand;

/* ------------------------------------------------------------------ */
/* Results and errors                                                  */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | 'NOT_AUTHENTICATED_SEAT'
  | 'STALE_VERSION'
  | 'COMMAND_ID_REUSED'
  | 'CHOICE_PENDING'
  | 'NOT_YOUR_CHOICE'
  | 'NOT_YOUR_TURN'
  | 'ACTION_NOT_ALLOWED'
  | 'ILLEGAL_TARGET'
  | 'ILLEGAL_COST'
  | 'INSUFFICIENT_ENERGY'
  | 'GAME_FINISHED'
  | 'UNSUPPORTED_CARD'
  | 'DECK_NOT_PLAYABLE';

export type SubmitResult =
  | {
      readonly ok: true;
      readonly duplicate: boolean;
      readonly version: number;
      readonly view: PlayerView;
    }
  | {
      readonly ok: false;
      readonly version: number;
      readonly code: ErrorCode;
      readonly message: string;
    };

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

export interface RecordedCommand {
  readonly seat: Seat;
  readonly command: Command;
}

/**
 * Server-side replay record. Contains the raw outputs of the random source and
 * may contain a seed-equivalent stream; it is never part of client I/O.
 */
export interface ReplayRecord {
  readonly deckEntries: readonly [readonly DeckEntry[], readonly DeckEntry[]];
  readonly names: readonly [string, string];
  readonly randomOutputs: readonly number[];
  readonly commands: readonly RecordedCommand[];
}
