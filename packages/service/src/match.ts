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
 *   1. 服务端随机决定先后攻选择权（`RandomSource`，正式服为 Node crypto；
 *      客户端不能提交种子或牌序）。
 *   2. 获选玩家明确选择先攻/后攻。
 *   3. 洗牌、发 7 张手牌。
 *   4. 无基础宝可梦时按 G5 处理：只有一方没有时必须等对手先完成到 7.
 *      （对手的战斗/备战选择与奖赏卡）后，才展示手牌并只重洗该方（5.c.–5.d.）；
 *      双方都没有时互相展示后共同重洗重抽（5.a.），共同重洗不算 5.d.。
 *   5. 双方盖放 1 张战斗宝可梦与最多 5 张基础备战宝可梦。
 *   6. 各放置 6 张奖赏卡。
 *   7. 对手每执行过一次 5.d.，己方可选补抽 0..N 张；G6 允许在对战开始前把
 *      手牌中剩余的基础宝可梦随时盖放到备战区（含补抽到的）。
 *   8. 公开翻面并进入唯一首回合（首回合玩家先抽 1 张）。
 *
 * 规则依据（冻结证据）：
 *   - 官方《进阶玩家向规则指南》Ver 3.1.0 G「对战准备」（5.a.–5.d. 重抽、
 *     6. 备战放置、7. 奖赏卡与按对手 5.d. 次数的补抽）。
 *   - 补抽上限只统计对手单独重抽次数（总重抽次数 − 共同重洗次数），共同重洗
 *     不执行 5.d.，不作为任何一方的补抽依据。
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
  prizesPlaced: boolean;
  /** 公开的重抽总次数（共同重洗 + 单独重抽）。 */
  mulligans: number;
  /** 单独重抽（执行 5.d.）次数；对手的补抽上限只依据它。 */
  soloMulligans: number;
}

interface PendingChoice {
  readonly kind: 'turn-order' | 'place-setup' | 'compensation-draw' | 'place-bench';
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
        prizesPlaced: false,
        mulligans: 0,
        soloMulligans: 0,
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
      case 'place-bench':
        this.placeBench(seat, command.bench);
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
      soloMulligans: player.soloMulligans,
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
    this.continueSetup();
  }

  /** G4：双方各从牌库顶抽 7 张；洗牌随机只来自服务端随机源。 */
  private dealOpeningHands(): void {
    for (const seat of [0, 1] as const) {
      this.shuffleDeck(seat);
      this.state.players[seat].hand = this.state.players[seat].deck.splice(0, 7);
    }
  }

  /**
   * G5/G6/G7 的确定性驱动：在没有待决选择时决定下一步。
   *
   * 顺序严格按冻结文本：
   *   - 双方都无基础宝可梦（5.a.）：互相展示后共同重洗重抽，不算 5.d.；
   *   - 只有一方无（5.a.–5.d.）：对手先前进至 7.（战斗/备战与奖赏卡），
   *     之后才展示无基础方的手牌并只重洗该方；重复时跳过 5.b.；
   *   - 双方都有：按先攻→后攻顺序盖放，然后双方放置奖赏卡。
   * 只有整体流程推进到补抽阶段时才创建补抽/最终备战选择。
   */
  private continueSetup(): void {
    for (;;) {
      const lacking = this.seatsWithoutBasic();
      if (lacking.length === 2) {
        this.jointMulligan();
        continue;
      }
      if (lacking.length === 1) {
        const seat = lacking[0] as MatchSeat;
        const opponent = otherSeat(seat);
        const opponentState = this.state.players[opponent];
        if (!(opponentState.setupPlaced && opponentState.prizesPlaced)) {
          if (!opponentState.setupPlaced) {
            // 5.b.：对手先前进至 7.；此处先让对手完成战斗/备战盖放，
            // 完成后继续由本驱动放置对手奖赏卡。
            this.state.pending = this.newChoice('place-setup', opponent, this.placeSetupFields(opponent));
            return;
          }
          this.placePrizes(opponent);
        }
        // 5.c.–5.d.：对手已经到 7.，现在才展示并只重洗本座位，直到有基础宝可梦。
        while (!this.hasBasic(seat)) {
          this.soloMulligan(seat);
        }
        this.state.pending = this.newChoice('place-setup', seat, this.placeSetupFields(seat));
        return;
      }
      // 双方都有基础宝可梦：按先攻→后攻顺序盖放。
      for (const seat of this.placementOrder()) {
        if (!this.state.players[seat].setupPlaced) {
          this.state.pending = this.newChoice('place-setup', seat, this.placeSetupFields(seat));
          return;
        }
      }
      for (const seat of [0, 1] as const) {
        if (!this.state.players[seat].prizesPlaced) {
          this.placePrizes(seat);
        }
      }
      this.beginCompensation();
      return;
    }
  }

  /** 5.a. 双方都没有基础宝可梦：互相展示后共同重洗重抽，不计入任何一方的 5.d.。 */
  private jointMulligan(): void {
    for (const seat of [0, 1] as const) {
      this.state.players[seat].mulligans += 1;
    }
    for (const seat of [0, 1] as const) {
      const player = this.state.players[seat];
      this.pushEvent({
        type: 'mulligan',
        seat,
        count: player.mulligans,
        shared: true,
        cards: player.hand.map((card) => this.cardView(card)),
      });
    }
    for (const seat of [0, 1] as const) {
      const player = this.state.players[seat];
      player.deck.push(...player.hand);
      player.hand = [];
      this.shuffleDeck(seat);
      player.hand = player.deck.splice(0, 7);
    }
  }

  /** 5.c.–5.d. 单方重抽：向对手展示当前手牌，放回牌库重洗重抽。 */
  private soloMulligan(seat: MatchSeat): void {
    const player = this.state.players[seat];
    player.mulligans += 1;
    player.soloMulligans += 1;
    this.pushEvent({
      type: 'mulligan',
      seat,
      count: player.mulligans,
      shared: false,
      cards: player.hand.map((card) => this.cardView(card)),
    });
    player.deck.push(...player.hand);
    player.hand = [];
    this.shuffleDeck(seat);
    player.hand = player.deck.splice(0, 7);
  }

  /**
   * 尚未盖放战斗宝可梦、手牌中没有基础宝可梦的座位（G5 的「没有」声明对象）。
   * 已经盖放过的座位不再参与声明，无论剩余手牌里还有什么。
   */
  private seatsWithoutBasic(): MatchSeat[] {
    const lacking: MatchSeat[] = [];
    for (const seat of [0, 1] as const) {
      const player = this.state.players[seat];
      if (!player.setupPlaced && !hasBasicPokemon(player.hand, this.cardsById)) {
        lacking.push(seat);
      }
    }
    return lacking;
  }

  private hasBasic(seat: MatchSeat): boolean {
    return hasBasicPokemon(this.state.players[seat].hand, this.cardsById);
  }

  /** G5 的顺序：先攻玩家 → 后攻玩家。 */
  private placementOrder(): [MatchSeat, MatchSeat] {
    const first = this.state.firstSeat;
    if (first === null) {
      throw new MatchEngineError('illegal-choice', '先后攻尚未确定，不能开始初始放置。');
    }
    return [first, otherSeat(first)];
  }

  private placeSetupFields(seat: MatchSeat): {
    readonly min: number;
    readonly max: number;
    readonly benchMin: number;
    readonly benchMax: number;
    readonly candidates: readonly number[];
  } {
    return { min: 1, max: 1, benchMin: 0, benchMax: 5, candidates: this.basicHandIndices(seat) };
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
    this.continueSetup();
  }

  /** G7：双方各从牌库顶取 6 张奖赏卡；奖赏身份只保留在服务端。 */
  private placePrizes(seat: MatchSeat): void {
    const player = this.state.players[seat];
    if (player.prizesPlaced) {
      return;
    }
    player.prizes = player.deck.splice(0, 6);
    player.prizesPlaced = true;
    this.pushEvent({ type: 'prizes-placed', seat });
  }

  private beginCompensation(): void {
    this.state.phase = 'compensation';
    this.state.compensationQueue = [0, 1];
    this.advanceCompensation();
  }

  private advanceCompensation(): void {
    const next = this.state.compensationQueue.shift();
    if (next === undefined) {
      this.revealAndStart();
      return;
    }
    // 补抽上限 = 对手执行过的 5.d. 次数（对手单独重抽次数）；共同重洗（5.a.）
    // 增加的是双方的总重抽次数，不计入任何一方的补抽依据。
    const max = this.state.players[otherSeat(next)].soloMulligans;
    if (max > 0) {
      this.state.pending = this.newChoice('compensation-draw', next, {
        min: 0,
        max,
        benchMin: 0,
        benchMax: 0,
        candidates: [],
      });
      return;
    }
    this.offerFinalBench(next);
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
    if (draw > 0) {
      player.hand.push(...player.deck.splice(0, draw));
    }
    this.pushEvent({ type: 'compensation-declared', seat, count: draw });
    this.offerFinalBench(seat);
  }

  /**
   * G6：只要对战还没开始，手牌中剩余的基础宝可梦都可以盖放到备战区，
   * 包括零补抽与补抽得到的基础宝可梦；备战上限 5，战斗宝可梦不变。
   */
  private offerFinalBench(seat: MatchSeat): void {
    const player = this.state.players[seat];
    const candidates = this.basicHandIndices(seat);
    const benchSpace = 5 - player.bench.length;
    if (candidates.length === 0 || benchSpace <= 0) {
      this.advanceCompensation();
      return;
    }
    const max = Math.min(candidates.length, benchSpace);
    this.state.pending = this.newChoice('place-bench', seat, {
      min: 0,
      max,
      benchMin: 0,
      benchMax: max,
      candidates,
    });
  }

  private placeBench(seat: MatchSeat, bench: readonly number[]): void {
    if (this.state.phase !== 'compensation') {
      throw new MatchEngineError('illegal-choice', '当前不是备战放置阶段。');
    }
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'place-bench') {
      throw new MatchEngineError('choice-pending', '当前没有备战放置选择。');
    }
    if (bench.length > pending.benchMax || bench.length < pending.benchMin) {
      throw new MatchEngineError('illegal-choice', `备战放置张数必须在 ${pending.benchMin}..${pending.benchMax} 之间。`);
    }
    const candidates = new Set(pending.candidates);
    const seen = new Set<number>();
    for (const index of bench) {
      if (!Number.isInteger(index) || !candidates.has(index)) {
        throw new MatchEngineError('illegal-choice', '只能选择当前手牌中的基础宝可梦。');
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
    this.pushEvent({ type: 'bench-placed', seat, count: selected.length });
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
    case 'place-bench':
      return 'place-bench';
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
  | {
      readonly ok: false;
      readonly code: MatchErrorCode;
      readonly message: string;
      readonly version: number;
      /**
       * 只在一开始就持有合法座位句柄的失败中回传；
       * 未认证句柄的失败绝不回传任何私人视图（不知座位时就无从投影）。
       */
      readonly view?: MatchView;
    };

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

  public isValidHandle(handle: unknown): handle is MatchSeatHandle {
    if (handle === null || typeof handle !== 'object') {
      return false;
    }
    const candidate = handle as { readonly seat?: unknown; readonly token?: unknown };
    if (candidate.seat !== 0 && candidate.seat !== 1) {
      return false;
    }
    return typeof candidate.token === 'string' && this.seats[candidate.seat].token === candidate.token;
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
      // 未认证句柄：不解析座位、不投影任何视图，避免伪造/缺失凭据拿到手牌。
      return {
        ok: false,
        code: 'not-in-match',
        message: '这个座位句柄不属于本局。',
        version: this.engine.version,
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
