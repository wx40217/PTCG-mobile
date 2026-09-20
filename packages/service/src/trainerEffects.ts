import { isPokemonVCard, type StadiumEffect, type TrainerChoiceMode, type TrainerEffect } from './match.ts';

/**
 * 正式服务注册的训练家卡效果（T10 / #11）。
 *
 * 只登记逐张按冻结卡面文字实现并通过行为测试的效果身份；目录中其余训练家卡
 * 继续以 `unsupported-card` 拒绝，不做近似。发行目录的 `effectSupported` 标记
 * 必须与本注册表一致（由 service 测试核对）。
 *
 * 覆盖：
 *   - 检索：精灵球（硬币+检索）、超级球（牌库顶 7 选 1）、高级球（弃 2 代价+检索）、
 *     等级球（HP≤90）、鼓励信（上一个对手回合己方昏厥时，最多 3 张基本能量）；
 *   - 支付弃牌成本：高级球；
 *   - 抽牌：莎莉娜（弃 1..3 后抽到 5 张）；
 *   - 换位：莎莉娜第二效果（对手备战区「宝可梦V」与战斗宝可梦互换）；
 *   - 竞技场持续状态：深钵镇（双方每回合 1 次检索基础非规则宝可梦进备战区）。
 */

const POKE_BALL: TrainerEffect = {
  canPlay: () => ({ ok: true }),
  play: (context) => {
    // 「抛掷1次硬币如果为正面」：反面时效果结束，不检索也不洗牌。
    const flip = context.flipCoin(context.card.nameZh);
    if (flip === 'tails') {
      return;
    }
    context.startDeckSearch({
      filter: { cardClass: 'pokemon' },
      min: 1,
      max: 1,
      destination: 'hand',
      descriptionZh: '精灵球：选择自己牌库中的 1 张宝可梦，向对手展示后加入手牌，并重洗牌库。',
    });
  },
};

const GREAT_BALL: TrainerEffect = {
  canPlay: () => ({ ok: true }),
  play: (context) => {
    context.startTopDeckLook({
      count: 7,
      filter: { cardClass: 'pokemon' },
      min: 1,
      max: 1,
      destination: 'hand',
      descriptionZh: '超级球：查看自己牌库上方 7 张卡牌，选择其中 1 张宝可梦，向对手展示后加入手牌；其余卡牌放回牌库并重洗牌库。',
    });
  },
};

const ULTRA_BALL: TrainerEffect = {
  canPlay: (context) =>
    context.otherHandCount() >= 2
      ? { ok: true }
      : {
          ok: false,
          code: 'action-not-allowed',
          message: '高级球需要使用前将自己 2 张其他手牌放于弃牌区；当前手牌不足。',
        },
  play: (context) => {
    context.startDiscardChoice({
      min: 2,
      max: 2,
      step: 1,
      stepCount: 2,
      descriptionZh: '高级球：选择 2 张其他手牌放于弃牌区（使用代价），然后从牌库检索 1 张宝可梦。',
      followUp: { kind: 'search-pokemon-to-hand' },
    });
  },
};

const LEVEL_BALL: TrainerEffect = {
  canPlay: () => ({ ok: true }),
  play: (context) => {
    context.startDeckSearch({
      filter: { cardClass: 'pokemon', maxHp: 90 },
      min: 1,
      max: 1,
      destination: 'hand',
      descriptionZh: '等级球：从自己牌库中选择 1 张 HP 在 90 以下（含 90）的宝可梦，向对手展示后加入手牌，并重洗牌库。',
    });
  },
};

const ENCOURAGEMENT_LETTER: TrainerEffect = {
  canPlay: (context) =>
    context.koDuringLastOpponentTurn()
      ? { ok: true }
      : {
          ok: false,
          code: 'action-not-allowed',
          message: '鼓励信只有在上一个对手的回合自己的宝可梦昏厥时才可使用。',
        },
  play: (context) => {
    context.startDeckSearch({
      filter: { basicEnergyOnly: true },
      min: 0,
      max: 3,
      destination: 'hand',
      descriptionZh: '鼓励信：选择自己牌库中最多 3 张基本能量，向对手展示后加入手牌，并重洗牌库（可选择 0 张）。',
    });
  },
};

const SERENA: TrainerEffect = {
  canPlay: () => ({ ok: true }),
  play: (context) => {
    const hasSwitchTarget = context.opponentBenchCards().some((entry) => isPokemonVCard(entry.card));
    const canDiscard = context.handCount() > 0;
    const modes: TrainerChoiceMode[] = [
      {
        modeId: 'discard-draw-five',
        labelZh: '弃置自己最多 3 张手牌（至少 1 张），然后从牌库抽卡直到手牌 5 张',
        available: canDiscard,
        unavailableReasonZh: canDiscard ? null : '手牌为空，无法弃置至少 1 张',
        resolution: 'discard-then-draw-five',
      },
      {
        modeId: 'switch-opponent-v',
        labelZh: '选择对手备战区的 1 只「宝可梦V」，将其与战斗宝可梦互换',
        available: hasSwitchTarget,
        unavailableReasonZh: hasSwitchTarget ? null : '对手备战区没有「宝可梦V」',
        resolution: 'switch-opponent-v',
      },
    ];
    // 两个效果都不可用时使用莎莉娜不产生任何效果（卡面没有使用条件）。
    context.startModeChoice({
      modes,
      step: 1,
      stepCount: 2,
      descriptionZh: '莎莉娜：从 2 个效果中选择 1 个使用。',
    });
  },
};

const DEEP_BOWL: TrainerEffect = {
  canPlay: () => ({ ok: true }),
  // 竞技场卡放于场上后持续存在；「每次在自己的回合有1次机会」由 `use-stadium` 驱动。
  play: () => undefined,
};

const DEEP_BOWL_STADIUM: StadiumEffect = {
  canUse: (context) => {
    if (context.ownBenchCount() >= 5) {
      return { ok: false, code: 'action-not-allowed', message: '备战区已满 5 只宝可梦，不能使用深钵镇。' };
    }
    if (!context.deckHas({ cardClass: 'pokemon', basicOnly: true, noRule: true })) {
      return {
        ok: false,
        code: 'illegal-target',
        message: '牌库中没有可放于备战区的基础宝可梦（拥有规则的宝可梦除外）。',
      };
    }
    return { ok: true };
  },
  use: (context) => {
    context.startDeckSearch({
      filter: { cardClass: 'pokemon', basicOnly: true, noRule: true },
      min: 1,
      max: 1,
      destination: 'bench',
      descriptionZh: '深钵镇：选择自己牌库中的 1 张基础宝可梦（拥有规则的宝可梦除外）放于备战区，并重洗牌库。',
      consumeStadiumUse: true,
    });
  },
};

/** 效果身份 → 使用效果注册表；发行服务只注册冻结环境下已验证的条目。 */
export const PRODUCTION_TRAINER_EFFECTS: ReadonlyMap<string, TrainerEffect> = new Map<string, TrainerEffect>([
  ['fx:trainer:精灵球:992d7d8946ca', POKE_BALL],
  ['fx:trainer:超级球:e8abaed723aa', GREAT_BALL],
  ['fx:trainer:高级球:d8722e9e5903', ULTRA_BALL],
  ['fx:trainer:等级球:267540cf9470', LEVEL_BALL],
  ['fx:trainer:鼓励信:e0854a592aea', ENCOURAGEMENT_LETTER],
  ['fx:trainer:莎莉娜:2cbdb4c4540e', SERENA],
  ['fx:trainer:深钵镇:7c178228afc9', DEEP_BOWL],
]);

/** 效果身份 → 竞技场使用效果表。 */
export const PRODUCTION_STADIUM_EFFECTS: ReadonlyMap<string, StadiumEffect> = new Map<string, StadiumEffect>([
  ['fx:trainer:深钵镇:7c178228afc9', DEEP_BOWL_STADIUM],
]);
