import type { AbilityEffect, AttackEffectResolver, ToolEffect } from './match.ts';

/**
 * 正式服务注册的宝可梦效果（T11 / #12）。
 *
 * 只登记逐张按冻结卡面文字实现并通过行为测试的效果身份；目录中其余宝可梦
 * 招式/特性/道具继续以 `unsupported-card` 拒绝，不做近似。发行目录的
 * `effectSupported` 标记必须与本注册表一致（由 service 测试核对）。
 *
 * 覆盖（有界代表组合，其余效果留给 #13/#14）：
 *   - A 线进化：仙子伊布V → 仙子伊布VMAX（名字链、回合限制与继承/重置由引擎
 *     统一处理，不在此登记）；
 *   - 特性「梦中赠礼」：自己回合 1 次，检索 1 张真正的「物品」（不含宝可梦
 *     道具），使用后自己的回合结束；
 *   - 特性「战栗冷气」：只在战斗场上、自己回合 1 次，检索最多 2 张基本水能量；
 *   - 招式「珍贵一触」：选 1 张手牌基本能量附着于 1 只备战宝可梦并回复 120 HP；
 *   - 招式「极巨和弦」：70 + 自己备战宝可梦的属性种类数×30；
 *   - 招式「冰雹利刃」：弃置自己场上宝可梦附着的任意数量基本水能量，
 *     每张造成 60 点伤害；
 *   - 宝可梦道具「勇气护符」：基础宝可梦最大 HP +50。
 *
 * 冻结环境未在四套预设中实际使用特殊能量（`csve1-171 一击能量` 继续标为
 * 未接入且不能附着），因此以上效果只接受基本能量；附着路径对未接入的特殊
 * 能量整体拒绝，不会用近似效果替代。
 *
 * 冻结证据边界（官方截止日前简中文章 product/15732，2024-08-23）：文章写明
 * 「讲究腰带」与光耀掉角鹰人可给对方的「宝可梦VMAX」追加伤害，而「讲究
 * 腰带」的效果面向「宝可梦V」，据此 VMAX 的 `VMAX规则` 也属于「宝可梦V」。
 * VSTAR 仍无同等截止日前定义证据，继续只按卡面规则文字处理，不按卡名推断。
 */

/** 仙子伊布V（csve1-062）的特性「梦中赠礼」。 */
const DREAM_GIFT: AbilityEffect = {
  // 特性本身会结束自己的回合，因此即使牌库公开张数为 0 也产生可观察变化，
  // 不套用「使用前就能判断无变化则不能使用」的检索类限制。
  canUse: () => ({ ok: true }),
  use: (context) => {
    context.startDeckSearch({
      filter: { cardClass: 'trainer', itemOnly: true },
      min: 0,
      max: 1,
      destination: 'hand',
      descriptionZh:
        '梦中赠礼：选择自己牌库中的 1 张物品，向对手展示后加入手牌，并重洗牌库（可以选择 0 张）；这个特性结算后自己的回合结束。',
      followUp: { kind: 'end-turn' },
    });
  },
};

/** 古剑豹ex（csv3c-043）的特性「战栗冷气」。 */
const CHILLING_COLD: AbilityEffect = {
  canUse: (context) => {
    if (!context.isActive()) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '「战栗冷气」只有在这只宝可梦位于战斗场上时才能使用。',
      };
    }
    if (context.ownDeckCount() === 0) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '牌库没有卡牌（公开张数为 0），「战栗冷气」不会产生任何效果，不能使用。',
      };
    }
    return { ok: true };
  },
  use: (context) => {
    context.startDeckSearch({
      filter: { basicEnergyOnly: true, energyType: '水' },
      min: 0,
      max: 2,
      destination: 'hand',
      descriptionZh:
        '战栗冷气：从自己牌库中选择最多 2 张基本水能量，向对手展示后加入手牌，并重洗牌库（可以选择 0 张）。',
    });
  },
};

/** 勇气护符（csv1c-118）：基础宝可梦最大 HP +50。 */
const COURAGE_CHARM: ToolEffect = {
  maxHpBonus: (target) =>
    target.cardClass === 'pokemon' && target.subtypes.includes('基础') ? 50 : 0,
};

/** 仙子伊布VMAX（csve1-063）的招式「珍贵一触」。 */
const PRECIOUS_TOUCH: AttackEffectResolver = (context) => {
  context.startAttachHandEnergyToBench({
    heal: 120,
    descriptionZh: '珍贵一触：选择自己备战区的 1 只宝可梦，作为附着能量与回复 HP 的目标。',
  });
};

/** 仙子伊布VMAX（csve1-063）的招式「极巨和弦」。 */
const MAX_CHORD: AttackEffectResolver = (context) => {
  const types = new Set(context.ownBenchTypes().filter((type): type is string => type !== null));
  context.dealDamageWithBase(70 + types.size * 30);
};

/** 古剑豹ex（csv3c-043）的招式「冰雹利刃」。 */
const HAIL_BLADE: AttackEffectResolver = (context) => {
  context.startDiscardAttachedEnergy({
    type: '水',
    basicOnly: true,
    min: 0,
    max: null,
    descriptionZh:
      '冰雹利刃：选择自己场上宝可梦附着的任意数量基本水能量放于弃牌区，造成其张数×60 点伤害（可以选择 0 张）。',
    followUp: { kind: 'attack-damage-per-discarded-energy', perEnergy: 60 },
  });
};

/** 效果身份 + 招式名 → 招式效果。 */
export const PRODUCTION_ATTACK_EFFECTS: ReadonlyMap<string, AttackEffectResolver> = new Map<string, AttackEffectResolver>([
  ['fx:pokemon:仙子伊布VMAX:7f46295cb5ec#珍贵一触', PRECIOUS_TOUCH],
  ['fx:pokemon:仙子伊布VMAX:7f46295cb5ec#极巨和弦', MAX_CHORD],
  ['fx:pokemon:古剑豹ex:47bdd73235a0#冰雹利刃', HAIL_BLADE],
]);

/** 效果身份 + 特性名 → 特性效果。 */
export const PRODUCTION_ABILITY_EFFECTS: ReadonlyMap<string, AbilityEffect> = new Map<string, AbilityEffect>([
  ['fx:pokemon:仙子伊布V:82add47b1578#梦中赠礼', DREAM_GIFT],
  ['fx:pokemon:古剑豹ex:47bdd73235a0#战栗冷气', CHILLING_COLD],
]);

/** 效果身份 → 宝可梦道具效果。 */
export const PRODUCTION_TOOL_EFFECTS: ReadonlyMap<string, ToolEffect> = new Map<string, ToolEffect>([
  ['fx:trainer:勇气护符:8eb34c62d928', COURAGE_CHARM],
]);
