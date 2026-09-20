/**
 * 对局契约（T07 / #8 开局 + T08 / #9 真实回合）。
 *
 * 房间建立唯一会话后，对局先完成开局（服务端随机决定先后攻选择权、洗牌与
 * 7 张手牌、无基础宝可梦的展示/重抽、初始盖放、6 张奖赏卡、按对手单独重抽
 * 次数的可选补抽与对战前备战），再进入双方交替的真实回合：
 *
 *   1. 回合开始必须从牌库顶抽 1 张；牌库为空时无法抽卡（完整胜负由后续票结算）。
 *   2. 每回合可自由执行：将基础宝可梦从手牌放入备战区（上限 5）、将 1 张能量
 *      附着于自己的宝可梦（每回合 1 次）、将战斗宝可梦撤退（每回合 1 次，支付
 *      所选的撤退能量并换入 1 只备战宝可梦）。
 *   3. 使用招式会结束回合；先攻玩家在自己的最初回合不能使用招式。
 *   4. 招式按基础伤害 → 弱点（倍增）→ 抵抗（减少）的顺序计算，结果为 0 或
 *      负数时不放置伤害指示物；“造成伤害”与“放置伤害指示物”是两种不同结算。
 *
 * 与房间协议分离：房间命令以 `roomId` + 房间版本路由，对局命令以 `sessionId`
 * + 对局版本路由。对局命令不能携带随机种子或预设牌序；解析器严格拒绝未知
 * 字段，服务端随机永远只来自服务端随机源。
 *
 * 隐藏信息在协议层就按座位投影：手牌只发给持有方，牌库与奖赏卡只有张数，
 * 对手盖放的初始宝可梦在公开翻面前没有身份。对手载荷中出现隐藏身份即视为
 * 解析失败，不能靠「界面恰好没渲染」来保证不泄露。
 */

export type MatchSeat = 0 | 1;

export type MatchPhase = 'turn-order' | 'setup' | 'compensation' | 'playing';

/**
 * 冻结 basic_rules07 的特殊状态。中毒/灼伤可与任意状态叠加；睡眠/麻痹/混乱
 * 三者互斥（新状态替换旧状态）。
 */
export type SpecialConditionKind = '中毒' | '灼伤' | '睡眠' | '麻痹' | '混乱';

/**
 * 待决选择种类：`take-prizes` 从本人未公开的奖赏卡中按规则取走指定张数，
 * `choose-replacement` 在战斗宝可梦昏厥后从备战区选 1 只升为战斗宝可梦。
 */
export type MatchPendingChoiceKind =
  | 'turn-order'
  | 'place-setup'
  | 'compensation-draw'
  | 'place-bench'
  | 'take-prizes'
  | 'choose-replacement';

/** 对场上宝可梦的公开引用；备战区序号只在当前视图内有效。 */
export type MatchPokemonRef = { readonly slot: 'active' } | { readonly slot: 'bench'; readonly index: number };

export interface MatchCommandBase {
  /** 客户端生成的唯一命令 ID；同一命令 ID 的精确重传返回第一次结果。 */
  readonly commandId: string;
  /** 稳定对局会话身份；对局命令必须指向它，不能落到复用房间码的新对局。 */
  readonly sessionId: string;
  /** 客户端最后确认的对局版本；不一致时服务端拒绝并且不修改状态。 */
  readonly expectedVersion: number;
}

export interface ChooseTurnOrderCommand extends MatchCommandBase {
  readonly type: 'choose-turn-order';
  /** 服务端随机决定的获选玩家选择权；必须携带当前待决选择身份。 */
  readonly choiceId: string;
  readonly goFirst: boolean;
}

export interface PlaceSetupCommand extends MatchCommandBase {
  readonly type: 'place-setup';
  readonly choiceId: string;
  /** 作为战斗宝可梦盖放的手牌序号。 */
  readonly active: number;
  /** 作为备战宝可梦盖放的手牌序号；最多 5 张，可为空。 */
  readonly bench: readonly number[];
}

export interface ResolveCompensationCommand extends MatchCommandBase {
  readonly type: 'resolve-compensation';
  readonly choiceId: string;
  /** 补抽张数，0..竞争上限；0 表示放弃补抽。 */
  readonly draw: number;
}

export interface PlaceBenchCommand extends MatchCommandBase {
  readonly type: 'place-bench';
  readonly choiceId: string;
  /**
   * 从当前手牌中选取要盖放到备战区的基础宝可梦序号；
   * 规则 G6 允许在对战开始前随时放置，可少放或零张。
   */
  readonly bench: readonly number[];
}

/** 回合内：把 1 张基础宝可梦从手牌放到备战区。 */
export interface PlayBasicCommand extends MatchCommandBase {
  readonly type: 'play-basic';
  readonly handIndex: number;
}

/** 回合内：将 1 张能量从手牌附着于自己的宝可梦（每回合 1 次）。 */
export interface AttachEnergyCommand extends MatchCommandBase {
  readonly type: 'attach-energy';
  readonly handIndex: number;
  readonly target: MatchPokemonRef;
}

/** 回合内：支付选定的撤退能量，与选定的备战宝可梦交换（每回合 1 次）。 */
export interface RetreatCommand extends MatchCommandBase {
  readonly type: 'retreat';
  /** 从战斗宝可梦身上选出的撤退能量序号（数量必须等于撤退费用）。 */
  readonly energyIndices: readonly number[];
  /** 换入战斗场的备战宝可梦序号。 */
  readonly benchIndex: number;
}

/** 回合内：使用战斗宝可梦的招式；结算后本回合结束。 */
export interface AttackCommand extends MatchCommandBase {
  readonly type: 'attack';
  readonly attackIndex: number;
  /** 基础规则下招式目标只能是对手战斗宝可梦；效果例外由服务端接口处理。 */
  readonly target: MatchPokemonRef;
}

/** 回合内：不使用招式，主动结束本回合。 */
export interface EndTurnCommand extends MatchCommandBase {
  readonly type: 'end-turn';
}

/**
 * 昏厥结算：从本人未公开的奖赏卡中取走 `prizes` 指定的序号（身份仍然隐藏），
 * 张数由规则固定。
 */
export interface TakePrizesCommand extends MatchCommandBase {
  readonly type: 'take-prizes';
  readonly choiceId: string;
  readonly prizes: readonly number[];
}

/** 昏厥结算：从备战区选择 1 只宝可梦升为战斗宝可梦。 */
export interface ChooseReplacementCommand extends MatchCommandBase {
  readonly type: 'choose-replacement';
  readonly choiceId: string;
  readonly benchIndex: number;
}

/** 确认认输：任意对局阶段可用，权威终态只生成一次。 */
export interface ConcedeCommand extends MatchCommandBase {
  readonly type: 'concede';
}

export type MatchClientMessage =
  | ChooseTurnOrderCommand
  | PlaceSetupCommand
  | ResolveCompensationCommand
  | PlaceBenchCommand
  | PlayBasicCommand
  | AttachEnergyCommand
  | RetreatCommand
  | AttackCommand
  | EndTurnCommand
  | TakePrizesCommand
  | ChooseReplacementCommand
  | ConcedeCommand;

/** 所有待决选择命令（需要 `choiceId`）。 */
export type MatchChoiceCommand =
  | ChooseTurnOrderCommand
  | PlaceSetupCommand
  | ResolveCompensationCommand
  | PlaceBenchCommand
  | TakePrizesCommand
  | ChooseReplacementCommand;

/** 所有回合内命令（不需要 `choiceId`，按当前回合玩家与版本校验）。 */
export type MatchTurnCommand = PlayBasicCommand | AttachEnergyCommand | RetreatCommand | AttackCommand | EndTurnCommand;

export const MATCH_ERROR_CODES = [
  'match-not-found',
  'not-in-match',
  'seat-taken-over',
  'stale-version',
  'command-id-reused',
  'choice-pending',
  'not-your-choice',
  'stale-choice',
  'illegal-choice',
  /** 回合内命令只能由当前回合玩家提交。 */
  'not-your-turn',
  /** 动作在当前状态被规则禁止（每回合次数、先攻限制、牌库为空等）。 */
  'action-not-allowed',
  /** 目标不存在或不属于允许的目标范围。 */
  'illegal-target',
  /** 撤退费用选择与身上能量不符（数量、序号、重复）。 */
  'illegal-cost',
  /** 使用招式所需能量不足。 */
  'insufficient-energy',
  /** 卡牌效果尚未接入，不能按近似规则执行。 */
  'unsupported-card',
  /** 对局已经产生唯一权威终态；结束后拒绝任何继续操作。 */
  'match-finished',
] as const;

export type MatchErrorCode = (typeof MATCH_ERROR_CODES)[number];

export function isMatchErrorCode(value: unknown): value is MatchErrorCode {
  return typeof value === 'string' && (MATCH_ERROR_CODES as readonly string[]).includes(value);
}

/** 对局中一张已公开或仅本人可见的卡牌投影；不包含内部实例 ID。 */
export interface MatchCardView {
  readonly cardId: string;
  readonly nameZh: string;
  readonly kind: 'pokemon' | 'trainer' | 'energy';
  readonly classLabelZh: string;
  /** 是否为「基础」宝可梦；用于初始盖放、备战放置与补抽后的选择。 */
  readonly isBasicPokemon: boolean;
  readonly type: string | null;
  readonly hp: number | null;
  readonly printDisplayNumber: string;
}

/** 招式投影：印刷信息是公开的；`supported` 表明当前引擎是否已接入该招式。 */
export interface MatchAttackView {
  readonly index: number;
  readonly name: string;
  readonly cost: readonly string[];
  /** 招式右侧印刷的伤害文字（如 `60`、`60×`）；没有伤害时为 null。 */
  readonly damageText: string | null;
  /** 招式说明文；无说明文时为 null。 */
  readonly effectTextZh: string | null;
  /** 未接入的招式在正式对局中不可宣告，界面必须如实显示。 */
  readonly supported: boolean;
}

/** 附着能量投影；`energyIndex` 只在当前视图的这只宝可梦内有效，用于撤退选择。 */
export interface MatchEnergyView {
  readonly energyIndex: number;
  readonly card: MatchCardView;
}

export interface MatchPokemonView {
  readonly card: MatchCardView;
  /** 已放置的伤害指示物数量（每个指示物代表 10 点伤害）。 */
  readonly damageCounters: number;
  /** 公开的特殊状态；战斗宝可梦回到备战区或昏厥后全部消除。 */
  readonly statuses: readonly SpecialConditionKind[];
  /** 附着于这只宝可梦的能量（公开信息）。 */
  readonly energies: readonly MatchEnergyView[];
  /** 印刷招式；对手场上宝可梦的招式同样是公开信息。 */
  readonly attacks: readonly MatchAttackView[];
  readonly retreatCost: number;
  readonly weakness: string | null;
  readonly resistance: string | null;
}

export interface MatchSideView {
  readonly seat: MatchSeat;
  readonly nickname: string;
  /** 仅本人座位携带完整手牌；对手座位永远为空数组（另外只有张数）。 */
  readonly hand: readonly MatchCardView[];
  readonly handCount: number;
  readonly deckCount: number;
  readonly prizeCount: number;
  readonly discard: readonly MatchCardView[];
  /** 公开翻面前对手（以及本人盖放时）的战斗宝可梦身份。 */
  readonly active: MatchPokemonView | null;
  readonly bench: readonly MatchPokemonView[];
  readonly setupPlaced: boolean;
  /** 该座位重抽（无基础宝可梦）总次数；公开信息（共同重抽 + 单独重抽）。 */
  readonly mulligans: number;
  /**
   * 该座位单独重抽（规则 5.d.）的次数。补抽上限只依据对手的这个计数：
   * 双方同时无基础宝可梦时共同重洗（规则 5.a.）不算任何一方的 5.d.。
   */
  readonly soloMulligans: number;
  /** 盖放的战斗/备战宝可梦是否已经公开翻面。 */
  readonly revealed: boolean;
  /** 本回合是否已经附着过能量（每个自己的回合 1 次）。 */
  readonly energyAttachedThisTurn: boolean;
  /** 本回合是否已经撤退过（每个自己的回合 1 次）。 */
  readonly retreatedThisTurn: boolean;
}

export interface MatchPendingChoiceView {
  readonly choiceId: string;
  readonly seat: MatchSeat;
  readonly kind: MatchPendingChoiceKind;
  /** 主动作的最少选择数。 */
  readonly min: number;
  /** 主动作的最多选择数。 */
  readonly max: number;
  /** `place-setup` 的备战最少张数。 */
  readonly benchMin: number;
  /** `place-setup` / `place-bench` 的备战最多张数。 */
  readonly benchMax: number;
  /**
   * `place-setup` 为手牌中可用基础宝可梦的序号；
   * `place-bench` 为当前手牌中仍可盖放到备战区的基础宝可梦序号。其他种类为空。
   */
  readonly candidates: readonly number[];
}

/** 触发或参与终局的公开条件。 */
export type MatchWinCondition = 'prizes' | 'no-pokemon' | 'deck-out';

/**
 * 终局原因：三项冻结败北条件之一，或确认认输；同时满足胜负条件且
 * 判定为平局时为 `simultaneous`（抢分赛是可选流程，不由引擎强制开始）。
 */
export type MatchFinishReason = MatchWinCondition | 'concede' | 'simultaneous';

export interface MatchResultCondition {
  readonly seat: MatchSeat;
  readonly condition: MatchWinCondition;
}

/** 唯一的权威终态；平局时 `winner` 为 null。 */
export interface MatchResultView {
  readonly winner: MatchSeat | null;
  readonly reason: MatchFinishReason;
  /** 依据冻结判定表参与结果的公开条件；不含任何隐藏身份。 */
  readonly conditions: readonly MatchResultCondition[];
}

export type MatchPublicEvent =
  | { readonly seq: number; readonly type: 'match-created'; readonly seats: readonly [string, string] }
  | { readonly seq: number; readonly type: 'turn-order-flip'; readonly winner: MatchSeat }
  | { readonly seq: number; readonly type: 'turn-order-chosen'; readonly seat: MatchSeat; readonly goFirst: boolean }
  | {
      readonly seq: number;
      readonly type: 'mulligan';
      readonly seat: MatchSeat;
      /** 第几次重抽（从 1 开始）。 */
      readonly count: number;
      /** 是否为双方同时无基础宝可梦的共同重洗（规则 5.a.）；不算任何一方的 5.d.。 */
      readonly shared: boolean;
      /** 重抽公开展示的手牌（规则要求向对手展示）。 */
      readonly cards: readonly MatchCardView[];
    }
  | { readonly seq: number; readonly type: 'setup-placed'; readonly seat: MatchSeat }
  | { readonly seq: number; readonly type: 'prizes-placed'; readonly seat: MatchSeat }
  | { readonly seq: number; readonly type: 'compensation-declared'; readonly seat: MatchSeat; readonly count: number }
  | { readonly seq: number; readonly type: 'bench-placed'; readonly seat: MatchSeat; readonly count: number }
  | {
      readonly seq: number;
      readonly type: 'setup-revealed';
      readonly seat: MatchSeat;
      readonly active: MatchCardView;
      readonly bench: readonly MatchCardView[];
    }
  | { readonly seq: number; readonly type: 'turn-started'; readonly seat: MatchSeat; readonly turn: number }
  | { readonly seq: number; readonly type: 'card-drawn'; readonly seat: MatchSeat; readonly count: number }
  /** 回合开始牌库为空，无法抽卡；完整胜负判定属于后续票。 */
  | { readonly seq: number; readonly type: 'draw-blocked'; readonly seat: MatchSeat; readonly turn: number }
  | { readonly seq: number; readonly type: 'basic-placed'; readonly seat: MatchSeat; readonly card: MatchCardView }
  | {
      readonly seq: number;
      readonly type: 'energy-attached';
      readonly seat: MatchSeat;
      readonly card: MatchCardView;
      readonly target: MatchPokemonRef;
      readonly targetNameZh: string;
    }
  | {
      readonly seq: number;
      readonly type: 'retreat';
      readonly seat: MatchSeat;
      /** 撤退后进入战斗场的宝可梦。 */
      readonly active: MatchCardView;
      /** 回到备战区的原战斗宝可梦。 */
      readonly bench: MatchCardView;
    }
  | {
      readonly seq: number;
      readonly type: 'attack-used';
      readonly seat: MatchSeat;
      readonly attackName: string;
      /** 招式印刷的基础伤害。 */
      readonly baseDamage: number;
      /** 经过弱点/抵抗后的最终伤害（点数）。 */
      readonly damage: number;
    }
  /**
   * 放置伤害指示物：不经过弱点/抵抗，区别于招式的伤害结算。
   */
  | {
      readonly seq: number;
      readonly type: 'damage-counters-placed';
      readonly seat: MatchSeat;
      readonly targetSeat: MatchSeat;
      readonly count: number;
    }
  /** 对场上宝可梦施加特殊状态（公开标记）。`seat` 是施加方。 */
  | {
      readonly seq: number;
      readonly type: 'status-inflicted';
      readonly seat: MatchSeat;
      readonly targetSeat: MatchSeat;
      readonly targetNameZh: string;
      readonly condition: SpecialConditionKind;
    }
  /** 特殊状态恢复：战斗宝可梦回备战区、宝可梦检查成功或卡牌效果。 */
  | {
      readonly seq: number;
      readonly type: 'status-recovered';
      readonly targetSeat: MatchSeat;
      readonly targetNameZh: string;
      readonly condition: SpecialConditionKind;
      readonly cause: 'checkup' | 'retreat' | 'evolve' | 'effect';
    }
  /** 宝可梦检查中【灼伤】/【睡眠】的硬币结果（公开随机结果）。 */
  | {
      readonly seq: number;
      readonly type: 'checkup-flip';
      readonly targetSeat: MatchSeat;
      readonly targetNameZh: string;
      readonly condition: '灼伤' | '睡眠';
      readonly result: 'heads' | 'tails';
    }
  /** 【混乱】攻击宣言时的硬币结果；反面时 `selfDamageCounters` 为 3。 */
  | {
      readonly seq: number;
      readonly type: 'confusion-flip';
      readonly seat: MatchSeat;
      readonly targetNameZh: string;
      readonly result: 'heads' | 'tails';
      readonly selfDamageCounters: number;
    }
  /** 一只宝可梦昏厥：其与所有附加卡已进入弃牌区，对手拿取 `prizeCount` 张奖赏卡。 */
  | {
      readonly seq: number;
      readonly type: 'pokemon-knocked-out';
      readonly targetSeat: MatchSeat;
      readonly targetNameZh: string;
      readonly prizeCount: number;
    }
  /** 拿取奖赏卡：只公开张数与剩余张数，奖赏身份在规则公开前不进载荷。 */
  | {
      readonly seq: number;
      readonly type: 'prizes-taken';
      readonly seat: MatchSeat;
      readonly count: number;
      readonly remaining: number;
    }
  /** 昏厥后从备战区升为战斗宝可梦（公开身份）。 */
  | { readonly seq: number; readonly type: 'replacement-placed'; readonly seat: MatchSeat; readonly card: MatchCardView }
  | { readonly seq: number; readonly type: 'conceded'; readonly seat: MatchSeat }
  | {
      readonly seq: number;
      readonly type: 'match-finished';
      readonly winner: MatchSeat | null;
      readonly reason: MatchFinishReason;
      readonly conditions: readonly MatchResultCondition[];
    }
  | { readonly seq: number; readonly type: 'turn-ended'; readonly seat: MatchSeat; readonly turn: number };

export interface MatchView {
  readonly sessionId: string;
  readonly version: number;
  readonly phase: MatchPhase;
  readonly turn: number;
  readonly activeSeat: MatchSeat | null;
  readonly firstSeat: MatchSeat | null;
  readonly you: MatchSideView;
  readonly opponent: MatchSideView;
  /** 仅当待决选择属于本人时携带；对手的选择只体现为 `waitingForOpponentChoice`。 */
  readonly pendingChoice: MatchPendingChoiceView | null;
  readonly waitingForOpponentChoice: boolean;
  /**
   * 当前回合开始时牌库为空、无法抽卡；此时对局已按回合开始抽空判定败北，
   * `result` 同步给出唯一终态。
   */
  readonly cannotDraw: boolean;
  /** 唯一权威终态；未结束时为 null。 */
  readonly result: MatchResultView | null;
  readonly events: readonly MatchPublicEvent[];
}

export interface MatchSnapshotMessage {
  readonly type: 'match';
  readonly view: MatchView;
  /** 直接回答的命令 ID；无命令关联的广播快照省略。 */
  readonly commandId?: string;
}

export interface MatchErrorMessage {
  readonly type: 'match-error';
  readonly code: MatchErrorCode;
  readonly message: string;
  readonly commandId?: string;
  /** 版本冲突等场景回传服务端当前按座位投影；客户端据此重新同步。 */
  readonly view?: MatchView;
}

export type MatchServerMessage = MatchSnapshotMessage | MatchErrorMessage;

export type ParseResult<T> = { readonly ok: true; readonly message: T } | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSeat(value: unknown): value is MatchSeat {
  return value === 0 || value === 1;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return key;
    }
  }
  return null;
}

const BASE_COMMAND_KEYS = ['type', 'commandId', 'sessionId', 'expectedVersion'] as const;

/** 每种命令只允许自身字段；多余字段一律拒绝。 */
const COMMAND_KEYS_BY_TYPE: Readonly<Record<MatchClientMessage['type'], readonly string[]>> = {
  'choose-turn-order': [...BASE_COMMAND_KEYS, 'choiceId', 'goFirst'],
  'place-setup': [...BASE_COMMAND_KEYS, 'choiceId', 'active', 'bench'],
  'resolve-compensation': [...BASE_COMMAND_KEYS, 'choiceId', 'draw'],
  'place-bench': [...BASE_COMMAND_KEYS, 'choiceId', 'bench'],
  'take-prizes': [...BASE_COMMAND_KEYS, 'choiceId', 'prizes'],
  'choose-replacement': [...BASE_COMMAND_KEYS, 'choiceId', 'benchIndex'],
  'play-basic': [...BASE_COMMAND_KEYS, 'handIndex'],
  'attach-energy': [...BASE_COMMAND_KEYS, 'handIndex', 'target'],
  retreat: [...BASE_COMMAND_KEYS, 'energyIndices', 'benchIndex'],
  attack: [...BASE_COMMAND_KEYS, 'attackIndex', 'target'],
  'end-turn': BASE_COMMAND_KEYS,
  concede: BASE_COMMAND_KEYS,
};

function parseCommandBase(
  decoded: Record<string, unknown>,
  type: MatchClientMessage['type'],
  allowed: readonly string[],
): ParseResult<{ commandId: string; sessionId: string; expectedVersion: number }> {
  const unknown = unknownKeys(decoded, allowed);
  if (unknown !== null) {
    return { ok: false, error: `${type}.${unknown} 不是允许的字段` };
  }
  const commandId = decoded['commandId'];
  if (!isNonEmptyString(commandId)) {
    return { ok: false, error: `${type}.commandId 缺失` };
  }
  const sessionId = decoded['sessionId'];
  if (!isNonEmptyString(sessionId)) {
    return { ok: false, error: `${type}.sessionId 缺失` };
  }
  const expectedVersion = decoded['expectedVersion'];
  if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
    return { ok: false, error: `${type}.expectedVersion 必须是正整数` };
  }
  return { ok: true, message: { commandId, sessionId, expectedVersion: expectedVersion as number } };
}

function parseChoiceId(decoded: Record<string, unknown>, type: string): ParseResult<string> {
  const choiceId = decoded['choiceId'];
  if (!isNonEmptyString(choiceId)) {
    return { ok: false, error: `${type}.choiceId 缺失` };
  }
  return { ok: true, message: choiceId };
}

function isHandIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function parseHandIndexArray(value: unknown, field: string): ParseResult<readonly number[]> {
  if (!Array.isArray(value) || !value.every(isHandIndex)) {
    return { ok: false, error: `${field} 必须是手牌序号数组` };
  }
  return { ok: true, message: value };
}

/** 解析 `{ slot: 'active' }` / `{ slot: 'bench', index }`，严格拒绝未知字段。 */
export function parseMatchPokemonRef(value: unknown): ParseResult<MatchPokemonRef> {
  if (!isRecord(value)) {
    return { ok: false, error: '目标必须是 { slot } 对象' };
  }
  if (value['slot'] === 'active') {
    const unknown = unknownKeys(value, ['slot']);
    if (unknown !== null) {
      return { ok: false, error: `target.${unknown} 不是允许的字段` };
    }
    return { ok: true, message: { slot: 'active' } };
  }
  if (value['slot'] === 'bench') {
    const unknown = unknownKeys(value, ['slot', 'index']);
    if (unknown !== null) {
      return { ok: false, error: `target.${unknown} 不是允许的字段` };
    }
    if (!isHandIndex(value['index'])) {
      return { ok: false, error: 'target.index 必须是非负整数' };
    }
    return { ok: true, message: { slot: 'bench', index: value['index'] } };
  }
  return { ok: false, error: 'target.slot 必须是 active 或 bench' };
}

function parseIntArray(value: unknown, field: string): ParseResult<readonly number[]> {
  if (!Array.isArray(value) || !value.every(isHandIndex)) {
    return { ok: false, error: `${field} 必须是非负整数数组` };
  }
  return { ok: true, message: value };
}

/**
 * 解析一条对局命令；不是对局命令时返回 `null`。
 *
 * 严格拒绝未知字段：客户端无法夹带 `seed`、`deckOrder` 之类的随机输入。
 */
export function parseMatchClientMessage(decoded: unknown): ParseResult<MatchClientMessage> | null {
  if (!isRecord(decoded)) {
    return null;
  }
  const type = decoded['type'];
  if (typeof type !== 'string') {
    return null;
  }
  const choiceTypes = [
    'choose-turn-order',
    'place-setup',
    'resolve-compensation',
    'place-bench',
    'take-prizes',
    'choose-replacement',
  ] as const;
  const turnTypes = ['play-basic', 'attach-energy', 'retreat', 'attack', 'end-turn'] as const;
  const isChoice = (choiceTypes as readonly string[]).includes(type);
  const isTurn = (turnTypes as readonly string[]).includes(type);
  if (!isChoice && !isTurn && type !== 'concede') {
    return null;
  }
  const typed = type as MatchClientMessage['type'];
  const base = parseCommandBase(decoded, typed, COMMAND_KEYS_BY_TYPE[typed]);
  if (!base.ok) {
    return base;
  }
  if (type === 'concede') {
    return { ok: true, message: { type: 'concede', ...base.message } };
  }
  if (isChoice) {
    const choice = parseChoiceId(decoded, typed);
    if (!choice.ok) {
      return choice;
    }
    if (type === 'choose-turn-order') {
      const goFirst = decoded['goFirst'];
      if (typeof goFirst !== 'boolean') {
        return { ok: false, error: 'choose-turn-order.goFirst 必须是布尔值' };
      }
      return { ok: true, message: { type, ...base.message, choiceId: choice.message, goFirst } };
    }
    if (type === 'place-setup') {
      const active = decoded['active'];
      if (!isHandIndex(active)) {
        return { ok: false, error: 'place-setup.active 必须是手牌序号' };
      }
      const bench = parseHandIndexArray(decoded['bench'], 'place-setup.bench');
      if (!bench.ok) {
        return bench;
      }
      return { ok: true, message: { type, ...base.message, choiceId: choice.message, active, bench: bench.message } };
    }
    if (type === 'resolve-compensation') {
      const draw = decoded['draw'];
      if (!Number.isInteger(draw) || (draw as number) < 0) {
        return { ok: false, error: 'resolve-compensation.draw 必须是非负整数' };
      }
      return { ok: true, message: { type, ...base.message, choiceId: choice.message, draw: draw as number } };
    }
    if (type === 'take-prizes') {
      const prizes = parseIntArray(decoded['prizes'], 'take-prizes.prizes');
      if (!prizes.ok) {
        return prizes;
      }
      return { ok: true, message: { type, ...base.message, choiceId: choice.message, prizes: prizes.message } };
    }
    if (type === 'choose-replacement') {
      const benchIndex = decoded['benchIndex'];
      if (!isHandIndex(benchIndex)) {
        return { ok: false, error: 'choose-replacement.benchIndex 必须是备战区序号' };
      }
      return { ok: true, message: { type, ...base.message, choiceId: choice.message, benchIndex } };
    }
    const bench = parseHandIndexArray(decoded['bench'], 'place-bench.bench');
    if (!bench.ok) {
      return bench;
    }
    return { ok: true, message: { type: 'place-bench', ...base.message, choiceId: choice.message, bench: bench.message } };
  }
  if (type === 'play-basic') {
    const handIndex = decoded['handIndex'];
    if (!isHandIndex(handIndex)) {
      return { ok: false, error: 'play-basic.handIndex 必须是手牌序号' };
    }
    return { ok: true, message: { type, ...base.message, handIndex } };
  }
  if (type === 'attach-energy') {
    const handIndex = decoded['handIndex'];
    if (!isHandIndex(handIndex)) {
      return { ok: false, error: 'attach-energy.handIndex 必须是手牌序号' };
    }
    const target = parseMatchPokemonRef(decoded['target']);
    if (!target.ok) {
      return { ok: false, error: `attach-energy.${target.error}` };
    }
    return { ok: true, message: { type, ...base.message, handIndex, target: target.message } };
  }
  if (type === 'retreat') {
    const indices = parseIntArray(decoded['energyIndices'], 'retreat.energyIndices');
    if (!indices.ok) {
      return indices;
    }
    const benchIndex = decoded['benchIndex'];
    if (!isHandIndex(benchIndex)) {
      return { ok: false, error: 'retreat.benchIndex 必须是备战区序号' };
    }
    return { ok: true, message: { type, ...base.message, energyIndices: indices.message, benchIndex } };
  }
  if (type === 'attack') {
    const attackIndex = decoded['attackIndex'];
    if (!isHandIndex(attackIndex)) {
      return { ok: false, error: 'attack.attackIndex 必须是招式序号' };
    }
    const target = parseMatchPokemonRef(decoded['target']);
    if (!target.ok) {
      return { ok: false, error: `attack.${target.error}` };
    }
    return { ok: true, message: { type, ...base.message, attackIndex, target: target.message } };
  }
  return { ok: true, message: { type: 'end-turn', ...base.message } };
}

/* ------------------------------------------------------------------ */
/* 服务端对局消息                                                      */
/* ------------------------------------------------------------------ */

function parseCardView(value: unknown): MatchCardView | null {
  if (!isRecord(value)) {
    return null;
  }
  const { cardId, nameZh, kind, classLabelZh, isBasicPokemon, type, hp, printDisplayNumber } = value;
  if (!isNonEmptyString(cardId) || !isNonEmptyString(nameZh) || !isNonEmptyString(classLabelZh) || !isNonEmptyString(printDisplayNumber)) {
    return null;
  }
  if (kind !== 'pokemon' && kind !== 'trainer' && kind !== 'energy') {
    return null;
  }
  if (typeof isBasicPokemon !== 'boolean') {
    return null;
  }
  if (type !== null && typeof type !== 'string') {
    return null;
  }
  if (hp !== null && typeof hp !== 'number') {
    return null;
  }
  return { cardId, nameZh, kind, classLabelZh, isBasicPokemon, type, hp, printDisplayNumber };
}

function parseCardArray(value: unknown): readonly MatchCardView[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const cards: MatchCardView[] = [];
  for (const entry of value) {
    const parsed = parseCardView(entry);
    if (parsed === null) {
      return null;
    }
    cards.push(parsed);
  }
  return cards;
}

function parseAttackView(value: unknown): MatchAttackView | null {
  if (!isRecord(value)) {
    return null;
  }
  const { index, name, cost, damageText, effectTextZh, supported } = value;
  if (!Number.isInteger(index) || (index as number) < 0 || !isNonEmptyString(name) || typeof supported !== 'boolean') {
    return null;
  }
  if (!Array.isArray(cost) || !cost.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    return null;
  }
  if (damageText !== null && typeof damageText !== 'string') {
    return null;
  }
  if (effectTextZh !== null && typeof effectTextZh !== 'string') {
    return null;
  }
  return {
    index: index as number,
    name,
    cost: cost as readonly string[],
    damageText: damageText as string | null,
    effectTextZh: effectTextZh as string | null,
    supported,
  };
}

function parseAttackArray(value: unknown): readonly MatchAttackView[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const attacks: MatchAttackView[] = [];
  for (const entry of value) {
    const parsed = parseAttackView(entry);
    if (parsed === null) {
      return null;
    }
    attacks.push(parsed);
  }
  return attacks;
}

function parseStatuses(value: unknown): readonly SpecialConditionKind[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const allowed: readonly SpecialConditionKind[] = ['中毒', '灼伤', '睡眠', '麻痹', '混乱'];
  const statuses: SpecialConditionKind[] = [];
  const seen = new Set<SpecialConditionKind>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !(allowed as readonly string[]).includes(entry) || seen.has(entry as SpecialConditionKind)) {
      return null;
    }
    seen.add(entry as SpecialConditionKind);
    statuses.push(entry as SpecialConditionKind);
  }
  return statuses;
}

function parsePokemonView(value: unknown): MatchPokemonView | null {
  if (!isRecord(value)) {
    return null;
  }
  const card = parseCardView(value['card']);
  if (card === null) {
    return null;
  }
  const damageCounters = value['damageCounters'];
  if (!Number.isInteger(damageCounters) || (damageCounters as number) < 0) {
    return null;
  }
  const statuses = parseStatuses(value['statuses']);
  if (statuses === null) {
    return null;
  }
  const rawEnergies = value['energies'];
  if (!Array.isArray(rawEnergies)) {
    return null;
  }
  const energies: MatchEnergyView[] = [];
  const seenEnergyIndices = new Set<number>();
  for (const entry of rawEnergies) {
    if (!isRecord(entry)) {
      return null;
    }
    const energyIndex = entry['energyIndex'];
    const energyCard = parseCardView(entry['card']);
    if (!Number.isInteger(energyIndex) || (energyIndex as number) < 0 || energyCard === null || seenEnergyIndices.has(energyIndex as number)) {
      return null;
    }
    seenEnergyIndices.add(energyIndex as number);
    energies.push({ energyIndex: energyIndex as number, card: energyCard });
  }
  const attacks = parseAttackArray(value['attacks']);
  if (attacks === null) {
    return null;
  }
  const retreatCost = value['retreatCost'];
  if (!Number.isInteger(retreatCost) || (retreatCost as number) < 0) {
    return null;
  }
  const weakness = value['weakness'];
  const resistance = value['resistance'];
  if ((weakness !== null && typeof weakness !== 'string') || (resistance !== null && typeof resistance !== 'string')) {
    return null;
  }
  return {
    card,
    damageCounters: damageCounters as number,
    statuses,
    energies,
    attacks,
    retreatCost: retreatCost as number,
    weakness,
    resistance,
  };
}

function parsePokemonArray(value: unknown): readonly MatchPokemonView[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const pokemon: MatchPokemonView[] = [];
  for (const entry of value) {
    const parsed = parsePokemonView(entry);
    if (parsed === null) {
      return null;
    }
    pokemon.push(parsed);
  }
  return pokemon;
}

function parseCount(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function parseSideView(value: unknown, seat: MatchSeat): MatchSideView | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['seat'] !== seat || !isNonEmptyString(value['nickname'])) {
    return null;
  }
  const hand = parseCardArray(value['hand']);
  const discard = parseCardArray(value['discard']);
  const bench = parsePokemonArray(value['bench']);
  if (hand === null || discard === null || bench === null) {
    return null;
  }
  const handCount = parseCount(value['handCount']);
  const deckCount = parseCount(value['deckCount']);
  const prizeCount = parseCount(value['prizeCount']);
  if (handCount === null || deckCount === null || prizeCount === null) {
    return null;
  }
  if (
    typeof value['setupPlaced'] !== 'boolean' ||
    typeof value['revealed'] !== 'boolean' ||
    typeof value['energyAttachedThisTurn'] !== 'boolean' ||
    typeof value['retreatedThisTurn'] !== 'boolean'
  ) {
    return null;
  }
  const mulligans = parseCount(value['mulligans']);
  const soloMulligans = parseCount(value['soloMulligans']);
  if (mulligans === null || soloMulligans === null) {
    return null;
  }
  const rawActive = value['active'];
  let active: MatchPokemonView | null = null;
  if (rawActive !== null && rawActive !== undefined) {
    const parsed = parsePokemonView(rawActive);
    if (parsed === null) {
      return null;
    }
    active = parsed;
  }
  return {
    seat,
    nickname: value['nickname'],
    hand,
    handCount,
    deckCount,
    prizeCount,
    discard,
    active,
    bench,
    setupPlaced: value['setupPlaced'],
    mulligans,
    soloMulligans,
    revealed: value['revealed'],
    energyAttachedThisTurn: value['energyAttachedThisTurn'],
    retreatedThisTurn: value['retreatedThisTurn'],
  };
}

function parsePendingChoice(value: unknown): MatchPendingChoiceView | null {
  if (!isRecord(value)) {
    return null;
  }
  const { choiceId, seat, kind, min, max, benchMin, benchMax } = value;
  if (!isNonEmptyString(choiceId) || !isSeat(seat)) {
    return null;
  }
  if (kind !== 'turn-order' && kind !== 'place-setup' && kind !== 'compensation-draw' && kind !== 'place-bench' && kind !== 'take-prizes' && kind !== 'choose-replacement') {
    return null;
  }
  const minCount = parseCount(min);
  const maxCount = parseCount(max);
  const benchMinCount = parseCount(benchMin);
  const benchMaxCount = parseCount(benchMax);
  if (minCount === null || maxCount === null || benchMinCount === null || benchMaxCount === null) {
    return null;
  }
  const candidates = parseHandIndexArray(value['candidates'], 'pendingChoice.candidates');
  if (!candidates.ok) {
    return null;
  }
  return { choiceId, seat, kind, min: minCount, max: maxCount, benchMin: benchMinCount, benchMax: benchMaxCount, candidates: candidates.message };
}

const SPECIAL_CONDITION_KINDS: readonly SpecialConditionKind[] = ['中毒', '灼伤', '睡眠', '麻痹', '混乱'];

function isSpecialConditionKind(value: unknown): value is SpecialConditionKind {
  return typeof value === 'string' && (SPECIAL_CONDITION_KINDS as readonly string[]).includes(value);
}

const MATCH_WIN_CONDITIONS: readonly MatchWinCondition[] = ['prizes', 'no-pokemon', 'deck-out'];

function isWinCondition(value: unknown): value is MatchWinCondition {
  return typeof value === 'string' && (MATCH_WIN_CONDITIONS as readonly string[]).includes(value);
}

function isFinishReason(value: unknown): value is MatchFinishReason {
  return isWinCondition(value) || value === 'concede' || value === 'simultaneous';
}

function parseResultConditions(value: unknown): readonly MatchResultCondition[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const conditions: MatchResultCondition[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isSeat(entry['seat']) || !isWinCondition(entry['condition'])) {
      return null;
    }
    conditions.push({ seat: entry['seat'], condition: entry['condition'] });
  }
  return conditions;
}

function parseResult(value: unknown): MatchResultView | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const winner = value['winner'];
  if (winner !== null && !isSeat(winner)) {
    return undefined;
  }
  if (!isFinishReason(value['reason'])) {
    return undefined;
  }
  const conditions = parseResultConditions(value['conditions']);
  if (conditions === null) {
    return undefined;
  }
  return { winner, reason: value['reason'], conditions };
}

function parseEvent(value: unknown): MatchPublicEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const seq = parseCount(value['seq']);
  if (seq === null) {
    return null;
  }
  const type = value['type'];
  if (type === 'match-created') {
    const seats = value['seats'];
    if (!Array.isArray(seats) || seats.length !== 2 || !seats.every(isNonEmptyString)) {
      return null;
    }
    return { seq, type, seats: [seats[0] as string, seats[1] as string] };
  }
  if (type === 'turn-order-flip') {
    const winner = value['winner'];
    return isSeat(winner) ? { seq, type, winner } : null;
  }
  if (type === 'turn-order-chosen') {
    const seat = value['seat'];
    const goFirst = value['goFirst'];
    return isSeat(seat) && typeof goFirst === 'boolean' ? { seq, type, seat, goFirst } : null;
  }
  if (type === 'mulligan') {
    const seat = value['seat'];
    const count = parseCount(value['count']);
    const shared = value['shared'];
    const cards = parseCardArray(value['cards']);
    return isSeat(seat) && count !== null && typeof shared === 'boolean' && cards !== null
      ? { seq, type, seat, count, shared, cards }
      : null;
  }
  if (type === 'setup-placed' || type === 'prizes-placed') {
    const seat = value['seat'];
    return isSeat(seat) ? { seq, type, seat } : null;
  }
  if (type === 'compensation-declared' || type === 'bench-placed') {
    const seat = value['seat'];
    const count = parseCount(value['count']);
    return isSeat(seat) && count !== null ? { seq, type, seat, count } : null;
  }
  if (type === 'setup-revealed') {
    const seat = value['seat'];
    const active = parseCardView(value['active']);
    const bench = parseCardArray(value['bench']);
    return isSeat(seat) && active !== null && bench !== null ? { seq, type, seat, active, bench } : null;
  }
  if (type === 'turn-started') {
    const seat = value['seat'];
    const turn = parseCount(value['turn']);
    return isSeat(seat) && turn !== null && turn > 0 ? { seq, type, seat, turn } : null;
  }
  if (type === 'card-drawn') {
    const seat = value['seat'];
    const count = parseCount(value['count']);
    return isSeat(seat) && count !== null ? { seq, type, seat, count } : null;
  }
  if (type === 'draw-blocked') {
    const seat = value['seat'];
    const turn = parseCount(value['turn']);
    return isSeat(seat) && turn !== null && turn > 0 ? { seq, type, seat, turn } : null;
  }
  if (type === 'basic-placed') {
    const seat = value['seat'];
    const card = parseCardView(value['card']);
    return isSeat(seat) && card !== null ? { seq, type, seat, card } : null;
  }
  if (type === 'energy-attached') {
    const seat = value['seat'];
    const card = parseCardView(value['card']);
    const target = parseMatchPokemonRef(value['target']);
    const targetNameZh = value['targetNameZh'];
    return isSeat(seat) && card !== null && target.ok && isNonEmptyString(targetNameZh)
      ? { seq, type, seat, card, target: target.message, targetNameZh }
      : null;
  }
  if (type === 'retreat') {
    const seat = value['seat'];
    const active = parseCardView(value['active']);
    const bench = parseCardView(value['bench']);
    return isSeat(seat) && active !== null && bench !== null ? { seq, type, seat, active, bench } : null;
  }
  if (type === 'attack-used') {
    const seat = value['seat'];
    const attackName = value['attackName'];
    const baseDamage = parseCount(value['baseDamage']);
    const damage = parseCount(value['damage']);
    return isSeat(seat) && isNonEmptyString(attackName) && baseDamage !== null && damage !== null
      ? { seq, type, seat, attackName, baseDamage, damage }
      : null;
  }
  if (type === 'damage-counters-placed') {
    const seat = value['seat'];
    const targetSeat = value['targetSeat'];
    const count = parseCount(value['count']);
    return isSeat(seat) && isSeat(targetSeat) && count !== null ? { seq, type, seat, targetSeat, count } : null;
  }
  if (type === 'status-inflicted') {
    const seat = value['seat'];
    const targetSeat = value['targetSeat'];
    const condition = value['condition'];
    if (
      !isSeat(seat) ||
      !isSeat(targetSeat) ||
      !isNonEmptyString(value['targetNameZh']) ||
      !isSpecialConditionKind(condition)
    ) {
      return null;
    }
    return { seq, type, seat, targetSeat, targetNameZh: value['targetNameZh'], condition };
  }
  if (type === 'status-recovered') {
    const targetSeat = value['targetSeat'];
    const condition = value['condition'];
    const cause = value['cause'];
    if (
      !isSeat(targetSeat) ||
      !isNonEmptyString(value['targetNameZh']) ||
      !isSpecialConditionKind(condition) ||
      (cause !== 'checkup' && cause !== 'retreat' && cause !== 'evolve' && cause !== 'effect')
    ) {
      return null;
    }
    return { seq, type, targetSeat, targetNameZh: value['targetNameZh'], condition, cause };
  }
  if (type === 'checkup-flip') {
    const targetSeat = value['targetSeat'];
    const condition = value['condition'];
    const result = value['result'];
    if (!isSeat(targetSeat) || !isNonEmptyString(value['targetNameZh'])) {
      return null;
    }
    if (condition !== '灼伤' && condition !== '睡眠') {
      return null;
    }
    if (result !== 'heads' && result !== 'tails') {
      return null;
    }
    return { seq, type, targetSeat, targetNameZh: value['targetNameZh'], condition, result };
  }
  if (type === 'confusion-flip') {
    const seat = value['seat'];
    const result = value['result'];
    const selfDamageCounters = parseCount(value['selfDamageCounters']);
    if (!isSeat(seat) || !isNonEmptyString(value['targetNameZh']) || (result !== 'heads' && result !== 'tails') || selfDamageCounters === null) {
      return null;
    }
    return { seq, type, seat, targetNameZh: value['targetNameZh'], result, selfDamageCounters };
  }
  if (type === 'pokemon-knocked-out') {
    const targetSeat = value['targetSeat'];
    const prizeCount = parseCount(value['prizeCount']);
    if (!isSeat(targetSeat) || !isNonEmptyString(value['targetNameZh']) || prizeCount === null || prizeCount <= 0) {
      return null;
    }
    return { seq, type, targetSeat, targetNameZh: value['targetNameZh'], prizeCount };
  }
  if (type === 'prizes-taken') {
    const seat = value['seat'];
    const count = parseCount(value['count']);
    const remaining = parseCount(value['remaining']);
    return isSeat(seat) && count !== null && remaining !== null ? { seq, type, seat, count, remaining } : null;
  }
  if (type === 'replacement-placed') {
    const seat = value['seat'];
    const card = parseCardView(value['card']);
    return isSeat(seat) && card !== null ? { seq, type, seat, card } : null;
  }
  if (type === 'conceded') {
    const seat = value['seat'];
    return isSeat(seat) ? { seq, type, seat } : null;
  }
  if (type === 'match-finished') {
    const winner = value['winner'];
    const reason = value['reason'];
    if (winner !== null && !isSeat(winner)) {
      return null;
    }
    if (!isFinishReason(reason)) {
      return null;
    }
    const conditions = parseResultConditions(value['conditions']);
    if (conditions === null) {
      return null;
    }
    return { seq, type, winner, reason, conditions };
  }
  if (type === 'turn-ended') {
    const seat = value['seat'];
    const turn = parseCount(value['turn']);
    return isSeat(seat) && turn !== null && turn > 0 ? { seq, type, seat, turn } : null;
  }
  return null;
}

function parseMatchView(value: unknown): ParseResult<MatchView> {
  if (!isRecord(value)) {
    return { ok: false, error: '对局视图必须是对象' };
  }
  if (!isNonEmptyString(value['sessionId'])) {
    return { ok: false, error: '对局视图缺少 sessionId' };
  }
  const version = parseCount(value['version']);
  if (version === null || version < 1) {
    return { ok: false, error: '对局视图缺少版本号' };
  }
  const phase = value['phase'];
  if (phase !== 'turn-order' && phase !== 'setup' && phase !== 'compensation' && phase !== 'playing') {
    return { ok: false, error: '对局视图 phase 非法' };
  }
  const turn = parseCount(value['turn']);
  if (turn === null) {
    return { ok: false, error: '对局视图缺少 turn' };
  }
  const activeSeat = value['activeSeat'];
  if (activeSeat !== null && !isSeat(activeSeat)) {
    return { ok: false, error: '对局视图 activeSeat 非法' };
  }
  const firstSeat = value['firstSeat'];
  if (firstSeat !== null && !isSeat(firstSeat)) {
    return { ok: false, error: '对局视图 firstSeat 非法' };
  }
  if (typeof value['cannotDraw'] !== 'boolean') {
    return { ok: false, error: '对局视图缺少 cannotDraw' };
  }
  const rawYou = value['you'];
  const rawOpponent = value['opponent'];
  if (!isRecord(rawYou) || !isRecord(rawOpponent)) {
    return { ok: false, error: '对局视图缺少 you/opponent' };
  }
  const youSeat = rawYou['seat'];
  const opponentSeat = rawOpponent['seat'];
  if (!isSeat(youSeat) || !isSeat(opponentSeat) || youSeat === opponentSeat) {
    return { ok: false, error: '对局视图座位映射非法' };
  }
  const you = parseSideView(rawYou, youSeat);
  const opponent = parseSideView(rawOpponent, opponentSeat);
  if (you === null || opponent === null) {
    return { ok: false, error: '对局视图座位内容非法' };
  }
  // 隐私边界：对手座位不得携带任何手牌身份。
  if (opponent.hand.length !== 0) {
    return { ok: false, error: '对手座位不得携带手牌身份' };
  }
  // 隐私边界：未公开翻面时对手的战斗/备战宝可梦不得携带身份。
  if (!opponent.revealed && (opponent.active !== null || opponent.bench.length > 0)) {
    return { ok: false, error: '对手未公开的初始宝可梦不得携带身份' };
  }
  if (you.hand.length !== you.handCount) {
    return { ok: false, error: '本人手牌张数与列表不一致' };
  }
  const rawPending = value['pendingChoice'];
  let pendingChoice: MatchPendingChoiceView | null = null;
  if (rawPending !== null && rawPending !== undefined) {
    pendingChoice = parsePendingChoice(rawPending);
    if (pendingChoice === null) {
      return { ok: false, error: '对局视图的待决选择结构非法' };
    }
    if (pendingChoice.seat !== youSeat) {
      return { ok: false, error: '待决选择只能发给对应座位' };
    }
  }
  if (typeof value['waitingForOpponentChoice'] !== 'boolean') {
    return { ok: false, error: '对局视图缺少 waitingForOpponentChoice' };
  }
  const result = parseResult(value['result']);
  if (result === undefined) {
    return { ok: false, error: '对局视图 result 非法' };
  }
  if (!Array.isArray(value['events'])) {
    return { ok: false, error: '对局视图缺少公开记录' };
  }
  const events: MatchPublicEvent[] = [];
  for (const entry of value['events']) {
    const parsed = parseEvent(entry);
    if (parsed === null) {
      return { ok: false, error: '对局视图包含非法公开记录' };
    }
    events.push(parsed);
  }
  return {
    ok: true,
    message: {
      sessionId: value['sessionId'],
      version,
      phase,
      turn,
      activeSeat,
      firstSeat,
      you,
      opponent,
      pendingChoice,
      waitingForOpponentChoice: value['waitingForOpponentChoice'],
      cannotDraw: value['cannotDraw'],
      result,
      events,
    },
  };
}

/** 解析一条服务端对局消息；不是对局消息时返回 `null`。 */
export function parseMatchServerMessage(decoded: unknown): ParseResult<MatchServerMessage> | null {
  if (!isRecord(decoded)) {
    return null;
  }
  const type = decoded['type'];
  if (type === 'match') {
    const view = parseMatchView(decoded['view']);
    if (!view.ok) {
      return view;
    }
    const commandId = decoded['commandId'];
    if (commandId !== undefined && !isNonEmptyString(commandId)) {
      return { ok: false, error: 'match.commandId 非法' };
    }
    return { ok: true, message: { type: 'match', view: view.message, ...(commandId === undefined ? {} : { commandId }) } };
  }
  if (type === 'match-error') {
    const code = decoded['code'];
    if (!isMatchErrorCode(code)) {
      return { ok: false, error: `未知的对局错误码: ${String(code)}` };
    }
    const message = decoded['message'];
    if (typeof message !== 'string') {
      return { ok: false, error: 'match-error.message 缺失' };
    }
    const commandId = decoded['commandId'];
    if (commandId !== undefined && !isNonEmptyString(commandId)) {
      return { ok: false, error: 'match-error.commandId 非法' };
    }
    let view: MatchView | undefined;
    if (decoded['view'] !== undefined) {
      const parsed = parseMatchView(decoded['view']);
      if (!parsed.ok) {
        return parsed;
      }
      view = parsed.message;
    }
    return {
      ok: true,
      message: { type: 'match-error', code, message, ...(commandId === undefined ? {} : { commandId }), ...(view === undefined ? {} : { view }) },
    };
  }
  return null;
}
