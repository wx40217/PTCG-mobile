import {
  isPokemonVCard,
  type StadiumEffect,
  type TrainerCanPlayResult,
  type TrainerChoiceMode,
  type TrainerEffect,
} from './match.ts';

/**
 * 正式服务注册的训练家卡效果（T10 / #11 首批 + T13 / #14 的 C/D 卡）。
 *
 * 只登记逐张按冻结卡面文字实现并通过行为测试的效果身份；目录中其余训练家卡
 * 继续以 `unsupported-card` 拒绝，不做近似。发行目录的 `effectSupported` 标记
 * 必须与本注册表一致（由 service 测试核对）。
 *
 * 覆盖：
 *   - 检索：精灵球（硬币+检索）、超级球（牌库顶 7 选 1）、高级球（弃 2 代价+检索）、
 *     等级球（HP≤90）、鼓励信（上一个对手回合己方昏厥时，最多 3 张基本能量）；
 *   - 支付弃牌成本：高级球、营火专家（1 张[火]能量 + 牌库顶 7 选 2）；
 *   - 抽牌：莎莉娜（弃 1..3 后抽到 5 张）；
 *   - 换位：莎莉娜第二效果（对手备战区「宝可梦V」与战斗宝可梦互换）、
 *     莉佳的邀请（看对手手牌 → 放基础宝可梦于对手备战区 → 互换）、
 *     捩木（弃牌区基础宝可梦与场上基础宝可梦互换并继承全部附着）；
 *   - 竞技场持续状态：深钵镇（双方每回合 1 次检索基础非规则宝可梦进备战区）、
 *     熔岩瀑布之渊（双方每回合 1 次弃牌区[火]能量附着于备战[火]宝可梦并放 2 个指示物）。
 *
 * 冻结 B-01/B-04：使用前就能判断使用后不会产生任何情况变化时不能使用。牌库
 * 张数、弃牌区与备战区都是公开信息；对手手牌内容不是，因此「莉佳的邀请」
 * 只在对手手牌张数为 0 或对手备战区已满时整体拒绝，非空但无基础宝可梦的
 * 情形仍可宣告并展示手牌后选择 0 张。
 */

/**
 * 牌库公开张数为 0 时，检索类效果使用前即可判断不会产生任何情况变化，
 * 依冻结 B-01/B-04 整体拒绝；牌库非空时不检查隐藏区域内容。
 */
function requireNonEmptyDeck(context: { ownDeckCount(): number }, cardNameZh: string): TrainerCanPlayResult {
  if (context.ownDeckCount() > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    code: 'action-not-allowed',
    message: `牌库没有卡牌（公开张数为 0），${cardNameZh}不会产生任何效果，不能使用。`,
  };
}

const POKE_BALL: TrainerEffect = {
  canPlay: (context) => requireNonEmptyDeck(context, '精灵球'),
  play: (context) => {
    // 「抛掷1次硬币如果为正面」：反面时效果结束，不检索也不洗牌。
    const flip = context.flipCoin(context.card.nameZh);
    if (flip === 'tails') {
      return;
    }
    context.startDeckSearch({
      filter: { cardClass: 'pokemon' },
      min: 0,
      max: 1,
      destination: 'hand',
      descriptionZh: '精灵球：选择自己牌库中的 1 张宝可梦，向对手展示后加入手牌，并重洗牌库（可以不选）。',
    });
  },
};

const GREAT_BALL: TrainerEffect = {
  canPlay: (context) => requireNonEmptyDeck(context, '超级球'),
  play: (context) => {
    context.startTopDeckLook({
      count: 7,
      filter: { cardClass: 'pokemon' },
      min: 0,
      max: 1,
      destination: 'hand',
      descriptionZh: '超级球：查看自己牌库上方 7 张卡牌，选择其中 1 张宝可梦，向对手展示后加入手牌（可以不选）；其余卡牌放回牌库并重洗牌库。',
    });
  },
};

const ULTRA_BALL: TrainerEffect = {
  canPlay: (context) => {
    const deck = requireNonEmptyDeck(context, '高级球');
    if (!deck.ok) {
      return deck;
    }
    return context.otherHandCount() >= 2
      ? { ok: true }
      : {
          ok: false,
          code: 'action-not-allowed',
          message: '高级球需要使用前将自己 2 张其他手牌放于弃牌区；当前手牌不足。',
        };
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
  canPlay: (context) => requireNonEmptyDeck(context, '等级球'),
  play: (context) => {
    context.startDeckSearch({
      filter: { cardClass: 'pokemon', maxHp: 90 },
      min: 0,
      max: 1,
      destination: 'hand',
      descriptionZh: '等级球：从自己牌库中选择 1 张 HP 在 90 以下（含 90）的宝可梦，向对手展示后加入手牌，并重洗牌库（可以不选）。',
    });
  },
};

const ENCOURAGEMENT_LETTER: TrainerEffect = {
  canPlay: (context) => {
    const deck = requireNonEmptyDeck(context, '鼓励信');
    if (!deck.ok) {
      return deck;
    }
    return context.koDuringLastOpponentTurn()
      ? { ok: true }
      : {
          ok: false,
          code: 'action-not-allowed',
          message: '鼓励信只有在上一个对手的回合自己的宝可梦昏厥时才可使用。',
        };
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
  // 冻结 B-03（支援者）：使用前就能判断使用后不会发生任何情况变化时不能使用。
  // 两个效果都不可用（手牌为空且对手没有可供互换的「宝可梦V」）时必须拒绝，
  // 不能消耗支援者次数与手牌后直接结束。
  canPlay: (context) => {
    const canDiscard = context.otherHandCount() > 0;
    const canSwitch =
      context.opponentActiveCard() !== null && context.opponentBenchCards().some((entry) => isPokemonVCard(entry.card));
    if (!canDiscard && !canSwitch) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '莎莉娜的两个效果目前都不可用：手牌为空，且对手备战区没有「宝可梦V」。',
      };
    }
    return { ok: true };
  },
  play: (context) => {
    const hasSwitchTarget =
      context.opponentActiveCard() !== null && context.opponentBenchCards().some((entry) => isPokemonVCard(entry.card));
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
    // 两个效果在使用前都不可用的情况已在 `canPlay` 拒绝；此处仍防御性处理。
    context.startModeChoice({
      modes,
      step: 1,
      stepCount: 2,
      descriptionZh: '莎莉娜：从 2 个效果中选择 1 个使用。',
    });
  },
};

const FIRE_EXPERT: TrainerEffect = {
  // 冻结 B-04：查看牌库顶也需要牌库非空（公开张数）；[火]能量是使用代价，
  // 手牌内容属于本人信息，可以在使用前确认代价是否支付得起。
  canPlay: (context) => {
    if (context.ownDeckCount() === 0) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '牌库没有卡牌（公开张数为 0），营火专家不会产生任何效果，不能使用。',
      };
    }
    if (!context.ownHandCards().some((card) => card.cardClass === 'energy' && card.type === '火')) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '这张卡牌只有将自己手牌中的 1 张[火]能量放于弃牌区后才可使用；当前手牌没有[火]能量。',
      };
    }
    return { ok: true };
  },
  play: (context) => {
    context.startDiscardChoice({
      min: 1,
      max: 1,
      step: 1,
      stepCount: 2,
      filter: { cardClass: 'energy', energyType: '火' },
      descriptionZh: '营火专家：选择自己手牌中的 1 张[火]能量放于弃牌区（使用代价），然后查看牌库顶 7 张。',
      followUp: { kind: 'top-deck-look-to-hand', count: 7, max: 2 },
    });
  },
};

const LILLIE_INVITE: TrainerEffect = {
  // 对手手牌内容不是公开信息：只在“对手没有手牌”或“对手备战区已满”时
  // 整体拒绝；否则即使手牌中没有基础宝可梦也允许宣告，展示手牌后选择 0 张。
  canPlay: (context) => {
    if (context.opponentHandCount() === 0) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '对手没有手牌，莉佳的邀请不会产生任何情况变化，不能使用。',
      };
    }
    if (context.opponentBenchCount() >= 5) {
      return {
        ok: false,
        code: 'action-not-allowed',
        message: '对手备战区已满 5 只宝可梦，无法放置基础宝可梦。',
      };
    }
    return { ok: true };
  },
  play: (context) => {
    context.startSelectCard({
      source: 'opponent-hand',
      filter: { cardClass: 'pokemon', basicOnly: true },
      min: 0,
      max: 1,
      step: 1,
      stepCount: 2,
      descriptionZh: '莉佳的邀请：查看对手的手牌，选择其中 1 张基础宝可梦放于对手的备战区，然后与战斗宝可梦互换（可以选择 0 张）。',
      followUp: { kind: 'invite-opponent-hand-basic' },
    });
  },
};

const THORNTON: TrainerEffect = {
  // 弃牌区与场上宝可梦都是公开信息，可以在使用前判断是否有目标。
  canPlay: (context) => {
    const hasDiscardBasic = context.ownDiscardCards().some((card) => card.cardClass === 'pokemon' && card.subtypes.includes('基础'));
    if (!hasDiscardBasic) {
      return { ok: false, code: 'action-not-allowed', message: '自己弃牌区没有基础宝可梦，捩木不会产生任何效果。' };
    }
    const hasFieldBasic = context.ownFieldCards().some((card) => card.cardClass === 'pokemon' && card.subtypes.includes('基础'));
    if (!hasFieldBasic) {
      return { ok: false, code: 'action-not-allowed', message: '自己场上没有基础宝可梦，捩木不会产生任何效果。' };
    }
    return { ok: true };
  },
  play: (context) => {
    context.startSelectCard({
      source: 'discard',
      filter: { cardClass: 'pokemon', basicOnly: true },
      min: 1,
      max: 1,
      step: 1,
      stepCount: 2,
      descriptionZh: '捩木：选择自己弃牌区中的 1 张基础宝可梦，与场上的基础宝可梦互换。',
      followUp: { kind: 'toss-select-field-target' },
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
    const deck = requireNonEmptyDeck(context, '深钵镇');
    if (!deck.ok) {
      return deck;
    }
    // 牌库非空时不查询隐藏区域内容：牌库没有目标时仍可宣告使用，按检索
    // 失败处理并重洗牌库（冻结 H）。牌库为空是公开信息（张数为 0），使用前
    // 即可判断不会产生任何情况变化，依冻结 B-04 整体拒绝且不消耗本回合次数。
    return { ok: true };
  },
  use: (context) => {
    context.startDeckSearch({
      filter: { cardClass: 'pokemon', basicOnly: true, noRule: true },
      min: 0,
      max: 1,
      destination: 'bench',
      descriptionZh: '深钵镇：选择自己牌库中的 1 张基础宝可梦（拥有规则的宝可梦除外）放于备战区，并重洗牌库（可以不选）。',
      consumeStadiumUse: true,
    });
  },
};

const MAGMA_FALLS: TrainerEffect = {
  // 竞技场卡放于场上后持续存在；「每次在自己的回合有1次机会」由 `use-stadium` 驱动。
  canPlay: () => ({ ok: true }),
  play: () => undefined,
};

const MAGMA_FALLS_STADIUM: StadiumEffect = {
  canUse: (context) => {
    const hasFireEnergy = context.ownDiscardCards().some((card) => card.cardClass === 'energy' && card.type === '火');
    if (!hasFireEnergy) {
      return { ok: false, code: 'action-not-allowed', message: '自己弃牌区没有[火]能量，熔岩瀑布之渊不会产生任何效果。' };
    }
    const hasFireBench = context.ownBenchCards().some((card) => card.cardClass === 'pokemon' && card.type === '火');
    if (!hasFireBench) {
      return { ok: false, code: 'action-not-allowed', message: '自己备战区没有[火]宝可梦，熔岩瀑布之渊不会产生任何效果。' };
    }
    return { ok: true };
  },
  use: (context) => {
    context.startSelectCard({
      source: 'discard',
      filter: { cardClass: 'energy', energyType: '火' },
      min: 1,
      max: 1,
      step: 1,
      stepCount: 2,
      consumeStadiumUse: true,
      descriptionZh: '熔岩瀑布之渊：选择自己弃牌区中的 1 张[火]能量。',
      followUp: { kind: 'stadium-select-fire-bench-target' },
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
  ['fx:trainer:营火专家:55e15d575c28', FIRE_EXPERT],
  ['fx:trainer:莉佳的邀请:7d3a1b1cd06a', LILLIE_INVITE],
  ['fx:trainer:捩木:88c348193755', THORNTON],
  ['fx:trainer:熔岩瀑布之渊:f5047e4f881c', MAGMA_FALLS],
]);

/** 效果身份 → 竞技场使用效果表。 */
export const PRODUCTION_STADIUM_EFFECTS: ReadonlyMap<string, StadiumEffect> = new Map<string, StadiumEffect>([
  ['fx:trainer:深钵镇:7c178228afc9', DEEP_BOWL_STADIUM],
  ['fx:trainer:熔岩瀑布之渊:f5047e4f881c', MAGMA_FALLS_STADIUM],
]);
