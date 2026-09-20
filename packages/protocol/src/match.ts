/**
 * 开局对局契约（T07 / #8）。
 *
 * 房间建立唯一会话后，对局从「服务端随机决定先后攻选择权」开始，依次完成：
 * 洗牌与 7 张手牌、无基础宝可梦的展示/重抽（含双方同时重抽）、初始战斗/备战
 * 宝可梦盖放、6 张奖赏卡、按对手重抽次数的可选补抽与补抽基础宝可梦的备战
 * 放置，最后公开翻面并进入唯一首回合。
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

export type MatchPendingChoiceKind = 'turn-order' | 'place-setup' | 'compensation-draw' | 'compensation-bench';

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

export interface PlaceCompensationBenchCommand extends MatchCommandBase {
  readonly type: 'place-compensation-bench';
  readonly choiceId: string;
  /** 从补抽得到的基础宝可梦手牌序号中选取要放入备战区的张数。 */
  readonly bench: readonly number[];
}

export type MatchClientMessage =
  | ChooseTurnOrderCommand
  | PlaceSetupCommand
  | ResolveCompensationCommand
  | PlaceCompensationBenchCommand;

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
  /** 是否为「基础」宝可梦；用于初始盖放与补抽后的备战选择。 */
  readonly isBasicPokemon: boolean;
  readonly type: string | null;
  readonly hp: number | null;
  readonly printDisplayNumber: string;
}

export interface MatchPokemonView {
  readonly card: MatchCardView;
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
  /** 该座位重抽（无基础宝可梦）次数；公开信息，用于补抽上限。 */
  readonly mulligans: number;
  /** 盖放的战斗/备战宝可梦是否已经公开翻面。 */
  readonly revealed: boolean;
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
  /** `place-setup` / `compensation-bench` 的备战最多张数。 */
  readonly benchMax: number;
  /**
   * `place-setup` 为手牌中可用基础宝可梦的序号；
   * `compensation-bench` 为补抽得到的基础宝可梦手牌序号。其他种类为空。
   */
  readonly candidates: readonly number[];
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
      /** 重抽公开展示的手牌（规则要求向对手展示）。 */
      readonly cards: readonly MatchCardView[];
    }
  | { readonly seq: number; readonly type: 'setup-placed'; readonly seat: MatchSeat }
  | { readonly seq: number; readonly type: 'prizes-placed'; readonly seat: MatchSeat }
  | { readonly seq: number; readonly type: 'compensation-declared'; readonly seat: MatchSeat; readonly count: number }
  | { readonly seq: number; readonly type: 'compensation-benched'; readonly seat: MatchSeat; readonly count: number }
  | {
      readonly seq: number;
      readonly type: 'setup-revealed';
      readonly seat: MatchSeat;
      readonly active: MatchCardView;
      readonly bench: readonly MatchCardView[];
    }
  | { readonly seq: number; readonly type: 'turn-started'; readonly seat: MatchSeat; readonly turn: number };

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

const COMMAND_KEYS = ['type', 'commandId', 'sessionId', 'expectedVersion', 'choiceId', 'goFirst', 'active', 'bench', 'draw'] as const;

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
  if (
    type !== 'choose-turn-order' &&
    type !== 'place-setup' &&
    type !== 'resolve-compensation' &&
    type !== 'place-compensation-bench'
  ) {
    return null;
  }
  const base = parseCommandBase(decoded, type, COMMAND_KEYS);
  if (!base.ok) {
    return base;
  }
  const choice = parseChoiceId(decoded, type);
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
  const bench = parseHandIndexArray(decoded['bench'], 'place-compensation-bench.bench');
  if (!bench.ok) {
    return bench;
  }
  return { ok: true, message: { type, ...base.message, choiceId: choice.message, bench: bench.message } };
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

function parsePokemonView(value: unknown): MatchPokemonView | null {
  if (!isRecord(value)) {
    return null;
  }
  const card = parseCardView(value['card']);
  return card === null ? null : { card };
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
  if (typeof value['setupPlaced'] !== 'boolean' || typeof value['revealed'] !== 'boolean') {
    return null;
  }
  const mulligans = parseCount(value['mulligans']);
  if (mulligans === null) {
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
    revealed: value['revealed'],
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
  if (kind !== 'turn-order' && kind !== 'place-setup' && kind !== 'compensation-draw' && kind !== 'compensation-bench') {
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
    const cards = parseCardArray(value['cards']);
    return isSeat(seat) && count !== null && cards !== null ? { seq, type, seat, count, cards } : null;
  }
  if (type === 'setup-placed' || type === 'prizes-placed') {
    const seat = value['seat'];
    return isSeat(seat) ? { seq, type, seat } : null;
  }
  if (type === 'compensation-declared' || type === 'compensation-benched') {
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
