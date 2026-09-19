import { CATALOG, getCard, type AttackDef, type CardDef } from './catalog.js';
import type {
  CardView,
  Command,
  DeckEntry,
  ErrorCode,
  MatchResult,
  PendingChoiceView,
  PlayerView,
  PokemonInPlayView,
  PokemonSlotRef,
  PublicEvent,
  Seat,
  SearchCandidateView,
} from './contract.js';
import { shuffleInPlace, type RandomSource } from './rng.js';

/* ------------------------------------------------------------------ */
/* Internal state                                                      */
/* ------------------------------------------------------------------ */

export type Phase = 'setup' | 'turn-order' | 'playing' | 'finished';

export interface CardInstance {
  readonly instanceId: number;
  readonly cardKey: string;
}

export interface InPlayPokemon {
  readonly pokemon: CardInstance;
  damage: number;
  readonly energies: CardInstance[];
  readonly tools: CardInstance[];
}

export interface PlayerState {
  readonly seat: Seat;
  name: string;
  deck: CardInstance[];
  hand: CardInstance[];
  discard: CardInstance[];
  prizes: CardInstance[];
  active: InPlayPokemon | null;
  bench: InPlayPokemon[];
  setupPlaced: boolean;
  energyAttachedThisTurn: boolean;
  supporterPlayedThisTurn: boolean;
  readonly abilityUsed: Set<number>;
}

export type SearchPurpose = 'search-pokemon' | 'search-basic-water-energy' | 'search-water-pokemon-and-item';

export interface CandidateRef {
  readonly ref: string;
  readonly instanceId: number;
}

export type InternalChoice =
  | {
      readonly kind: 'search-deck';
      readonly seat: Seat;
      readonly choiceId: string;
      readonly purpose: SearchPurpose;
      readonly min: number;
      readonly max: number;
      readonly candidates: readonly CandidateRef[];
    }
  | {
      readonly kind: 'discard-energy';
      readonly seat: Seat;
      readonly choiceId: string;
      readonly attackName: string;
      readonly min: number;
      readonly max: number;
      readonly candidates: readonly CandidateRef[];
    }
  | {
      readonly kind: 'promote-active';
      readonly seat: Seat;
      readonly choiceId: string;
      readonly min: 1;
      readonly max: 1;
      readonly candidates: readonly CandidateRef[];
    }
  | {
      readonly kind: 'turn-order';
      readonly seat: Seat;
      readonly choiceId: string;
    };

export interface EngineState {
  version: number;
  turn: number;
  phase: Phase;
  activeSeat: Seat | null;
  players: [PlayerState, PlayerState];
  pendingChoice: InternalChoice | null;
  events: PublicEvent[];
  readonly nextInstanceId: { value: number };
  readonly nextChoiceId: { value: number };
  result: MatchResult | null;
}

export class EngineError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

export interface MatchEngineConfig {
  readonly deckEntries: readonly [readonly DeckEntry[], readonly DeckEntry[]];
  readonly names?: readonly [string, string];
  readonly random: RandomSource;
}

export interface FixturePokemonSpec {
  readonly cardKey: string;
  readonly damage?: number;
  readonly energies?: readonly string[];
  readonly tools?: readonly string[];
}

export interface FixturePlayerSpec {
  readonly hand?: readonly string[];
  readonly deck?: readonly string[];
  readonly discard?: readonly string[];
  readonly prizes?: readonly string[];
  readonly active?: FixturePokemonSpec | null;
  readonly bench?: readonly FixturePokemonSpec[];
  readonly setupPlaced?: boolean;
  readonly energyAttachedThisTurn?: boolean;
  readonly supporterPlayedThisTurn?: boolean;
}

export interface FixtureEngineConfig {
  readonly players: readonly [FixturePlayerSpec, FixturePlayerSpec];
  readonly names?: readonly [string, string];
  readonly activeSeat?: Seat | null;
  readonly turn?: number;
  readonly phase?: 'setup' | 'turn-order' | 'playing';
  readonly random: RandomSource;
}

function emptyPlayer(seat: Seat, name: string): PlayerState {
  return {
    seat,
    name,
    deck: [],
    hand: [],
    discard: [],
    prizes: [],
    active: null,
    bench: [],
    setupPlaced: false,
    energyAttachedThisTurn: false,
    supporterPlayedThisTurn: false,
    abilityUsed: new Set<number>(),
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PublicEventInput = DistributiveOmit<PublicEvent, 'seq'>;

function pushEvent(state: EngineState, event: PublicEventInput): void {
  state.events.push({ ...event, seq: state.events.length + 1 } as PublicEvent);
}

function choiceId(state: EngineState, seat: Seat): string {
  state.nextChoiceId.value += 1;
  return `choice-${seat}-${state.nextChoiceId.value}`;
}

function makePokemon(state: EngineState, spec: FixturePokemonSpec): InPlayPokemon {
  const def = getCard(spec.cardKey);
  if (def.kind !== 'pokemon') {
    throw new EngineError('ILLEGAL_TARGET', `${def.nameZh} is not a Pokémon`);
  }
  return {
    pokemon: { instanceId: state.nextInstanceId.value++, cardKey: spec.cardKey },
    damage: spec.damage ?? 0,
    energies: (spec.energies ?? []).map(cardKey => ({ instanceId: state.nextInstanceId.value++, cardKey })),
    tools: (spec.tools ?? []).map(cardKey => ({ instanceId: state.nextInstanceId.value++, cardKey })),
  };
}

function materialize(state: EngineState, cardKeys: readonly string[]): CardInstance[] {
  return cardKeys.map(cardKey => {
    getCard(cardKey); // validate known
    return { instanceId: state.nextInstanceId.value++, cardKey };
  });
}

function hasBasicPokemon(cards: readonly CardInstance[]): boolean {
  return cards.some(card => {
    const def = CATALOG[card.cardKey];
    return def !== undefined && def.kind === 'pokemon' && def.basic === true;
  });
}

function createBaseState(): EngineState {
  return {
    version: 1,
    turn: 0,
    phase: 'setup',
    activeSeat: null,
    players: [emptyPlayer(0, '玩家1'), emptyPlayer(1, '玩家2')],
    pendingChoice: null,
    events: [],
    nextInstanceId: { value: 1 },
    nextChoiceId: { value: 0 },
    result: null,
  };
}

export function createMatchEngine(config: MatchEngineConfig): ProbeEngine {
  const state = createBaseState();
  const names = config.names ?? (['玩家1', '玩家2'] as const);
  state.players[0].name = names[0];
  state.players[1].name = names[1];

  for (const seat of [0, 1] as const) {
    const entries = config.deckEntries[seat];
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    if (total < 13) {
      throw new EngineError('DECK_NOT_PLAYABLE', `seat ${seat} deck must hold at least 13 cards (7 hand + 6 prizes)`);
    }
    for (const entry of entries) {
      if (!Number.isInteger(entry.count) || entry.count <= 0) {
        throw new EngineError('DECK_NOT_PLAYABLE', `invalid count for ${entry.cardKey}`);
      }
      if (CATALOG[entry.cardKey] === undefined) {
        throw new EngineError('UNSUPPORTED_CARD', `card not known to the probe catalog: ${entry.cardKey}`);
      }
    }
    const cards: CardInstance[] = [];
    for (const entry of entries) {
      for (let i = 0; i < entry.count; i += 1) {
        cards.push({ instanceId: state.nextInstanceId.value++, cardKey: entry.cardKey });
      }
    }
    if (!hasBasicPokemon(cards)) {
      throw new EngineError('DECK_NOT_PLAYABLE', `seat ${seat} deck needs at least one basic Pokémon`);
    }
    state.players[seat].deck = cards;
  }

  pushEvent(state, { type: 'match-created', seats: [state.players[0].name, state.players[1].name] });

  for (const seat of [0, 1] as const) {
    const player = state.players[seat];
    let mulligans = 0;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      shuffleInPlace(player.deck, config.random);
      player.hand = player.deck.splice(0, 7);
      if (hasBasicPokemon(player.hand)) {
        break;
      }
      mulligans += 1;
      player.deck.push(...player.hand);
      player.hand = [];
    }
    if (mulligans > 0) {
      pushEvent(state, { type: 'mulligan', seat, count: mulligans });
    }
    if (!hasBasicPokemon(player.hand)) {
      throw new EngineError('DECK_NOT_PLAYABLE', `seat ${seat} could not draw a basic Pokémon after 1000 mulligans`);
    }
  }

  for (const seat of [0, 1] as const) {
    const player = state.players[seat];
    player.prizes = player.deck.splice(0, 6);
  }

  return new ProbeEngine(state);
}

export function createFixtureEngine(config: FixtureEngineConfig): ProbeEngine {
  const state = createBaseState();
  const names = config.names ?? (['玩家1', '玩家2'] as const);
  state.players[0].name = names[0];
  state.players[1].name = names[1];
  state.phase = config.phase ?? 'playing';
  state.turn = config.turn ?? 1;
  state.activeSeat = config.activeSeat === undefined ? 0 : config.activeSeat;

  for (const seat of [0, 1] as const) {
    const spec = config.players[seat];
    const player = state.players[seat];
    player.hand = materialize(state, spec.hand ?? []);
    player.deck = materialize(state, spec.deck ?? []);
    player.discard = materialize(state, spec.discard ?? []);
    player.prizes = materialize(state, spec.prizes ?? []);
    player.active = spec.active === undefined || spec.active === null ? null : makePokemon(state, spec.active);
    player.bench = (spec.bench ?? []).map(pokemon => makePokemon(state, pokemon));
    player.setupPlaced = spec.setupPlaced ?? true;
    player.energyAttachedThisTurn = spec.energyAttachedThisTurn ?? false;
    player.supporterPlayedThisTurn = spec.supporterPlayedThisTurn ?? false;
  }

  pushEvent(state, { type: 'match-created', seats: [state.players[0].name, state.players[1].name] });
  return new ProbeEngine(state);
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class ProbeEngine {
  constructor(public readonly state: EngineState) {}

  public get version(): number {
    return this.state.version;
  }

  public viewFor(seat: Seat): PlayerView {
    return buildPlayerView(this.state, seat);
  }

  public internalSnapshotForTest(): InternalSnapshot {
    return snapshot(this.state);
  }

  /**
   * Validates and applies one command. Mutations happen only after all
   * validations pass; the version is bumped exactly once at the end.
   */
  public execute(seat: Seat, command: Command, random: RandomSource): void {
    if (this.state.phase === 'finished') {
      throw new EngineError('GAME_FINISHED', 'the match is already finished');
    }

    if (this.state.pendingChoice !== null) {
      const pending = this.state.pendingChoice;
      const resolvesTurnOrder = pending.kind === 'turn-order' && command.type === 'choose-turn-order';
      if (!resolvesTurnOrder) {
        if (command.type !== 'resolve-choice') {
          throw new EngineError('CHOICE_PENDING', 'a pending choice must be resolved first');
        }
        if (pending.seat !== seat) {
          throw new EngineError('NOT_YOUR_CHOICE', 'another seat must resolve the pending choice');
        }
        this.resolveChoice(seat, command.choiceId, command.picks, random);
        this.state.version += 1;
        return;
      }
    }

    switch (command.type) {
      case 'place-setup-pokemon':
        this.placeSetupPokemon(seat, command.active, command.bench, random);
        break;
      case 'choose-turn-order':
        this.chooseTurnOrder(seat, command.goFirst);
        break;
      case 'attach-energy':
        this.attachEnergy(seat, command.handIndex, command.target);
        break;
      case 'play-trainer':
        this.playTrainer(seat, command.handIndex, command.discardHandIndices ?? [], random);
        break;
      case 'use-ability':
        this.useAbility(seat, command.name);
        break;
      case 'attack':
        this.attack(seat, command.name);
        break;
      case 'end-turn':
        this.endTurn(seat);
        break;
      case 'concede':
        this.concede(seat);
        break;
      case 'resolve-choice':
        throw new EngineError('ACTION_NOT_ALLOWED', 'there is no pending choice');
      default:
        throw new EngineError('ACTION_NOT_ALLOWED', 'unknown command');
    }

    this.state.version += 1;
  }

  /* ---------------- setup ---------------- */

  private placeSetupPokemon(
    seat: Seat,
    activeIndex: number,
    benchIndices: readonly number[],
    random: RandomSource,
  ): void {
    const state = this.state;
    if (state.phase !== 'setup') {
      throw new EngineError('ACTION_NOT_ALLOWED', 'setup placements are only allowed during setup');
    }
    const player = getPlayer(state, seat);
    if (player.setupPlaced) {
      throw new EngineError('ACTION_NOT_ALLOWED', 'setup Pokémon already placed');
    }
    validateHandIndex(player, activeIndex);
    const chosen = [activeIndex, ...benchIndices];
    const seen = new Set<number>();
    for (const index of chosen) {
      validateHandIndex(player, index);
      if (seen.has(index)) {
        throw new EngineError('ILLEGAL_TARGET', 'duplicate setup card index');
      }
      seen.add(index);
      const def = getCard(player.hand[index]!.cardKey);
      if (def.kind !== 'pokemon' || def.basic !== true) {
        throw new EngineError('ILLEGAL_TARGET', `${def.nameZh} cannot be placed during setup`);
      }
    }
    if (benchIndices.length > 5) {
      throw new EngineError('ILLEGAL_TARGET', 'bench can hold at most 5 Pokémon');
    }

    const activeCard = player.hand[activeIndex]!;
    const benchCards = benchIndices.map(index => player.hand[index]!);
    player.hand = player.hand.filter((_card, index) => !seen.has(index));
    player.active = { pokemon: activeCard, damage: 0, energies: [], tools: [] };
    player.bench = benchCards.map(pokemon => ({ pokemon, damage: 0, energies: [], tools: [] }));
    player.setupPlaced = true;
    pushEvent(state, { type: 'setup-pokemon-placed', seat });

    const opponent = getPlayer(state, otherSeat(seat));
    if (player.setupPlaced && opponent.setupPlaced) {
      const winner: Seat = random.nextInt(2) === 0 ? 0 : 1;
      state.phase = 'turn-order';
      state.pendingChoice = { kind: 'turn-order', seat: winner, choiceId: choiceId(state, winner) };
      pushEvent(state, { type: 'turn-order-flip', winner });
    }
  }

  private chooseTurnOrder(seat: Seat, goFirst: boolean): void {
    const state = this.state;
    if (state.phase !== 'turn-order' || state.pendingChoice?.kind !== 'turn-order') {
      throw new EngineError('ACTION_NOT_ALLOWED', 'turn order is not being chosen');
    }
    if (state.pendingChoice.seat !== seat) {
      throw new EngineError('NOT_YOUR_CHOICE', 'the coin-flip winner chooses the turn order');
    }
    state.pendingChoice = null;
    state.phase = 'playing';
    pushEvent(state, { type: 'turn-order-chosen', seat, goFirst });
    const first = goFirst ? seat : otherSeat(seat);
    this.startTurn(first);
  }

  private startTurn(seat: Seat): void {
    const state = this.state;
    state.turn += 1;
    state.activeSeat = seat;
    const player = getPlayer(state, seat);
    player.energyAttachedThisTurn = false;
    player.supporterPlayedThisTurn = false;
    player.abilityUsed.clear();
    pushEvent(state, { type: 'turn-started', seat, turn: state.turn });
    if (player.deck.length === 0) {
      this.finish(otherSeat(seat), 'deck-out');
      return;
    }
    player.hand.push(player.deck.shift()!);
  }

  /* ---------------- turn actions ---------------- */

  private requireTurn(seat: Seat): PlayerState {
    const state = this.state;
    if (state.phase !== 'playing') {
      throw new EngineError('ACTION_NOT_ALLOWED', 'the match is not in the playing phase');
    }
    if (state.activeSeat !== seat) {
      throw new EngineError('NOT_YOUR_TURN', 'it is the other seat\'s turn');
    }
    return getPlayer(state, seat);
  }

  private attachEnergy(seat: Seat, handIndex: number, target: PokemonSlotRef): void {
    const player = this.requireTurn(seat);
    if (player.energyAttachedThisTurn) {
      throw new EngineError('ACTION_NOT_ALLOWED', 'only one energy may be attached per turn');
    }
    validateHandIndex(player, handIndex);
    const card = player.hand[handIndex]!;
    const def = getCard(card.cardKey);
    if (def.kind !== 'energy' || def.provides === undefined) {
      throw new EngineError('ILLEGAL_TARGET', `${def.nameZh} is not a basic energy card`);
    }
    const pokemon = findOwnPokemon(player, target);
    player.hand.splice(handIndex, 1);
    pokemon.energies.push(card);
    player.energyAttachedThisTurn = true;
    pushEvent(this.state, {
      type: 'energy-attached',
      seat,
      cardKey: card.cardKey,
      nameZh: def.nameZh,
      target: slotLabel(target),
    });
  }

  private playTrainer(seat: Seat, handIndex: number, discardHandIndices: readonly number[], random: RandomSource): void {
    const state = this.state;
    const player = this.requireTurn(seat);
    validateHandIndex(player, handIndex);
    const card = player.hand[handIndex]!;
    const def = getCard(card.cardKey);
    if (def.kind !== 'trainer') {
      throw new EngineError('ILLEGAL_TARGET', `${def.nameZh} is not a trainer card`);
    }
    if (!def.implemented || def.trainerEffect === undefined) {
      throw new EngineError('UNSUPPORTED_CARD', `${def.nameZh} is known but not implemented in this probe`);
    }
    if (def.category === '支援者') {
      if (player.supporterPlayedThisTurn) {
        throw new EngineError('ACTION_NOT_ALLOWED', 'only one supporter may be played per turn');
      }
    }

    switch (def.trainerEffect) {
      case 'discard2-search-pokemon': {
        if (discardHandIndices.length !== 2) {
          throw new EngineError('ILLEGAL_COST', '高级球 requires exactly two hand cards to be discarded');
        }
        const indices = new Set<number>();
        for (const index of discardHandIndices) {
          validateHandIndex(player, index);
          if (index === handIndex) {
            throw new EngineError('ILLEGAL_COST', 'the trainer card itself cannot pay the discard cost');
          }
          if (indices.has(index)) {
            throw new EngineError('ILLEGAL_COST', 'discard cost indices must be distinct');
          }
          indices.add(index);
        }
        const costCards = [...indices].map(index => player.hand[index]!);
        const remaining = player.hand.filter((_c, index) => index !== handIndex && !indices.has(index));
        player.hand = remaining;
        player.discard.push(...costCards, card);
        pushEvent(state, { type: 'trainer-played', seat, cardKey: card.cardKey, nameZh: def.nameZh });
        const candidates = player.deck.filter(instance => getCard(instance.cardKey).kind === 'pokemon');
        // Guide Ver 3.1.0 H: a specified-category deck search may pick 0 cards.
        this.openSearch(seat, 'search-pokemon', candidates, 0, Math.min(1, candidates.length));
        break;
      }
      case 'search-water-pokemon-and-item': {
        player.hand.splice(handIndex, 1);
        player.discard.push(card);
        player.supporterPlayedThisTurn = true;
        pushEvent(state, { type: 'trainer-played', seat, cardKey: card.cardKey, nameZh: def.nameZh });
        const candidates = player.deck.filter(instance => {
          const candidate = getCard(instance.cardKey);
          // 2025-01-17: 「物品」検索 must not reach 宝可梦道具.
          return isWaterPokemon(candidate) || isItem(candidate);
        });
        const hasWater = candidates.some(instance => isWaterPokemon(getCard(instance.cardKey)));
        const hasItem = candidates.some(instance => isItem(getCard(instance.cardKey)));
        // Guide Ver 3.1.0 H: each specified category is optional, at most one card per category.
        const maxPicks = (hasWater ? 1 : 0) + (hasItem ? 1 : 0);
        this.openSearch(seat, 'search-water-pokemon-and-item', candidates, 0, maxPicks);
        break;
      }
      case 'coin-flip-search-pokemon': {
        player.hand.splice(handIndex, 1);
        player.discard.push(card);
        pushEvent(state, { type: 'trainer-played', seat, cardKey: card.cardKey, nameZh: def.nameZh });
        const heads = random.nextInt(2) === 0;
        pushEvent(state, { type: 'coin-flip', seat, result: heads ? 'heads' : 'tails' });
        if (heads) {
          const candidates = player.deck.filter(instance => getCard(instance.cardKey).kind === 'pokemon');
          this.openSearch(seat, 'search-pokemon', candidates, 0, Math.min(1, candidates.length));
        }
        break;
      }
    }
  }

  private useAbility(seat: Seat, name: string): void {
    const state = this.state;
    const player = this.requireTurn(seat);
    const active = player.active;
    if (active === null) {
      throw new EngineError('ILLEGAL_TARGET', 'no active Pokémon');
    }
    const def = getCard(active.pokemon.cardKey);
    const ability = (def.abilities ?? []).find(item => item.name === name && item.requiresActive);
    if (ability === undefined) {
      throw new EngineError('ILLEGAL_TARGET', `${def.nameZh} has no usable ability named ${name}`);
    }
    if (!ability.implemented) {
      throw new EngineError('UNSUPPORTED_CARD', `${def.nameZh} ability ${name} is not implemented in this probe`);
    }
    if (player.abilityUsed.has(active.pokemon.instanceId)) {
      throw new EngineError('ACTION_NOT_ALLOWED', 'this ability can only be used once per turn');
    }
    const candidates = player.deck.filter(instance => {
      const candidate = getCard(instance.cardKey);
      return candidate.kind === 'energy' && candidate.provides === '水';
    });
    if (candidates.length === 0) {
      throw new EngineError('ACTION_NOT_ALLOWED', 'no basic water energy left in the deck');
    }
    player.abilityUsed.add(active.pokemon.instanceId);
    pushEvent(state, { type: 'ability-used', seat, name });
    this.openSearch(seat, 'search-basic-water-energy', candidates, 0, Math.min(2, candidates.length));
  }

  private attack(seat: Seat, name: string): void {
    const state = this.state;
    const player = this.requireTurn(seat);
    const active = player.active;
    if (active === null) {
      throw new EngineError('ILLEGAL_TARGET', 'no active Pokémon to attack with');
    }
    const def = getCard(active.pokemon.cardKey);
    const attack = (def.attacks ?? []).find(item => item.name === name);
    if (attack === undefined) {
      throw new EngineError('ILLEGAL_TARGET', `${def.nameZh} has no attack named ${name}`);
    }
    if (!attack.implemented) {
      throw new EngineError('UNSUPPORTED_CARD', `${def.nameZh} attack ${name} is not implemented in this probe`);
    }
    if (!canPayCost(active.energies, attack.cost)) {
      throw new EngineError('INSUFFICIENT_ENERGY', `${name} energy cost is not satisfied`);
    }

    if (attack.kind === 'hail-blade') {
      const ownPokemon = [active, ...player.bench];
      const energies: CandidateRef[] = [];
      ownPokemon.forEach(pokemon => {
        pokemon.energies.forEach(energy => {
          if (getCard(energy.cardKey).provides === '水') {
            energies.push({ ref: `e${energies.length + 1}`, instanceId: energy.instanceId });
          }
        });
      });
      state.pendingChoice = {
        kind: 'discard-energy',
        seat,
        choiceId: choiceId(state, seat),
        attackName: name,
        min: 0,
        max: energies.length,
        candidates: energies,
      };
      return;
    }

    // Fixed-damage attacks resolve immediately.
    const opponent = getPlayer(state, otherSeat(seat));
    const target = opponent.active;
    if (target === null) {
      throw new EngineError('ILLEGAL_TARGET', 'opponent has no active Pokémon');
    }
    this.dealDamage(seat, active, target, attack.baseDamage, attack.name);
    this.finishAttackTurn(seat);
  }

  /* ---------------- choices ---------------- */

  private openSearch(
    seat: Seat,
    purpose: SearchPurpose,
    candidates: readonly CardInstance[],
    min: number,
    max: number,
  ): void {
    const state = this.state;
    state.pendingChoice = {
      kind: 'search-deck',
      seat,
      choiceId: choiceId(state, seat),
      purpose,
      min,
      max,
      candidates: candidates.map((instance, index) => ({ ref: `c${index + 1}`, instanceId: instance.instanceId })),
    };
  }

  private resolveChoice(seat: Seat, requestedChoiceId: string, picks: readonly string[], random: RandomSource): void {
    const state = this.state;
    const pending = state.pendingChoice;
    if (pending === null) {
      throw new EngineError('ACTION_NOT_ALLOWED', 'there is no pending choice');
    }
    if (pending.choiceId !== requestedChoiceId) {
      throw new EngineError('ILLEGAL_TARGET', 'the pending choice id does not match');
    }
    if (pending.kind === 'turn-order') {
      throw new EngineError('ACTION_NOT_ALLOWED', 'turn order is resolved with choose-turn-order');
    }
    if (picks.length < pending.min || picks.length > pending.max) {
      throw new EngineError('ILLEGAL_TARGET', `choice expects between ${pending.min} and ${pending.max} picks`);
    }
    const seen = new Set<string>();
    for (const ref of picks) {
      if (seen.has(ref)) {
        throw new EngineError('ILLEGAL_TARGET', 'picks must be distinct');
      }
      seen.add(ref);
      if (!pending.candidates.some(candidate => candidate.ref === ref)) {
        throw new EngineError('ILLEGAL_TARGET', `unknown candidate reference: ${ref}`);
      }
    }
    // Validate each kind completely before mutating: a rejected resolution must
    // leave the pending choice, engine state, version and random stream untouched.
    switch (pending.kind) {
      case 'search-deck': {
        const player = getPlayer(state, seat);
        const chosen = pending.candidates.filter(candidate => seen.has(candidate.ref));
        const instances = chosen.map(candidate => instanceById(player.deck, candidate.instanceId));
        if (pending.purpose === 'search-water-pokemon-and-item') {
          const roles = instances.map(instance => searchRoles(pending.purpose, getCard(instance.cardKey)));
          const waterCount = roles.filter(role => role.includes('water-pokemon')).length;
          const itemCount = roles.filter(role => role.includes('item')).length;
          if (waterCount > 1 || itemCount > 1) {
            throw new EngineError('ILLEGAL_TARGET', '珠贝 can find at most one water Pokémon and one item');
          }
        }
        state.pendingChoice = null;
        for (const instance of instances) {
          player.deck = player.deck.filter(card => card.instanceId !== instance.instanceId);
          player.hand.push(instance);
        }
        if (instances.length > 0) {
          pushEvent(state, {
            type: 'cards-revealed',
            seat,
            cards: instances.map(instance => ({
              cardKey: instance.cardKey,
              nameZh: getCard(instance.cardKey).nameZh,
            })),
          });
        }
        shuffleInPlace(player.deck, random);
        pushEvent(state, { type: 'deck-shuffled', seat });
        break;
      }
      case 'discard-energy': {
        const player = getPlayer(state, seat);
        const opponent = getPlayer(state, otherSeat(seat));
        const attacker = player.active;
        const target = opponent.active;
        if (attacker === null || target === null) {
          throw new EngineError('ILLEGAL_TARGET', 'attack targets are no longer valid');
        }
        const discarded = pending.candidates
          .filter(candidate => seen.has(candidate.ref))
          .map(candidate => ({
            instance: instanceFromAttachments(player, candidate.instanceId),
            owner: findAttachmentOwner(player, candidate.instanceId),
          }));
        state.pendingChoice = null;
        for (const entry of discarded) {
          const index = entry.owner.energies.findIndex(energy => energy.instanceId === entry.instance.instanceId);
          entry.owner.energies.splice(index, 1);
          player.discard.push(entry.instance);
        }
        this.dealDamage(seat, attacker, target, 60 * discarded.length, pending.attackName);
        this.finishAttackTurn(seat);
        break;
      }
      case 'promote-active': {
        const player = getPlayer(state, seat);
        const candidate = pending.candidates.find(item => seen.has(item.ref));
        const index =
          candidate === undefined
            ? -1
            : player.bench.findIndex(pokemon => pokemon.pokemon.instanceId === candidate.instanceId);
        if (candidate === undefined || index < 0) {
          throw new EngineError('ILLEGAL_TARGET', 'chosen Pokémon is not on the bench');
        }
        const [promoted] = player.bench.splice(index, 1);
        player.active = promoted!;
        state.pendingChoice = null;
        this.finishAttackTurn(otherSeat(seat));
        break;
      }
    }
  }

  /* ---------------- damage and KO ---------------- */

  private dealDamage(seat: Seat, attacker: InPlayPokemon, target: InPlayPokemon, baseDamage: number, attackName: string): void {
    const state = this.state;
    const attackerDef = getCard(attacker.pokemon.cardKey);
    const targetDef = getCard(target.pokemon.cardKey);
    let damage = baseDamage;
    if (targetDef.weakness !== undefined && targetDef.weakness.type === attackerDef.type) {
      damage *= targetDef.weakness.factor;
    }
    if (targetDef.resistance !== undefined && targetDef.resistance.type === attackerDef.type) {
      damage += targetDef.resistance.value;
    }
    damage = Math.max(0, damage);
    target.damage += damage;
    pushEvent(state, {
      type: 'attack-used',
      seat,
      name: attackName,
      damage,
      targetCardKey: target.pokemon.cardKey,
    });
    this.checkKnockOut(seat, target);
  }

  private checkKnockOut(attackerSeat: Seat, target: InPlayPokemon): void {
    const state = this.state;
    const targetDef = getCard(target.pokemon.cardKey);
    const maxHp = targetDef.hp ?? 0;
    if (target.damage < maxHp) {
      return;
    }
    const ownerSeat = otherSeat(attackerSeat);
    const owner = getPlayer(state, ownerSeat);
    const attacker = getPlayer(state, attackerSeat);
    pushEvent(state, {
      type: 'pokemon-knocked-out',
      seat: ownerSeat,
      cardKey: target.pokemon.cardKey,
      nameZh: targetDef.nameZh,
    });

    owner.discard.push(target.pokemon, ...target.energies, ...target.tools);
    if (owner.active?.pokemon.instanceId === target.pokemon.instanceId) {
      owner.active = null;
    } else {
      owner.bench = owner.bench.filter(pokemon => pokemon.pokemon.instanceId !== target.pokemon.instanceId);
    }

    const prizeCount = targetDef.prizeValue ?? 1;
    const take = Math.min(prizeCount, attacker.prizes.length);
    const taken = attacker.prizes.splice(0, take);
    attacker.hand.push(...taken);
    pushEvent(state, {
      type: 'prizes-taken',
      seat: attackerSeat,
      count: take,
      remaining: attacker.prizes.length,
    });

    if (attacker.prizes.length === 0) {
      this.finish(attackerSeat, 'prizes');
      return;
    }
    if (owner.active === null && owner.bench.length === 0) {
      this.finish(attackerSeat, 'no-pokemon');
      return;
    }
    if (owner.active === null && owner.bench.length > 0) {
      state.pendingChoice = {
        kind: 'promote-active',
        seat: ownerSeat,
        choiceId: choiceId(state, ownerSeat),
        min: 1,
        max: 1,
        candidates: owner.bench.map((pokemon, index) => ({
          ref: `b${index + 1}`,
          instanceId: pokemon.pokemon.instanceId,
        })),
      };
    }
  }

  /* ---------------- turn end / finish ---------------- */

  /**
   * Using an attack ends the attacker's turn (guide Ver 3.1.0 A-01). A pending
   * knockout promotion defers the transition until the owner places a new
   * active Pokémon; the promoting player then starts the next turn.
   */
  private finishAttackTurn(seat: Seat): void {
    const state = this.state;
    if (state.phase === 'finished' || state.pendingChoice?.kind === 'promote-active') {
      return;
    }
    this.endTurn(seat);
  }

  private endTurn(seat: Seat): void {
    this.requireTurn(seat);
    pushEvent(this.state, { type: 'turn-ended', seat });
    this.startTurn(otherSeat(seat));
  }

  private concede(seat: Seat): void {
    const state = this.state;
    if (state.phase === 'finished') {
      throw new EngineError('GAME_FINISHED', 'the match is already finished');
    }
    pushEvent(state, { type: 'conceded', seat });
    this.finish(otherSeat(seat), 'concede');
  }

  private finish(winner: Seat | null, reason: MatchResult['reason']): void {
    const state = this.state;
    if (state.phase === 'finished') {
      return;
    }
    state.phase = 'finished';
    state.pendingChoice = null;
    state.result = { winner, reason };
    pushEvent(state, { type: 'match-finished', winner, reason });
  }
}

/* ------------------------------------------------------------------ */
/* View building                                                       */
/* ------------------------------------------------------------------ */

export function buildPlayerView(state: EngineState, seat: Seat): PlayerView {
  const self = getPlayer(state, seat);
  const opponent = getPlayer(state, otherSeat(seat));
  const pending = state.pendingChoice;
  const pendingView = pending !== null && pending.seat === seat ? toPendingView(state, pending) : null;
  return {
    seat,
    version: state.version,
    turn: state.turn,
    phase: state.phase,
    activeSeat: state.activeSeat,
    self: {
      hand: self.hand.map((card, index) => ({ handIndex: index, card: toCardView(card.cardKey) })),
      deck: { count: self.deck.length },
      prizes: { count: self.prizes.length },
      discard: self.discard.map(card => toCardView(card.cardKey)),
      active: self.active === null ? null : toPokemonView('active', self.active),
      bench: self.bench.map((pokemon, index) => toPokemonView(index, pokemon)),
      setupPlaced: self.setupPlaced,
    },
    opponent: {
      hand: { count: opponent.hand.length },
      deck: { count: opponent.deck.length },
      prizes: { count: opponent.prizes.length },
      discard: opponent.discard.map(card => toCardView(card.cardKey)),
      active: opponent.active === null ? null : toPokemonView('active', opponent.active),
      bench: opponent.bench.map((pokemon, index) => toPokemonView(index, pokemon)),
      setupPlaced: opponent.setupPlaced,
    },
    pendingChoice: pendingView,
    waitingForOpponentChoice: pending !== null && pending.seat !== seat,
    events: [...state.events],
    result: state.result,
  };
}

function toCardView(cardKey: string): CardView {
  const def = getCard(cardKey);
  return { cardKey: def.cardKey, nameZh: def.nameZh, kind: def.kind, category: def.category };
}

function toPokemonView(slot: 'active' | number, pokemon: InPlayPokemon): PokemonInPlayView {
  const def = getCard(pokemon.pokemon.cardKey);
  return {
    slot,
    cardKey: pokemon.pokemon.cardKey,
    nameZh: def.nameZh,
    type: def.type ?? '',
    maxHp: def.hp ?? 0,
    damage: pokemon.damage,
    energies: pokemon.energies.map(energy => toCardView(energy.cardKey)),
    tools: pokemon.tools.map(tool => toCardView(tool.cardKey)),
  };
}

function toPendingView(state: EngineState, pending: InternalChoice): PendingChoiceView {
  switch (pending.kind) {
    case 'search-deck':
      return {
        choiceId: pending.choiceId,
        seat: pending.seat,
        kind: 'search-deck',
        purpose: pending.purpose,
        min: pending.min,
        max: pending.max,
        candidates: pending.candidates.map(candidate => toCandidateView(state, pending.purpose, candidate.ref, candidate.instanceId)),
      };
    case 'discard-energy': {
      const player = getPlayer(state, pending.seat);
      return {
        choiceId: pending.choiceId,
        seat: pending.seat,
        kind: 'discard-energy',
        min: pending.min,
        max: pending.max,
        energies: pending.candidates.map(candidate => {
          const instance = instanceFromAttachments(player, candidate.instanceId);
          const owner = findAttachmentOwner(player, candidate.instanceId);
          const attachedTo = owner === player.active ? 'active' : `bench:${player.bench.indexOf(owner)}`;
          return {
            ref: candidate.ref,
            cardKey: instance.cardKey,
            nameZh: getCard(instance.cardKey).nameZh,
            attachedTo,
          };
        }),
      };
    }
    case 'promote-active': {
      const player = getPlayer(state, pending.seat);
      return {
        choiceId: pending.choiceId,
        seat: pending.seat,
        kind: 'promote-active',
        min: 1,
        max: 1,
        candidates: pending.candidates.map(candidate => {
          const pokemon = player.bench.find(item => item.pokemon.instanceId === candidate.instanceId)!;
          const def = getCard(pokemon.pokemon.cardKey);
          return {
            ref: candidate.ref,
            cardKey: pokemon.pokemon.cardKey,
            nameZh: def.nameZh,
            kind: 'pokemon' as const,
            category: null,
            hp: def.hp,
            type: def.type,
            roles: ['pokemon'] as const,
          };
        }),
      };
    }
    case 'turn-order':
      return { choiceId: pending.choiceId, seat: pending.seat, kind: 'turn-order' };
  }
}

function toCandidateView(
  state: EngineState,
  purpose: SearchPurpose,
  ref: string,
  instanceId: number,
): SearchCandidateView {
  const cardKey = instanceCardKey(state, instanceId);
  const def = getCard(cardKey);
  return {
    ref,
    cardKey,
    nameZh: def.nameZh,
    kind: def.kind,
    category: def.category,
    hp: def.hp,
    type: def.type,
    roles: searchRoles(purpose, def),
  };
}

function searchRoles(purpose: SearchPurpose, def: CardDef): readonly SearchCandidateView['roles'][number][] {
  switch (purpose) {
    case 'search-pokemon':
      return ['pokemon'];
    case 'search-basic-water-energy':
      return ['basic-water-energy'];
    case 'search-water-pokemon-and-item': {
      const roles: ('water-pokemon' | 'item')[] = [];
      if (isWaterPokemon(def)) {
        roles.push('water-pokemon');
      }
      if (isItem(def)) {
        roles.push('item');
      }
      return roles;
    }
  }
}

function isWaterPokemon(def: CardDef): boolean {
  return def.kind === 'pokemon' && def.type === '水';
}

function isItem(def: CardDef): boolean {
  return def.kind === 'trainer' && def.category === '物品';
}

/* ------------------------------------------------------------------ */
/* Test-only internal snapshot                                         */
/* ------------------------------------------------------------------ */

export interface InternalSnapshotPlayer {
  readonly seat: Seat;
  readonly hand: readonly CardInstance[];
  readonly deck: readonly CardInstance[];
  readonly discard: readonly CardInstance[];
  readonly prizes: readonly CardInstance[];
  readonly active: InPlayPokemon | null;
  readonly bench: readonly InPlayPokemon[];
}

export interface InternalSnapshot {
  readonly version: number;
  readonly turn: number;
  readonly phase: Phase;
  readonly activeSeat: Seat | null;
  readonly result: MatchResult | null;
  readonly pendingChoice:
    | { readonly kind: InternalChoice['kind']; readonly seat: Seat; readonly choiceId: string; readonly refs: readonly CandidateRef[] }
    | null;
  readonly players: readonly [InternalSnapshotPlayer, InternalSnapshotPlayer];
}

function snapshot(state: EngineState): InternalSnapshot {
  return {
    version: state.version,
    turn: state.turn,
    phase: state.phase,
    activeSeat: state.activeSeat,
    result: state.result,
    pendingChoice:
      state.pendingChoice === null
        ? null
        : {
            kind: state.pendingChoice.kind,
            seat: state.pendingChoice.seat,
            choiceId: state.pendingChoice.choiceId,
            refs: state.pendingChoice.kind === 'turn-order' ? [] : state.pendingChoice.candidates.map(candidate => ({ ...candidate })),
          },
    players: [snapshotPlayer(state.players[0]), snapshotPlayer(state.players[1])],
  };
}

function snapshotPlayer(player: PlayerState): InternalSnapshotPlayer {
  return {
    seat: player.seat,
    hand: player.hand.map(card => ({ ...card })),
    deck: player.deck.map(card => ({ ...card })),
    discard: player.discard.map(card => ({ ...card })),
    prizes: player.prizes.map(card => ({ ...card })),
    active: player.active === null ? null : cloneInPlay(player.active),
    bench: player.bench.map(cloneInPlay),
  };
}

function cloneInPlay(pokemon: InPlayPokemon): InPlayPokemon {
  return {
    pokemon: { ...pokemon.pokemon },
    damage: pokemon.damage,
    energies: pokemon.energies.map(card => ({ ...card })),
    tools: pokemon.tools.map(card => ({ ...card })),
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function getPlayer(state: EngineState, seat: Seat): PlayerState {
  return state.players[seat];
}

function validateHandIndex(player: PlayerState, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= player.hand.length) {
    throw new EngineError('ILLEGAL_TARGET', `hand index ${index} is out of range`);
  }
}

function findOwnPokemon(player: PlayerState, target: PokemonSlotRef): InPlayPokemon {
  if (target.slot === 'active') {
    if (player.active === null) {
      throw new EngineError('ILLEGAL_TARGET', 'there is no active Pokémon');
    }
    return player.active;
  }
  const pokemon = player.bench[target.index];
  if (pokemon === undefined) {
    throw new EngineError('ILLEGAL_TARGET', `bench slot ${target.index} is empty`);
  }
  return pokemon;
}

function slotLabel(target: PokemonSlotRef): string {
  return target.slot === 'active' ? 'active' : `bench:${target.index}`;
}

function canPayCost(energies: readonly CardInstance[], cost: readonly string[]): boolean {
  const available = energies.map(energy => getCard(energy.cardKey).provides);
  for (const symbol of cost) {
    if (symbol === '无') {
      continue;
    }
    const index = available.findIndex(provide => provide === symbol);
    if (index < 0) {
      return false;
    }
    available.splice(index, 1);
  }
  return true;
}

function instanceById(cards: readonly CardInstance[], instanceId: number): CardInstance {
  const card = cards.find(item => item.instanceId === instanceId);
  if (card === undefined) {
    throw new EngineError('ILLEGAL_TARGET', `card instance ${instanceId} no longer exists`);
  }
  return card;
}

function instanceCardKey(state: EngineState, instanceId: number): string {
  for (const player of state.players) {
    const all = [
      ...player.hand,
      ...player.deck,
      ...player.discard,
      ...player.prizes,
      ...(player.active === null ? [] : [player.active.pokemon, ...player.active.energies, ...player.active.tools]),
      ...player.bench.flatMap(pokemon => [pokemon.pokemon, ...pokemon.energies, ...pokemon.tools]),
    ];
    const card = all.find(item => item.instanceId === instanceId);
    if (card !== undefined) {
      return card.cardKey;
    }
  }
  throw new EngineError('ILLEGAL_TARGET', `unknown card instance ${instanceId}`);
}

function instanceFromAttachments(player: PlayerState, instanceId: number): CardInstance {
  return findAttachmentOwner(player, instanceId).energies.find(energy => energy.instanceId === instanceId)!;
}

function findAttachmentOwner(player: PlayerState, instanceId: number): InPlayPokemon {
  const all = [...(player.active === null ? [] : [player.active]), ...player.bench];
  const owner = all.find(pokemon => pokemon.energies.some(energy => energy.instanceId === instanceId));
  if (owner === undefined) {
    throw new EngineError('ILLEGAL_TARGET', `energy instance ${instanceId} is not attached`);
  }
  return owner;
}
