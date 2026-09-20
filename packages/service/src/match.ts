import { randomInt, randomUUID } from 'node:crypto';
import type {
  CatalogAttack,
  CatalogCard,
  CatalogContent,
  DeckDocument,
  MatchAttackView,
  MatchCardView,
  MatchClientMessage,
  MatchErrorCode,
  MatchFinishReason,
  MatchPendingChoiceKind,
  MatchPendingChoiceView,
  MatchPhase,
  MatchPokemonRef,
  MatchPokemonView,
  MatchPublicEvent,
  MatchResultCondition,
  MatchResultView,
  MatchSeat,
  MatchSideView,
  MatchTurnCommand,
  MatchView,
  MatchWinCondition,
  SpecialConditionKind,
} from '@ptcg/protocol';

/**
 * 对局引擎（T07 / #8 开局 + T08 / #9 真实回合）。
 *
 * 开局：服务端随机决定先后攻选择权（`RandomSource`，正式服为 Node crypto；客户端
 * 不能提交种子或牌序）；洗牌、7 张手牌；无基础宝可梦时按冻结 G5 处理（单方 5.b.–5.d.、
 * 双方同时 5.a. 共同重洗不计 5.d.）；盖放战斗/备战；各 6 张奖赏卡；按对手单独重抽
 * 次数的可选补抽与对战前备战（G6）；公开翻面后进入唯一首回合。
 *
 * 回合（冻结 basic_rules05 / 进阶指南 A、C）：
 *   1. 回合开始必须从牌库顶抽 1 张；牌库为空时无法抽卡（完整胜负由后续票结算）。
 *   2. 自由动作：基础宝可梦进备战区（上限 5，任意只）、每回合至多附着 1 张能量、
 *      每回合至多撤退 1 次（支付所选撤退能量并以 1 只备战宝可梦交换）。
 *   3. 使用招式结束回合；先攻玩家在自己的最初回合不能使用招式。
 *   4. 伤害按「基础伤害 → 造成伤害方附加效果 → 弱点（倍增）→ 抵抗（减少）→
 *      受到伤害方附加效果 → 最终伤害」计算；“造成伤害”与“放置伤害指示物”是两种
 *      不同结算：放置伤害指示物不计算弱点/抵抗与附加效果。
 *
 * 所有隐藏区域（对手手牌、双方牌库顺序、奖赏卡身份）只以张数或本人视图投影；
 * 内部卡牌实例 ID 永不序列化。待决选择带 `choiceId`、座位与版本：越权、非法
 * 数量、重复回答及旧选择 ID 都不会改变状态。回合命令按「当前回合玩家 + 对局
 * 版本」串行裁决，任何失败都不修改状态。
 *
 * 卡牌效果例外通过 `attackEffects`（会话级行为接口）注册；未注册的带说明文
 * 招式一律以 `unsupported-card` 拒绝，不做近似结算。发行目录中不注册任何效果。
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

/** 场上一只宝可梦；伤害、能量与特殊状态是公开状态，效果标记留给后续卡牌例外。 */
interface PokemonState {
  /** 持有者座位；特殊状态恢复时机与昏厥条件需要知道归属。 */
  readonly seat: MatchSeat;
  readonly card: CardInstance;
  /** 已放置的伤害指示物数量（每个 10 点）。 */
  damageCounters: number;
  /** 附着能量；序号与视图中的 `energyIndex` 一致。 */
  energies: CardInstance[];
  /** 宝可梦道具等附加卡；当前仅作为后续接口占位。 */
  readonly tools: CardInstance[];
  /** 公开的特殊状态；睡眠/麻痹/混乱互斥，中毒/灼伤可叠加。 */
  readonly statuses: Set<SpecialCondition>;
  /** 麻痹恢复到期的回合编号（该回合结束后的宝可梦检查恢复）；未麻痹为 null。 */
  paralysisRecoversAfterTurn: number | null;
  /** 进入场上的回合编号（开局盖放为 0）；进化限制等后续规则使用。 */
  enteredTurn: number;
  /** 受到“无法撤退”效果时为 true（后续卡牌例外接口）。 */
  cannotRetreat: boolean;
  /** 受到“无法使用招式”效果时为 true（后续卡牌例外接口）。 */
  attackLocked: boolean;
}

interface PlayerState {
  readonly seat: MatchSeat;
  readonly nickname: string;
  deck: CardInstance[];
  hand: CardInstance[];
  prizes: CardInstance[];
  discard: CardInstance[];
  active: PokemonState | null;
  bench: PokemonState[];
  setupPlaced: boolean;
  prizesPlaced: boolean;
  /** 公开的重抽总次数（共同重洗 + 单独重抽）。 */
  mulligans: number;
  /** 单独重抽（执行 5.d.）次数；对手的补抽上限只依据它。 */
  soloMulligans: number;
  /** 本回合是否已经附着过能量。 */
  energyAttachedThisTurn: boolean;
  /** 本回合是否已经撤退过。 */
  retreatedThisTurn: boolean;
}

interface PendingChoice {
  readonly kind: MatchPendingChoiceKind;
  readonly seat: MatchSeat;
  readonly choiceId: string;
  readonly min: number;
  readonly max: number;
  readonly benchMin: number;
  readonly benchMax: number;
  readonly candidates: readonly number[];
}

/**
 * 招式效果例外接口：只有注册了行为的带说明文招式才会被引擎执行。
 * 未注册说明文的招式（`text === null` 且有固定伤害数字）走基础伤害结算。
 *
 * 特殊状态、无法撤退/无法使用招式等只提供状态接口；胜负、检查与恢复时机
 * 属于后续票据，当前不会自动清除（撤退本身会清除这些标记）。
 */
export type SpecialCondition = SpecialConditionKind;

export interface AttackEffectContext {
  readonly seat: MatchSeat;
  readonly defenderSeat: MatchSeat;
  /** 基础伤害经过弱点/抵抗后的最终伤害（点数；未到 0 即为正数）。 */
  readonly finalDamage: number;
  /** 把当前招式的基础伤害作为伤害放置（经过弱点/抵抗）。 */
  dealDamage(): void;
  /** 直接放置伤害指示物：不经过弱点/抵抗与附加效果。 */
  placeDamageCounters(targetSeat: MatchSeat, target: MatchPokemonRef, count: number): void;
  /** 后续卡牌例外接口：施加/清除“无法撤退”。 */
  setCannotRetreat(targetSeat: MatchSeat, target: MatchPokemonRef, locked: boolean): void;
  /** 后续卡牌例外接口：施加/清除“无法使用招式”。 */
  setAttackLocked(targetSeat: MatchSeat, target: MatchPokemonRef, locked: boolean): void;
  /** 后续卡牌例外接口：让目标进入特殊状态（检查与恢复时机由后续票实现）。 */
  addSpecialCondition(targetSeat: MatchSeat, target: MatchPokemonRef, condition: SpecialCondition): void;
  /**
   * 一般效果抽牌：牌库不足时按剩余张数抽完，抽空本身不构成败北；
   * 只有“自己回合最初无法从牌库抽取卡牌”才判败（冻结 E）。
   */
  drawCards(count: number): void;
}

export type AttackEffectResolver = (context: AttackEffectContext) => void;

/**
 * 招式效果回调只能登记这些纯数据操作；引擎在回调全部返回且所有输入校验通过后
 * 才按顺序应用，因此任一登记失败都会让整条命令保持原状（原子）。
 */
type StagedAttackOperation =
  | { readonly kind: 'damage'; readonly targetSeat: MatchSeat; readonly target: PokemonState; readonly damage: number }
  | { readonly kind: 'cannot-retreat'; readonly target: PokemonState; readonly locked: boolean }
  | { readonly kind: 'attack-locked'; readonly target: PokemonState; readonly locked: boolean }
  | { readonly kind: 'special-condition'; readonly target: PokemonState; readonly condition: SpecialCondition }
  | { readonly kind: 'draw'; readonly seat: MatchSeat; readonly count: number };

/**
 * 效果接口的指示物数量必须是正整数，且换算成点数后仍可安全表示；
 * 在登记阶段就拒绝（而不是应用阶段），避免留下部分状态。
 */
function damageForCounters(count: number): number {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new MatchEngineError('illegal-choice', `伤害指示物数量 ${count} 必须是正整数。`);
  }
  const damage = count * 10;
  if (!Number.isSafeInteger(damage)) {
    throw new MatchEngineError('illegal-choice', `伤害指示物数量 ${count} 超出可安全表示的范围。`);
  }
  return damage;
}

/** 效果注册键：效果身份 + 招式名；发行目录不注册任何键。 */
export function attackEffectKey(effectIdentity: string, attackName: string): string {
  return `${effectIdentity}#${attackName}`;
}

/** 一轮昏厥结算中待执行的动作：先取奖赏卡，再补充战斗宝可梦。 */
type SettlementAction =
  | { readonly kind: 'take-prizes'; readonly seat: MatchSeat; readonly needed: number }
  | { readonly kind: 'replace'; readonly seat: MatchSeat };

interface SettlementState {
  readonly actions: SettlementAction[];
  /** 结算完成且未终局时继续的流程。 */
  readonly after: 'end-turn' | 'start-next-turn';
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
  /** 当前回合开始时牌库为空；对局已按回合开始抽空判定为唯一终态。 */
  cannotDraw: boolean;
  /** 唯一权威终态；产生后拒绝任何继续操作。 */
  result: MatchResultView | null;
  /** 进行中的昏厥结算（含取奖赏卡与补充战斗宝可梦的待决选择）。 */
  settlement: SettlementState | null;
  /** 本次昏厥结算中“没有能放于战斗场的宝可梦”条件。 */
  readonly noPokemonCondition: [boolean, boolean];
  readonly attackEffects: ReadonlyMap<string, AttackEffectResolver>;
  players: [PlayerState, PlayerState];
}

export interface MatchEngineConfig {
  readonly sessionId: string;
  readonly decks: readonly [DeckDocument, DeckDocument];
  readonly nicknames: readonly [string, string];
  readonly catalog: CatalogContent;
  readonly random: RandomSource;
  /**
   * 卡牌效果例外注册表；仅测试和后续逐卡接入使用。
   * 发行构建不注册任何效果，带说明文的招式会被 `unsupported-card` 拒绝。
   */
  readonly attackEffects?: ReadonlyMap<string, AttackEffectResolver>;
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

function isBasicEnergy(definition: CatalogCard): boolean {
  return definition.cardClass === 'energy' && definition.effectiveCategory === '基本能量';
}

/** 招式印刷伤害为固定数字（如 `60`）时才可由基础伤害结算处理。 */
export function parseBaseDamage(damageText: string | null): number | null {
  if (damageText === null) {
    return null;
  }
  const match = /^(\d+)$/u.exec(damageText.trim());
  if (match === null) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * 昏厥时对手拿取的奖赏卡张数。
 *
 * 冻结卡面规则文字直接写明（`ex=2`、`V=2`、`VSTAR=2`、`VMAX=3`）；
 * 未写明的卡默认为 1 张。仅解析卡面规则文本，不从卡名猜测。
 */
export function prizeValueOf(definition: CatalogCard): number {
  const text = definition.specialRuleTextZh;
  if (text === null) {
    return 1;
  }
  const match = /拿取\s*(\d+)\s*张奖赏卡/u.exec(text);
  if (match === null) {
    return 1;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

interface BattleModifier {
  readonly type: string;
  /** 弱点倍增系数。 */
  readonly factor: number;
  /** 抵抗减少数值。 */
  readonly amount: number;
}

/** 解析弱点（`钢×2`）与抵抗（`斗-30`）；未知格式返回 null（不生效）。 */
export function parseBattleModifier(text: string | null): BattleModifier | null {
  if (text === null) {
    return null;
  }
  const match = /^(.+?)(?:×(\d+)|-(\d+))$/u.exec(text.trim());
  if (match === null) {
    return null;
  }
  const type = match[1] as string;
  if (match[2] !== undefined) {
    const factor = Number(match[2]);
    return Number.isSafeInteger(factor) && factor > 0 ? { type, factor, amount: 0 } : null;
  }
  const amount = Number(match[3]);
  return Number.isSafeInteger(amount) && amount > 0 ? { type, factor: 1, amount } : null;
}

/**
 * 冻结 Ver 3.1.0 E「同时满足胜负条件时的判定」判定表。
 *
 * 四项条件：自己拿取所有奖赏卡（对手败北）、对手拿取所有奖赏卡（自己败北）、
 * 自己没有能放于战斗场的宝可梦（自己败北）、对手没有能放于战斗场的宝可梦
 * （对手败北）。把各条件换算为有利于各方的票数：票多者获胜，相等为平局。
 * 判定表（●=成立；行顺序与官方表一致）：
 *   ●     ●   → 平局；  ● ●     → 平局；  ● ● ● ● → 平局；
 *   ●   ●     → 平局；    ● ●   → 平局；
 *   ● ●   ● → 自己获胜；●   ● ● → 自己获胜；●     ● → 自己获胜；
 *   ● ● ●   → 自己败北；  ● ● ● → 自己败北；  ● ●   → 自己败北。
 * 没有任何条件时返回 null；不采用 first-match 分支。
 */
export function judgeWinConditions(
  prizeDone: readonly [boolean, boolean],
  noPokemon: readonly [boolean, boolean],
): { readonly winner: MatchSeat | null; readonly reason: MatchFinishReason; readonly conditions: readonly MatchResultCondition[] } | null {
  const conditions: MatchResultCondition[] = [];
  if (prizeDone[0]) {
    conditions.push({ seat: 0, condition: 'prizes' });
  }
  if (prizeDone[1]) {
    conditions.push({ seat: 1, condition: 'prizes' });
  }
  if (noPokemon[0]) {
    conditions.push({ seat: 0, condition: 'no-pokemon' });
  }
  if (noPokemon[1]) {
    conditions.push({ seat: 1, condition: 'no-pokemon' });
  }
  if (conditions.length === 0) {
    return null;
  }
  const selfWins = (prizeDone[0] ? 1 : 0) + (noPokemon[1] ? 1 : 0);
  const opponentWins = (prizeDone[1] ? 1 : 0) + (noPokemon[0] ? 1 : 0);
  if (selfWins === opponentWins) {
    return { winner: null, reason: 'simultaneous', conditions };
  }
  const winner: MatchSeat = selfWins > opponentWins ? 0 : 1;
  const loser = otherSeat(winner);
  // 原因优先用获胜方自己的取胜条件；否再用败北方“无法补充战斗宝可梦”。
  let reason: MatchFinishReason = 'prizes';
  if (conditions.some((entry) => entry.seat === winner && entry.condition === 'prizes')) {
    reason = 'prizes';
  } else if (conditions.some((entry) => entry.seat === loser && entry.condition === 'no-pokemon')) {
    reason = 'no-pokemon';
  }
  return { winner, reason, conditions };
}

/**
 * 基础伤害计算顺序（冻结伤害计算步骤 1–4）：
 * 基础伤害 → 弱点（倍增）→ 抵抗（减少）。最终为 0 或负数时不放置伤害指示物。
 */
export function calculateDamage(
  baseDamage: number,
  attackerType: string | null,
  weakness: string | null,
  resistance: string | null,
): number {
  let damage = baseDamage;
  const weak = parseBattleModifier(weakness);
  if (weak !== null && attackerType !== null && weak.type === attackerType) {
    damage *= weak.factor;
  }
  const resist = parseBattleModifier(resistance);
  if (resist !== null && attackerType !== null && resist.type === attackerType) {
    damage -= resist.amount;
  }
  return Math.max(0, damage);
}

function attackHasEffectText(attack: CatalogAttack): boolean {
  return attack.text !== null && attack.text.trim().length > 0;
}

function isBasicDamageAttack(attack: CatalogAttack): boolean {
  return !attackHasEffectText(attack) && parseBaseDamage(attack.damage) !== null;
}

/**
 * 招式费用是否可由身上能量支付：同属性符号必须由同属性能量满足，
 * `无`（无色）由剩余任意能量满足。费用是使用条件，不会因使用招式而弃置能量。
 */
export function energyCoversCost(cost: readonly string[], energyTypes: readonly (string | null)[]): boolean {
  const pool = new Map<string, number>();
  let any = 0;
  for (const type of energyTypes) {
    const key = type ?? '无';
    pool.set(key, (pool.get(key) ?? 0) + 1);
    any += 1;
  }
  let colorless = 0;
  for (const symbol of cost) {
    if (symbol === '无') {
      colorless += 1;
      continue;
    }
    const available = pool.get(symbol) ?? 0;
    if (available <= 0) {
      return false;
    }
    pool.set(symbol, available - 1);
    any -= 1;
  }
  return any >= colorless;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PublicEventInput = DistributiveOmit<MatchPublicEvent, 'seq'>;

const CHOICE_TYPES = new Set([
  'choose-turn-order',
  'place-setup',
  'resolve-compensation',
  'place-bench',
  'take-prizes',
  'choose-replacement',
]);

function isChoiceCommand(command: MatchClientMessage): boolean {
  return CHOICE_TYPES.has(command.type);
}

/**
 * 对局引擎。所有公开验证先于任何状态修改；每条成功命令只递增一次版本。
 */
export class MatchEngine {
  private readonly cardsById: ReadonlyMap<string, CatalogCard>;
  private readonly random: RandomSource;
  private readonly state: EngineState;

  public constructor(config: MatchEngineConfig) {
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
        energyAttachedThisTurn: false,
        retreatedThisTurn: false,
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
      cannotDraw: false,
      result: null,
      settlement: null,
      noPokemonCondition: [false, false],
      attackEffects: config.attackEffects ?? new Map(),
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

  /** 唯一权威终态；未结束时为 null。 */
  public get result(): MatchResultView | null {
    return this.state.result === null ? null : { ...this.state.result, conditions: this.state.result.conditions.map((entry) => ({ ...entry })) };
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
      cannotDraw: state.cannotDraw,
      result: this.result,
      events: state.events.map((event) => ({ ...event })),
    };
  }

  /**
   * 执行一条已通过会话层去重与版本校验的命令。所有验证先于状态修改；
   * 抛出的 `MatchEngineError` 表示本次命令未产生任何变化。
   */
  public execute(seat: MatchSeat, command: MatchClientMessage): void {
    if (this.state.result !== null) {
      throw new MatchEngineError('match-finished', '对局已经结束，不能再执行任何操作。');
    }
    if (command.type === 'concede') {
      this.concede(seat);
    } else if (isChoiceCommand(command)) {
      this.executeChoice(seat, command);
    } else {
      this.executeTurnCommand(seat, command as MatchTurnCommand);
    }
    this.state.version += 1;
  }

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

  private definitionOf(card: CardInstance): CatalogCard {
    const definition = this.cardsById.get(card.cardId);
    if (definition === undefined) {
      throw new MatchEngineError('illegal-choice', `目录中不存在卡牌 ${card.cardId}。`);
    }
    return definition;
  }

  private attackViewsFor(definition: CatalogCard): readonly MatchAttackView[] {
    return definition.attacks.map((attack, index) => ({
      index,
      name: attack.name,
      cost: [...attack.cost],
      damageText: attack.damage,
      effectTextZh: attack.text,
      supported: this.state.attackEffects.has(attackEffectKey(definition.identities.effectIdentity, attack.name)) || isBasicDamageAttack(attack),
    }));
  }

  private pokemonView(pokemon: PokemonState): MatchPokemonView {
    const definition = this.definitionOf(pokemon.card);
    return {
      card: this.cardView(pokemon.card),
      damageCounters: pokemon.damageCounters,
      statuses: [...pokemon.statuses],
      energies: pokemon.energies.map((energy, index) => ({ energyIndex: index, card: this.cardView(energy) })),
      attacks: this.attackViewsFor(definition),
      retreatCost: definition.retreat ?? 0,
      weakness: definition.weakness,
      resistance: definition.resistance,
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
      active: identitiesVisible && player.active !== null ? this.pokemonView(player.active) : null,
      bench: identitiesVisible ? player.bench.map((pokemon) => this.pokemonView(pokemon)) : [],
      setupPlaced: player.setupPlaced,
      mulligans: player.mulligans,
      soloMulligans: player.soloMulligans,
      revealed: identitiesVisible,
      energyAttachedThisTurn: player.energyAttachedThisTurn,
      retreatedThisTurn: player.retreatedThisTurn,
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
    player.active = this.newPokemon(seat, activeCard, 0);
    player.bench = benchCards.map((card) => this.newPokemon(seat, card, 0));
    player.setupPlaced = true;
    this.pushEvent({ type: 'setup-placed', seat });
    this.continueSetup();
  }

  private newPokemon(seat: MatchSeat, card: CardInstance, enteredTurn: number): PokemonState {
    return {
      seat,
      card,
      damageCounters: 0,
      energies: [],
      tools: [],
      statuses: new Set(),
      paralysisRecoversAfterTurn: null,
      enteredTurn,
      cannotRetreat: false,
      attackLocked: false,
    };
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
    player.bench.push(...selected.map((card) => this.newPokemon(seat, card, 0)));
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
        active: this.cardView(active.card),
        bench: player.bench.map((pokemon) => this.cardView(pokemon.card)),
      });
    }
    this.startTurn(first, 1);
  }

  /* ---------------- 待决选择 ---------------- */

  private executeChoice(seat: MatchSeat, command: MatchClientMessage): void {
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
    if ((command as { readonly choiceId: string }).choiceId !== pending.choiceId) {
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
      case 'take-prizes':
        this.takePrizes(seat, command.prizes);
        break;
      case 'choose-replacement':
        this.chooseReplacement(seat, command.benchIndex);
        break;
      default:
        throw new MatchEngineError('choice-pending', '这条命令不是待决选择命令。');
    }
  }

  /* ---------------- 回合 ---------------- */

  private executeTurnCommand(seat: MatchSeat, command: MatchTurnCommand): void {
    if (this.state.pending !== null) {
      throw new MatchEngineError('choice-pending', '必须先结算当前待决选择。');
    }
    if (this.state.phase !== 'playing') {
      throw new MatchEngineError('action-not-allowed', '对战尚未开始，不能执行回合动作。');
    }
    if (this.state.activeSeat !== seat) {
      throw new MatchEngineError('not-your-turn', '当前是对手的回合。');
    }
    switch (command.type) {
      case 'play-basic':
        this.playBasic(seat, command.handIndex);
        break;
      case 'attach-energy':
        this.attachEnergy(seat, command.handIndex, command.target);
        break;
      case 'retreat':
        this.retreat(seat, command.energyIndices, command.benchIndex);
        break;
      case 'attack':
        this.attack(seat, command.attackIndex, command.target);
        break;
      case 'end-turn':
        this.endTurn();
        break;
    }
  }

  /** 把目标引用解析为自己的场上宝可梦；不合法时抛 `illegal-target`。 */
  private ownPokemonAt(seat: MatchSeat, ref: MatchPokemonRef): PokemonState {
    const player = this.state.players[seat];
    if (ref.slot === 'active') {
      if (player.active === null) {
        throw new MatchEngineError('illegal-target', '战斗场没有宝可梦。');
      }
      return player.active;
    }
    const target = player.bench[ref.index];
    if (target === undefined) {
      throw new MatchEngineError('illegal-target', '备战区没有这个位置的宝可梦。');
    }
    return target;
  }

  /** 回合 1 的先攻玩家不能使用招式（冻结 basic_rules05 3.b.）。 */
  private isFirstPlayersFirstTurn(seat: MatchSeat): boolean {
    return this.state.turn === 1 && this.state.firstSeat === seat && this.state.activeSeat === seat;
  }

  /**
   * 回合开始：递增/重置本回合标记后，必须从牌库顶抽 1 张。
   * 牌库为空时不抽，按冻结 E「回合最初无法从牌库抽取卡牌」判定唯一终态。
   */
  private startTurn(seat: MatchSeat, turn: number): void {
    this.state.turn = turn;
    this.state.activeSeat = seat;
    this.state.cannotDraw = false;
    // 每回合标记只属于当前回合：双方都在新回合开始重置，避免等待方显示旧标记。
    for (const player of this.state.players) {
      player.energyAttachedThisTurn = false;
      player.retreatedThisTurn = false;
    }
    const player = this.state.players[seat];
    this.pushEvent({ type: 'turn-started', seat, turn });
    if (player.deck.length === 0) {
      this.state.cannotDraw = true;
      this.pushEvent({ type: 'draw-blocked', seat, turn });
      // 只有“自己回合最初无法抽牌”才败北；一般效果抽空不在此处判定。
      this.finishMatch(otherSeat(seat), 'deck-out', [{ seat, condition: 'deck-out' }]);
      return;
    }
    const drawn = player.deck.shift() as CardInstance;
    player.hand.push(drawn);
    this.pushEvent({ type: 'card-drawn', seat, count: 1 });
  }

  /**
   * 不使用招式时主动结束回合：先执行宝可梦检查与检查末尾的昏厥确认，
   * 未终局时再轮到对手并开始其回合（含回合开始抽牌）。
   */
  private endTurn(): void {
    const seat = this.state.activeSeat;
    if (seat === null) {
      throw new MatchEngineError('action-not-allowed', '当前没有回合玩家。');
    }
    this.pushEvent({ type: 'turn-ended', seat, turn: this.state.turn });
    this.runPokemonCheckup();
    this.settleKnockOuts('start-next-turn');
  }

  /** A-04：基础宝可梦进备战区；只要不足 5 只，一回合可以放任意只。 */
  private playBasic(seat: MatchSeat, handIndex: number): void {
    const player = this.state.players[seat];
    if (player.bench.length >= 5) {
      throw new MatchEngineError('action-not-allowed', '备战区已满 5 只宝可梦。');
    }
    if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
      throw new MatchEngineError('illegal-target', '手牌序号无效。');
    }
    const card = player.hand[handIndex] as CardInstance;
    const definition = this.definitionOf(card);
    if (!(definition.cardClass === 'pokemon' && definition.subtypes.includes('基础'))) {
      throw new MatchEngineError('illegal-target', '只有基础宝可梦可以放入备战区。');
    }
    // 验证完成后再修改状态。
    player.hand = player.hand.filter((_card, index) => index !== handIndex);
    player.bench.push(this.newPokemon(seat, card, this.state.turn));
    this.pushEvent({ type: 'basic-placed', seat, card: this.cardView(card) });
  }

  /** C 能量：每个自己的回合能且仅能从手牌附着 1 张能量。 */
  private attachEnergy(seat: MatchSeat, handIndex: number, target: MatchPokemonRef): void {
    const player = this.state.players[seat];
    if (player.energyAttachedThisTurn) {
      throw new MatchEngineError('action-not-allowed', '每个回合只能附着 1 张能量。');
    }
    if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
      throw new MatchEngineError('illegal-target', '手牌序号无效。');
    }
    const card = player.hand[handIndex] as CardInstance;
    const definition = this.definitionOf(card);
    if (definition.cardClass !== 'energy') {
      throw new MatchEngineError('illegal-target', '只有能量卡可以附着。');
    }
    if (!isBasicEnergy(definition)) {
      throw new MatchEngineError('unsupported-card', `${definition.nameZh} 的效果尚未接入，不能附着。`);
    }
    // 目标必须在附着前解析成功：无效目标不能消耗本回合的附能次数。
    const pokemon = this.ownPokemonAt(seat, target);
    const targetNameZh = this.cardView(pokemon.card).nameZh;
    player.hand = player.hand.filter((_card, index) => index !== handIndex);
    pokemon.energies.push(card);
    player.energyAttachedThisTurn = true;
    this.pushEvent({ type: 'energy-attached', seat, card: this.cardView(card), target: { ...target }, targetNameZh });
  }

  /**
   * A-03：撤退支付所选的撤退能量（数量必须等于撤退费用），与选定的备战宝可梦交换。
   * 睡眠/麻痹、无法撤退效果与“备战区为空”都禁止撤退；失败不消耗任何能量或次数。
   */
  private retreat(seat: MatchSeat, energyIndices: readonly number[], benchIndex: number): void {
    const player = this.state.players[seat];
    if (player.retreatedThisTurn) {
      throw new MatchEngineError('action-not-allowed', '每个回合只能撤退 1 次。');
    }
    const active = player.active;
    if (active === null) {
      throw new MatchEngineError('illegal-target', '战斗场没有宝可梦。');
    }
    if (player.bench.length === 0) {
      throw new MatchEngineError('action-not-allowed', '备战区没有宝可梦，无法撤退。');
    }
    if (active.statuses.has('睡眠') || active.statuses.has('麻痹')) {
      throw new MatchEngineError('action-not-allowed', '睡眠或麻痹状态的宝可梦无法撤退。');
    }
    if (active.cannotRetreat) {
      throw new MatchEngineError('action-not-allowed', '这只宝可梦受到无法撤退的效果影响。');
    }
    const replacement = player.bench[benchIndex];
    if (!Number.isInteger(benchIndex) || benchIndex < 0 || replacement === undefined) {
      throw new MatchEngineError('illegal-target', '备战区换入序号无效。');
    }
    const cost = this.definitionOf(active.card).retreat ?? 0;
    if (energyIndices.length !== cost) {
      throw new MatchEngineError('illegal-cost', `撤退需要恰好 ${cost} 个能量。`);
    }
    const seen = new Set<number>();
    for (const index of energyIndices) {
      if (!Number.isInteger(index) || index < 0 || index >= active.energies.length || seen.has(index)) {
        throw new MatchEngineError('illegal-cost', '撤退能量序号无效或重复。');
      }
      seen.add(index);
    }
    // 验证完成后再修改状态：从战斗宝可梦身上移除所选能量并放于弃牌区。
    const paid = energyIndices.map((index) => active.energies[index] as CardInstance);
    active.energies = active.energies.filter((_energy, index) => !seen.has(index));
    player.discard.push(...paid);
    // 交换：原战斗宝可梦进入所选备战宝可梦的位置，剩余能量与伤害指示物保留；
    // 回到备战区后特殊状态与附加效果全部消除（冻结 basic_rules07「回到备战区」）。
    const leaving = active;
    this.clearStatusesForLeave(leaving, 'retreat');
    leaving.cannotRetreat = false;
    leaving.attackLocked = false;
    player.active = replacement;
    player.bench = player.bench.map((pokemon, index) => (index === benchIndex ? leaving : pokemon));
    player.retreatedThisTurn = true;
    this.pushEvent({
      type: 'retreat',
      seat,
      active: this.cardView(replacement.card),
      bench: this.cardView(leaving.card),
    });
  }

  /**
   * A-01：使用招式需要满足费用；使用后回合结束。先攻玩家最初回合不能使用招式。
   * 带说明文的招式只有在会话级效果注册表中有行为时才可执行，否则 `unsupported-card`。
   */
  private attack(seat: MatchSeat, attackIndex: number, target: MatchPokemonRef): void {
    if (this.isFirstPlayersFirstTurn(seat)) {
      throw new MatchEngineError('action-not-allowed', '先攻玩家在自己的最初回合不能使用招式。');
    }
    const player = this.state.players[seat];
    const attacker = player.active;
    if (attacker === null) {
      throw new MatchEngineError('illegal-target', '战斗场没有宝可梦，无法使用招式。');
    }
    if (attacker.statuses.has('睡眠') || attacker.statuses.has('麻痹')) {
      throw new MatchEngineError('action-not-allowed', '睡眠或麻痹状态的宝可梦无法宣告招式。');
    }
    if (attacker.attackLocked) {
      throw new MatchEngineError('action-not-allowed', '这只宝可梦受到无法使用招式的效果影响。');
    }
    const attackerDefinition = this.definitionOf(attacker.card);
    const attack = attackerDefinition.attacks[attackIndex];
    if (!Number.isInteger(attackIndex) || attackIndex < 0 || attack === undefined) {
      throw new MatchEngineError('illegal-target', '招式序号无效。');
    }
    // 基础规则下招式目标只能是对手战斗宝可梦；备战区狙击等属于卡牌例外。
    const defenderSeat = otherSeat(seat);
    const defender = this.state.players[defenderSeat].active;
    if (target.slot !== 'active' || defender === null) {
      throw new MatchEngineError('illegal-target', '招式目标必须是对手的战斗宝可梦。');
    }
    const energyTypes = attacker.energies.map((energy) => this.definitionOf(energy).type);
    if (!energyCoversCost(attack.cost, energyTypes)) {
      throw new MatchEngineError('insufficient-energy', `能量不足，无法使用「${attack.name}」。`);
    }
    const effectKey = attackEffectKey(attackerDefinition.identities.effectIdentity, attack.name);
    const resolver = this.state.attackEffects.get(effectKey);
    const baseDamage = parseBaseDamage(attack.damage);
    if (resolver === undefined && (attackHasEffectText(attack) || baseDamage === null)) {
      throw new MatchEngineError('unsupported-card', `招式「${attack.name}」的效果尚未接入，不能使用。`);
    }
    // 效果接口只登记纯数据操作，不立即改动状态；回调全部返回后才统一应用。
    // 目标、数量、单次与累计溢出都在登记时校验，因此任何一步失败都不会留下
    // 部分伤害、公开事件或标记：整条命令要么全部生效，要么完全不变。
    // 登记与基础伤害校验都必须先于【混乱】硬币，非法招式不消耗随机、不追加事件。
    const staged: StagedAttackOperation[] = [];
    let basicBaseDamage: number | null = null;
    let basicFinalDamage = 0;
    if (resolver !== undefined) {
      const finalDamage = baseDamage === null ? 0 : this.finalDamage(attackerDefinition, defender, baseDamage);
      /** 同一目标上已登记但尚未应用的指示物增量，用于累计溢出校验。 */
      const pendingCounters = new Map<PokemonState, number>();
      const stageDamage = (targetSeat: MatchSeat, target: PokemonState, damage: number): void => {
        const counters = this.damageCountersForPlacement(target, damage);
        const accumulated = (pendingCounters.get(target) ?? 0) + counters;
        if (!Number.isSafeInteger(accumulated) || !Number.isSafeInteger(target.damageCounters + accumulated)) {
          throw new MatchEngineError('illegal-choice', '累计伤害指示物超出可安全表示的范围。');
        }
        pendingCounters.set(target, accumulated);
        staged.push({ kind: 'damage', targetSeat, target, damage });
      };
      resolver({
        seat,
        defenderSeat,
        finalDamage,
        dealDamage: () => {
          if (finalDamage > 0) {
            stageDamage(defenderSeat, defender, finalDamage);
          }
        },
        placeDamageCounters: (targetSeat, ref, count) => {
          const targetPokemon = this.ownPokemonAt(targetSeat, ref);
          stageDamage(targetSeat, targetPokemon, damageForCounters(count));
        },
        setCannotRetreat: (targetSeat, ref, locked) => {
          staged.push({ kind: 'cannot-retreat', target: this.ownPokemonAt(targetSeat, ref), locked });
        },
        setAttackLocked: (targetSeat, ref, locked) => {
          staged.push({ kind: 'attack-locked', target: this.ownPokemonAt(targetSeat, ref), locked });
        },
        addSpecialCondition: (targetSeat, ref, condition) => {
          if (ref.slot !== 'active') {
            throw new MatchEngineError('illegal-target', '特殊状态只能施加于战斗宝可梦。');
          }
          staged.push({ kind: 'special-condition', target: this.ownPokemonAt(targetSeat, ref), condition });
        },
        drawCards: (count) => {
          if (!Number.isSafeInteger(count) || count < 0) {
            throw new MatchEngineError('illegal-choice', `抽牌张数 ${count} 必须是非负整数。`);
          }
          staged.push({ kind: 'draw', seat, count });
        },
      });
    } else {
      // 基础伤害路径同样在硬币之前完成放置校验（含累计溢出）。
      basicBaseDamage = baseDamage;
      basicFinalDamage = this.finalDamage(attackerDefinition, defender, baseDamage as number);
      if (basicFinalDamage > 0) {
        this.damageCountersForPlacement(defender, basicFinalDamage);
      }
    }
    // 【混乱】：宣告招式后抛硬币；反面招式失败，自身放置 3 个伤害指示物并结束回合。
    // 只有全部验证与效果登记完成后才消耗硬币；失败的命令不能重掷或跳过随机。
    if (attacker.statuses.has('混乱')) {
      const flip = this.flipCoin();
      this.pushEvent({
        type: 'confusion-flip',
        seat,
        targetNameZh: this.cardView(attacker.card).nameZh,
        result: flip,
        selfDamageCounters: flip === 'tails' ? 3 : 0,
      });
      if (flip === 'tails') {
        // 招式失败：登记通过的暂存效果全部丢弃，只做自身伤害与回合结束。
        this.placeDamageCounters(seat, attacker, 30, seat);
        this.settleKnockOuts('end-turn');
        return;
      }
    }
    if (resolver !== undefined) {
      for (const operation of staged) {
        switch (operation.kind) {
          case 'damage':
            this.placeDamageCounters(operation.targetSeat, operation.target, operation.damage, seat);
            break;
          case 'cannot-retreat':
            operation.target.cannotRetreat = operation.locked;
            break;
          case 'attack-locked':
            operation.target.attackLocked = operation.locked;
            break;
          case 'special-condition':
            this.applySpecialCondition(seat, operation.target, operation.condition);
            break;
          case 'draw': {
            const drawPlayer = this.state.players[operation.seat];
            const actual = Math.min(operation.count, drawPlayer.deck.length);
            if (actual > 0) {
              drawPlayer.hand.push(...drawPlayer.deck.splice(0, actual));
            }
            // 一般效果抽空不判败：只如实记录实际抽到的张数。
            this.pushEvent({ type: 'card-drawn', seat: operation.seat, count: actual });
            break;
          }
        }
      }
      this.settleKnockOuts('end-turn');
      return;
    }
    this.pushEvent({ type: 'attack-used', seat, attackName: attack.name, baseDamage: basicBaseDamage as number, damage: basicFinalDamage });
    if (basicFinalDamage > 0) {
      this.placeDamageCounters(defenderSeat, defender, basicFinalDamage, seat);
    }
    this.settleKnockOuts('end-turn');
  }

  private finalDamage(attacker: CatalogCard, defender: PokemonState, baseDamage: number): number {
    const defenderDefinition = this.definitionOf(defender.card);
    return calculateDamage(baseDamage, attacker.type, defenderDefinition.weakness, defenderDefinition.resistance);
  }

  /**
   * 校验点数并返回指示物增量；不修改状态，供应用与暂存共用。
   * 非法点数（非正、非 10 的倍数、非有限/安全整数）与累计溢出都在此拒绝。
   */
  private damageCountersForPlacement(target: PokemonState, damage: number): number {
    if (!Number.isSafeInteger(damage) || damage <= 0 || damage % 10 !== 0) {
      throw new MatchEngineError('illegal-choice', `伤害 ${damage} 必须是正的 10 的倍数。`);
    }
    const counters = damage / 10;
    if (!Number.isSafeInteger(target.damageCounters + counters)) {
      throw new MatchEngineError('illegal-choice', '累计伤害指示物超出可安全表示的范围。');
    }
    return counters;
  }

  /**
   * 放置伤害指示物：`damage` 是点数，每个指示物 10 点。
   * 该路径直接放置，不经过弱点/抵抗或附加效果（与招式伤害结算区分）。
   */
  private placeDamageCounters(targetSeat: MatchSeat, target: PokemonState, damage: number, sourceSeat: MatchSeat): void {
    const counters = this.damageCountersForPlacement(target, damage);
    target.damageCounters += counters;
    this.pushEvent({ type: 'damage-counters-placed', seat: sourceSeat, targetSeat, count: counters });
  }

  /* ---------------- 特殊状态、宝可梦检查与昏厥结算 ---------------- */

  /** 服务端随机硬币：0 为正面、1 为反面；客户端无法影响。 */
  private flipCoin(): 'heads' | 'tails' {
    return this.random.nextInt(2) === 0 ? 'heads' : 'tails';
  }

  /** 该座位的下一个自己的回合编号；用于【麻痹】恢复时机。 */
  private nextOwnTurnNumber(seat: MatchSeat): number {
    return this.state.activeSeat === seat ? this.state.turn + 2 : this.state.turn + 1;
  }

  /**
   * 施加特殊状态：中毒/灼伤可与任意状态叠加；睡眠/麻痹/混乱互斥，
   * 新状态替换旧状态（冻结 basic_rules07）。
   */
  private applySpecialCondition(sourceSeat: MatchSeat, target: PokemonState, condition: SpecialCondition): void {
    if (condition === '中毒' || condition === '灼伤') {
      target.statuses.add(condition);
    } else {
      for (const other of EXCLUSIVE_STATUSES) {
        target.statuses.delete(other);
      }
      target.statuses.add(condition);
      target.paralysisRecoversAfterTurn = condition === '麻痹' ? this.nextOwnTurnNumber(target.seat) : null;
    }
    this.pushEvent({
      type: 'status-inflicted',
      seat: sourceSeat,
      targetSeat: target.seat,
      targetNameZh: this.cardView(target.card).nameZh,
      condition,
    });
  }

  /** 战斗宝可梦回到备战区/进化/离场时，特殊状态全部消除并公开说明。 */
  private clearStatusesForLeave(pokemon: PokemonState, cause: 'checkup' | 'retreat' | 'evolve' | 'effect'): void {
    const name = this.cardView(pokemon.card).nameZh;
    for (const condition of [...pokemon.statuses]) {
      pokemon.statuses.delete(condition);
      this.pushEvent({ type: 'status-recovered', targetSeat: pokemon.seat, targetNameZh: name, condition, cause });
    }
    pokemon.paralysisRecoversAfterTurn = null;
  }

  /**
   * 宝可梦检查（每个玩家回合结束时）：按【中毒】【灼伤】【睡眠】【麻痹】顺序
   * 对双方战斗宝可梦确认；灼伤/睡眠由持有者抛硬币。检查末尾再确认昏厥（由
   * `settleKnockOuts` 在调用方完成）。
   */
  private runPokemonCheckup(): void {
    for (const condition of CHECKUP_ORDER) {
      for (const seat of [0, 1] as const) {
        const active = this.state.players[seat].active;
        if (active === null || !active.statuses.has(condition)) {
          continue;
        }
        const name = this.cardView(active.card).nameZh;
        if (condition === '中毒') {
          this.placeDamageCounters(seat, active, 10, seat);
          continue;
        }
        if (condition === '灼伤') {
          this.placeDamageCounters(seat, active, 20, seat);
          const flip = this.flipCoin();
          this.pushEvent({ type: 'checkup-flip', targetSeat: seat, targetNameZh: name, condition: '灼伤', result: flip });
          if (flip === 'heads') {
            active.statuses.delete('灼伤');
            this.pushEvent({ type: 'status-recovered', targetSeat: seat, targetNameZh: name, condition: '灼伤', cause: 'checkup' });
          }
          continue;
        }
        if (condition === '睡眠') {
          const flip = this.flipCoin();
          this.pushEvent({ type: 'checkup-flip', targetSeat: seat, targetNameZh: name, condition: '睡眠', result: flip });
          if (flip === 'heads') {
            active.statuses.delete('睡眠');
            this.pushEvent({ type: 'status-recovered', targetSeat: seat, targetNameZh: name, condition: '睡眠', cause: 'checkup' });
          }
          continue;
        }
        // 【麻痹】：在自己的下一个回合结束后的宝可梦检查恢复。
        if (active.paralysisRecoversAfterTurn !== null && active.paralysisRecoversAfterTurn <= this.state.turn) {
          active.statuses.delete('麻痹');
          active.paralysisRecoversAfterTurn = null;
          this.pushEvent({ type: 'status-recovered', targetSeat: seat, targetNameZh: name, condition: '麻痹', cause: 'checkup' });
        }
      }
    }
  }

  private isKnockedOut(pokemon: PokemonState): boolean {
    const hp = this.definitionOf(pokemon.card).hp;
    if (hp === null || !Number.isSafeInteger(hp)) {
      return false;
    }
    return pokemon.damageCounters * 10 >= hp;
  }

  /** 下一回合轮到的玩家；昏厥确认发生在当前回合结束前，因此是另一座位。 */
  private nextTurnSeat(): MatchSeat {
    const active = this.state.activeSeat;
    if (active === null) {
      throw new MatchEngineError('action-not-allowed', '当前没有回合玩家，无法确定交替顺序。');
    }
    return otherSeat(active);
  }

  /**
   * 昏厥处理（冻结 D）：确认没有剩余 HP 的宝可梦；与所有附着卡一并放入弃牌区；
   * 双方拿取与对手昏厥宝可梦（按卡面奖赏价值）相同张数的奖赏卡；双方战斗
   * 宝可梦同时昏厥时，由下一回合轮到的玩家先放战斗宝可梦。取奖赏卡与补充
   * 战斗宝可梦都可能产生待决选择；全部处理完后再按冻结判定表判定胜负。
   */
  private settleKnockOuts(after: 'end-turn' | 'start-next-turn'): void {
    if (this.state.result !== null) {
      return;
    }
    const knockedOut: { readonly pokemon: PokemonState; readonly zone: 'active' | 'bench' }[] = [];
    for (const seat of [0, 1] as const) {
      const player = this.state.players[seat];
      if (player.active !== null && this.isKnockedOut(player.active)) {
        knockedOut.push({ pokemon: player.active, zone: 'active' });
      }
      for (const bench of player.bench) {
        if (this.isKnockedOut(bench)) {
          knockedOut.push({ pokemon: bench, zone: 'bench' });
        }
      }
    }
    if (knockedOut.length === 0) {
      this.afterSettlement(after);
      return;
    }
    const owed: [number, number] = [0, 0];
    const activeKnocked: [boolean, boolean] = [false, false];
    for (const entry of knockedOut) {
      const pokemon = entry.pokemon;
      const seat = pokemon.seat;
      const player = this.state.players[seat];
      const prizeCount = prizeValueOf(this.definitionOf(pokemon.card));
      if (entry.zone === 'active') {
        player.active = null;
        activeKnocked[seat] = true;
      } else {
        const index = player.bench.indexOf(pokemon);
        if (index >= 0) {
          player.bench.splice(index, 1);
        }
      }
      // 昏厥宝可梦与所有附着卡（能量/道具）一同进入弃牌区；伤害指示物消失。
      player.discard.push(pokemon.card, ...pokemon.energies, ...pokemon.tools);
      this.pushEvent({
        type: 'pokemon-knocked-out',
        targetSeat: seat,
        targetNameZh: this.cardView(pokemon.card).nameZh,
        prizeCount,
      });
      owed[otherSeat(seat)] += prizeCount;
    }
    for (const seat of [0, 1] as const) {
      if (activeKnocked[seat] && this.state.players[seat].bench.length === 0) {
        this.state.noPokemonCondition[seat] = true;
      }
    }
    const actions: SettlementAction[] = [];
    for (const seat of [0, 1] as const) {
      if (owed[seat] > 0) {
        actions.push({ kind: 'take-prizes', seat, needed: owed[seat] });
      }
    }
    const needingReplacement = ([0, 1] as const).filter(
      (seat) => activeKnocked[seat] && this.state.players[seat].bench.length > 0,
    );
    if (needingReplacement.length === 2) {
      const next = this.nextTurnSeat();
      for (const seat of [next, otherSeat(next)] as const) {
        if (needingReplacement.includes(seat)) {
          actions.push({ kind: 'replace', seat });
        }
      }
    } else if (needingReplacement.length === 1) {
      actions.push({ kind: 'replace', seat: needingReplacement[0] as MatchSeat });
    }
    this.state.settlement = { actions, after };
    this.advanceSettlement();
  }

  /**
   * 依次执行昏厥结算动作：可以不经选择直接取完的奖赏卡立即结算；需要选择时
   * 创建待决选择并返回，待命令完成后继续。全部动作完成后判定胜负，未终局时
   * 按 `after` 继续（招式后走宝可梦检查，检查后进入下一回合）。
   */
  private advanceSettlement(): void {
    const settlement = this.state.settlement;
    if (settlement === null) {
      return;
    }
    while (settlement.actions.length > 0) {
      const action = settlement.actions[0] as SettlementAction;
      if (action.kind === 'take-prizes') {
        const player = this.state.players[action.seat];
        const available = player.prizes.length;
        const take = Math.min(action.needed, available);
        if (take <= 0) {
          settlement.actions.shift();
          continue;
        }
        if (take >= available) {
          settlement.actions.shift();
          this.applyPrizeTake(action.seat, player.prizes.map((_card, index) => index));
          continue;
        }
        this.state.pending = this.newChoice('take-prizes', action.seat, {
          min: take,
          max: take,
          benchMin: 0,
          benchMax: 0,
          candidates: player.prizes.map((_card, index) => index),
        });
        return;
      }
      const player = this.state.players[action.seat];
      if (player.bench.length === 0) {
        settlement.actions.shift();
        continue;
      }
      // 保留动作在队首，由 `chooseReplacement` 验证后移除；保证验证失败不改状态。
      this.state.pending = this.newChoice('choose-replacement', action.seat, {
        min: 1,
        max: 1,
        benchMin: 0,
        benchMax: 0,
        candidates: player.bench.map((_pokemon, index) => index),
      });
      return;
    }
    this.state.settlement = null;
    const after = settlement.after;
    if (this.evaluateWinConditions()) {
      return;
    }
    this.afterSettlement(after);
  }

  private afterSettlement(after: 'end-turn' | 'start-next-turn'): void {
    if (after === 'end-turn') {
      this.endTurn();
      return;
    }
    const endedSeat = this.state.activeSeat;
    if (endedSeat === null) {
      // 理论上不可达：进入 playing 后始终有回合玩家。
      return;
    }
    this.startTurn(otherSeat(endedSeat), this.state.turn + 1);
  }

  private takePrizes(seat: MatchSeat, indices: readonly number[]): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'take-prizes') {
      throw new MatchEngineError('choice-pending', '当前没有取奖赏卡选择。');
    }
    if (indices.length !== pending.min) {
      throw new MatchEngineError('illegal-choice', `必须取走恰好 ${pending.min} 张奖赏卡。`);
    }
    const seen = new Set<number>();
    for (const index of indices) {
      if (!Number.isInteger(index) || !pending.candidates.includes(index) || seen.has(index)) {
        throw new MatchEngineError('illegal-choice', '奖赏卡序号无效或重复。');
      }
      seen.add(index);
    }
    const settlement = this.state.settlement;
    if (settlement === null || settlement.actions.length === 0) {
      throw new MatchEngineError('choice-pending', '当前没有进行中的昏厥结算。');
    }
    // 验证完成后再修改状态。
    settlement.actions.shift();
    this.state.pending = null;
    this.applyPrizeTake(seat, indices);
    this.advanceSettlement();
  }

  private applyPrizeTake(seat: MatchSeat, indices: readonly number[]): void {
    const player = this.state.players[seat];
    const sorted = [...indices].sort((a, b) => b - a);
    const taken: CardInstance[] = [];
    for (const index of sorted) {
      const card = player.prizes[index];
      if (card !== undefined) {
        taken.push(card);
        player.prizes.splice(index, 1);
      }
    }
    // 取走的奖赏进入手牌后仍是私人信息；公开事件只记录张数与剩余张数。
    player.hand.push(...taken.reverse());
    this.pushEvent({ type: 'prizes-taken', seat, count: taken.length, remaining: player.prizes.length });
  }

  private chooseReplacement(seat: MatchSeat, benchIndex: number): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'choose-replacement') {
      throw new MatchEngineError('choice-pending', '当前没有补充战斗宝可梦选择。');
    }
    const player = this.state.players[seat];
    const replacement = player.bench[benchIndex];
    if (!Number.isInteger(benchIndex) || benchIndex < 0 || replacement === undefined) {
      throw new MatchEngineError('illegal-target', '备战区序号无效。');
    }
    const settlement = this.state.settlement;
    if (settlement === null || settlement.actions.length === 0) {
      throw new MatchEngineError('choice-pending', '当前没有进行中的昏厥结算。');
    }
    settlement.actions.shift();
    this.state.pending = null;
    player.bench.splice(benchIndex, 1);
    player.active = replacement;
    this.pushEvent({ type: 'replacement-placed', seat, card: this.cardView(replacement.card) });
    this.advanceSettlement();
  }

  /**
   * 冻结 E「同时满足胜负条件时的判定」：把四项条件交给判定表（`judgeWinConditions`），
   * 票多者获胜，相等为平局；不采用 first-match。
   */
  private evaluateWinConditions(): boolean {
    if (this.state.result !== null) {
      return true;
    }
    const players = this.state.players;
    const prizeDone: [boolean, boolean] = [players[0].prizes.length === 0, players[1].prizes.length === 0];
    const judgement = judgeWinConditions(prizeDone, this.state.noPokemonCondition);
    if (judgement === null) {
      return false;
    }
    this.finishMatch(judgement.winner, judgement.reason, judgement.conditions);
    return true;
  }

  /** 确认认输：任意对局阶段可用，唯一终态只生成一次。 */
  private concede(seat: MatchSeat): void {
    this.pushEvent({ type: 'conceded', seat });
    this.finishMatch(otherSeat(seat), 'concede', []);
  }

  private finishMatch(winner: MatchSeat | null, reason: MatchFinishReason, conditions: readonly MatchResultCondition[]): void {
    if (this.state.result !== null) {
      return;
    }
    const result: MatchResultView = {
      winner,
      reason,
      conditions: conditions.map((entry) => ({ ...entry })),
    };
    this.state.result = result;
    this.state.pending = null;
    this.state.settlement = null;
    this.pushEvent({ type: 'match-finished', winner, reason, conditions: result.conditions });
  }
}

const EXCLUSIVE_STATUSES: readonly SpecialCondition[] = ['睡眠', '麻痹', '混乱'];
const CHECKUP_ORDER: readonly SpecialCondition[] = ['中毒', '灼伤', '睡眠', '麻痹'];

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
    case 'take-prizes':
      return 'take-prizes';
    case 'choose-replacement':
      return 'choose-replacement';
    default:
      throw new MatchEngineError('choice-pending', '这条命令不是待决选择命令。');
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

export interface MatchSessionConfig extends MatchEngineConfig {}

/**
 * 对局会话：把引擎包在「认证座位 + 命令 ID 去重 + 版本校验」里。
 *
 * 命令 ID 的作用域是座位：一个座位的重复 ID 不会拿到另一个座位的结果或
 * 私人视图。会话不接触网络，房间注册表负责按授权座位收发。
 */
export class MatchSession {
  public readonly sessionId: string;
  private readonly engine: MatchEngine;
  private readonly seats: readonly [MatchSeatHandle, MatchSeatHandle];
  private readonly dedup: readonly [Map<string, DedupEntry>, Map<string, DedupEntry>] = [new Map(), new Map()];

  public constructor(config: MatchSessionConfig) {
    this.sessionId = config.sessionId;
    this.engine = new MatchEngine(config);
    this.seats = [
      { seat: 0, token: randomUUID() },
      { seat: 1, token: randomUUID() },
    ];
  }

  public get version(): number {
    return this.engine.version;
  }

  /** 唯一权威终态；房间注册表据此进入“已结束、可重新准备”状态。 */
  public get result(): MatchResultView | null {
    return this.engine.result;
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
