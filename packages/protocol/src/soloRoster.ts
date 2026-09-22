import { validateDeck, type DeckCatalogView, type DeckDocument } from './deck.ts';
import { SOLO_PRESETS, SOLO_DATA_REVISION } from './soloPresets.ts';

export { SOLO_PRESETS, SOLO_DATA_REVISION } from './soloPresets.ts';
// The exported data is shared by UI and AI in one process. Enforce the readonly
// contract at runtime; callers needing a session document use soloDeckDocument.
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
freezeTree(SOLO_PRESETS);
export const SOLO_ROSTER_VERSION = 'solo-roster-v1';
export type SoloPresetId = 'solo-a-v1' | 'solo-b-v1' | 'solo-d-v1';
export type SoloOpponentId = 'linyue' | 'canglan' | 'yansen';
export type SoloStrategyId = 'harmony-evolution' | 'hail-resource' | 'prize-pressure';
export interface SoloPreset {
  readonly id: SoloPresetId;
  readonly sourceCode: 'A' | 'B' | 'D';
  readonly version: 1;
  readonly nameZh: string;
  readonly deck: DeckDocument;
}
export interface SoloTacticalScenario {
  readonly id: string;
  readonly givenZh: string;
  readonly expectedZh: string;
}
export interface SoloOpponent {
  readonly id: SoloOpponentId;
  readonly presetId: SoloPresetId;
  readonly strategyId: SoloStrategyId;
  readonly nameZh: string;
  readonly introductionZh: string;
  readonly available: true;
  readonly portrait: { readonly svg: string; readonly altZh: string; readonly license: 'GPL-3.0-only'; readonly provenanceZh: string };
  readonly tactics: {
    readonly primaryCardIds: readonly string[];
    readonly planZh: string;
    readonly preferencesZh: readonly string[];
    readonly resourceTradeoffZh: string;
    readonly weaknessZh: string;
    readonly adaptationZh: string;
    readonly scenarios: readonly SoloTacticalScenario[];
  };
  readonly dialogue: Readonly<Record<'start' | 'win' | 'loss', string>>;
}

// Original geometric portraits: no external images, fonts, scripts or network URLs.
function portrait(color: string, accessory: string, altZh: string): SoloOpponent['portrait'] {
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="24" fill="${color}"/><path d="M22 128v-20a42 42 0 0 1 84 0v20" fill="#243447"/><circle cx="64" cy="53" r="29" fill="#f1c7a5"/><path d="M34 49q-1-37 30-35 33 0 30 35L77 32 44 45Z" fill="#243447"/><circle cx="54" cy="54" r="3"/><circle cx="75" cy="54" r="3"/><path d="M55 68q9 7 18 0" fill="none" stroke="#633d32" stroke-width="3"/>${accessory}</svg>`, altZh, license: 'GPL-3.0-only', provenanceZh: '本项目原创几何人物形象；源码随项目 GPL-3.0-only 交付，无第三方素材。' };
}

export const SOLO_OPPONENTS: readonly SoloOpponent[] = [
  {
    id: 'linyue', presetId: 'solo-a-v1', strategyId: 'harmony-evolution', nameZh: '林悦', available: true,
    introductionZh: '让伙伴各就各位，再用和弦稳步推进。',
    portrait: portrait('#e8b6d4', '<path d="M86 28l21-10v23Z" fill="#fff0f7"/>', '林悦：粉色背景、发侧蝴蝶结'),
    tactics: {
      primaryCardIds: ['csve1-062', 'csve1-063', 'csv3c-095'],
      planZh: '保住仙子伊布V并进化VMAX，备战保留超与钢两种属性，以极巨和弦持续输出。',
      preferencesZh: ['优先检索缺失的进化环节，藤树只检索合法连击基础。', '备战没有钢属性时优先铺拖拖蚓，不为重复属性占满位置。', '能依法完成击倒时优先攻击；珍贵一触用于有能量可贴且值得回复的备战。'],
      resourceTradeoffZh: '偏向保留唯一VMAX和下一次手贴能量；宁可少抽牌，也不轻易用高级球弃掉唯一进化件。',
      weaknessZh: '成型需要进化与多回合附能，VMAX被击倒会失去三张奖赏；铺出的拖拖蚓也可能成为狙击目标。',
      adaptationZh: '进化件暂缺时用基础招式或梦幻ex的合法复制周转；有公开致胜机会时放弃继续铺场或回复。',
      scenarios: [
        { id: 'harmony-diversity', givenZh: 'VMAX可用极巨和弦，备战只有超属性，手中有拖拖蚓且有空位。', expectedZh: '先铺钢属性拖拖蚓再攻击，和弦基础伤害从100提高到130。' },
        { id: 'harmony-evolve', givenZh: '仙子伊布V满足进化条件，手中有VMAX。', expectedZh: '优先进化；不能在刚放置或首回合非法进化。' },
        { id: 'harmony-finish', givenZh: '极巨和弦可拿最后奖赏，同时有受伤备战可用珍贵一触。', expectedZh: '选择致胜攻击，不为性格强行回复拖延。' },
      ],
    },
    dialogue: { start: '伙伴到齐，就开始吧。', win: '这一拍，刚刚好。', loss: '下次换个节奏。' },
  },
  {
    id: 'canglan', presetId: 'solo-b-v1', strategyId: 'hail-resource', nameZh: '沧澜', available: true,
    introductionZh: '每一份水能量，都要换来恰好的突破。',
    portrait: portrait('#9dd7ec', '<path d="M30 91l34 17 34-17-7 25H37Z" fill="#327bb5"/>', '沧澜：蓝色背景、蓝色围巾'),
    tactics: {
      primaryCardIds: ['csv3c-043', 'csve1-138', 'csv3c-095'],
      planZh: '战栗冷气补充手中水能量，按每回合手贴积累，再以冰雹利刃换取关键击倒。没有额外能量加速。',
      preferencesZh: ['优先给主攻古剑豹附能，珠贝按当前缺口找水宝可梦与物品。', '冰雹利刃以公开HP、弱点与抵抗估算击倒阈值，只弃必要数量。', '无法击倒时权衡累积伤害与保留下一回合攻击费用。'],
      resourceTradeoffZh: '可从自己备战弃水能量，但优先保住下一只攻击者；不因场上水能量多而全弃。',
      weaknessZh: '每次爆发都会减少场上能量，只有正常手贴时续航慢；战栗冷气是检索而非附能。',
      adaptationZh: '水能量不足时不做零伤害爆发，转向可合法攻击的副攻或继续蓄能；最后奖赏可打破保能偏好。',
      scenarios: [
        { id: 'hail-exact-cost', givenZh: '冰雹可用，场上4张水能量，对手战斗剩余120HP且无弱抗或减伤。', expectedZh: '弃2张造成120击倒，保留另外2张，不全弃。' },
        { id: 'hail-no-acceleration', givenZh: '战栗冷气获得2张水能量，本回合已手贴且没有其他合法附能效果。', expectedZh: '保留在手牌，不提交第二次普通附能。' },
        { id: 'hail-finish', givenZh: '弃尽场上水能量才能依法拿最后奖赏。', expectedZh: '允许全弃结束对局，不为保能放弃胜局。' },
      ],
    },
    dialogue: { start: '慢慢积蓄，也能掀起浪。', win: '这一击，足够了。', loss: '余力还要算得更仔细。' },
  },
  {
    id: 'yansen', presetId: 'solo-d-v1', strategyId: 'prize-pressure', nameZh: '岩森', available: true,
    introductionZh: '盯住备战的空隙，局势越紧越要沉着。',
    portrait: portrait('#b7cf98', '<path d="M31 29q33-30 66 0v9H31Z" fill="#47643b"/><path d="M23 37h83" stroke="#47643b" stroke-width="8"/>', '岩森：绿色背景、宽檐帽'),
    tactics: {
      primaryCardIds: ['csv3c-015', 'csv3c-095'],
      planZh: '古简蜗积累草能量；按对手已取得的奖赏计算贪欲藤蔓，优先狙击可拿奖赏的备战，森林燃烧处理战斗场。',
      preferencesZh: ['只看公开备战HP、伤害和奖赏数选择狙击目标，不猜隐藏牌。', '相近收益时偏向备战击倒，阻止已公开的进化或蓄能后续。', '捩木仅交换弃牌区与场上基础宝可梦，继承能量、伤害和状态；避免换成低HP宝可梦后立即昏厥，不能当作回复。'],
      resourceTradeoffZh: '偏向给古简蜗集中附能以达到森林燃烧费用，保留第二攻击者；不会故意送出奖赏来提高藤蔓伤害。',
      weaknessZh: '对手未拿奖赏时藤蔓为零，且森林燃烧需要四能量；缺少合适备战目标时狙击优势消失。',
      adaptationZh: '零奖赏或无备战时转向森林燃烧/合法副攻；公开战斗场致胜击倒优先于狙击偏好。',
      scenarios: [
        { id: 'prize-snipe', givenZh: '对手已拿2张奖赏，其备战有剩余120HP目标，藤蔓费用满足。', expectedZh: '选择该备战造成120伤害；备战不计算弱点或抵抗。' },
        { id: 'prize-zero', givenZh: '对手尚未拿奖赏，古简蜗有足够费用使用森林燃烧。', expectedZh: '用森林燃烧攻击战斗场，不重复使用零伤害藤蔓。' },
        { id: 'prize-finish', givenZh: '森林燃烧可拿最后奖赏，备战也有可狙击但不能结束对局的目标。', expectedZh: '攻击战斗场结束对局；不为展示狙击牺牲胜局。' },
      ],
    },
    dialogue: { start: '看看这次，机会会落在哪里。', win: '稳住，就能找到空隙。', loss: '这次是你先找到了机会。' },
  },
];

/** All combinations are open; this is not a progression or unlock table. */
export const SOLO_MATCHUPS: readonly Readonly<{ presetId: SoloPresetId; opponentId: SoloOpponentId }>[] = SOLO_PRESETS.flatMap(preset => SOLO_OPPONENTS.map(opponent => ({ presetId: preset.id, opponentId: opponent.id })));
freezeTree(SOLO_OPPONENTS);
freezeTree(SOLO_MATCHUPS);

/** Static, event-only lines; no interpolation of hands, future RNG or private choices. */
export function soloDialogue(opponentId: SoloOpponentId, event: 'start' | 'win' | 'loss', enabled: boolean): string | null {
  return enabled ? SOLO_OPPONENTS.find(opponent => opponent.id === opponentId)?.dialogue[event] ?? null : null;
}

/** Returns a detached document so sessions/editors cannot mutate the frozen roster. */
export function soloDeckDocument(presetId: string): DeckDocument | null {
  const preset = SOLO_PRESETS.find(candidate => candidate.id === presetId);
  return preset ? { ...preset.deck, cards: preset.deck.cards.map(card => ({ ...card })) } : null;
}

/** Fail closed on revision drift as well as the existing shared legality/effect checks. */
export function validateSoloRoster(catalog: DeckCatalogView): readonly string[] {
  const errors: string[] = [];
  if (catalog.content.dataRevision.sourceDigest !== SOLO_DATA_REVISION) errors.push('单人预设目录修订不匹配。');
  for (const preset of SOLO_PRESETS) {
    const result = validateDeck(preset.deck, catalog);
    errors.push(...result.problems.map(problem => `${preset.id}: ${problem.message}`));
    const original = catalog.content.decks.find(deck => deck.code === preset.sourceCode);
    const counts = (cards: readonly { id: string; count: number }[]) => JSON.stringify([...cards].sort((a, b) => a.id.localeCompare(b.id)));
    if (!original || counts(original.cards) !== counts(preset.deck.cards.map(card => ({ id: card.cardId, count: card.count })))) errors.push(`${preset.id}: 原始预设卡表已改变。`);
  }
  return errors;
}
