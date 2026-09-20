import type { AbilityEffect, AttackEffectContext, AttackEffectResolver, PassiveAbilityEffect, ToolEffect } from './match.ts';

/**
 * 正式服务注册的宝可梦效果（T11 / #12 首批 + T13 / #14 的 C/D 卡）。
 *
 * 只登记逐张按冻结卡面文字实现并通过行为测试的效果身份；目录中其余宝可梦
 * 招式/特性/道具继续以 `unsupported-card` 拒绝，不做近似。发行目录的
 * `effectSupported` 标记必须与本注册表一致（由 service 测试核对）。
 *
 * 覆盖：
 *   - A 线进化：仙子伊布V → 仙子伊布VMAX（名字链、回合限制与继承/重置由引擎
 *     统一处理，不在此登记）；
 *   - A 线特性/招式/道具：梦中赠礼、魔法射击、珍贵一触、极巨和弦、勇气护符；
 *   - B 线：战栗冷气、冰雹利刃、古剑豹ex 的 ex 规则；
 *   - C/D 线：再起动与基因侵入（梦幻ex）、营养铁质与刺穿（拖拖蚓）、
 *     妒火中烧与火焰巨浪（古玉鱼ex）、贪欲藤蔓与森林燃烧（古简蜗ex）、
 *     古代睿智与巨人破坏（雷吉奇卡斯）。
 *
 * 冻结环境未在四套预设中实际使用特殊能量（`csve1-171 一击能量` 继续标为
 * 未接入且不能附着），因此附着类效果只接受基本能量；附着路径对未接入的特殊
 * 能量整体拒绝，不会用近似效果替代。
 *
 * 冻结证据边界（官方截止日前简中文章 product/15732，2024-08-23）：文章写明
 * 「讲究腰带」与光耀掉角鹰人可给对方的「宝可梦VMAX」追加伤害，而「讲究
 * 腰带」的效果面向「宝可梦V」，据此 VMAX 的 `VMAX规则` 也属于「宝可梦V」。
 * VSTAR 仍无同等截止日前定义证据，继续只按卡面规则文字处理，不按卡名推断。
 * 「巨人破坏」的追加条件直接按印刷的 `VMAX规则` 判定（`defenderIsPokemonVmax`）。
 */

/** 梦幻ex（csve1-056）的特性「再起动」。 */
const RESTART: AbilityEffect = {
  // 冻结 B-01/B-04：手牌已有 3 张或更多、或牌库公开张数为 0 时，抽牌直到
  // 手牌 3 张不会产生任何情况变化，因此不能使用。
  canUse: (context) => {
    if (context.ownHandCount() >= 3) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '自己的手牌已经有 3 张或更多，「再起动」不会抽到任何卡牌。',
      };
    }
    if (context.ownDeckCount() === 0) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '牌库没有卡牌（公开张数为 0），「再起动」不会产生任何效果，不能使用。',
      };
    }
    return { ok: true };
  },
  use: (context) => {
    context.drawUntilHandSize(3);
  },
};

/** 梦幻ex（csve1-056）的招式「基因侵入」。 */
const GENOME_HACKING: AttackEffectResolver = Object.assign(
  (context: AttackEffectContext) => {
    context.startCopyOpponentAttack({
      descriptionZh: '基因侵入：选择对手战斗宝可梦拥有的 1 个招式，作为这个招式使用。',
    });
  },
  // 复制类效果：复制到的复制招式仍可继续使用（官方同机制 Q&A，如
  // トレース→ゆびをふる）；只有在没有任何非复制出口的闭合环里才以显式的
  // 暂定边界收招，精确的官方闭环裁定待来源确认。
  { copiesAttack: true as const },
);

/** 拖拖蚓（csv3c-095）的特性「营养铁质」：附着 3 个及以上[钢]能量时最大 HP +100。 */
const NOURISHING_IRON: PassiveAbilityEffect = {
  maxHpBonus: (context) =>
    context.attachedEnergyTypes.filter((type) => type === '钢').length >= 3 ? 100 : 0,
};

/** 拖拖蚓（csv3c-095）的招式「刺穿」：100 伤害 + 对对手备战 1 只目标追加 30。 */
const PIERCE: AttackEffectResolver = (context) => {
  if (context.opponentBenchCount() === 0) {
    // 没有备战目标时效果只包含战斗伤害；用 `dealDamageWithBase` 记录公开招式结果。
    context.dealDamageWithBase(context.baseDamage);
    return;
  }
  context.startOpponentBenchSnipe({
    activeBaseDamage: context.baseDamage,
    activeDamage: context.finalDamage,
    benchDamage: 30,
    descriptionZh: '刺穿：选择对手备战区的 1 只宝可梦，对其造成 30 点伤害（备战宝可梦不计算弱点、抗性）。',
  });
};

/** 古简蜗ex（csv3c-015）的招式「贪欲藤蔓」：按对手已获得奖赏卡张数×60 狙击备战区。 */
const GREEDY_VINES: AttackEffectResolver = (context) => {
  const benchDamage = context.opponentPrizesTaken() * 60;
  if (context.opponentBenchCount() === 0 || benchDamage === 0) {
    // 没有备战目标或倍率为 0 时不产生伤害；仍公开记录本次招式使用。
    context.dealDamageWithBase(0);
    return;
  }
  context.startOpponentBenchSnipe({
    activeBaseDamage: 0,
    activeDamage: 0,
    benchDamage,
    descriptionZh: `贪欲藤蔓：选择对手备战区的 1 只宝可梦，造成对手已获得奖赏卡张数×60（当前 ${benchDamage}）点伤害（备战宝可梦不计算弱点、抗性）。`,
  });
};

/** 古玉鱼ex（csv3c-031）的招式「妒火中烧」：将对手牌库上方 2 张放于其弃牌区。 */
const ENVIOUS_FLAME: AttackEffectResolver = (context) => {
  context.discardOpponentDeckTop(2);
};

/** 古玉鱼ex（csv3c-031）的招式「火焰巨浪」：100 伤害 + 最多 3 只备战各贴 1 张牌库基本火能量。 */
const FIREY_SURGE: AttackEffectResolver = (context) => {
  context.startAttachDeckEnergyToBench({
    energyType: '火',
    maxTargets: 3,
    activeBaseDamage: context.baseDamage,
    activeDamage: context.finalDamage,
    descriptionZh: '火焰巨浪：选择自己最多 3 只备战宝可梦，各附着 1 张牌库中的「基本火能量」，并重洗牌库（可以选择 0 只）。',
  });
};

/** 雷吉奇卡斯（csve1-098）的特性「古代睿智」：场上须同时集齐全部五只指定雷吉。 */
const ANCIENT_WISDOM: AbilityEffect = {
  canUse: (context) => {
    // 冻结简中卡面与官方文章 product/15767（2024-07-09）：「需要在场上同时存在
    // 雷吉洛克、雷吉艾斯、雷吉斯奇鲁、雷吉艾勒奇以及雷吉铎拉戈的情况下方能使用」。
    const requiredNames = ['雷吉洛克', '雷吉艾斯', '雷吉斯奇鲁', '雷吉艾勒奇', '雷吉铎拉戈'] as const;
    const presentNames = new Set(context.ownFieldCards().map((card) => card.nameZh));
    const missing = requiredNames.filter((name) => !presentNames.has(name));
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: `「古代睿智」需要自己场上同时集齐「雷吉洛克」「雷吉艾斯」「雷吉斯奇鲁」「雷吉艾勒奇」「雷吉铎拉戈」；当前缺少${missing.join('、')}。`,
      };
    }
    if (!context.ownDiscardCards().some((card) => card.cardClass === 'energy')) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '自己弃牌区没有能量，「古代睿智」不会产生任何效果，不能使用。',
      };
    }
    return { ok: true };
  },
  use: (context) => {
    context.startSelectCard({
      source: 'discard',
      filter: { cardClass: 'energy' },
      min: 0,
      max: 3,
      descriptionZh: '古代睿智：选择自己弃牌区中最多 3 张能量，附着于自己的 1 只宝可梦身上。',
      followUp: { kind: 'regi-energies-chosen' },
    });
  },
};

/** 雷吉奇卡斯（csve1-098）的招式「巨人破坏」：对手战斗宝可梦为 VMAX 时 +150。 */
const GIANT_BREAK: AttackEffectResolver = (context) => {
  context.dealDamageWithBase(context.defenderIsPokemonVmax() ? 300 : 150);
};

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
  ['fx:pokemon:梦幻ex:d782ea07a666#基因侵入', GENOME_HACKING],
  ['fx:pokemon:拖拖蚓:428e5ea49c3c#刺穿', PIERCE],
  ['fx:pokemon:古简蜗ex:424c917c76f2#贪欲藤蔓', GREEDY_VINES],
  ['fx:pokemon:古玉鱼ex:74092e521712#妒火中烧', ENVIOUS_FLAME],
  ['fx:pokemon:古玉鱼ex:74092e521712#火焰巨浪', FIREY_SURGE],
  ['fx:pokemon:雷吉奇卡斯:e7626369eb12#巨人破坏', GIANT_BREAK],
]);

/** 效果身份 + 特性名 → 特性效果。 */
export const PRODUCTION_ABILITY_EFFECTS: ReadonlyMap<string, AbilityEffect> = new Map<string, AbilityEffect>([
  ['fx:pokemon:仙子伊布V:82add47b1578#梦中赠礼', DREAM_GIFT],
  ['fx:pokemon:古剑豹ex:47bdd73235a0#战栗冷气', CHILLING_COLD],
  ['fx:pokemon:梦幻ex:d782ea07a666#再起动', RESTART],
  ['fx:pokemon:雷吉奇卡斯:e7626369eb12#古代睿智', ANCIENT_WISDOM],
]);

/** 效果身份 + 特性名 → 持续生效、不能主动使用的特性。 */
export const PRODUCTION_PASSIVE_ABILITY_EFFECTS: ReadonlyMap<string, PassiveAbilityEffect> = new Map<string, PassiveAbilityEffect>([
  ['fx:pokemon:拖拖蚓:428e5ea49c3c#营养铁质', NOURISHING_IRON],
]);

/** 效果身份 → 宝可梦道具效果。 */
export const PRODUCTION_TOOL_EFFECTS: ReadonlyMap<string, ToolEffect> = new Map<string, ToolEffect>([
  ['fx:trainer:勇气护符:8eb34c62d928', COURAGE_CHARM],
]);
