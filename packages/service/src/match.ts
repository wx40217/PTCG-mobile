import { randomInt, randomUUID } from 'node:crypto';
import type {
  CatalogCard,
  CatalogContent,
  DeckDocument,
  MatchCardView,
  MatchClientMessage,
  MatchErrorCode,
  MatchPendingChoiceView,
  MatchPhase,
  MatchPublicEvent,
  MatchSeat,
  MatchSideView,
  MatchView,
} from '@ptcg/protocol';

/**
 * 开局对局引擎（T07 / #8）。
 *
 * 只实现「从双方准备完成到首回合开始」的规则，不实现回合内动作与卡牌效果：
 *
 *   1. 服务端随机决定先后攻选择权（`RandomSource`，正式服为 WebCrypto/Node
 *      crypto；客户端不能提交种子或牌序）。
 *   2. 获选玩家明确选择先攻/后攻。
 *   3. 洗牌、发 7 张手牌；无「基础」宝可梦时向对手展示并重洗重抽（支持双方
 *      同时重抽）。
 *   4. 双方盖放 1 张战斗宝可梦与最多 5 张基础备战宝可梦。
 *   5. 各放置 6 张奖赏卡。
 *   6. 对手每重抽一次，己方可选补抽 0..N 张；补抽到的基础宝可梦可继续盖放
 *      到备战区。
 *   7. 公开翻面并进入唯一首回合（首回合玩家先抽 1 张）。
 *
 * 规则依据（冻结证据）：
 *   - 官方《进阶玩家向规则指南》Ver 3.1.0 G「对战准备」（重抽、6 张奖赏卡、
 *     补抽上限与补抽后的备战放置）。
 *   - 官方可玩规则「开始和对手对战吧」快照（7 张手牌、无基础宝可梦展示/重洗、
 *     双方都没有时双方重洗、补抽「可」抽 0..次数张）。
 *
 * 所有隐藏区域（对手手牌、双方牌库顺序、奖赏卡身份）只以张数或本人视图投影；
 * 内部卡牌实例 ID 永不序列化。待决选择带 `choiceId`、座位与版本：越权、非法
 * 数量、重复回答及旧选择 ID 都不会改变状态。
 */

export interface RandomSource {
  nextInt(maxExclusive: number): number;
}

/** 正式服随机源：`crypto.randomInt` 排除可预测的 `Math.random`。 */
export class CryptoRandomSource implements RandomSource {
  public nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt expects a positive integer, got ${maxExclusive}`);
    }
    return randomInt(maxExclusive);
  }
}

/** Fisher–Yates 洗牌；随机输出只来自注入的随机源。 */
export function shuffleInPlace<T>(items: T[], random: RandomSource): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const position = random.nextInt(i + 1);
    if (!Number.isInteger(position) || position < 0 || position > i) {
      throw new Error(`随机源返回了非法值 ${position}（nextInt(${i + 1})）`);
    }
    const value = items[i] as T;
    items[i] = items[position] as T;
    items[position] = value;
  }
}

export class MatchEngineError extends Error {
  public readonly code: MatchErrorCode;

  public constructor(code: MatchErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MatchEngineError';
  }
}

interface CardInstance {
  readonly instanceId: number;
  readonly cardId: string;
}

interface PlayerState {
  readonly seat: MatchSeat;
  readonly nickname: string;
  deck: CardInstance[];
  hand: CardInstance[];
  prizes: CardInstance[];
  discard: CardInstance[];
  active: CardInstance | null;
  bench: CardInstance[];
  setupPlaced: boolean;
  mulligans: number;
}

interface PendingChoice {
  readonly kind: 'turn-order' | 'place-setup' | 'compensation-draw' | 'compensation-bench';
  readonly seat: MatchSeat;
  readonly choiceId: string;
  readonly min: number;
  readonly max: number;
  readonly benchMin: number;
  readonly benchMax: number;
  readonly candidates: readonly number[];
}

interface EngineState {
  readonly sessionId: string;
  version: number;
  phase: MatchPhase;
  turn: number;
  activeSeat: MatchSeat | null;
  firstSeat: MatchSeat | null;
  pending: PendingChoice | null;
  compensationQueue: MatchSeat[];
  events: MatchPublicEvent[];
  nextChoiceSeq: number;
  players: [PlayerState, PlayerState];
}

export interface OpeningEngineConfig {
  readonly sessionId: string;
  readonly decks: readonly [DeckDocument, DeckDocument];
  readonly nicknames: readonly [string, string];
  readonly catalog: CatalogContent;
  readonly random: RandomSource;
}

export function otherSeat(seat: MatchSeat): MatchSeat {
  return seat === 0 ? 1 : 0;
}

function hasBasicPokemon(cards: readonly CardInstance[], cardsById: ReadonlyMap<string, CatalogCard>): boolean {
  return cards.some((card) => {
    const definition = cardsById.get(card.cardId);
    return definition !== undefined && definition.cardClass === 'pokemon' && definition.subtypes.includes('基础');
  });
}

/**
 * 开局引擎。所有公开验证先于任何状态修改；每条成功命令只递增一次版本。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PublicEventInput = DistributiveOmit<MatchPublicEvent, 'seq'>;

export class OpeningEngine {
  private readonly cardsById: ReadonlyMap<string, CatalogCard>;
  private readonly random: RandomSource;
  private readonly state: EngineState;

  public constructor(config: OpeningEngineConfig) {
    this.cardsById = new Map(config.catalog.cards.map((card) => [card.id, card]));
    this.random = config.random;
    let nextInstanceId = 1;
    const materialize = (seat: MatchSeat): PlayerState => {
      const deck = config.decks[seat];
      const cards: CardInstance[] = [];
      let total = 0;
      for (const entry of deck.cards) {
        const definition = this.cardsById.get(entry.cardId);
        if (definition === undefined) {
          throw new MatchEngineError('illegal-choice', `卡组引用了目录中不存在的卡牌 ${entry.cardId}。`);
        }
        for (let i = 0; i < entry.count; i += 1) {
          cards.push({ instanceId: nextInstanceId, cardId: entry.cardId });
          nextInstanceId += 1;
        }
        total += entry.count;
      }
      if (total < 13) {
        throw new MatchEngineError('illegal-choice', '卡组至少需要 13 张（7 张手牌 + 6 张奖赏卡）。');
      }
      if (!hasBasicPokemon(cards, this.cardsById)) {
        throw new MatchEngineError('illegal-choice', '卡组必须含有至少 1 张基础宝可梦。');
      }
      return {
        seat,
        nickname: config.nicknames[seat],
        deck: cards,
        hand: [],
        prizes: [],
        discard: [],
        active: null,
        bench: [],
        setupPlaced: false,
        mulligans: 0,
      };
    };
    const players: [PlayerState, PlayerState] = [materialize(0), materialize(1)];
    this.state = {
      sessionId: config.sessionId,
      version: 1,
      phase: 'turn-order',
      turn: 0,
      activeSeat: null,
      firstSeat: null,
      pending: null,
      compensationQueue: [],
      events: [],
      nextChoiceSeq: 0,
      players,
    };
    this.pushEvent({ type: 'match-created', seats: [players[0].nickname, players[1].nickname] });
    // 猜拳的公平替代：服务端随机决定谁获得先后攻选择权。
    const winner: MatchSeat = config.random.nextInt(2) === 0 ? 0 : 1;
    this.pushEvent({ type: 'turn-order-flip', winner });
    this.state.pending = this.newChoice('turn-order', winner, { min: 1, max: 1, benchMin: 0, benchMax: 0, candidates: [] });
  }

  public get version(): number {
    return this.state.version;
  }

  public get phase(): MatchPhase {
    return this.state.phase;
  }

  public get sessionId(): string {
    return this.state.sessionId;
  }

  public viewFor(seat: MatchSeat): MatchView {
    const state = this.state;
    const other = otherSeat(seat);
    return {
      sessionId: state.sessionId,
      version: state.version,
      phase: state.phase,
      turn: state.turn,
      activeSeat: state.activeSeat,
      firstSeat: state.firstSeat,
      you: this.sideViewFor(seat, seat),
      opponent: this.sideViewFor(other, seat),
      pendingChoice: state.pending !== null && state.pending.seat === seat ? this.pendingView(state.pending) : null,
      waitingForOpponentChoice: state.pending !== null && state.pending.seat !== seat,
      events: state.events.map((event) => ({ ...event })),
    };
  }

  /**
   * 执行一条已通过会话层去重与版本校验的命令。所有验证先于状态修改；
   * 抛出的 `MatchEngineError` 表示本次命令未产生任何变化。
   */
  public execute(seat: MatchSeat, command: MatchClientMessage): void {
    const pending = this.state.pending;
    const kind = commandKind(command);
    if (pending === null) {
      throw new MatchEngineError('choice-pending', '当前没有待决选择。');
    }
    if (pending.kind !== kind) {
      throw new MatchEngineError('choice-pending', '必须等待当前待决选择结算后再操作。');
    }
    if (pending.seat !== seat) {
      throw new MatchEngineError('not-your-choice', '这个待决选择不属于你。');
    }
    if (command.choiceId !== pending.choiceId) {
      throw new MatchEngineError('stale-choice', '这条选择已经过期，请按最新的待决选择重新操作。');
    }
    switch (command.type) {
      case 'choose-turn-order':
        this.chooseTurnOrder(seat, command.goFirst);
        break;
      case 'place-setup':
        this.placeSetup(seat, command.active, command.bench);
        break;
      case 'resolve-compensation':
        this.resolveCompensation(seat, command.draw);
        break;
      case 'place-compensation-bench':
        this.placeCompensationBench(seat, command.bench);
        break;
    }
    this.state.version += 1;
  }

  /* ---------------- 初始化 ---------------- */

  /* ---------------- 选择与事件 ---------------- */

  private newChoice(
    kind: PendingChoice['kind'],
    seat: MatchSeat,
    fields: { min: number; max: number; benchMin: number; benchMax: number; candidates: readonly number[] },
  ): PendingChoice {
    this.state.nextChoiceSeq += 1;
    return {
      kind,
      seat,
      choiceId: `choice-${this.state.nextChoiceSeq}`,
      min: fields.min,
      max: fields.max,
      benchMin: fields.benchMin,
      benchMax: fields.benchMax,
      candidates: [...fields.candidates],
    };
  }

  private pushEvent(event: PublicEventInput): void {
    this.state.events.push({ ...event, seq: this.state.events.length + 1 } as MatchPublicEvent);
  }

  private cardView(card: CardInstance): MatchCardView {
    const definition = this.cardsById.get(card.cardId);
    if (definition === undefined) {
      throw new MatchEngineError('illegal-choice', `目录中不存在卡牌 ${card.cardId}。`);
    }
    return {
      cardId: definition.id,
      nameZh: definition.nameZh,
      kind: definition.cardClass,
      classLabelZh: definition.classLabelZh,
      isBasicPokemon: definition.cardClass === 'pokemon' && definition.subtypes.includes('基础'),
      type: definition.type,
      hp: definition.hp,
      printDisplayNumber: definition.print.displayNumber,
    };
  }

  private sideViewFor(sideSeat: MatchSeat, viewerSeat: MatchSeat): MatchSideView {
    const player = this.state.players[sideSeat];
    const own = sideSeat === viewerSeat;
    // 对局开始前，对手盖放的战斗/备战宝可梦没有身份。
    const identitiesVisible = own || this.state.phase === 'playing';
    return {
      seat: player.seat,
      nickname: player.nickname,
      hand: own ? player.hand.map((card) => this.cardView(card)) : [],
      handCount: player.hand.length,
      deckCount: player.deck.length,
      prizeCount: player.prizes.length,
      discard: player.discard.map((card) => this.cardView(card)),
      active: identitiesVisible && player.active !== null ? { card: this.cardView(player.active) } : null,
      bench: identitiesVisible ? player.bench.map((card) => ({ card: this.cardView(card) })) : [],
      setupPlaced: player.setupPlaced,
      mulligans: player.mulligans,
      revealed: identitiesVisible,
    };
  }

  private pendingView(pending: PendingChoice): MatchPendingChoiceView {
    return {
      choiceId: pending.choiceId,
      seat: pending.seat,
      kind: pending.kind,
      min: pending.min,
      max: pending.max,
      benchMin: pending.benchMin,
      benchMax: pending.benchMax,
      candidates: [...pending.candidates],
    };
  }

  /* ---------------- 开局准备 ---------------- */

  private chooseTurnOrder(seat: MatchSeat, goFirst: boolean): void {
    if (this.state.phase !== 'turn-order') {
      throw new MatchEngineError('illegal-choice', '先后攻已经确定。');
    }
    const first = goFirst ? seat : otherSeat(seat);
    this.state.firstSeat = first;
    this.state.pending = null;
    this.pushEvent({ type: 'turn-order-chosen', seat, goFirst });
    this.dealOpeningHands();
    this.state.phase = 'setup';
    this.state.pending = this.newChoice('place-setup', first, {
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 5,
      candidates: this.basicHandIndices(first),
    });
  }

  private dealOpeningHands(): void {
    for (const seat of [0, 1] as const) {
      this.shuffleDeck(seat);
      this.state.players[seat].hand = this.state.players[seat].deck.splice(0, 7);
    }
    // 无基础宝可梦：向对手展示整副手牌，放回牌库重洗后重抽；双方都没有时
    // 双方都会在下一轮重抽。一直重抽到每方都能放置战斗宝可梦。
    let lacking = this.seatsWithoutBasic();
    while (lacking.length > 0) {
      for (const seat of lacking) {
        const player = this.state.players[seat];
        player.mulligans += 1;
        this.pushEvent({
          type: 'mulligan',
          seat,
          count: player.mulligans,
          cards: player.hand.map((card) => this.cardView(card)),
        });
        player.deck.push(...player.hand);
        player.hand = [];
        this.shuffleDeck(seat);
        player.hand = player.deck.splice(0, 7);
      }
      lacking = this.seatsWithoutBasic();
    }
  }

  private seatsWithoutBasic(): MatchSeat[] {
    const lacking: MatchSeat[] = [];
    for (const seat of [0, 1] as const) {
      if (!hasBasicPokemon(this.state.players[seat].hand, this.cardsById)) {
        lacking.push(seat);
      }
    }
    return lacking;
  }

  private shuffleDeck(seat: MatchSeat): void {
    shuffleInPlace(this.state.players[seat].deck, this.random);
  }

  private basicHandIndices(seat: MatchSeat): number[] {
    const indices: number[] = [];
    this.state.players[seat].hand.forEach((card, index) => {
      if (hasBasicPokemon([card], this.cardsById)) {
        indices.push(index);
      }
    });
    return indices;
  }

  private placeSetup(seat: MatchSeat, active: number, bench: readonly number[]): void {
    if (this.state.phase !== 'setup') {
      throw new MatchEngineError('illegal-choice', '当前不是初始放置阶段。');
    }
    const player = this.state.players[seat];
    if (player.setupPlaced) {
      throw new MatchEngineError('illegal-choice', '初始宝可梦已经放置。');
    }
    if (!Number.isInteger(active) || active < 0 || active >= player.hand.length) {
      throw new MatchEngineError('illegal-choice', '战斗宝可梦的手牌序号无效。');
    }
    if (bench.length > 5) {
      throw new MatchEngineError('illegal-choice', '备战区最多 5 只宝可梦。');
    }
    const chosen = [active, ...bench];
    const seen = new Set<number>();
    for (const index of chosen) {
      if (!Number.isInteger(index) || index < 0 || index >= player.hand.length) {
        throw new MatchEngineError('illegal-choice', '初始放置引用了不存在的手牌序号。');
      }
      if (seen.has(index)) {
        throw new MatchEngineError('illegal-choice', '同一张手牌不能被重复放置。');
      }
      seen.add(index);
      const card = player.hand[index] as CardInstance;
      if (!hasBasicPokemon([card], this.cardsById)) {
        throw new MatchEngineError('illegal-choice', '初始放置只能选择基础宝可梦。');
      }
    }
    // 验证完成后再修改状态。
    const activeCard = player.hand[active] as CardInstance;
    const benchCards = bench.map((index) => player.hand[index] as CardInstance);
    player.hand = player.hand.filter((_card, index) => !seen.has(index));
    player.active = activeCard;
    player.bench = benchCards;
    player.setupPlaced = true;
    this.pushEvent({ type: 'setup-placed', seat });

    const other = otherSeat(seat);
    if (this.state.players[other].setupPlaced) {
      this.placePrizesAndCompensation();
    } else {
      this.state.pending = this.newChoice('place-setup', other, {
        min: 1,
        max: 1,
        benchMin: 0,
        benchMax: 5,
        candidates: this.basicHandIndices(other),
      });
    }
  }

  private placePrizesAndCompensation(): void {
    for (const seat of [0, 1] as const) {
      const player = this.state.players[seat];
      player.prizes = player.deck.splice(0, 6);
      this.pushEvent({ type: 'prizes-placed', seat });
    }
    this.state.phase = 'compensation';
    this.state.compensationQueue = ([0, 1] as const).filter((seat) => this.state.players[otherSeat(seat)].mulligans > 0);
    this.advanceCompensation();
  }

  private advanceCompensation(): void {
    const next = this.state.compensationQueue.shift();
    if (next === undefined) {
      this.revealAndStart();
      return;
    }
    const max = this.state.players[otherSeat(next)].mulligans;
    this.state.pending = this.newChoice('compensation-draw', next, {
      min: 0,
      max,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
    });
  }

  private resolveCompensation(seat: MatchSeat, draw: number): void {
    if (this.state.phase !== 'compensation') {
      throw new MatchEngineError('illegal-choice', '当前不是补抽阶段。');
    }
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'compensation-draw') {
      throw new MatchEngineError('choice-pending', '当前没有补抽选择。');
    }
    if (!Number.isInteger(draw) || draw < pending.min || draw > pending.max) {
      throw new MatchEngineError('illegal-choice', `补抽张数必须在 ${pending.min}..${pending.max} 之间。`);
    }
    const player = this.state.players[seat];
    if (draw > player.deck.length) {
      throw new MatchEngineError('illegal-choice', '牌库剩余卡牌不足，无法补抽。');
    }
    const drawnCount = draw;
    const startIndex = player.hand.length;
    if (drawnCount > 0) {
      player.hand.push(...player.deck.splice(0, drawnCount));
    }
    this.pushEvent({ type: 'compensation-declared', seat, count: drawnCount });
    const drawnBasics = player.hand
      .map((card, index) => ({ card, index }))
      .slice(startIndex)
      .filter((entry) => hasBasicPokemon([entry.card], this.cardsById))
      .map((entry) => entry.index);
    const benchSpace = 5 - player.bench.length;
    if (drawnBasics.length > 0 && benchSpace > 0) {
      const max = Math.min(drawnBasics.length, benchSpace);
      this.state.pending = this.newChoice('compensation-bench', seat, {
        min: 0,
        max,
        benchMin: 0,
        benchMax: max,
        candidates: drawnBasics,
      });
      return;
    }
    this.advanceCompensation();
  }

  private placeCompensationBench(seat: MatchSeat, bench: readonly number[]): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'compensation-bench') {
      throw new MatchEngineError('choice-pending', '当前没有补抽后的备战放置选择。');
    }
    if (bench.length > pending.benchMax || bench.length < pending.benchMin) {
      throw new MatchEngineError('illegal-choice', `补抽后的备战放置张数必须在 ${pending.benchMin}..${pending.benchMax} 之间。`);
    }
    const candidates = new Set(pending.candidates);
    const seen = new Set<number>();
    for (const index of bench) {
      if (!Number.isInteger(index) || !candidates.has(index)) {
        throw new MatchEngineError('illegal-choice', '只能选择本次补抽得到的基础宝可梦。');
      }
      if (seen.has(index)) {
        throw new MatchEngineError('illegal-choice', '同一张手牌不能被重复放置。');
      }
      seen.add(index);
      const card = this.state.players[seat].hand[index] as CardInstance;
      if (!hasBasicPokemon([card], this.cardsById)) {
        throw new MatchEngineError('illegal-choice', '备战区只能放置基础宝可梦。');
      }
    }
    const player = this.state.players[seat];
    const selected = bench.map((index) => player.hand[index] as CardInstance);
    player.hand = player.hand.filter((_card, index) => !seen.has(index));
    player.bench.push(...selected);
    this.pushEvent({ type: 'compensation-benched', seat, count: selected.length });
    this.advanceCompensation();
  }

  private revealAndStart(): void {
    const first = this.state.firstSeat;
    if (first === null) {
      throw new MatchEngineError('illegal-choice', '先后攻尚未确定，不能开始对局。');
    }
    this.state.phase = 'playing';
    this.state.pending = null;
    for (const seat of [0, 1] as const) {
      const player = this.state.players[seat];
      const active = player.active;
      if (active === null) {
        throw new MatchEngineError('illegal-choice', '初始战斗宝可梦尚未放置。');
      }
      this.pushEvent({
        type: 'setup-revealed',
        seat,
        active: this.cardView(active),
        bench: player.bench.map((card) => this.cardView(card)),
      });
    }
    this.startFirstTurn(first);
  }

  /** 双方公开翻面后进入唯一首回合；首回合玩家按规则先抽 1 张。 */
  private startFirstTurn(first: MatchSeat): void {
    this.state.turn = 1;
    this.state.activeSeat = first;
    if (this.state.events.some((event) => event.type === 'turn-started')) {
      throw new MatchEngineError('illegal-choice', '首回合已经开始。');
    }
    const player = this.state.players[first];
    if (player.deck.length === 0) {
      throw new MatchEngineError('illegal-choice', '首回合开始时牌库为空。');
    }
    const drawn = player.deck.shift() as CardInstance;
    player.hand.push(drawn);
    this.pushEvent({ type: 'turn-started', seat: first, turn: 1 });
  }
}

function commandKind(command: MatchClientMessage): PendingChoice['kind'] {
  switch (command.type) {
    case 'choose-turn-order':
      return 'turn-order';
    case 'place-setup':
      return 'place-setup';
    case 'resolve-compensation':
      return 'compensation-draw';
    case 'place-compensation-bench':
      return 'compensation-bench';
  }
}

/* ------------------------------------------------------------------ */
/* 会话：认证座位 + 每座位命令去重                                       */
/* ------------------------------------------------------------------ */

export interface MatchSeatHandle {
  readonly seat: MatchSeat;
  readonly token: string;
}

export type MatchSubmitResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly version: number; readonly view: MatchView }
  | { readonly ok: false; readonly code: MatchErrorCode; readonly message: string; readonly version: number; readonly view: MatchView };

interface DedupEntry {
  readonly fingerprint: string;
  readonly result: Extract<MatchSubmitResult, { ok: true }>;
}

export interface MatchSessionConfig extends OpeningEngineConfig {}

/**
 * 对局会话：把引擎包在「认证座位 + 命令 ID 去重 + 版本校验」里。
 *
 * 命令 ID 的作用域是座位：一个座位的重复 ID 不会拿到另一个座位的结果或
 * 私人视图。会话不接触网络，房间注册表负责按授权座位收发。
 */
export class MatchSession {
  public readonly sessionId: string;
  private readonly engine: OpeningEngine;
  private readonly seats: readonly [MatchSeatHandle, MatchSeatHandle];
  private readonly dedup: readonly [Map<string, DedupEntry>, Map<string, DedupEntry>] = [new Map(), new Map()];

  public constructor(config: MatchSessionConfig) {
    this.sessionId = config.sessionId;
    this.engine = new OpeningEngine(config);
    this.seats = [
      { seat: 0, token: randomUUID() },
      { seat: 1, token: randomUUID() },
    ];
  }

  public get version(): number {
    return this.engine.version;
  }

  public handleFor(seat: MatchSeat): MatchSeatHandle {
    return this.seats[seat];
  }

  public isValidHandle(handle: MatchSeatHandle): boolean {
    if (handle === null || typeof handle !== 'object' || typeof handle.token !== 'string') {
      return false;
    }
    if (handle.seat !== 0 && handle.seat !== 1) {
      return false;
    }
    return this.seats[handle.seat].token === handle.token;
  }

  public viewFor(handle: MatchSeatHandle): MatchView {
    if (!this.isValidHandle(handle)) {
      throw new MatchEngineError('not-in-match', '这个座位句柄不属于本局。');
    }
    return this.engine.viewFor(handle.seat);
  }

  /** 按已认证座位提交；返回的视图只属于该座位。 */
  public submit(handle: MatchSeatHandle, command: MatchClientMessage): MatchSubmitResult {
    if (!this.isValidHandle(handle)) {
      return {
        ok: false,
        code: 'not-in-match',
        message: '这个座位句柄不属于本局。',
        version: this.engine.version,
        view: this.engine.viewFor(handle.seat === 0 || handle.seat === 1 ? handle.seat : 0),
      };
    }
    const seat = handle.seat;
    const seatDedup = this.dedup[seat];
    const existing = seatDedup.get(command.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== commandFingerprint(command)) {
        return {
          ok: false,
          code: 'command-id-reused',
          message: `命令 ID ${command.commandId} 已用于不同的请求。`,
          version: this.engine.version,
          view: this.engine.viewFor(seat),
        };
      }
      return { ...existing.result, duplicate: true };
    }
    if (command.sessionId !== this.sessionId) {
      return {
        ok: false,
        code: 'match-not-found',
        message: '这条命令指向的对局会话不存在。',
        version: this.engine.version,
        view: this.engine.viewFor(seat),
      };
    }
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion !== this.engine.version) {
      return {
        ok: false,
        code: 'stale-version',
        message: `对局状态已更新到版本 ${this.engine.version}，这条命令基于版本 ${command.expectedVersion}，未生效。`,
        version: this.engine.version,
        view: this.engine.viewFor(seat),
      };
    }
    try {
      this.engine.execute(seat, command);
    } catch (error) {
      if (error instanceof MatchEngineError) {
        return { ok: false, code: error.code, message: error.message, version: this.engine.version, view: this.engine.viewFor(seat) };
      }
      throw error;
    }
    const result: Extract<MatchSubmitResult, { ok: true }> = {
      ok: true,
      duplicate: false,
      version: this.engine.version,
      view: this.engine.viewFor(seat),
    };
    seatDedup.set(command.commandId, { fingerprint: commandFingerprint(command), result });
    return result;
  }
}

function commandFingerprint(command: MatchClientMessage): string {
  const copy: Record<string, unknown> = { ...command };
  delete copy['commandId'];
  return stableJson(copy);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
