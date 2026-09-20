import { randomInt, randomUUID } from 'node:crypto';
import type {
  CatalogAbility,
  CatalogAttack,
  CatalogCard,
  CatalogContent,
  DeckDocument,
  MatchAbilityView,
  MatchAttackView,
  MatchCardView,
  MatchChoiceCandidateView,
  MatchChoiceModeView,
  MatchChoiceSource,
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

/** 场上一只宝可梦；伤害、能量、道具与特殊状态是公开状态。 */
interface PokemonState {
  /** 持有者座位；特殊状态恢复时机与昏厥条件需要知道归属。 */
  readonly seat: MatchSeat;
  /** 当前最上方的宝可梦卡；进化时被新卡覆盖（下方旧卡进入 `evolutionStack`）。 */
  card: CardInstance;
  /** 进化卡下方的旧宝可梦卡（从旧到新）；昏厥时全部进入弃牌区。 */
  readonly evolutionStack: CardInstance[];
  /** 已放置的伤害指示物数量（每个 10 点）。 */
  damageCounters: number;
  /** 附着能量；序号与视图中的 `energyIndex` 一致。 */
  energies: CardInstance[];
  /** 附着的宝可梦道具；每只至多 1 张，保持附着。 */
  readonly tools: CardInstance[];
  /** 公开的特殊状态；睡眠/麻痹/混乱互斥，中毒/灼伤可叠加。 */
  readonly statuses: Set<SpecialCondition>;
  /** 麻痹恢复到期的回合编号（该回合结束后的宝可梦检查恢复）；未麻痹为 null。 */
  paralysisRecoversAfterTurn: number | null;
  /** 进入场上的回合编号（开局盖放为 0）；进化限制等使用。 */
  enteredTurn: number;
  /** 最近一次进化的回合编号；未进化为 null。同回合不能再次进化。 */
  evolvedTurn: number | null;
  /** 本回合已使用过自己特性的名称；每次自己的回合开始清空。 */
  readonly abilitiesUsedThisTurn: Set<string>;
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
  /** 本回合是否已经使用过支援者卡（自己的回合 1 张）。 */
  supporterUsedThisTurn: boolean;
  /** 本回合是否已经将竞技场卡放于场上（自己的回合 1 张）。 */
  stadiumPlayedThisTurn: boolean;
  /** 本回合是否已经使用过当前竞技场的效果（该竞技场每回合每名玩家 1 次）。 */
  stadiumUsedThisTurn: boolean;
  /** 在上一个对手的回合，自己的宝可梦是否昏厥（「鼓励信」等条件卡）。 */
  koDuringLastOpponentTurn: boolean;
  /** 当前回合自己的宝可梦是否被昏厥，供下一次对手回合开始时结转。 */
  koSufferedThisTurn: boolean;
  /** 自己已经开始的回合数；1 表示自己的最初回合（此时不能进化）。 */
  ownTurnsStarted: number;
}

/**
 * 待决选择中的一个候选卡牌实例；`candidateId` 只在当前选择内有效。
 * `selectable` 表示卡面文字是否允许选择这张卡：查看牌库顶（超级球）会把
 * 被查看的全部卡牌作为私人候选展示，但不满足效果的卡不可选。
 */
interface ChoiceCandidate {
  readonly candidateId: string;
  readonly card: CardInstance;
  readonly selectable: boolean;
  /** 附着能量候选的所属宝可梦公开名称；其它候选为 null。 */
  readonly targetLabelZh: string | null;
}

/** `choose-mode` 的一个模式；可用性决定服务端是否接受选择。 */
export type TrainerModeResolution =
  | 'discard-then-draw-five'
  | 'switch-opponent-v'
  /** 「基因侵入」：把选定的对手战斗宝可梦招式作为当前招式使用。 */
  | 'copy-opponent-attack'
  /** 「海之伴奏」：把选定的手牌能量附着于选定的自己场上宝可梦。 */
  | 'attach-energy-to-own';

export interface TrainerChoiceMode {
  readonly modeId: string;
  readonly labelZh: string;
  readonly available: boolean;
  readonly unavailableReasonZh: string | null;
  /** 引擎内部解析方式；不进入线上视图。 */
  readonly resolution: TrainerModeResolution;
}

type ChoiceMode = TrainerChoiceMode;

/**
 * 选择解析成功后的后续动作。只使用纯数据描述，既不存闭包也不需要跨进程
 * 序列化：未结束对局只存在于当前服务进程内（服务重启后对局作废）。
 */
export type EffectFollowUp =
  | { readonly kind: 'search-pokemon-to-hand' }
  | { readonly kind: 'draw-to-hand-size'; readonly size: number }
  /** 使用后结束自己的回合（如「梦中赠礼」）。 */
  | { readonly kind: 'end-turn' }
  /** 一般效果：从牌库顶抽取固定张数（不足时抽完为止），如「循环抽取」。 */
  | { readonly kind: 'draw-cards'; readonly count: number }
  /**
   * 分步牌库检索：完成当前检索后按同一效果继续下一次检索；
   * `deferShuffle` 为 true 时本次检索不重洗，等整段效果结束后再重洗
   * （如「珠贝」先找[水]宝可梦、再找物品，只在最后重洗一次）。
   */
  | {
      readonly kind: 'search-deck-second';
      readonly filter: TrainerCardFilter;
      readonly min: number;
      readonly max: number;
      readonly destination: 'hand' | 'bench';
      readonly descriptionZh: string;
      readonly deferShuffle?: boolean;
    }
  /** 「莎莉娜」模式 2：选择对手备战区「宝可梦V」与战斗宝可梦互换。 */
  | { readonly kind: 'switch-opponent-v' }
  /** 「刺穿」：对选定的对手备战宝可梦直接放置伤害指示物。 */
  | { readonly kind: 'attack-bench-damage'; readonly baseDamage: number; readonly counters: number }
  /**
   * 将选定的手牌能量附着于指定自己场上宝可梦（可选回复 HP）；
   * 供「珍贵一触」与「海之伴奏」共用。
   */
  | {
      readonly kind: 'attach-energy-to-target';
      readonly target: MatchPokemonRef;
      readonly heal: number;
      readonly energyType: string | null;
    }
  /** 攻击效果：按放于弃牌区的能量数量，每张造成固定伤害。 */
  | { readonly kind: 'attack-damage-per-discarded-energy'; readonly perEnergy: number };

/** 兼容既有训练家效果代码的别名；后续动作现由通用效果续接统一处理。 */
export type TrainerFollowUp = EffectFollowUp;

interface PendingChoice {
  readonly kind: MatchPendingChoiceKind;
  readonly seat: MatchSeat;
  readonly choiceId: string;
  readonly min: number;
  readonly max: number;
  readonly benchMin: number;
  readonly benchMax: number;
  readonly candidates: readonly number[];
  /** 通用步骤信息：当前步骤从 1 开始，总步骤数至少等于当前步骤。 */
  readonly step: number;
  readonly stepCount: number;
  readonly source: MatchChoiceSource;
  readonly descriptionZh: string;
  readonly cardCandidates: readonly ChoiceCandidate[];
  readonly modes: readonly ChoiceMode[];
  /** 选择完成后要执行的后续动作；单步选择为 null。 */
  readonly followUp: TrainerFollowUp | null;
  /** 该选择解析成功后才消耗竞技场每回合使用次数（深钵镇）。 */
  readonly consumeStadiumUse: boolean;
  /** 检索选择的放置区域；非检索选择为 null。 */
  readonly destination: 'hand' | 'bench' | 'opponent-bench' | null;
  /** 本次检索是否暂不重洗（分步检索的中间步骤）。 */
  readonly deferShuffle: boolean;
}

/**
 * 训练家卡效果例外接口。`canPlay` 在消耗手牌、生成公开事件之前运行，任何
 * 拒绝都不改变状态、不消耗随机；`play` 在卡牌已进入公开区后执行卡面效果，
 * 可以创建待决选择或直接结算。
 */
export interface TrainerCanPlayContext {
  readonly seat: MatchSeat;
  readonly card: CatalogCard;
  handCount(): number;
  /** 排除正在使用的这张卡后的手牌张数（用于「支付2张手牌」类代价）。 */
  otherHandCount(): number;
  /**
   * 自己牌库的公开张数（对双方都可见，见 `MatchSideView.deckCount`）。
   * 张数为 0 时，检索类效果在使用前即可判断不会产生任何情况变化
   * （冻结 B-01/B-04），必须整体拒绝；张数非 0 时不得查询隐藏区域的
   * 内容来判断是否有目标。
   */
  ownDeckCount(): number;
  ownBenchCount(): number;
  /** 对手的公开手牌张数；用于判断「查看对手手牌」类效果使用前是否确定无变化。 */
  opponentHandCount(): number;
  opponentBenchCards(): readonly { readonly index: number; readonly card: CatalogCard }[];
  /** 对手的公开备战区张数，「莉佳的邀请」等需要判断是否还能放置。 */
  opponentBenchCount(): number;
  opponentActiveCard(): CatalogCard | null;
  koDuringLastOpponentTurn(): boolean;
}

export type TrainerCanPlayResult = { readonly ok: true } | { readonly ok: false; readonly code: MatchErrorCode; readonly message: string };

export interface TrainerCardFilter {
  readonly cardClass?: 'pokemon' | 'energy' | 'trainer';
  /** 只允许「基础」宝可梦。 */
  readonly basicOnly?: boolean;
  /** 排除「拥有规则的宝可梦」（卡面印有 ex/V/VMAX/VSTAR 等规则文字）。 */
  readonly noRule?: boolean;
  /** 只允许 HP 不高于该值（含）的宝可梦。 */
  readonly maxHp?: number;
  /** 只允许基本能量。 */
  readonly basicEnergyOnly?: boolean;
  /**
   * 只允许真正的「物品」卡；2025-01-17 起「宝可梦道具」独立于物品，
   * 因此不能把印刷为宝可梦道具的卡当作物品检索。
   */
  readonly itemOnly?: boolean;
  /** 只允许指定属性的能量（如基本水能量）。 */
  readonly energyType?: string;
  /** 只允许拥有指定标签（如「连击」）的卡牌。 */
  readonly subtype?: string;
  /** 只允许指定属性的宝可梦（如「水」）；「珠贝」等按属性检索。 */
  readonly type?: string;
}

export interface TrainerPlayContext extends TrainerCanPlayContext {
  /** 公开掷硬币；只在效果真正执行时调用，拒绝路径不得消耗随机。 */
  flipCoin(cardNameZh: string): 'heads' | 'tails';
  /** 从手牌选择弃置（使用代价或效果）；张数含上下限。 */
  startDiscardChoice(options: {
    readonly min: number;
    readonly max: number;
    readonly descriptionZh: string;
    readonly followUp: TrainerFollowUp | null;
    readonly step?: number;
    readonly stepCount?: number;
  }): void;
  /** 从牌库搜索候选；没有候选时直接按检索失败处理并重洗牌库。 */
  startDeckSearch(options: {
    readonly filter: TrainerCardFilter;
    readonly min: number;
    readonly max: number;
    readonly destination: 'hand' | 'bench';
    readonly descriptionZh: string;
    readonly consumeStadiumUse?: boolean;
    readonly step?: number;
    readonly stepCount?: number;
    readonly followUp?: EffectFollowUp | null;
    /** 分步检索的中间步骤不立即重洗，等最后一步再重洗（如「珠贝」）。 */
    readonly deferShuffle?: boolean;
  }): void;
  /** 查看牌库上方若干张并选择其中至多 `max` 张；没有候选时重洗牌库。 */
  startTopDeckLook(options: {
    readonly count: number;
    readonly filter: TrainerCardFilter;
    readonly min: number;
    readonly max: number;
    readonly destination: 'hand';
    readonly descriptionZh: string;
  }): void;
  /** 从牌库顶抽牌直到手牌达到 `size` 张（牌库不足时抽完为止）。 */
  drawUntilHandSize(size: number): void;
  /** 二选一效果；没有可用模式时由调用方决定不创建选择。 */
  startModeChoice(options: { readonly modes: readonly TrainerChoiceMode[]; readonly descriptionZh: string; readonly step?: number; readonly stepCount?: number }): void;
  /** 选择对手备战区的 1 只「宝可梦V」与战斗宝可梦互换。 */
  startOpponentVSwitch(descriptionZh: string, step?: number, stepCount?: number): void;
  /**
   * 「莉佳的邀请」：把对手手牌作为私人候选展示给使用者，可选中基础宝可梦
   * 放于对手备战区并互换；候选只发给选择者。
   */
  startOpponentHandChoice(options: { readonly descriptionZh: string }): void;
}

export interface TrainerEffect {
  canPlay(context: TrainerCanPlayContext): TrainerCanPlayResult;
  play(context: TrainerPlayContext): void;
}

/**
 * 宝可梦道具的持续效果；只有登记过的道具才能附着。道具不写入卡面文字之外
 * 的状态：HP 修正由视图与昏厥判定即时计算，道具本身保持附着。
 */
export interface ToolEffect {
  maxHpBonus(target: CatalogCard): number;
}

/** 特性可用性上下文：只提供公开可见条件，不读取隐藏区域内容。 */
export interface AbilityCanUseContext {
  readonly seat: MatchSeat;
  readonly card: CatalogCard;
  readonly ability: CatalogAbility;
  /** 这只宝可梦当前是否在战斗场上（如「战栗冷气」的发动条件）。 */
  isActive(): boolean;
  /** 这只宝可梦本回合是否已经使用过同名特性。 */
  usedThisTurn(): boolean;
  ownBenchCount(): number;
  ownDeckCount(): number;
  /** 自己当前手牌张数（「再起动」等的公开条件）。 */
  ownHandCount(): number;
  /**
   * 自己场上拥有指定招式名的宝可梦（含战斗场与备战区）；
   * 「海之伴奏」按此筛选附着目标，也是可否使用该特性的公开条件。
   */
  ownPokemonWithAttack(attackName: string): readonly { readonly slot: 'active' | 'bench'; readonly index: number; readonly nameZh: string }[];
}

export interface AbilityUseContext extends AbilityCanUseContext {
  /** 公开掷硬币；只在效果真正执行时调用，拒绝路径不得消耗随机。 */
  flipCoin(cardNameZh: string): 'heads' | 'tails';
  startDeckSearch(options: {
    readonly filter: TrainerCardFilter;
    readonly min: number;
    readonly max: number;
    readonly destination: 'hand' | 'bench';
    readonly descriptionZh: string;
    readonly followUp?: EffectFollowUp | null;
  }): void;
  /** 从牌库顶抽牌直到手牌达到 `size` 张（「再起动」）。 */
  drawUntilHandSize(size: number): void;
  /** 以模式选择表示多个可选目标（「海之伴奏」的附着目标）。 */
  startModeChoice(options: { readonly modes: readonly TrainerChoiceMode[]; readonly descriptionZh: string }): void;
}

/** 持续效果特性的最大 HP 修正上下文；只提供公开的附着能量属性。 */
export interface AbilityMaxHpContext {
  readonly card: CatalogCard;
  readonly attachedEnergyTypes: readonly (string | null)[];
}

export interface AbilityEffect {
  /** 主动使用效果的可用性；持续效果可以省略（如「营养铁质」）。 */
  canUse?(context: AbilityCanUseContext): TrainerCanPlayResult;
  use?(context: AbilityUseContext): void;
  /** 持续效果：最大 HP 修正（如「营养铁质」的 3 个以上[钢]能量时 +100）。 */
  maxHpBonus?(context: AbilityMaxHpContext): number;
  /** 「在自己的回合可以使用任意次」的特性不受每回合 1 次记账限制。 */
  repeatable?: boolean;
}

/** 特性注册键：效果身份 + 特性名。 */
export function abilityEffectKey(effectIdentity: string, abilityName: string): string {
  return `${effectIdentity}#${abilityName}`;
}

/**
 * 竞技场 `canUse` 上下文。不提供查询牌库内容的接口：宣告使用竞技场效果时
 * 不能以隐藏区域的内容作为可否使用的条件（冻结 H：允许检索失败；
 * 冻结 B-04：只有使用前就能判断没有任何情况变化时才不能使用）。牌库张数
 * 对双方公开，因此 `ownDeckCount()` 可用于判断空牌库这种公开的无效情形。
 */
export interface StadiumCanUseContext {
  readonly seat: MatchSeat;
  readonly card: CatalogCard;
  ownBenchCount(): number;
  ownDeckCount(): number;
}

export interface StadiumUseContext extends StadiumCanUseContext, TrainerPlayContext {}

export interface StadiumEffect {
  canUse(context: StadiumCanUseContext): TrainerCanPlayResult;
  use(context: StadiumUseContext): void;
}

interface StadiumState {
  readonly seat: MatchSeat;
  readonly card: CardInstance;
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
  /**
   * 以修改后的基础伤害走完整的「基础伤害 → 弱点 → 抵抗」结算；
   * 供「极巨和弦」这类印刷伤害为 `70+` 的招式使用。
   */
  dealDamageWithBase(baseDamage: number): void;
  /** 自己当前手牌张数（「循环抽取」等招式效果）。 */
  ownHandCount(): number;
  /** 对手备战区宝可梦数量（「刺穿」等选择部分备战目标的招式）。 */
  opponentBenchCount(): number;
  /** 当前战斗宝可梦身上附着的指定属性能量数量（「月亮强念」按[超]能量计数）。 */
  attachedEnergyCountOfActive(type: string): number;
  /** 从自己手牌选择若干张放于弃牌区（「循环抽取」的弃 1 张）。 */
  startDiscardHand(options: {
    readonly min: number;
    readonly max: number;
    readonly descriptionZh: string;
    readonly followUp: EffectFollowUp | null;
  }): void;
  /** 选择对手备战区的 1 只宝可梦作为效果目标（「刺穿」）。 */
  startChooseOpponentBench(options: { readonly descriptionZh: string; readonly followUp: EffectFollowUp }): void;
  /** 选择对手战斗宝可梦拥有的 1 个招式（「基因侵入」）。 */
  startChooseOpponentAttack(options: { readonly descriptionZh: string }): void;
  /**
   * 自己备战宝可梦的属性列表（按备战区序号）；「极巨和弦」按属性种类加伤。
   */
  ownBenchTypes(): readonly (string | null)[];
  /**
   * 从自己场上宝可梦附着的能量中选择任意数量放于弃牌区；
   * 选择完成后按 `followUp` 续接（如按张数计算伤害）并结算回合。
   */
  startDiscardAttachedEnergy(options: {
    readonly type: string;
    readonly basicOnly: boolean;
    readonly min: number;
    readonly max: number | null;
    readonly descriptionZh: string;
    readonly followUp: EffectFollowUp;
  }): void;
  /**
   * 从手牌选择 1 张可附着的能量，附着于所选备战宝可梦并回复其 `heal` 点 HP；
   * 没有可附着的能量或没有备战宝可梦时，招式按“无效果”处理并结束回合。
   */
  startAttachHandEnergyToBench(options: { readonly heal: number; readonly descriptionZh?: string }): void;
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
 * 招式结算的登记结果：暂存操作、延迟计划与基础伤害。
 * `deferredPlan` 非 null 时所有选择完成前不应用任何状态（原子性）。
 */
interface PreparedAttackEffect {
  readonly staged: readonly StagedAttackOperation[];
  readonly deferredPlan: (() => void) | null;
  readonly eventBaseDamage: number | null;
  /** 「造成伤害」暂存的实际最终伤害（未声明基础伤害时用于公开事件）。 */
  readonly basicDamage: number | null;
  readonly basicBaseDamage: number | null;
  readonly basicFinalDamage: number;
}

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
  readonly trainerEffects: ReadonlyMap<string, TrainerEffect>;
  readonly stadiumEffects: ReadonlyMap<string, StadiumEffect>;
  readonly abilityEffects: ReadonlyMap<string, AbilityEffect>;
  readonly toolEffects: ReadonlyMap<string, ToolEffect>;
  /** 场上的竞技场卡（双方共用）；没有时为 null。 */
  stadium: StadiumState | null;
  /**
   * 攻击效果已创建待决选择：在所有选择完成前不结算昏厥、不结束回合；
   * 选择流程完成后由续接动作收尾。
   */
  /**
   * 进行中的延迟招式。这里的上下文只在本次招式结算期间存在：招式结束后必须
   * 由终止路径（结算完成/无效果收招）清空，不能带入下一个回合。
   */
  deferredAttack: { readonly seat: MatchSeat; readonly attackName: string } | null;
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
  /** 训练家卡效果注册表；未注册的卡牌以 `unsupported-card` 拒绝。 */
  readonly trainerEffects?: ReadonlyMap<string, TrainerEffect>;
  /** 竞技场效果注册表；未注册的竞技场不能使用其效果。 */
  readonly stadiumEffects?: ReadonlyMap<string, StadiumEffect>;
  /** 特性效果注册表；未注册的特性不可使用（目录同步标为未接入）。 */
  readonly abilityEffects?: ReadonlyMap<string, AbilityEffect>;
  /** 宝可梦道具效果注册表；未注册的道具不能附着。 */
  readonly toolEffects?: ReadonlyMap<string, ToolEffect>;
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

/** 训练家效果检索筛选：不依赖卡名或卡图，只按已核实的目录字段判断。 */
function matchesTrainerFilter(definition: CatalogCard, filter: TrainerCardFilter): boolean {
  if (filter.cardClass !== undefined && definition.cardClass !== filter.cardClass) {
    return false;
  }
  if (filter.basicOnly === true && !(definition.cardClass === 'pokemon' && definition.subtypes.includes('基础'))) {
    return false;
  }
  if (filter.noRule === true && definition.specialRuleTextZh !== null) {
    return false;
  }
  if (filter.maxHp !== undefined && (definition.hp === null || definition.hp > filter.maxHp)) {
    return false;
  }
  if (filter.basicEnergyOnly === true && !isBasicEnergy(definition)) {
    return false;
  }
  if (filter.itemOnly === true && !(definition.cardClass === 'trainer' && definition.effectiveCategory === '物品')) {
    return false;
  }
  if (filter.energyType !== undefined && definition.type !== filter.energyType) {
    return false;
  }
  if (filter.subtype !== undefined && !definition.subtypes.includes(filter.subtype)) {
    return false;
  }
  if (filter.type !== undefined && definition.type !== filter.type) {
    return false;
  }
  return true;
}

/**
 * 是否为「宝可梦V」：由卡面印刷的 V / VMAX 规则文字判定，不使用卡名猜测。
 *
 * 冻结证据（截止日前官方简中文章 product/15732，2024-08-23）：介绍怰响VSTAR
 * 卡组时写明「配合道具卡『讲究腰带』和光耀掉角鹰人，甚至可以给对方的宝可梦
 * VMAX 造成 370 点伤害」。「讲究腰带」（Choice Belt）的效果是对对手战斗宝
 * 可梦「宝可梦V」+30；该官方文章将 VMAX 作为该效果的适用对象，因此 VMAX
 * 打印的 `VMAX规则` 也视为「宝可梦V」。
 *
 * VSTAR 仍无同等的截止日前官方简中定义证据：官方文章把 VSTAR 写作另一
 * 类卡而未给出「宝可梦V」条件，故 `VSTAR规则` 暂不匹配；待冻结来源明确后
 * 再扩展，不按卡名推断。
 */
export function isPokemonVCard(definition: CatalogCard): boolean {
  return (
    definition.cardClass === 'pokemon' &&
    definition.specialRuleTextZh !== null &&
    (definition.specialRuleTextZh.includes('V规则') || definition.specialRuleTextZh.includes('VMAX规则'))
  );
}

/** 是否为印刷了 VMAX 规则的宝可梦（奖赏价值同样只从印刷数字读取）。 */
export function isPokemonVmaxCard(definition: CatalogCard): boolean {
  return (
    definition.cardClass === 'pokemon' &&
    definition.specialRuleTextZh !== null &&
    definition.specialRuleTextZh.includes('VMAX规则')
  );
}

/** 是否为印刷了 VSTAR 规则的宝可梦。 */
export function isPokemonVstarCard(definition: CatalogCard): boolean {
  return (
    definition.cardClass === 'pokemon' &&
    definition.specialRuleTextZh !== null &&
    definition.specialRuleTextZh.includes('VSTAR规则')
  );
}

/**
 * 是否为「拥有规则的宝可梦」（进阶指南 D-18）：卡面写有“…（的）规则”。
 * 只读印刷规则文字，不按卡名或类别竞猜。
 */
export function isRuleBoxPokemon(definition: CatalogCard): boolean {
  return definition.cardClass === 'pokemon' && definition.specialRuleTextZh !== null;
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
  'discard-hand',
  'search-deck',
  'choose-mode',
  'switch-opponent',
  'choose-own-bench',
  'attach-hand-energy',
  'discard-energy',
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
        supporterUsedThisTurn: false,
        stadiumPlayedThisTurn: false,
        stadiumUsedThisTurn: false,
        koDuringLastOpponentTurn: false,
        koSufferedThisTurn: false,
        ownTurnsStarted: 0,
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
      trainerEffects: config.trainerEffects ?? new Map(),
      stadiumEffects: config.stadiumEffects ?? new Map(),
      abilityEffects: config.abilityEffects ?? new Map(),
      toolEffects: config.toolEffects ?? new Map(),
      stadium: null,
      deferredAttack: null,
      players,
    };
    this.pushEvent({ type: 'match-created', seats: [players[0].nickname, players[1].nickname] });
    // 猜拳的公平替代：服务端随机决定谁获得先后攻选择权。
    const winner: MatchSeat = config.random.nextInt(2) === 0 ? 0 : 1;
    this.pushEvent({ type: 'turn-order-flip', winner });
    this.state.pending = this.newChoice('turn-order', winner, {
      min: 1,
      max: 1,
      descriptionZh: '服务端猜拳由你获得先后攻选择权：请选择先攻或后攻。',
    });
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
      stadium: state.stadium === null ? null : this.cardView(state.stadium.card),
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

  /**
   * 外部原因终止（断线超限）：只生成一次权威终态并递增版本；已有终态时返回
   * null，不覆盖任何结果。冻结三项败北条件之外的网络原因不改动胜负条件表。
   */
  public finishExternal(winner: MatchSeat | null, reason: MatchFinishReason): MatchResultView | null {
    if (this.state.result !== null) {
      return null;
    }
    this.finishMatch(winner, reason, []);
    this.state.version += 1;
    return this.result;
  }

  /* ---------------- 选择与事件 ---------------- */

  private newChoice(
    kind: PendingChoice['kind'],
    seat: MatchSeat,
    fields: {
      readonly min: number;
      readonly max: number;
      readonly benchMin?: number;
      readonly benchMax?: number;
      readonly candidates?: readonly number[];
      readonly step?: number;
      readonly stepCount?: number;
      readonly source?: MatchChoiceSource;
      readonly descriptionZh: string;
      readonly cardCandidates?: readonly ChoiceCandidate[];
      readonly modes?: readonly ChoiceMode[];
      readonly followUp?: TrainerFollowUp | null;
      readonly consumeStadiumUse?: boolean;
      readonly destination?: 'hand' | 'bench' | 'opponent-bench' | null;
      readonly deferShuffle?: boolean;
    },
  ): PendingChoice {
    this.state.nextChoiceSeq += 1;
    return {
      kind,
      seat,
      choiceId: `choice-${this.state.nextChoiceSeq}`,
      min: fields.min,
      max: fields.max,
      benchMin: fields.benchMin ?? 0,
      benchMax: fields.benchMax ?? 0,
      candidates: [...(fields.candidates ?? [])],
      step: fields.step ?? 1,
      stepCount: fields.stepCount ?? fields.step ?? 1,
      source: fields.source ?? 'none',
      descriptionZh: fields.descriptionZh,
      cardCandidates: (fields.cardCandidates ?? []).map((candidate) => ({ ...candidate })),
      modes: (fields.modes ?? []).map((mode) => ({ ...mode })),
      followUp: fields.followUp ?? null,
      consumeStadiumUse: fields.consumeStadiumUse ?? false,
      destination: fields.destination ?? null,
      deferShuffle: fields.deferShuffle ?? false,
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
      evolvesFrom: definition.evolvesFrom,
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

  /** 计入附着道具、宝可梦道具与持续效果特性后的最大 HP；昏厥判定与界面共用同一来源。 */
  private maxHpOf(pokemon: PokemonState): number {
    const definition = this.definitionOf(pokemon.card);
    let maxHp = definition.hp ?? 0;
    for (const tool of pokemon.tools) {
      const toolDefinition = this.definitionOf(tool);
      const effect = this.state.toolEffects.get(toolDefinition.identities.effectIdentity);
      if (effect !== undefined) {
        maxHp += effect.maxHpBonus(definition);
      }
    }
    // 持续效果特性（如「营养铁质」）按当前公开的附着能量即时计算；
    // 不写入额外状态，能量增减后下一处计算自然使用新值。
    const attachedEnergyTypes = pokemon.energies.map((energy) => this.definitionOf(energy).type);
    for (const ability of definition.abilities) {
      const effect = this.state.abilityEffects.get(abilityEffectKey(definition.identities.effectIdentity, ability.name));
      if (effect?.maxHpBonus !== undefined) {
        const bonus = effect.maxHpBonus({ card: definition, attachedEnergyTypes });
        if (!Number.isSafeInteger(bonus) || bonus < 0) {
          throw new MatchEngineError('illegal-choice', `特性「${ability.name}」的 HP 修正值 ${bonus} 非法。`);
        }
        maxHp += bonus;
      }
    }
    return maxHp;
  }

  /**
   * 特性投影：`supported` 只取决于注册表；`usable` 综合回合、次数与卡面条件，
   * 不可用时必须给出可读原因。对手场上的特性也如实投影公开信息。
   */
  private abilityViewsFor(pokemon: PokemonState): readonly MatchAbilityView[] {
    const definition = this.definitionOf(pokemon.card);
    return definition.abilities.map((ability, index) => {
      const supported = this.state.abilityEffects.has(abilityEffectKey(definition.identities.effectIdentity, ability.name));
      if (!supported) {
        return {
          index,
          labelZh: ability.label,
          name: ability.name,
          textZh: ability.text,
          supported: false,
          usable: false,
          unusableReasonZh: '这个特性的效果尚未接入。',
        };
      }
      if (this.state.result !== null) {
        return { index, labelZh: ability.label, name: ability.name, textZh: ability.text, supported: true, usable: false, unusableReasonZh: '对局已经结束。' };
      }
      if (this.state.phase !== 'playing' || this.state.activeSeat !== pokemon.seat) {
        return { index, labelZh: ability.label, name: ability.name, textZh: ability.text, supported: true, usable: false, unusableReasonZh: '现在不是这只宝可梦的持有者的回合。' };
      }
      const effect = this.state.abilityEffects.get(abilityEffectKey(definition.identities.effectIdentity, ability.name)) as AbilityEffect;
      if (effect.canUse === undefined || effect.use === undefined) {
        // 持续效果特性：条件满足时自动生效，不存在主动使用动作。
        return { index, labelZh: ability.label, name: ability.name, textZh: ability.text, supported: true, usable: false, unusableReasonZh: '这是持续效果，满足条件时自动生效，不需要使用。' };
      }
      if (effect.repeatable !== true && pokemon.abilitiesUsedThisTurn.has(ability.name)) {
        return { index, labelZh: ability.label, name: ability.name, textZh: ability.text, supported: true, usable: false, unusableReasonZh: '这个特性在本回合已经使用过。' };
      }
      const canUse = effect.canUse(this.abilityCanUseContext(pokemon, definition, ability));
      return canUse.ok
        ? { index, labelZh: ability.label, name: ability.name, textZh: ability.text, supported: true, usable: true, unusableReasonZh: null }
        : { index, labelZh: ability.label, name: ability.name, textZh: ability.text, supported: true, usable: false, unusableReasonZh: canUse.message };
    });
  }

  private pokemonView(pokemon: PokemonState): MatchPokemonView {
    const definition = this.definitionOf(pokemon.card);
    const evolution = this.evolutionEligibility(pokemon);
    return {
      card: this.cardView(pokemon.card),
      damageCounters: pokemon.damageCounters,
      statuses: [...pokemon.statuses],
      energies: pokemon.energies.map((energy, index) => ({ energyIndex: index, card: this.cardView(energy) })),
      tools: pokemon.tools.map((tool) => this.cardView(tool)),
      maxHp: this.maxHpOf(pokemon),
      attacks: this.attackViewsFor(definition),
      abilities: this.abilityViewsFor(pokemon),
      canEvolve: evolution.canEvolve,
      evolveBlockedReasonZh: evolution.reason,
      retreatCost: definition.retreat ?? 0,
      weakness: definition.weakness,
      resistance: definition.resistance,
    };
  }

  /** 仅按规则时机判断能否接受进化；手牌中是否有对应进化卡由客户端比对卡名。 */
  private evolutionEligibility(pokemon: PokemonState): { readonly canEvolve: boolean; readonly reason: string | null } {
    if (this.state.result !== null) {
      return { canEvolve: false, reason: '对局已经结束。' };
    }
    if (this.state.phase !== 'playing') {
      return { canEvolve: false, reason: '对战尚未开始。' };
    }
    if (this.state.activeSeat !== pokemon.seat) {
      return { canEvolve: false, reason: '现在不是这只宝可梦的持有者的回合。' };
    }
    if (this.state.players[pokemon.seat].ownTurnsStarted <= 1) {
      return { canEvolve: false, reason: '双方玩家在自己的最初回合不能进行进化。' };
    }
    if (pokemon.enteredTurn === this.state.turn) {
      return { canEvolve: false, reason: '刚刚出场的宝可梦在这个回合不能进化。' };
    }
    if (pokemon.evolvedTurn === this.state.turn) {
      return { canEvolve: false, reason: '刚刚进化过的宝可梦在这个回合不能再次进化。' };
    }
    return { canEvolve: true, reason: null };
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
      supporterUsedThisTurn: player.supporterUsedThisTurn,
      stadiumPlayedThisTurn: player.stadiumPlayedThisTurn,
      stadiumUsedThisTurn: player.stadiumUsedThisTurn,
      koDuringLastOpponentTurn: player.koDuringLastOpponentTurn,
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
      step: pending.step,
      stepCount: pending.stepCount,
      source: pending.source,
      descriptionZh: pending.descriptionZh,
      cardCandidates: pending.cardCandidates.map(
        (candidate): MatchChoiceCandidateView => ({
          candidateId: candidate.candidateId,
          card: this.cardView(candidate.card),
          selectable: candidate.selectable,
          targetLabelZh: candidate.targetLabelZh,
        }),
      ),
      modes: pending.modes.map(
        (mode): MatchChoiceModeView => ({
          modeId: mode.modeId,
          labelZh: mode.labelZh,
          available: mode.available,
          unavailableReasonZh: mode.unavailableReasonZh,
        }),
      ),
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
    readonly descriptionZh: string;
  } {
    return {
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 5,
      candidates: this.basicHandIndices(seat),
      descriptionZh: '请从手牌选择 1 张基础宝可梦作为战斗宝可梦，并可选择至多 5 张基础宝可梦放入备战区（可少放或不放）。',
    };
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
      evolutionStack: [],
      damageCounters: 0,
      energies: [],
      tools: [],
      statuses: new Set(),
      paralysisRecoversAfterTurn: null,
      enteredTurn,
      evolvedTurn: null,
      abilitiesUsedThisTurn: new Set(),
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
        descriptionZh: `对手单独重抽了 ${max} 次，你可以补抽 0 到 ${max} 张（也可选择不补抽）。`,
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
      descriptionZh: `还可以把选中的基础宝可梦盖放到备战区（最多 ${max} 张，也可跳过）。`,
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
      case 'discard-hand':
        this.resolveDiscardHand(seat, command.handIndices);
        break;
      case 'search-deck':
        this.resolveSearchDeck(seat, command.candidateIds);
        break;
      case 'choose-mode':
        this.resolveModeChoice(seat, command.modeId);
        break;
      case 'switch-opponent':
        this.resolveOpponentSwitch(seat, command.benchIndex);
        break;
      case 'choose-own-bench':
        this.resolveChooseOwnBench(seat, command.benchIndex);
        break;
      case 'attach-hand-energy':
        this.resolveAttachHandEnergy(seat, command.candidateId);
        break;
      case 'discard-energy':
        this.resolveDiscardEnergy(seat, command.candidateIds);
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
      case 'play-trainer':
        this.playTrainer(seat, command.handIndex);
        break;
      case 'use-stadium':
        this.useStadium(seat);
        break;
      case 'evolve':
        this.evolve(seat, command.handIndex, command.target);
        break;
      case 'use-ability':
        this.useAbility(seat, command.target, command.abilityIndex);
        break;
      case 'attach-tool':
        this.attachTool(seat, command.handIndex, command.target);
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
    // 「上一个对手的回合」条件在轮到该座位时结转：自己在对手刚结束的回合中
    // 是否发生昏厥；结转后再清空本回合的昏厥记录，避免跨回合误用条件卡。
    // 宝可梦检查发生在双方回合之外（冻结 F），检查造成的昏厥不写入该记录。
    this.state.players[seat].koDuringLastOpponentTurn = this.state.players[seat].koSufferedThisTurn;
    // 每回合标记只属于当前回合：双方都在新回合开始重置，避免等待方显示旧标记。
    this.state.players[seat].ownTurnsStarted += 1;
    for (const player of this.state.players) {
      player.energyAttachedThisTurn = false;
      player.retreatedThisTurn = false;
      player.supporterUsedThisTurn = false;
      player.stadiumPlayedThisTurn = false;
      player.stadiumUsedThisTurn = false;
      player.koSufferedThisTurn = false;
      // “在自己的回合可以使用 1 次”的特性按每只宝可梦每回合计数；
      // 自己的回合开始时清除，新进场的宝可梦自然不继承旧限制。
      for (const pokemon of [player.active, ...player.bench]) {
        pokemon?.abilitiesUsedThisTurn.clear();
      }
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
    const prepared = this.prepareAttackEffect(seat, attacker, attackerDefinition, attack, defenderSeat, defender, attackerDefinition);
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
    if (prepared.deferredPlan !== null) {
      // 延迟效果在所有验证与【混乱】硬币之后才创建待决选择或立即结算。
      this.state.deferredAttack = { seat, attackName: attack.name };
      prepared.deferredPlan();
      return;
    }
    this.applyPreparedAttack(seat, attack, attackerDefinition, defenderSeat, defender, prepared);
  }

  /** 招式效果是否已接入：注册了解析器，或为无说明文的固定伤害招式。 */
  private isAttackSupported(definition: CatalogCard, attack: CatalogAttack): boolean {
    const resolver = this.state.attackEffects.get(attackEffectKey(definition.identities.effectIdentity, attack.name));
    return resolver !== undefined || (!attackHasEffectText(attack) && parseBaseDamage(attack.damage) !== null);
  }

  /**
   * 登记招式结算：只登记纯数据操作，不立即改动状态；回调全部返回后才统一应用。
   * 目标、数量、单次与累计溢出都在登记时校验，因此任何一步失败都不会留下
   * 部分伤害、公开事件或标记。登记与基础伤害校验都必须先于【混乱】硬币。
   *
   * `effectDefinition` 提供招式效果身份与说明文；「基因侵入」复制对手招式时
   * 传入对手卡，而 `attackerDefinition` 仍是实际使用招式的自己宝可梦。
   */
  private prepareAttackEffect(
    seat: MatchSeat,
    attacker: PokemonState,
    attackerDefinition: CatalogCard,
    attack: CatalogAttack,
    defenderSeat: MatchSeat,
    defender: PokemonState,
    effectDefinition: CatalogCard,
  ): PreparedAttackEffect {
    const resolver = this.state.attackEffects.get(attackEffectKey(effectDefinition.identities.effectIdentity, attack.name));
    const baseDamage = parseBaseDamage(attack.damage);
    if (resolver === undefined && (attackHasEffectText(attack) || baseDamage === null)) {
      throw new MatchEngineError('unsupported-card', `招式「${attack.name}」的效果尚未接入，不能使用。`);
    }
    if (resolver === undefined) {
      // 基础伤害路径同样在硬币之前完成放置校验（含累计溢出）。
      const basicFinalDamage = this.finalDamage(attackerDefinition, defender, baseDamage as number);
      if (basicFinalDamage > 0) {
        this.damageCountersForPlacement(defender, basicFinalDamage);
      }
      return { staged: [], deferredPlan: null, eventBaseDamage: null, basicDamage: null, basicBaseDamage: baseDamage, basicFinalDamage };
    }
    const staged: StagedAttackOperation[] = [];
    /** 延迟到【混乱】硬币之后才执行的攻击效果计划（如需要玩家选择）。 */
    let deferredPlan: (() => void) | null = null;
    /** 事件中记录的本次招式基础伤害；只有 `dealDamageWithBase` 会设置并触发公开记录。 */
    let eventBaseDamage: number | null = null;
    /** 「造成伤害」暂存的实际最终伤害；供未声明基础伤害的招式公开记录使用。 */
    let basicDamage: number | null = null;
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
          basicDamage = finalDamage;
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
      dealDamageWithBase: (value) => {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new MatchEngineError('illegal-choice', `基础伤害 ${value} 必须是非负整数。`);
        }
        eventBaseDamage = value;
        const adjusted = this.finalDamage(attackerDefinition, defender, value);
        if (adjusted > 0) {
          stageDamage(defenderSeat, defender, adjusted);
        }
      },
      ownBenchTypes: () => this.state.players[seat].bench.map((pokemon) => this.definitionOf(pokemon.card).type),
      ownHandCount: () => this.state.players[seat].hand.length,
      opponentBenchCount: () => this.state.players[defenderSeat].bench.length,
      attachedEnergyCountOfActive: (type) =>
        attacker.energies.filter((energy) => this.definitionOf(energy).type === type).length,
      startDiscardAttachedEnergy: (options) => {
        deferredPlan = () => this.startDiscardAttachedEnergyChoice(seat, attack.name, options);
      },
      startAttachHandEnergyToBench: (options) => {
        deferredPlan = () => this.startAttachHandEnergyToBench(seat, attack.name, options);
      },
      startDiscardHand: (options) => {
        deferredPlan = () => this.startDiscardChoice(seat, options);
      },
      startChooseOpponentBench: (options) => {
        deferredPlan = () => this.startOpponentBenchChoice(seat, options);
      },
      startChooseOpponentAttack: (options) => {
        deferredPlan = () => this.startOpponentAttackChoice(seat, options);
      },
    });
    if (deferredPlan !== null && staged.length > 0) {
      // 延迟效果必须完全依赖后续选择；不允许同一招式先改状态再等待输入。
      throw new MatchEngineError('illegal-choice', '这个招式的延迟效果不能与立即结算混合。');
    }
    return { staged, deferredPlan, eventBaseDamage, basicDamage, basicBaseDamage: null, basicFinalDamage: 0 };
  }

  /** 按登记结果应用招式：应用暂存操作、公开 attack-used 并结算昏厥与回合。 */
  private applyPreparedAttack(
    seat: MatchSeat,
    attack: CatalogAttack,
    attackerDefinition: CatalogCard,
    defenderSeat: MatchSeat,
    defender: PokemonState,
    prepared: PreparedAttackEffect,
  ): void {
    if (prepared.basicBaseDamage !== null) {
      this.pushEvent({ type: 'attack-used', seat, attackName: attack.name, baseDamage: prepared.basicBaseDamage, damage: prepared.basicFinalDamage });
      if (prepared.basicFinalDamage > 0) {
        this.placeDamageCounters(defenderSeat, defender, prepared.basicFinalDamage, seat);
      }
      this.settleKnockOuts('end-turn');
      return;
    }
    for (const operation of prepared.staged) {
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
    const resolvedDamage =
      prepared.eventBaseDamage !== null && prepared.eventBaseDamage > 0
        ? this.finalDamage(attackerDefinition, defender, prepared.eventBaseDamage)
        : (prepared.basicDamage ?? 0);
    // 只要招式登记了实际结算（伤害/状态/标记/抽牌）或声明了基础伤害，就公开
    // attack-used；完全无效果的收招（如复制到无效果招式）不产生事件。
    if (prepared.eventBaseDamage !== null || prepared.staged.length > 0 || parseBaseDamage(attack.damage) !== null) {
      this.pushEvent({
        type: 'attack-used',
        seat,
        attackName: attack.name,
        baseDamage: prepared.eventBaseDamage ?? parseBaseDamage(attack.damage) ?? 0,
        damage: resolvedDamage,
      });
    }
    this.settleKnockOuts('end-turn');
  }

  /**
   * 「基因侵入」的复制计划：只读校验并登记暂存操作，不修改任何状态、
   * 不消费待决选择；失败时调用方保持原状态不变（原子性）。
   */
  private planCopiedAttack(
    seat: MatchSeat,
    copiedDefinition: CatalogCard,
    attack: CatalogAttack,
  ): {
    readonly attackerDefinition: CatalogCard;
    readonly defenderSeat: MatchSeat;
    readonly defender: PokemonState;
    readonly prepared: PreparedAttackEffect;
  } {
    const player = this.state.players[seat];
    const attacker = player.active;
    if (attacker === null) {
      throw new MatchEngineError('illegal-target', '战斗场没有宝可梦，无法使用复制的招式。');
    }
    const defenderSeat = otherSeat(seat);
    const defender = this.state.players[defenderSeat].active;
    if (defender === null) {
      throw new MatchEngineError('illegal-target', '对手战斗场没有宝可梦，无法使用复制的招式。');
    }
    const attackerDefinition = this.definitionOf(attacker.card);
    const prepared = this.prepareAttackEffect(seat, attacker, attackerDefinition, attack, defenderSeat, defender, copiedDefinition);
    return { attackerDefinition, defenderSeat, defender, prepared };
  }

  /**
   * 应用已验证的复制计划。延迟路径把上下文切换为被复制招式，完成后续选择后
   * 由 `finishDeferredAttack` 收招；立即路径先清空「基因侵入」的延迟上下文，
   * 再应用伤害并结束回合，避免旧上下文残留到下一个回合。
   */
  private commitCopiedAttack(
    seat: MatchSeat,
    attack: CatalogAttack,
    plan: {
      readonly attackerDefinition: CatalogCard;
      readonly defenderSeat: MatchSeat;
      readonly defender: PokemonState;
      readonly prepared: PreparedAttackEffect;
    },
  ): void {
    if (plan.prepared.deferredPlan !== null) {
      this.state.deferredAttack = { seat, attackName: attack.name };
      plan.prepared.deferredPlan();
      return;
    }
    this.state.deferredAttack = null;
    this.applyPreparedAttack(seat, attack, plan.attackerDefinition, plan.defenderSeat, plan.defender, plan.prepared);
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

  /* ---------------- 训练家卡与竞技场效果 ---------------- */

  /**
   * 使用手牌中的训练家卡：类别限制（物品不限张数、支援者每回合 1 张且先攻
   * 首回合禁用、竞技场每回合 1 张且不能同名）与卡牌自身条件全部先于任何
   * 状态修改；未注册效果的卡以 `unsupported-card` 拒绝。
   */
  private playTrainer(seat: MatchSeat, handIndex: number): void {
    const player = this.state.players[seat];
    if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
      throw new MatchEngineError('illegal-target', '手牌序号无效。');
    }
    const card = player.hand[handIndex] as CardInstance;
    const definition = this.definitionOf(card);
    if (definition.cardClass !== 'trainer') {
      throw new MatchEngineError('illegal-target', '只有训练家卡可以这样使用。');
    }
    const category = definition.effectiveCategory;
    if (category !== '物品' && category !== '支援者' && category !== '竞技场') {
      throw new MatchEngineError(
        'unsupported-card',
        `${definition.nameZh} 的类别（${category ?? '未知'}）尚未接入，不能使用。`,
      );
    }
    const effect = this.state.trainerEffects.get(definition.identities.effectIdentity);
    if (effect === undefined) {
      throw new MatchEngineError('unsupported-card', `${definition.nameZh} 的效果尚未接入，不能使用。`);
    }
    if (category === '支援者') {
      if (this.isFirstPlayersFirstTurn(seat)) {
        throw new MatchEngineError('action-not-allowed', '先攻玩家在自己的最初回合不能使用支援者卡。');
      }
      if (player.supporterUsedThisTurn) {
        throw new MatchEngineError('action-not-allowed', '每个自己的回合只能使用 1 张支援者卡。');
      }
    }
    if (category === '竞技场') {
      if (player.stadiumPlayedThisTurn) {
        throw new MatchEngineError('action-not-allowed', '每个自己的回合只能将 1 张竞技场卡放于场上。');
      }
      const current = this.state.stadium;
      if (current !== null && this.definitionOf(current.card).identities.nameGroupKey === definition.identities.nameGroupKey) {
        throw new MatchEngineError('action-not-allowed', `场上已经有一张同名的竞技场卡「${definition.nameZh}」。`);
      }
    }
    const context = this.trainerContext(seat, card);
    const canPlay = effect.canPlay(context);
    if (!canPlay.ok) {
      throw new MatchEngineError(canPlay.code, canPlay.message);
    }
    // 全部验证通过后才消耗手牌、向对手公开并进入弃牌区/竞技场区。
    player.hand = player.hand.filter((_entry, index) => index !== handIndex);
    this.pushEvent({ type: 'trainer-played', seat, card: this.cardView(card) });
    if (category === '支援者') {
      player.supporterUsedThisTurn = true;
      player.discard.push(card);
    } else if (category === '竞技场') {
      player.stadiumPlayedThisTurn = true;
      this.placeStadium(seat, card);
    } else {
      player.discard.push(card);
    }
    effect.play(this.trainerContext(seat, card));
  }

  /**
   * 使用场上竞技场的效果：每名玩家每回合 1 次，且只对已注册效果的竞技场开放。
   * 没有目标时拒绝且不消耗本回合次数（失败不改变状态）。
   */
  private useStadium(seat: MatchSeat): void {
    const player = this.state.players[seat];
    if (player.stadiumUsedThisTurn) {
      throw new MatchEngineError('action-not-allowed', '本回合已经使用过竞技场效果。');
    }
    const stadium = this.state.stadium;
    if (stadium === null) {
      throw new MatchEngineError('action-not-allowed', '场上没有竞技场卡。');
    }
    const definition = this.definitionOf(stadium.card);
    const effect = this.state.stadiumEffects.get(definition.identities.effectIdentity);
    if (effect === undefined) {
      throw new MatchEngineError('unsupported-card', `${definition.nameZh} 的竞技场效果尚未接入，不能使用。`);
    }
    const context = this.trainerContext(seat, stadium.card);
    const canUse = effect.canUse(context);
    if (!canUse.ok) {
      throw new MatchEngineError(canUse.code, canUse.message);
    }
    effect.use(context);
  }

  /** 把竞技场卡放于场上；旧竞技场进入其所有者的弃牌区，使用次数按新卡重置。 */
  private placeStadium(seat: MatchSeat, card: CardInstance): void {
    const previous = this.state.stadium;
    let replaced: MatchCardView | null = null;
    if (previous !== null) {
      replaced = this.cardView(previous.card);
      this.state.players[previous.seat].discard.push(previous.card);
    }
    this.state.stadium = { seat, card };
    for (const player of this.state.players) {
      player.stadiumUsedThisTurn = false;
    }
    this.pushEvent({ type: 'stadium-placed', seat, card: this.cardView(card), replaced });
  }

  /** 当前卡牌上的效果接口：所有查询都读取即时权威状态，不缓存视图。 */
  private trainerContext(seat: MatchSeat, card: CardInstance): TrainerPlayContext {
    const definition = this.definitionOf(card);
    const player = this.state.players[seat];
    return {
      seat,
      card: definition,
      handCount: () => player.hand.length,
      otherHandCount: () => Math.max(0, player.hand.length - (player.hand.includes(card) ? 1 : 0)),
      ownBenchCount: () => player.bench.length,
      opponentBenchCards: () => {
        const opponent = this.state.players[otherSeat(seat)];
        return opponent.bench.map((pokemon, index) => ({ index, card: this.definitionOf(pokemon.card) }));
      },
      opponentHandCount: () => this.state.players[otherSeat(seat)].hand.length,
      opponentBenchCount: () => this.state.players[otherSeat(seat)].bench.length,
      opponentActiveCard: () => {
        const active = this.state.players[otherSeat(seat)].active;
        return active === null ? null : this.definitionOf(active.card);
      },
      koDuringLastOpponentTurn: () => player.koDuringLastOpponentTurn,
      ownDeckCount: () => player.deck.length,
      flipCoin: (cardNameZh) => {
        const result = this.flipCoin();
        this.pushEvent({ type: 'coin-flip', seat, cardNameZh, result });
        return result;
      },
      startDiscardChoice: (options) => this.startDiscardChoice(seat, options),
      startDeckSearch: (options) => this.startDeckSearch(seat, options),
      startTopDeckLook: (options) => this.startTopDeckLook(seat, options),
      drawUntilHandSize: (size) => this.drawUntilHandSize(seat, size),
      startModeChoice: (options) => this.startModeChoice(seat, options),
      startOpponentVSwitch: (descriptionZh, step, stepCount) => this.startOpponentVSwitch(seat, descriptionZh, step, stepCount),
      startOpponentHandChoice: (options) => this.startOpponentHandLook(seat, options),
    };
  }

  /* ---------------- 进化、特性与宝可梦道具 ---------------- */

  /**
   * 进化（冻结进阶指南 A-05）：从手牌使出与场上宝可梦名字链匹配的进化卡，
   * 覆盖在其上。伤害指示物、能量、宝可梦道具保留；特殊状态与受到的招式
   * 效果消除；双方的最初回合与刚出场/刚进化的当回合不能进化。
   */
  private evolve(seat: MatchSeat, handIndex: number, target: MatchPokemonRef): void {
    const player = this.state.players[seat];
    if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
      throw new MatchEngineError('illegal-target', '手牌序号无效。');
    }
    const evolutionCard = player.hand[handIndex] as CardInstance;
    const evolutionDefinition = this.definitionOf(evolutionCard);
    if (evolutionDefinition.cardClass !== 'pokemon' || evolutionDefinition.evolvesFrom === null) {
      throw new MatchEngineError('illegal-target', '只有进化宝可梦可以这样使出。');
    }
    const pokemon = this.ownPokemonAt(seat, target);
    const currentDefinition = this.definitionOf(pokemon.card);
    if (currentDefinition.cardClass !== 'pokemon') {
      throw new MatchEngineError('illegal-target', '目标不是宝可梦。');
    }
    if (currentDefinition.nameZh !== evolutionDefinition.evolvesFrom) {
      throw new MatchEngineError(
        'illegal-target',
        `「${evolutionDefinition.nameZh}」只能放于卡名为「${evolutionDefinition.evolvesFrom}」的宝可梦身上。`,
      );
    }
    if (player.ownTurnsStarted <= 1) {
      throw new MatchEngineError('action-not-allowed', '双方玩家在自己的最初回合不能进行进化。');
    }
    if (pokemon.enteredTurn === this.state.turn) {
      throw new MatchEngineError('action-not-allowed', '刚刚出场的宝可梦在这个回合不能进化。');
    }
    if (pokemon.evolvedTurn === this.state.turn) {
      throw new MatchEngineError('action-not-allowed', '刚刚进化过的宝可梦在这个回合不能再次进化。');
    }
    // 验证完成后原子地覆盖：旧卡进入进化堆叠，附着卡与伤害指示物保留。
    const previousNameZh = currentDefinition.nameZh;
    player.hand = player.hand.filter((_card, index) => index !== handIndex);
    pokemon.evolutionStack.push(pokemon.card);
    pokemon.card = evolutionCard;
    pokemon.evolvedTurn = this.state.turn;
    // 战斗宝可梦进化后，特殊状态与受到的招式效果全部消除（A-05）。
    this.clearStatusesForLeave(pokemon, 'evolve');
    pokemon.cannotRetreat = false;
    pokemon.attackLocked = false;
    this.pushEvent({
      type: 'evolved',
      seat,
      target: { ...target },
      fromNameZh: previousNameZh,
      toNameZh: evolutionDefinition.nameZh,
      toCard: this.cardView(evolutionCard),
    });
  }

  /**
   * 使用特性：未接入、回合/次数/卡面条件不满足或找不到特性时全部在状态修改前
   * 拒绝；使用后按每只宝可梦每回合记账，重进场的宝可梦是新实例。
   */
  private useAbility(seat: MatchSeat, target: MatchPokemonRef, abilityIndex: number): void {
    const pokemon = this.ownPokemonAt(seat, target);
    const definition = this.definitionOf(pokemon.card);
    const ability = definition.abilities[abilityIndex];
    if (!Number.isInteger(abilityIndex) || abilityIndex < 0 || ability === undefined) {
      throw new MatchEngineError('illegal-target', '特性序号无效。');
    }
    const effect = this.state.abilityEffects.get(abilityEffectKey(definition.identities.effectIdentity, ability.name));
    if (effect === undefined) {
      throw new MatchEngineError('unsupported-card', `${definition.nameZh} 的特性「${ability.name}」尚未接入，不能使用。`);
    }
    if (effect.canUse === undefined || effect.use === undefined) {
      throw new MatchEngineError('action-not-allowed', `特性「${ability.name}」是持续效果，满足条件时自动生效，不需要使用。`);
    }
    if (effect.repeatable !== true && pokemon.abilitiesUsedThisTurn.has(ability.name)) {
      throw new MatchEngineError('action-not-allowed', `特性「${ability.name}」本回合已经使用过。`);
    }
    const canUse = effect.canUse(this.abilityCanUseContext(pokemon, definition, ability));
    if (!canUse.ok) {
      throw new MatchEngineError(canUse.code, canUse.message);
    }
    // 全部验证通过后才记账、公开并执行效果；「任意次」特性不写入每回合记账。
    if (effect.repeatable !== true) {
      pokemon.abilitiesUsedThisTurn.add(ability.name);
    }
    this.pushEvent({
      type: 'ability-used',
      seat,
      target: { ...target },
      targetNameZh: definition.nameZh,
      abilityName: ability.name,
    });
    effect.use(this.abilityUseContext(pokemon, definition, ability));
  }

  /**
   * 附着宝可梦道具（冻结 B-02）：每只宝可梦至多 1 张，保持附着且不能按玩家
   * 意愿移除；未接入效果的道具整体拒绝，不做近似。
   */
  private attachTool(seat: MatchSeat, handIndex: number, target: MatchPokemonRef): void {
    const player = this.state.players[seat];
    if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
      throw new MatchEngineError('illegal-target', '手牌序号无效。');
    }
    const card = player.hand[handIndex] as CardInstance;
    const definition = this.definitionOf(card);
    if (!(definition.cardClass === 'trainer' && definition.effectiveCategory === '宝可梦道具')) {
      throw new MatchEngineError('illegal-target', '只有宝可梦道具可以附着于宝可梦身上。');
    }
    if (!this.state.toolEffects.has(definition.identities.effectIdentity)) {
      throw new MatchEngineError('unsupported-card', `${definition.nameZh} 的效果尚未接入，不能附着。`);
    }
    const pokemon = this.ownPokemonAt(seat, target);
    if (pokemon.tools.length > 0) {
      throw new MatchEngineError('action-not-allowed', '每只宝可梦身上只能放 1 张宝可梦道具。');
    }
    const targetNameZh = this.definitionOf(pokemon.card).nameZh;
    player.hand = player.hand.filter((_card, index) => index !== handIndex);
    pokemon.tools.push(card);
    this.pushEvent({ type: 'tool-attached', seat, card: this.cardView(card), target: { ...target }, targetNameZh });
  }

  private abilityCanUseContext(pokemon: PokemonState, definition: CatalogCard, ability: CatalogAbility): AbilityCanUseContext {
    const player = this.state.players[pokemon.seat];
    return {
      seat: pokemon.seat,
      card: definition,
      ability,
      isActive: () => player.active === pokemon,
      usedThisTurn: () => pokemon.abilitiesUsedThisTurn.has(ability.name),
      ownBenchCount: () => player.bench.length,
      ownDeckCount: () => player.deck.length,
      ownHandCount: () => player.hand.length,
      ownPokemonWithAttack: (attackName) => this.ownPokemonWithAttack(pokemon.seat, attackName),
    };
  }

  /** 自己场上（战斗场 + 备战区）拥有指定招式名的宝可梦及公开位置。 */
  private ownPokemonWithAttack(
    seat: MatchSeat,
    attackName: string,
  ): readonly { readonly slot: 'active' | 'bench'; readonly index: number; readonly nameZh: string }[] {
    const player = this.state.players[seat];
    const found: { readonly slot: 'active' | 'bench'; readonly index: number; readonly nameZh: string }[] = [];
    const consider = (pokemon: PokemonState | null, slot: 'active' | 'bench', index: number): void => {
      if (pokemon === null) {
        return;
      }
      const definition = this.definitionOf(pokemon.card);
      if (definition.attacks.some((attack) => attack.name === attackName)) {
        found.push({ slot, index, nameZh: definition.nameZh });
      }
    };
    consider(player.active, 'active', -1);
    player.bench.forEach((pokemon, index) => consider(pokemon, 'bench', index));
    return found;
  }

  private abilityUseContext(pokemon: PokemonState, definition: CatalogCard, ability: CatalogAbility): AbilityUseContext {
    const seat = pokemon.seat;
    return {
      ...this.abilityCanUseContext(pokemon, definition, ability),
      flipCoin: (cardNameZh) => {
        const result = this.flipCoin();
        this.pushEvent({ type: 'coin-flip', seat, cardNameZh, result });
        return result;
      },
      startDeckSearch: (options) => this.startDeckSearch(seat, options),
      drawUntilHandSize: (size) => this.drawUntilHandSize(seat, size),
      startModeChoice: (options) => this.startModeChoice(seat, options),
    };
  }

  /* ---------------- 攻击效果的待决选择续接 ---------------- */

  /** 回复 HP：移除至多 `amount / 10` 个伤害指示物，公开回复量。 */
  private healDamage(target: PokemonState, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 10 !== 0) {
      throw new MatchEngineError('illegal-choice', `回复量 ${amount} 必须是正的 10 的倍数。`);
    }
    const counters = Math.min(amount / 10, target.damageCounters);
    if (counters <= 0) {
      return;
    }
    target.damageCounters -= counters;
    this.pushEvent({
      type: 'damage-healed',
      targetSeat: target.seat,
      targetNameZh: this.definitionOf(target.card).nameZh,
      counters,
    });
  }

  /**
   * 「珍贵一触」：先选备战宝可梦，再选 1 张手牌基本能量，附着后回复其 HP。
   * 没有备战宝可梦或没有可附着的能量时，招式按“无效果”处理并结束回合。
   */
  private startAttachHandEnergyToBench(
    seat: MatchSeat,
    attackName: string,
    options: { readonly heal: number; readonly descriptionZh?: string },
  ): void {
    const player = this.state.players[seat];
    if (player.bench.length === 0) {
      this.finishDeferredAttack(seat, attackName, 0, 0);
      return;
    }
    const hasEnergy = player.hand.some((card) => {
      const definition = this.definitionOf(card);
      return definition.cardClass === 'energy' && isBasicEnergy(definition);
    });
    if (!hasEnergy) {
      this.finishDeferredAttack(seat, attackName, 0, 0);
      return;
    }
    this.state.pending = this.newChoice('choose-own-bench', seat, {
      min: 1,
      max: 1,
      candidates: player.bench.map((_pokemon, index) => index),
      source: 'own-bench',
      step: 1,
      stepCount: 2,
      descriptionZh: options.descriptionZh ?? '选择自己备战区的 1 只宝可梦，作为附着能量与回复 HP 的目标。',
      // 具体备战序号在 `resolveChooseOwnBench` 中填入；这里只携带回复量。
      followUp: { kind: 'attach-energy-to-target', target: { slot: 'bench', index: -1 }, heal: options.heal, energyType: null },
    });
    this.state.deferredAttack = { seat, attackName };
  }

  /**
   * 弃置附着能量：把每张可选的（水）能量作为一个私人候选，并标注所属宝可梦；
   * 选择完成后按张数造成伤害。「任意数量」允许 0 张。
   */
  private startDiscardAttachedEnergyChoice(
    seat: MatchSeat,
    attackName: string,
    options: {
      readonly type: string;
      readonly basicOnly: boolean;
      readonly min: number;
      readonly max: number | null;
      readonly descriptionZh: string;
      readonly followUp: EffectFollowUp;
    },
  ): void {
    const player = this.state.players[seat];
    const candidates: { readonly candidateId: string; readonly card: CardInstance; readonly labelZh: string }[] = [];
    const collect = (pokemon: PokemonState | null, labelZh: string, idPrefix: string): void => {
      if (pokemon === null) {
        return;
      }
      pokemon.energies.forEach((card, energyIndex) => {
        const definition = this.definitionOf(card);
        if (options.basicOnly && !isBasicEnergy(definition)) {
          return;
        }
        if (definition.type !== options.type) {
          return;
        }
        candidates.push({ candidateId: `${idPrefix}:${energyIndex}`, card, labelZh });
      });
    };
    collect(player.active, '战斗宝可梦', 'active');
    player.bench.forEach((pokemon, index) => collect(pokemon, `备战区 ${index + 1}`, `bench-${index}`));
    if (candidates.length === 0) {
      this.finishDeferredAttack(seat, attackName, 0, 0);
      return;
    }
    const max = options.max === null ? candidates.length : Math.min(options.max, candidates.length);
    this.state.pending = this.newChoice('discard-energy', seat, {
      min: options.min,
      max,
      cardCandidates: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        card: candidate.card,
        selectable: true,
        targetLabelZh: candidate.labelZh,
      })),
      source: 'own-field-energy',
      descriptionZh: options.descriptionZh,
      followUp: options.followUp,
    });
    this.state.deferredAttack = { seat, attackName };
  }

  /** 「刺穿」：选择对手备战区的 1 只宝可梦作为后续伤害目标。 */
  private startOpponentBenchChoice(
    seat: MatchSeat,
    options: { readonly descriptionZh: string; readonly followUp: EffectFollowUp },
  ): void {
    const opponent = this.state.players[otherSeat(seat)];
    if (opponent.bench.length === 0) {
      throw new MatchEngineError('illegal-target', '对手备战区没有宝可梦。');
    }
    this.state.pending = this.newChoice('switch-opponent', seat, {
      min: 1,
      max: 1,
      candidates: opponent.bench.map((_pokemon, index) => index),
      source: 'opponent-bench',
      descriptionZh: options.descriptionZh,
      followUp: options.followUp,
    });
  }

  /**
   * 「基因侵入」：把对手战斗宝可梦的全部招式作为选择；未接入的招式
   * 仍然列出但不可选，不能静默隐藏残局信息。
   */
  private startOpponentAttackChoice(seat: MatchSeat, options: { readonly descriptionZh: string }): void {
    const opponent = this.state.players[otherSeat(seat)];
    const active = opponent.active;
    if (active === null) {
      throw new MatchEngineError('illegal-target', '对手战斗场没有宝可梦。');
    }
    const definition = this.definitionOf(active.card);
    const modes: TrainerChoiceMode[] = definition.attacks.map((attack, index) => {
      const supported = this.isAttackSupported(definition, attack);
      const damageText = attack.damage === null ? '' : ` ${attack.damage}`;
      const costText = attack.cost.length === 0 ? '无' : attack.cost.join('·');
      return {
        modeId: `attack-${index}`,
        labelZh: `${attack.name}${damageText}（费用：${costText}）${attack.text === null ? '' : ` · ${attack.text}`}`,
        available: supported,
        unavailableReasonZh: supported ? null : '这个招式的效果尚未接入，不能通过「基因侵入」使用。',
        resolution: 'copy-opponent-attack' as const,
      };
    });
    const availableModes = modes.filter((mode) => mode.available);
    if (availableModes.length === 0) {
      // 对手战斗宝可梦的招式全部未接入：没有可执行效果，按无效果收招并结束回合。
      const deferredName = this.state.deferredAttack?.attackName ?? '招式';
      this.finishDeferredAttack(seat, deferredName, 0, 0);
      return;
    }
    if (availableModes.length === 1) {
      // 唯一可选招式就是「基因侵入」自身：复制它只会再次要求同一选择，形成没有
      // 状态变化、也没有出口的强制循环。冻结指南（进阶指南 Ver 3.1.0 第 39–40 页）
      // 要求复制后的效果照常执行并保留原招式身份，但没有给出封闭镜像的终止规则；
      // 有界的官方来源检索也没有找到直接裁定（Angelite/Decidueye 的 Q&A 是招式
      // 自身条件不满足的个例，2023 赛事手册 5.8.3.2 是超时后的额外回合裁定，均
      // 不能直接推出镜像规则）。因此这里只对一个真正封闭、无状态变化且无出口的
      // 循环按“无效果收招”实现，避免永久待决；这是实现行为，不是已核实的官方
      // 裁定。对手还有其它可选招式（存在出口）时仍按卡面允许玩家继续选择，不设
      // 任意层数上限。
      const onlyMode = availableModes[0] as TrainerChoiceMode;
      const onlyIndex = Number(onlyMode.modeId.replace('attack-', ''));
      if (definition.attacks[onlyIndex]?.name === '基因侵入') {
        const deferredName = this.state.deferredAttack?.attackName ?? '招式';
        this.finishDeferredAttack(seat, deferredName, 0, 0);
        return;
      }
    }
    this.state.pending = this.newChoice('choose-mode', seat, {
      min: 1,
      max: 1,
      modes,
      source: 'none',
      descriptionZh: options.descriptionZh,
    });
  }

  private resolveChooseOwnBench(seat: MatchSeat, benchIndex: number): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'choose-own-bench') {
      throw new MatchEngineError('choice-pending', '当前没有选择自己备战宝可梦的选择。');
    }
    const player = this.state.players[seat];
    const target = player.bench[benchIndex];
    if (!Number.isInteger(benchIndex) || benchIndex < 0 || target === undefined || !pending.candidates.includes(benchIndex)) {
      throw new MatchEngineError('illegal-target', '备战区序号无效。');
    }
    const followUp = pending.followUp;
    if (followUp === null || followUp.kind !== 'attach-energy-to-target' || followUp.target.slot !== 'bench') {
      throw new MatchEngineError('illegal-choice', '这个选择没有登记附着与回复效果。');
    }
    this.state.pending = null;
    this.startAttachHandEnergyChoice(seat, {
      target: { slot: 'bench', index: benchIndex },
      heal: followUp.heal,
      energyType: followUp.energyType,
      step: pending.step + 1,
      stepCount: pending.stepCount,
      descriptionZh: '选择自己手牌中的 1 张基本能量，附着于所选备战宝可梦身上。',
    });
  }

  /**
   * 选择 1 张符合条件的手牌基本能量附着于指定目标；
   * 「珍贵一触」与「海之伴奏」共用。没有可选能量时：招式延迟结算收招，
   * 普通特性静默结束（能量是否存在属于隐藏信息，不用它预判能否使用）。
   */
  private startAttachHandEnergyChoice(
    seat: MatchSeat,
    options: {
      readonly target: MatchPokemonRef;
      readonly heal: number;
      readonly energyType: string | null;
      readonly step: number;
      readonly stepCount: number;
      readonly descriptionZh: string;
    },
  ): void {
    const player = this.state.players[seat];
    const candidates: { readonly handIndex: number; readonly card: CardInstance }[] = [];
    player.hand.forEach((card, handIndex) => {
      const definition = this.definitionOf(card);
      if (
        definition.cardClass === 'energy' &&
        isBasicEnergy(definition) &&
        (options.energyType === null || definition.type === options.energyType)
      ) {
        candidates.push({ handIndex, card });
      }
    });
    if (candidates.length === 0) {
      const deferred = this.state.deferredAttack;
      if (deferred !== null && deferred.seat === seat) {
        this.finishDeferredAttack(seat, deferred.attackName, 0, 0);
      }
      return;
    }
    this.state.pending = this.newChoice('attach-hand-energy', seat, {
      min: 1,
      max: 1,
      cardCandidates: candidates.map((candidate) => ({ candidateId: `h${candidate.handIndex + 1}`, card: candidate.card, selectable: true, targetLabelZh: null })),
      source: 'hand',
      step: options.step,
      stepCount: options.stepCount,
      descriptionZh: options.descriptionZh,
      followUp: { kind: 'attach-energy-to-target', target: { ...options.target }, heal: options.heal, energyType: options.energyType },
    });
  }

  private resolveAttachHandEnergy(seat: MatchSeat, candidateId: string): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'attach-hand-energy') {
      throw new MatchEngineError('choice-pending', '当前没有选择手牌能量的选择。');
    }
    const candidate = pending.cardCandidates.find((entry) => entry.candidateId === candidateId);
    if (candidate === undefined || !candidate.selectable) {
      throw new MatchEngineError('illegal-choice', '候选 ID 无效或这张卡不能选择。');
    }
    const match = /^h(\d+)$/u.exec(candidateId);
    const handIndex = match === null ? -1 : Number(match[1]) - 1;
    const player = this.state.players[seat];
    if (handIndex < 0 || player.hand[handIndex] !== candidate.card) {
      throw new MatchEngineError('illegal-choice', '候选 ID 与当前手牌不一致。');
    }
    const followUp = pending.followUp;
    if (followUp === null || followUp.kind !== 'attach-energy-to-target') {
      throw new MatchEngineError('illegal-choice', '这个选择没有登记附着与回复效果。');
    }
    const target = this.ownPokemonAt(seat, followUp.target);
    // 验证完成后附着能量并回复；随后结算伤害与回合结束。
    player.hand = player.hand.filter((_card, index) => index !== handIndex);
    target.energies.push(candidate.card);
    const targetNameZh = this.definitionOf(target.card).nameZh;
    this.pushEvent({
      type: 'energy-attached',
      seat,
      card: this.cardView(candidate.card),
      target: { ...followUp.target },
      targetNameZh,
    });
    if (followUp.heal > 0) {
      this.healDamage(target, followUp.heal);
    }
    this.state.pending = null;
    const deferred = this.state.deferredAttack;
    if (deferred !== null && deferred.seat === seat) {
      this.finishDeferredAttack(seat, deferred.attackName, 0, 0);
    }
  }

  private resolveDiscardEnergy(seat: MatchSeat, candidateIds: readonly string[]): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'discard-energy') {
      throw new MatchEngineError('choice-pending', '当前没有弃置附着能量的选择。');
    }
    if (candidateIds.length < pending.min || candidateIds.length > pending.max) {
      throw new MatchEngineError('illegal-choice', `选择张数必须在 ${pending.min}..${pending.max} 之间。`);
    }
    const byId = new Map(pending.cardCandidates.map((entry) => [entry.candidateId, entry]));
    const seen = new Set<string>();
    const chosen: { readonly pokemon: PokemonState; readonly energyIndex: number; readonly card: CardInstance }[] = [];
    for (const candidateId of candidateIds) {
      if (byId.get(candidateId) === undefined || seen.has(candidateId)) {
        throw new MatchEngineError('illegal-choice', '候选 ID 无效或重复。');
      }
      seen.add(candidateId);
      const parsed = this.parseAttachedEnergyCandidateId(seat, candidateId);
      if (parsed === null) {
        throw new MatchEngineError('illegal-choice', '候选 ID 与场上能量不一致。');
      }
      chosen.push(parsed);
    }
    // 验证完成后统一移除并放入弃牌区。
    for (const entry of chosen) {
      const index = entry.pokemon.energies.indexOf(entry.card);
      if (index < 0) {
        throw new MatchEngineError('illegal-choice', '候选能量已经不在场上。');
      }
      entry.pokemon.energies.splice(index, 1);
    }
    const player = this.state.players[seat];
    player.discard.push(...chosen.map((entry) => entry.card));
    this.pushEvent({ type: 'energy-discarded', seat, cards: chosen.map((entry) => this.cardView(entry.card)) });
    const followUp = pending.followUp;
    if (followUp === null || followUp.kind !== 'attack-damage-per-discarded-energy') {
      throw new MatchEngineError('illegal-choice', '这个选择没有登记伤害计算方式。');
    }
    const attacker = player.active;
    const defender = this.state.players[otherSeat(seat)].active;
    let baseDamage = chosen.length * followUp.perEnergy;
    let damage = 0;
    if (attacker !== null && defender !== null && baseDamage > 0) {
      damage = this.finalDamage(this.definitionOf(attacker.card), defender, baseDamage);
      if (damage > 0) {
        this.damageCountersForPlacement(defender, damage);
      }
    }
    this.state.pending = null;
    if (damage > 0 && defender !== null) {
      this.placeDamageCounters(otherSeat(seat), defender, damage, seat);
    }
    this.finishDeferredAttack(seat, this.state.deferredAttack?.attackName ?? '招式', baseDamage, damage);
  }

  /** 解析 `active:N` / `bench-I:N` 候选 ID，并核对对应能量实例。 */
  private parseAttachedEnergyCandidateId(
    seat: MatchSeat,
    candidateId: string,
  ): { readonly pokemon: PokemonState; readonly energyIndex: number; readonly card: CardInstance } | null {
    const match = /^(active|bench-(\d+)):(\d+)$/u.exec(candidateId);
    if (match === null) {
      return null;
    }
    const player = this.state.players[seat];
    let pokemon: PokemonState | null = null;
    if (match[1] === 'active') {
      pokemon = player.active;
    } else {
      const index = Number(match[2]);
      pokemon = player.bench[index] ?? null;
    }
    if (pokemon === null) {
      return null;
    }
    const energyIndex = Number(match[3]);
    const card = pokemon.energies[energyIndex];
    return card === undefined ? null : { pokemon, energyIndex, card };
  }

  /** 公开招式使用并结算本回合（延迟效果全部完成后调用）。 */
  private finishDeferredAttack(seat: MatchSeat, attackName: string, baseDamage: number, damage: number): void {
    this.pushEvent({ type: 'attack-used', seat, attackName, baseDamage, damage });
    this.state.deferredAttack = null;
    this.settleKnockOuts('end-turn');
  }

  /** 从手牌弃置若干张（使用代价或效果）；失败不修改状态。 */
  private startDiscardChoice(
    seat: MatchSeat,
    options: {
      readonly min: number;
      readonly max: number;
      readonly descriptionZh: string;
      readonly followUp: TrainerFollowUp | null;
      readonly step?: number;
      readonly stepCount?: number;
    },
  ): void {
    const player = this.state.players[seat];
    const max = Math.min(options.max, player.hand.length);
    if (max < options.min) {
      throw new MatchEngineError('illegal-choice', `手牌数量不足，无法选择 ${options.min}..${options.max} 张。`);
    }
    this.state.pending = this.newChoice('discard-hand', seat, {
      min: options.min,
      max,
      candidates: player.hand.map((_card, index) => index),
      source: 'hand',
      step: options.step ?? 1,
      stepCount: options.stepCount ?? options.step ?? 1,
      descriptionZh: options.descriptionZh,
      followUp: options.followUp,
    });
  }

  /**
   * 从牌库检索：候选身份只进入选择者视图；没有候选时按检索失败处理
   * （依检索规则重洗牌库），不创建无人能答的选择；可携带后续动作
   * （如「梦中赠礼」检索完立即结束回合）。
   */
  private startDeckSearch(
    seat: MatchSeat,
    options: {
      readonly filter: TrainerCardFilter;
      readonly min: number;
      readonly max: number;
      readonly destination: 'hand' | 'bench';
      readonly descriptionZh: string;
      readonly consumeStadiumUse?: boolean;
      readonly step?: number;
      readonly stepCount?: number;
      readonly followUp?: EffectFollowUp | null;
      readonly deferShuffle?: boolean;
    },
  ): void {
    const player = this.state.players[seat];
    const matches = player.deck.filter((card) => matchesTrainerFilter(this.definitionOf(card), options.filter));
    if (matches.length === 0) {
      // 检索失败：牌库没有合法目标；依照检索卡的处理重洗牌库。
      // 分步检索的中间步骤暂不重洗，等最后一步再重洗。
      if (options.deferShuffle !== true) {
        this.pushEvent({ type: 'deck-shuffled', seat });
        this.shuffleDeck(seat);
      }
      if (options.consumeStadiumUse === true) {
        player.stadiumUsedThisTurn = true;
      }
      this.runFollowUp(seat, options.followUp ?? null, options.step ?? 1, options.stepCount ?? options.step ?? 1);
      return;
    }
    // 放于备战区的检索不能超过备战区剩余位置；张数上限同时受牌库匹配数约束。
    let max = Math.min(options.max, matches.length);
    if (options.destination === 'bench') {
      max = Math.min(max, Math.max(0, 5 - player.bench.length));
    }
    // 冻结 H（牌库）：从牌库选择时可以少于指定张数，也可以 1 张都不选，
    // 此时结束选择行为；因此所有牌库检索的 min 都由卡面/冻结规则给出，
    // 当前接入的检索效果均为可选 0 张。
    const min = Math.min(options.min, max);
    this.state.pending = this.newChoice('search-deck', seat, {
      min,
      max,
      cardCandidates: matches.map((card, index) => ({ candidateId: `c${index + 1}`, card, selectable: true, targetLabelZh: null })),
      source: 'deck',
      step: options.step ?? 1,
      stepCount: options.stepCount ?? options.step ?? 1,
      descriptionZh: options.descriptionZh,
      consumeStadiumUse: options.consumeStadiumUse ?? false,
      destination: options.destination,
      followUp: options.followUp ?? null,
      deferShuffle: options.deferShuffle ?? false,
    });
  }

  /**
   * 「莉佳的邀请」：把对手手牌作为私人候选。是否含有基础宝可梦属于隐藏
   * 信息，因此不据此预判；使用前已由 `canPlay` 确认对手备战区有空位。
   */
  private startOpponentHandLook(seat: MatchSeat, options: { readonly descriptionZh: string }): void {
    const opponent = this.state.players[otherSeat(seat)];
    const selectableCount = opponent.hand.filter((card) => {
      const definition = this.definitionOf(card);
      return definition.cardClass === 'pokemon' && definition.subtypes.includes('基础');
    }).length;
    const max = Math.min(1, selectableCount);
    const min = max > 0 ? 1 : 0;
    this.state.pending = this.newChoice('search-deck', seat, {
      min,
      max,
      cardCandidates: opponent.hand.map((card, index) => {
        const definition = this.definitionOf(card);
        return {
          candidateId: `oh${index + 1}`,
          card,
          selectable: definition.cardClass === 'pokemon' && definition.subtypes.includes('基础'),
          targetLabelZh: null,
        };
      }),
      source: 'opponent-hand',
      destination: 'opponent-bench',
      descriptionZh: options.descriptionZh,
    });
  }

  /**
   * 查看牌库上方固定张数并选择其中若干张。被查看的全部卡牌都作为私人候选
   * 发给选择者（卡面：查看上方 7 张），但只有满足效果筛选的卡可选；即使
   * 一张目标都没有，也要让选择者看完卡牌后再重洗（冻结 H：可以选择 0 张）。
   */
  private startTopDeckLook(
    seat: MatchSeat,
    options: {
      readonly count: number;
      readonly filter: TrainerCardFilter;
      readonly min: number;
      readonly max: number;
      readonly destination: 'hand';
      readonly descriptionZh: string;
    },
  ): void {
    const player = this.state.players[seat];
    const looked = player.deck.slice(0, options.count);
    if (looked.length === 0) {
      // 牌库为空：没有可查看的卡牌，按检索失败处理并重洗牌库。
      this.pushEvent({ type: 'deck-shuffled', seat });
      this.shuffleDeck(seat);
      return;
    }
    const candidates: ChoiceCandidate[] = looked.map((card, index) => ({
      candidateId: `c${index + 1}`,
      card,
      selectable: matchesTrainerFilter(this.definitionOf(card), options.filter),
      targetLabelZh: null,
    }));
    const selectable = candidates.filter((candidate) => candidate.selectable).length;
    const max = Math.min(options.max, selectable);
    const min = Math.min(options.min, max);
    this.state.pending = this.newChoice('search-deck', seat, {
      min,
      max,
      cardCandidates: candidates,
      source: 'top-deck',
      descriptionZh: options.descriptionZh,
      destination: options.destination,
    });
  }

  /** 二选一效果：没有可用模式时直接结束（不创建无法完成的选择）。 */
  private startModeChoice(
    seat: MatchSeat,
    options: {
      readonly modes: readonly TrainerChoiceMode[];
      readonly descriptionZh: string;
      readonly step?: number;
      readonly stepCount?: number;
    },
  ): void {
    if (!options.modes.some((mode) => mode.available)) {
      return;
    }
    this.state.pending = this.newChoice('choose-mode', seat, {
      min: 1,
      max: 1,
      modes: options.modes,
      source: 'none',
      step: options.step ?? 1,
      stepCount: options.stepCount ?? options.step ?? 1,
      descriptionZh: options.descriptionZh,
    });
  }

  /** 选择对手备战区的 1 只「宝可梦V」与战斗宝可梦互换。 */
  private startOpponentVSwitch(seat: MatchSeat, descriptionZh: string, step?: number, stepCount?: number): void {
    const opponent = this.state.players[otherSeat(seat)];
    const candidates: number[] = [];
    opponent.bench.forEach((pokemon, index) => {
      if (isPokemonVCard(this.definitionOf(pokemon.card))) {
        candidates.push(index);
      }
    });
    if (candidates.length === 0 || opponent.active === null) {
      throw new MatchEngineError('illegal-target', '对手没有可以互换的备战「宝可梦V」。');
    }
    this.state.pending = this.newChoice('switch-opponent', seat, {
      min: 1,
      max: 1,
      candidates,
      source: 'opponent-bench',
      step: step ?? 1,
      stepCount: stepCount ?? step ?? 1,
      descriptionZh,
      followUp: { kind: 'switch-opponent-v' },
    });
  }

  /** 一般效果抽牌：从牌库顶抽到手牌达到 `size` 张，牌库不足时抽完为止。 */
  private drawUntilHandSize(seat: MatchSeat, size: number): void {
    const player = this.state.players[seat];
    const needed = Math.max(0, size - player.hand.length);
    const actual = Math.min(needed, player.deck.length);
    if (actual > 0) {
      player.hand.push(...player.deck.splice(0, actual));
    }
    this.pushEvent({ type: 'card-drawn', seat, count: actual });
  }

  private resolveDiscardHand(seat: MatchSeat, indices: readonly number[]): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'discard-hand') {
      throw new MatchEngineError('choice-pending', '当前没有弃牌选择。');
    }
    if (indices.length < pending.min || indices.length > pending.max) {
      throw new MatchEngineError('illegal-choice', `弃牌张数必须在 ${pending.min}..${pending.max} 之间。`);
    }
    const seen = new Set<number>();
    for (const index of indices) {
      if (!Number.isInteger(index) || !pending.candidates.includes(index) || seen.has(index)) {
        throw new MatchEngineError('illegal-choice', '弃牌序号无效或重复。');
      }
      seen.add(index);
    }
    const player = this.state.players[seat];
    const cards = indices.map((index) => player.hand[index] as CardInstance);
    player.hand = player.hand.filter((_card, index) => !seen.has(index));
    player.discard.push(...cards);
    this.pushEvent({ type: 'cards-discarded', seat, cards: cards.map((card) => this.cardView(card)) });
    this.state.pending = null;
    this.runTrainerFollowUp(seat, pending);
    // 招式发起的弃牌（「循环抽取」）在后续动作完成后收招并结算回合；
    // 如果后续动作又创建了新选择（如分步检索），等它结束后再收招。
    const deferred = this.state.deferredAttack;
    if (this.state.pending === null && deferred !== null && deferred.seat === seat) {
      this.finishDeferredAttack(seat, deferred.attackName, 0, 0);
    }
  }

  private resolveSearchDeck(seat: MatchSeat, candidateIds: readonly string[]): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'search-deck') {
      throw new MatchEngineError('choice-pending', '当前没有检索选择。');
    }
    if (candidateIds.length < pending.min || candidateIds.length > pending.max) {
      throw new MatchEngineError('illegal-choice', `选择张数必须在 ${pending.min}..${pending.max} 之间。`);
    }
    const byId = new Map(pending.cardCandidates.map((candidate) => [candidate.candidateId, candidate]));
    const seen = new Set<string>();
    const chosen: CardInstance[] = [];
    for (const candidateId of candidateIds) {
      const candidate = byId.get(candidateId);
      if (candidate === undefined || seen.has(candidateId)) {
        throw new MatchEngineError('illegal-choice', '候选 ID 无效或重复。');
      }
      if (!candidate.selectable) {
        // 超级球等“查看后选择”的效果会展示全部被查看卡，但只有满足效果的卡可选。
        throw new MatchEngineError('illegal-choice', '这张卡牌不能作为本次选择的目标。');
      }
      seen.add(candidateId);
      chosen.push(candidate.card);
    }
    const destination = pending.destination;
    if (destination === null) {
      throw new MatchEngineError('illegal-choice', '这个检索没有登记放置区域。');
    }
    const player = this.state.players[seat];
    if (pending.source === 'opponent-hand') {
      if (destination !== 'opponent-bench') {
        throw new MatchEngineError('illegal-choice', '对手手牌选择没有登记放置区域。');
      }
      this.resolveOpponentHandChoice(seat, chosen as CardInstance[]);
      return;
    }
    if (destination !== 'hand' && destination !== 'bench') {
      throw new MatchEngineError('illegal-choice', '这个检索没有登记有效放置区域。');
    }
    if (destination === 'bench' && player.bench.length + chosen.length > 5) {
      throw new MatchEngineError('illegal-choice', '备战区最多 5 只宝可梦。');
    }
    const chosenSet = new Set(chosen);
    player.deck = player.deck.filter((card) => !chosenSet.has(card));
    if (destination === 'bench') {
      player.bench.push(...chosen.map((card) => this.newPokemon(seat, card, this.state.turn)));
    } else {
      player.hand.push(...chosen);
    }
    if (chosen.length > 0) {
      this.pushEvent({ type: 'cards-searched', seat, destination, cards: chosen.map((card) => this.cardView(card)) });
    }
    if (pending.deferShuffle !== true) {
      this.pushEvent({ type: 'deck-shuffled', seat });
      this.shuffleDeck(seat);
    }
    if (pending.consumeStadiumUse) {
      player.stadiumUsedThisTurn = true;
    }
    this.state.pending = null;
    this.runTrainerFollowUp(seat, pending);
  }

  /**
   * 「莉佳的邀请」结算：把选中的对手手牌基础宝可梦直接放于对手备战区，
   * 再与对手战斗宝可梦互换；选择 0 张时只结束查看（不重洗）。
   */
  private resolveOpponentHandChoice(seat: MatchSeat, chosen: CardInstance[]): void {
    const opponentSeat = otherSeat(seat);
    const opponent = this.state.players[opponentSeat];
    if (chosen.length === 0) {
      this.state.pending = null;
      return;
    }
    const chosenCard = chosen[0] as CardInstance;
    const handIndex = opponent.hand.indexOf(chosenCard);
    if (handIndex < 0) {
      throw new MatchEngineError('illegal-choice', '选中的卡已经不在对手手牌中。');
    }
    if (opponent.active === null) {
      throw new MatchEngineError('illegal-target', '对手战斗场没有宝可梦，无法互换。');
    }
    if (opponent.bench.length >= 5) {
      throw new MatchEngineError('illegal-choice', '对手备战区已满 5 只宝可梦。');
    }
    opponent.hand.splice(handIndex, 1);
    const previousActive = opponent.active;
    this.clearStatusesForLeave(previousActive, 'effect');
    previousActive.cannotRetreat = false;
    previousActive.attackLocked = false;
    opponent.active = this.newPokemon(opponentSeat, chosenCard, this.state.turn);
    opponent.bench.push(previousActive);
    this.pushEvent({
      type: 'bench-switched',
      seat,
      targetSeat: opponentSeat,
      active: this.cardView(chosenCard),
      bench: this.cardView(previousActive.card),
    });
    this.state.pending = null;
  }

  private resolveModeChoice(seat: MatchSeat, modeId: string): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'choose-mode') {
      throw new MatchEngineError('choice-pending', '当前没有效果模式选择。');
    }
    const mode = pending.modes.find((entry) => entry.modeId === modeId);
    if (mode === undefined) {
      throw new MatchEngineError('illegal-choice', '效果模式无效。');
    }
    if (!mode.available) {
      throw new MatchEngineError('illegal-choice', mode.unavailableReasonZh ?? '这个效果目前不可用。');
    }
    if (mode.resolution === 'discard-then-draw-five') {
      // 先完成校验再消费模式选择：失败时保留待决选择、版本与随机不变。
      if (this.state.players[seat].hand.length < 1) {
        throw new MatchEngineError('illegal-choice', '手牌为空，无法弃置至少 1 张。');
      }
      this.state.pending = null;
      this.startDiscardChoice(seat, {
        min: 1,
        max: 3,
        step: pending.step + 1,
        stepCount: pending.stepCount,
        descriptionZh: '选择自己 1 到 3 张手牌放于弃牌区（至少 1 张），然后从牌库抽到 5 张手牌。',
        followUp: { kind: 'draw-to-hand-size', size: 5 },
      });
      return;
    }
    if (mode.resolution === 'copy-opponent-attack') {
      const attackMatch = /^attack-(\d+)$/u.exec(modeId);
      const attackIndex = attackMatch === null ? -1 : Number(attackMatch[1]);
      const opponent = this.state.players[otherSeat(seat)];
      const opponentActive = opponent.active;
      if (opponentActive === null) {
        throw new MatchEngineError('illegal-target', '对手战斗场没有宝可梦。');
      }
      const copiedDefinition = this.definitionOf(opponentActive.card);
      const copiedAttack = copiedDefinition.attacks[attackIndex];
      if (!Number.isInteger(attackIndex) || attackIndex < 0 || copiedAttack === undefined) {
        throw new MatchEngineError('illegal-choice', '选择的对手招式无效。');
      }
      // 复制计划（含目标、暂存操作与溢出校验）全部验证成功后才消费选择。
      const plan = this.planCopiedAttack(seat, copiedDefinition, copiedAttack);
      this.state.pending = null;
      this.commitCopiedAttack(seat, copiedAttack, plan);
      return;
    }
    if (mode.resolution === 'attach-energy-to-own') {
      const target = this.parseOwnFieldModeTarget(modeId);
      if (target === null) {
        throw new MatchEngineError('illegal-choice', '选择的附着目标无效。');
      }
      this.ownPokemonAt(seat, target);
      this.state.pending = null;
      this.startAttachHandEnergyChoice(seat, {
        target,
        heal: 0,
        energyType: '水',
        step: pending.step + 1,
        stepCount: pending.stepCount,
        descriptionZh: '海之伴奏：选择自己手牌中的 1 张[水]能量，附着于所选宝可梦身上。',
      });
      return;
    }
    // 模式 2：互换对手备战区的「宝可梦V」；先校验存在目标再消费选择。
    const opponent = this.state.players[otherSeat(seat)];
    const hasSwitchTarget =
      opponent.active !== null && opponent.bench.some((pokemon) => isPokemonVCard(this.definitionOf(pokemon.card)));
    if (!hasSwitchTarget) {
      throw new MatchEngineError('illegal-target', '对手没有可以互换的备战「宝可梦V」。');
    }
    this.state.pending = null;
    this.startOpponentVSwitch(seat, '选择对手备战区的 1 只「宝可梦V」，将其与战斗宝可梦互换。', pending.step + 1, pending.stepCount);
  }

  /** 解析「海之伴奏」模式：`active` 或 `bench-<序号>`。 */
  private parseOwnFieldModeTarget(modeId: string): MatchPokemonRef | null {
    if (modeId === 'active') {
      return { slot: 'active' };
    }
    const match = /^bench-(\d+)$/u.exec(modeId);
    return match === null ? null : { slot: 'bench', index: Number(match[1]) };
  }

  private resolveOpponentSwitch(seat: MatchSeat, benchIndex: number): void {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'switch-opponent') {
      throw new MatchEngineError('choice-pending', '当前没有互换对手宝可梦的选择。');
    }
    const opponentSeat = otherSeat(seat);
    const opponent = this.state.players[opponentSeat];
    const active = opponent.active;
    if (active === null || !pending.candidates.includes(benchIndex)) {
      throw new MatchEngineError('illegal-target', '对手备战区序号无效。');
    }
    const replacement = opponent.bench[benchIndex];
    if (replacement === undefined) {
      throw new MatchEngineError('illegal-target', '对手备战区序号无效。');
    }
    const followUp = pending.followUp;
    if (followUp !== null && followUp.kind === 'attack-bench-damage') {
      // 「刺穿」：先按弱点/抵抗结算战斗宝可梦伤害，再对选中的备战宝可梦
      // 直接放置 30 伤害指示物（备战宝可梦不计算弱点/抗性）。
      const attacker = this.state.players[seat].active;
      if (attacker === null) {
        throw new MatchEngineError('illegal-target', '战斗场没有宝可梦。');
      }
      const attackerDefinition = this.definitionOf(attacker.card);
      const damage = followUp.baseDamage > 0 ? this.finalDamage(attackerDefinition, active, followUp.baseDamage) : 0;
      if (damage > 0) {
        this.damageCountersForPlacement(active, damage);
      }
      const benchDamage = followUp.counters * 10;
      this.damageCountersForPlacement(replacement, benchDamage);
      this.state.pending = null;
      if (damage > 0) {
        this.placeDamageCounters(opponentSeat, active, damage, seat);
      }
      this.placeDamageCounters(opponentSeat, replacement, benchDamage, seat);
      const deferredName = this.state.deferredAttack?.attackName ?? '招式';
      this.finishDeferredAttack(seat, deferredName, followUp.baseDamage, damage);
      return;
    }
    if (!isPokemonVCard(this.definitionOf(replacement.card))) {
      throw new MatchEngineError('illegal-target', '只能选择对手备战区的「宝可梦V」。');
    }
    // 验证完成后再交换：原战斗宝可梦回备战区并清除特殊状态与附加效果。
    this.state.pending = null;
    const leaving = active;
    this.clearStatusesForLeave(leaving, 'effect');
    leaving.cannotRetreat = false;
    leaving.attackLocked = false;
    opponent.active = replacement;
    opponent.bench = opponent.bench.map((pokemon, index) => (index === benchIndex ? leaving : pokemon));
    this.pushEvent({
      type: 'bench-switched',
      seat,
      targetSeat: opponentSeat,
      active: this.cardView(replacement.card),
      bench: this.cardView(leaving.card),
    });
  }

  /** 多步效果的后续动作：只使用纯数据描述，不依赖闭包。 */
  private runTrainerFollowUp(seat: MatchSeat, pending: PendingChoice): void {
    this.runFollowUp(seat, pending.followUp, pending.step + 1, pending.stepCount);
  }

  private runFollowUp(seat: MatchSeat, followUp: EffectFollowUp | null, step: number, stepCount: number): void {
    if (followUp === null) {
      return;
    }
    if (followUp.kind === 'search-pokemon-to-hand') {
      this.startDeckSearch(seat, {
        filter: { cardClass: 'pokemon' },
        min: 0,
        max: 1,
        destination: 'hand',
        step,
        stepCount,
        descriptionZh: '使用代价已支付：从牌库中选择 1 张宝可梦，向对手展示后加入手牌（可以不选）。',
      });
      return;
    }
    if (followUp.kind === 'draw-to-hand-size') {
      this.drawUntilHandSize(seat, followUp.size);
      return;
    }
    if (followUp.kind === 'draw-cards') {
      const player = this.state.players[seat];
      const actual = Math.min(followUp.count, player.deck.length);
      if (actual > 0) {
        player.hand.push(...player.deck.splice(0, actual));
      }
      this.pushEvent({ type: 'card-drawn', seat, count: actual });
      return;
    }
    if (followUp.kind === 'search-deck-second') {
      this.startDeckSearch(seat, {
        filter: followUp.filter,
        min: followUp.min,
        max: followUp.max,
        destination: followUp.destination,
        descriptionZh: followUp.descriptionZh,
        deferShuffle: followUp.deferShuffle ?? false,
        step,
        stepCount,
      });
      return;
    }
    if (followUp.kind === 'end-turn') {
      this.endTurn();
      return;
    }
    // 攻击/互换类效果的续接由对应待决选择解析方法直接完成，不使用通用后续动作。
    throw new MatchEngineError('illegal-choice', `效果后续动作 ${followUp.kind} 不能在此处执行。`);
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
    const maxHp = this.maxHpOf(pokemon);
    if (maxHp <= 0 || !Number.isSafeInteger(maxHp)) {
      return false;
    }
    return pokemon.damageCounters * 10 >= maxHp;
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
      // 「鼓励信」要求在上一个对手的回合昏厥。招式/效果处理在回合内发生，
      // 写入本回合标记；宝可梦检查发生在双方回合之外（冻结 F），不写入。
      if (after === 'end-turn') {
        player.koSufferedThisTurn = true;
      }
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
      // 昏厥宝可梦与所有附着卡（进化堆叠/能量/道具）一同进入弃牌区；伤害指示物消失。
      player.discard.push(pokemon.card, ...pokemon.evolutionStack, ...pokemon.energies, ...pokemon.tools);
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
          candidates: player.prizes.map((_card, index) => index),
          source: 'prizes',
          descriptionZh: `拿取奖赏卡：请从未公开的奖赏卡中选择 ${take} 张（拿取前不看身份）。`,
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
        candidates: player.bench.map((_pokemon, index) => index),
        source: 'own-bench',
        descriptionZh: '战斗宝可梦已昏厥，请从备战区选择 1 只升为战斗宝可梦。',
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
    case 'discard-hand':
      return 'discard-hand';
    case 'search-deck':
      return 'search-deck';
    case 'choose-mode':
      return 'choose-mode';
    case 'switch-opponent':
      return 'switch-opponent';
    case 'choose-own-bench':
      return 'choose-own-bench';
    case 'attach-hand-energy':
      return 'attach-hand-energy';
    case 'discard-energy':
      return 'discard-energy';
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

  /**
   * 是否为已生效命令的精确重传（只读探测，不产生任何状态变化）。
   *
   * 供房间注册表在“对手离线、等待重连”时仍放行确认丢失的重传：重传由
   * `submit` 返回第一次的结果，不会重复执行；而任何新的对局操作都会被拒绝。
   */
  public isKnownCommand(handle: MatchSeatHandle, command: MatchClientMessage): boolean {
    if (!this.isValidHandle(handle)) {
      return false;
    }
    const existing = this.dedup[handle.seat].get(command.commandId);
    return existing !== undefined && existing.fingerprint === commandFingerprint(command);
  }

  public viewFor(handle: MatchSeatHandle): MatchView {
    if (!this.isValidHandle(handle)) {
      throw new MatchEngineError('not-in-match', '这个座位句柄不属于本局。');
    }
    return this.engine.viewFor(handle.seat);
  }

  /**
   * 断线预算超限等外部原因终止：只生成一次终态；已有终态时返回 false。
   * 终态视图仍按座位投影，由房间注册表发给幸存连接，离线方重连后也拿到同一结果。
   */
  public finishExternal(winner: MatchSeat | null, reason: MatchFinishReason): boolean {
    return this.engine.finishExternal(winner, reason) !== null;
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
