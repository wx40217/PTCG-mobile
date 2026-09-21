import type { MatchAttackView, MatchCardView, MatchPokemonView, MatchPublicEvent, MatchSideView, MatchView } from '@ptcg/protocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function matchCard(overrides: Partial<MatchCardView> = {}): MatchCardView {
  return {
    cardId: 'csve1-035',
    nameZh: '荧光鱼',
    kind: 'pokemon',
    classLabelZh: '宝可梦',
    isBasicPokemon: true,
    evolvesFrom: null,
    type: '水',
    hp: 50,
    printDisplayNumber: 'CSVE1C 035/177',
    ...overrides,
  };
}

export function matchAttack(overrides: Partial<MatchAttackView> = {}): MatchAttackView {
  return {
    index: 0,
    name: '水枪',
    cost: ['水'],
    damageText: '10',
    effectTextZh: null,
    supported: true,
    ...overrides,
  };
}

export function matchPokemon(overrides: Partial<MatchPokemonView> = {}): MatchPokemonView {
  return {
    card: matchCard(),
    damageCounters: 0,
    statuses: [],
    energies: [],
    tools: [],
    evolutionStack: [],
    maxHp: 50,
    attacks: [matchAttack()],
    abilities: [],
    canEvolve: true,
    evolveBlockedReasonZh: null,
    retreatCost: 1,
    weakness: '雷×2',
    resistance: null,
    ...overrides,
  };
}

export function matchSide(seat: 0 | 1, overrides: Partial<MatchSideView> = {}): MatchSideView {
  return {
    seat,
    nickname: seat === 0 ? '小智' : '小茂',
    hand: [],
    handCount: 7,
    deckCount: 13,
    prizeCount: 0,
    discard: [],
    active: null,
    bench: [],
    setupPlaced: false,
    mulligans: 0,
    soloMulligans: 0,
    revealed: true,
    energyAttachedThisTurn: false,
    retreatedThisTurn: false,
    supporterUsedThisTurn: false,
    stadiumPlayedThisTurn: false,
    stadiumUsedThisTurn: false,
    koDuringLastOpponentTurn: false,
    ...overrides,
  };
}

export function matchEvent(seq: number, event: DistributiveOmit<MatchPublicEvent, 'seq'>): MatchPublicEvent {
  return { seq, ...event } as MatchPublicEvent;
}

export function matchView(overrides: Partial<MatchView> = {}): MatchView {
  return {
    sessionId: 'session-1',
    version: 3,
    phase: 'setup',
    turn: 0,
    activeSeat: null,
    firstSeat: 0,
    you: matchSide(0),
    opponent: matchSide(1, { revealed: false }),
    stadium: null,
    pendingChoice: null,
    waitingForOpponentChoice: false,
    cannotDraw: false,
    result: null,
    events: [],
    ...overrides,
  };
}
