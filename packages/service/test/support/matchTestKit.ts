import { readFileSync } from 'node:fs';
import {
  parseServiceCatalog,
  type CatalogCard,
  type CatalogContent,
  type DeckDocument,
  type ServiceCatalog,
} from '@ptcg/protocol';
import { defaultCatalogPath } from '../../src/catalog.ts';
import type { RandomSource } from '../../src/match.ts';

/**
 * 开局测试工具（#8）。
 *
 * 产品路径始终使用服务端随机源；测试通过**内部脚本随机源**精确安排洗牌结果，
 * 不经过任何客户端可见的种子或牌序输入。
 */

/** 依次返回预设整数，耗尽或越界即报错；用于让洗牌结果可精确安排。 */
export class SequenceRandomSource implements RandomSource {
  private index = 0;

  public constructor(private readonly values: readonly number[]) {}

  public nextInt(maxExclusive: number): number {
    if (this.index >= this.values.length) {
      throw new Error(`脚本随机源已耗尽（需要 nextInt(${maxExclusive})）`);
    }
    const value = this.values[this.index] as number;
    this.index += 1;
    if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
      throw new Error(`脚本随机值 ${value} 对 nextInt(${maxExclusive}) 非法（第 ${this.index} 个）`);
    }
    return value;
  }

  public get remaining(): number {
    return this.values.length - this.index;
  }
}

/**
 * 为 Fisher–Yates 洗牌规划输出序列：让 `initialOrder` 在洗牌后恰好变成 `desiredFinal`。
 * 重复卡牌按可互换处理。
 */
export function planShuffleOutputsForOrder(initialOrder: readonly string[], desiredFinal: readonly string[]): number[] {
  if (initialOrder.length !== desiredFinal.length || initialOrder.length === 0) {
    throw new Error('洗牌规划要求非空且等长的初始/目标序列');
  }
  const current = [...initialOrder];
  const outputs: number[] = [];
  for (let i = desiredFinal.length - 1; i >= 1; i -= 1) {
    const target = desiredFinal[i] as string;
    let position = -1;
    for (let scan = i; scan >= 0; scan -= 1) {
      if (current[scan] === target) {
        position = scan;
        break;
      }
    }
    if (position < 0) {
      throw new Error(`无法规划洗牌：目标位置 ${i} 的卡牌 ${target} 不在剩余牌库中`);
    }
    outputs.push(position);
    const value = current[i] as string;
    current[i] = current[position] as string;
    current[position] = value;
  }
  if (current[0] !== desiredFinal[0]) {
    throw new Error('洗牌规划失败：最终序列与目标不一致');
  }
  return outputs;
}

/** 把卡牌 id 序列聚合为卡组文档（保留首次出现顺序）。 */
export function deckDocumentFromCards(cards: readonly string[]): DeckDocument {
  return deckDocumentFromCardsWith(cards, loadReleaseCatalog().content);
}

/** 用给定目录把卡牌 id 序列聚合为卡组文档；测试夹具卡也走同一路径。 */
export function deckDocumentFromCardsWith(cards: readonly string[], catalog: CatalogContent): DeckDocument {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const cardId of cards) {
    if (!counts.has(cardId)) {
      order.push(cardId);
    }
    counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  }
  return {
    formatVersion: 1,
    environmentId: 'zh-cn-standard-2025-06-05',
    cards: order.map((cardId) => {
      const definition = catalog.cards.find((card) => card.id === cardId);
      if (definition === undefined) {
        throw new Error(`未知卡牌 ${cardId}`);
      }
      return {
        cardId,
        printIdentity: definition.identities.printIdentity,
        effectIdentity: definition.identities.effectIdentity,
        count: counts.get(cardId) as number,
      };
    }),
  };
}

/** 测试夹具卡描述：只用于会话级效果接口的自动化验证，不进入发行目录。 */
export interface FixtureCardInput {
  readonly id: string;
  readonly nameZh: string;
  readonly cardClass: 'pokemon' | 'energy' | 'trainer';
  readonly subtypes?: readonly string[];
  /** 训练家类别（物品/支援者/竞技场）；夹具测试限制时使用。 */
  readonly effectiveCategory?: string | null;
  readonly type?: string | null;
  readonly hp?: number | null;
  readonly weakness?: string | null;
  readonly resistance?: string | null;
  readonly retreat?: number | null;
  /** 卡面规则文字（如 `ex规则：…拿取2张奖赏卡。`）；用于奖赏价值与规则判定。 */
  readonly specialRuleTextZh?: string | null;
  readonly ruleLabels?: readonly string[];
  readonly attacks?: readonly {
    readonly name: string;
    readonly cost: readonly string[];
    readonly damage: string | null;
    readonly text?: string | null;
  }[];
}

/**
 * 在发行目录副本上追加测试夹具卡，返回用于引擎的目录内容。
 * 夹具卡的效果身份带 `fixture` 标记，绝不会写入发行目录或 APK。
 */
export function fixtureCatalog(cards: readonly FixtureCardInput[], base: CatalogContent = releaseCatalogContent()): CatalogContent {
  const additions: CatalogCard[] = cards.map((card) => ({
    id: card.id,
    nameZh: card.nameZh,
    cardClass: card.cardClass,
    classLabelZh: card.cardClass === 'pokemon' ? '宝可梦' : card.cardClass === 'energy' ? '能量' : '训练家',
    subtypes: [...(card.subtypes ?? [])],
    effectiveCategory:
      card.effectiveCategory ?? (card.cardClass === 'energy' && (card.subtypes ?? []).includes('基本能量') ? '基本能量' : null),
    categoryLabelZh: card.cardClass === 'pokemon' ? '宝可梦' : card.cardClass === 'energy' ? '能量' : '训练家',
    type: card.type ?? null,
    hp: card.hp ?? null,
    weakness: card.weakness ?? null,
    resistance: card.resistance ?? null,
    retreat: card.retreat ?? null,
    evolvesFrom: null,
    pokedexText: null,
    abilities: [],
    attacks: (card.attacks ?? []).map((attack) => ({
      name: attack.name,
      cost: [...attack.cost],
      damage: attack.damage,
      text: attack.text ?? null,
      attackKind: null,
    })),
    ruleLabels: [...(card.ruleLabels ?? [])],
    specialRuleTextZh: card.specialRuleTextZh ?? null,
    effectTextZh: null,
    classRuleTextZh: null,
    printedClassRuleTextZh: null,
    toolBannerTextZh: null,
    fullTextZh: card.nameZh,
    effectSummaryZh: '',
    mechanics: [],
    identities: {
      effectIdentity: `fx:fixture:${card.nameZh}:${card.id}`,
      printIdentity: `print:FIXTURE:${card.id}`,
      nameGroupKey: `name:${card.nameZh}`,
    },
    print: { printCode: 'FIXTURE', regulationMark: 'G', number: card.id, total: '001', displayNumber: `FIXTURE ${card.id}`, illustrator: 'test', copyright: 'test' },
    productCode: 'FIXTURE',
    productNameZh: '测试夹具',
    flags: { environmentLegal: true, legalityNoteZh: '测试夹具', effectSupported: true, effectNoteZh: '测试夹具' },
    imageSource: null,
    decks: [],
  }));
  return { ...base, cards: [...base.cards, ...additions] };
}

/** 逐次规划双方洗牌与发牌，输出与引擎处理顺序一一对应。 */
export class OpeningHandScript {
  private readonly decks: [string[], string[]];
  private readonly hands: [string[], string[]] = [[], []];
  public readonly outputs: number[] = [];

  public constructor(initial: readonly [readonly string[], readonly string[]]) {
    this.decks = [[...initial[0]], [...initial[1]]];
  }

  /** 让指定座位下一次洗牌后落到给定完整顺序（手牌 + 奖赏 + 剩余）。 */
  public planOrder(seat: 0 | 1, desired: readonly string[]): void {
    const current = this.decks[seat];
    this.outputs.push(...planShuffleOutputsForOrder(current, desired));
    this.decks[seat] = [...desired];
  }

  /** 规划手牌与奖赏卡；剩余牌库保持当前相对顺序。 */
  public planHand(seat: 0 | 1, hand: readonly string[], prizes: readonly string[]): void {
    const pool = [...this.decks[seat]];
    const take = (cardId: string): void => {
      const index = pool.indexOf(cardId);
      if (index < 0) {
        throw new Error(`规划手牌失败：牌库中没有 ${cardId}`);
      }
      pool.splice(index, 1);
    };
    for (const cardId of hand) {
      take(cardId);
    }
    for (const cardId of prizes) {
      take(cardId);
    }
    this.planOrder(seat, [...hand, ...prizes, ...pool]);
  }

  public deal(seat: 0 | 1): readonly string[] {
    this.hands[seat] = this.decks[seat].splice(0, 7);
    return this.hands[seat];
  }

  /** 镜像服务端放置 6 张奖赏卡：从牌库顶移除并保持测试牌库与引擎同步。 */
  public prizes(seat: 0 | 1): readonly string[] {
    return this.decks[seat].splice(0, 6);
  }

  /** 镜像一次牌库顶抽牌（补抽或首回合抽牌）。 */
  public drawTop(seat: 0 | 1): string {
    const card = this.decks[seat].shift();
    if (card === undefined) {
      throw new Error('测试牌库已空');
    }
    return card;
  }

  public returnHand(seat: 0 | 1): void {
    this.decks[seat] = [...this.decks[seat], ...this.hands[seat]];
    this.hands[seat] = [];
  }

  public hand(seat: 0 | 1): readonly string[] {
    return this.hands[seat];
  }

  public topOfDeck(seat: 0 | 1, offset = 0): string {
    const card = this.decks[seat][offset];
    if (card === undefined) {
      throw new Error(`牌库位置 ${offset} 不存在`);
    }
    return card;
  }
}

let cachedRelease: ServiceCatalog | undefined;

export function loadReleaseCatalog(): ServiceCatalog {
  if (cachedRelease === undefined) {
    cachedRelease = parseServiceCatalog(JSON.parse(readFileSync(defaultCatalogPath(), 'utf8'))) as ServiceCatalog;
  }
  return cachedRelease;
}

export function releaseCatalogContent(): CatalogContent {
  return loadReleaseCatalog().content;
}

/** 统计手中基础宝可梦数量（测试断言用）。 */
export function countBasicPokemon(cards: readonly string[], catalog: CatalogContent = releaseCatalogContent()): number {
  return cards.filter((cardId) => {
    const card = catalog.cards.find((entry) => entry.id === cardId);
    return card !== undefined && card.cardClass === 'pokemon' && card.subtypes.includes('基础');
  }).length;
}
