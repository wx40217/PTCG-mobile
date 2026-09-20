import { useEffect, useState, type ReactElement } from 'react';
import type {
  MatchAttackView,
  MatchCardView,
  MatchChoiceCandidateView,
  MatchPokemonRef,
  MatchPokemonView,
  MatchPublicEvent,
  MatchSeat,
  MatchView,
  ServiceCatalog,
} from '@ptcg/protocol';
import type { ImageCache } from '../catalog/imageCache.ts';
import { useCardImage } from '../catalog/useCardImage.ts';
import type { MatchState } from '../rooms/matchController.ts';

export interface MatchScreenProps {
  /** 联机会话是否仍然存活；断线时禁用开局与回合操作。 */
  readonly connected: boolean;
  /** 正在自动重连（保留当前屏，不切到失败页）。 */
  readonly reconnecting?: boolean;
  readonly onRetryConnection?: () => void;
  readonly match: MatchState;
  readonly onChooseTurnOrder: (goFirst: boolean) => void;
  readonly onPlaceSetup: (active: number, bench: readonly number[]) => void;
  readonly onResolveCompensation: (draw: number) => void;
  readonly onPlaceBench: (bench: readonly number[]) => void;
  readonly onPlayBasic: (handIndex: number) => void;
  readonly onAttachEnergy: (handIndex: number, target: MatchPokemonRef) => void;
  readonly onRetreat: (energyIndices: readonly number[], benchIndex: number) => void;
  readonly onEvolve: (handIndex: number, target: MatchPokemonRef) => void;
  readonly onUseAbility: (abilityIndex: number, target: MatchPokemonRef) => void;
  readonly onAttachTool: (handIndex: number, target: MatchPokemonRef) => void;
  readonly onAttack: (attackIndex: number, target: MatchPokemonRef) => void;
  readonly onEndTurn: () => void;
  readonly onPlayTrainer: (handIndex: number) => void;
  readonly onUseStadium: () => void;
  readonly onDiscardHand: (handIndices: readonly number[]) => void;
  readonly onSearchDeck: (candidateIds: readonly string[]) => void;
  readonly onChooseMode: (modeId: string) => void;
  readonly onSwitchOpponent: (benchIndex: number) => void;
  readonly onChooseOwnBench: (benchIndex: number) => void;
  readonly onAttachHandEnergy: (candidateId: string) => void;
  readonly onDiscardEnergy: (candidateIds: readonly string[]) => void;
  /** 卡牌效果：从弃牌区/对手手牌等私有区域选择卡牌。 */
  readonly onSelectCard: (candidateIds: readonly string[]) => void;
  /** 卡牌效果：选择场上目标（备战狙击、能量附着、互换等）。 */
  readonly onSelectTarget: (candidateIds: readonly string[]) => void;
  /** 卡牌效果：「基因侵入」复制对手战斗宝可梦的招式。 */
  readonly onCopyAttack: (attackIndex: number) => void;
  readonly onTakePrizes: (prizes: readonly number[]) => void;
  readonly onChooseReplacement: (benchIndex: number) => void;
  readonly onConcede: () => void;
  /** 终局后返回原房间；房间仍保留会话供重入查看，重新准备后开新局。 */
  readonly onReturnToRoom: () => void;
  readonly onBack: () => void;
  readonly onClearError: () => void;
  /** 可选卡库/图片缓存：用于候选卡放大与完整卡面文字兜底。 */
  readonly catalog?: ServiceCatalog | undefined;
  readonly imageCache?: ImageCache | undefined;
  readonly resolveAssetUrl?: ((path: string) => string) | undefined;
  readonly onOpenImage?: ((image: { readonly src: string; readonly labelZh: string; readonly provenanceZh: string }) => void) | undefined;
}

function seatName(view: MatchView, seat: MatchSeat): string {
  return seat === view.you.seat ? view.you.nickname : view.opponent.nickname;
}

/** 公开记录说明：只使用合法公开信息（重抽展示、补抽张数、公开翻面、公开行动等）。 */
function describeEvent(event: MatchPublicEvent, view: MatchView): string {
  switch (event.type) {
    case 'match-created':
      return `对局建立：${event.seats[0]} vs ${event.seats[1]}`;
    case 'turn-order-flip':
      return `服务端猜拳：${seatName(view, event.winner)}获得先后攻选择权`;
    case 'turn-order-chosen':
      return `${seatName(view, event.seat)}选择${event.goFirst ? '先攻' : '后攻'}`;
    case 'mulligan':
      return event.shared
        ? `双方第 ${event.count} 次重抽，展示：${event.cards.map((card) => card.nameZh).join('、')}`
        : `${seatName(view, event.seat)}第 ${event.count} 次重抽，展示：${event.cards.map((card) => card.nameZh).join('、')}`;
    case 'setup-placed':
      return `${seatName(view, event.seat)}已盖放初始宝可梦`;
    case 'prizes-placed':
      return `${seatName(view, event.seat)}已放置 6 张奖赏卡`;
    case 'compensation-declared':
      return `${seatName(view, event.seat)}补抽 ${event.count} 张`;
    case 'bench-placed':
      return `${seatName(view, event.seat)}将 ${event.count} 张基础宝可梦放入备战区`;
    case 'setup-revealed':
      return `${seatName(view, event.seat)}公开翻面：战斗 ${event.active.nameZh}${event.bench.length === 0 ? '' : ` · 备战 ${event.bench.map((card) => card.nameZh).join('、')}`}`;
    case 'turn-started':
      return `第 ${event.turn} 回合开始：轮到${seatName(view, event.seat)}`;
    case 'card-drawn':
      return `${seatName(view, event.seat)}从牌库抽 ${event.count} 张`;
    case 'draw-blocked':
      return `第 ${event.turn} 回合开始：${seatName(view, event.seat)}牌库为空，无法抽卡`;
    case 'basic-placed':
      return `${seatName(view, event.seat)}将基础宝可梦「${event.card.nameZh}」放入备战区`;
    case 'energy-attached':
      return `${seatName(view, event.seat)}给「${event.targetNameZh}」附着「${event.card.nameZh}」`;
    case 'tool-attached':
      return `${seatName(view, event.seat)}给「${event.targetNameZh}」附着宝可梦道具「${event.card.nameZh}」`;
    case 'evolved':
      return `${seatName(view, event.seat)}将「${event.fromNameZh}」进化为「${event.toNameZh}」`;
    case 'ability-used':
      return `${seatName(view, event.seat)}的「${event.targetNameZh}」使用了特性「${event.abilityName}」`;
    case 'damage-healed':
      return `「${event.targetNameZh}」回复了 ${event.counters} 个伤害指示物（${event.counters * 10} 点 HP）`;
    case 'energy-discarded':
      return `${seatName(view, event.seat)}将 ${event.cards.length} 张附着能量放于弃牌区：${event.cards.map((card) => card.nameZh).join('、')}`;
    case 'retreat':
      return `${seatName(view, event.seat)}撤退：「${event.bench.nameZh}」回到备战区，「${event.active.nameZh}」上场`;
    case 'attack-used':
      return `${seatName(view, event.seat)}使用「${event.attackName}」造成 ${event.damage} 点伤害（基础 ${event.baseDamage}）`;
    case 'damage-counters-placed':
      return `「${seatName(view, event.targetSeat)}」的宝可梦身上放置 ${event.count} 个伤害指示物`;
    case 'status-inflicted':
      return `${seatName(view, event.seat)}使「${event.targetNameZh}」陷入【${event.condition}】`;
    case 'status-recovered':
      return `「${event.targetNameZh}」的【${event.condition}】已恢复（${
        event.cause === 'checkup' ? '宝可梦检查' : event.cause === 'retreat' ? '回到备战区' : event.cause === 'evolve' ? '进化' : '卡牌效果'
      }）`;
    case 'checkup-flip':
      return `宝可梦检查：「${event.targetNameZh}」的【${event.condition}】抛硬币为${event.result === 'heads' ? '正面' : '反面'}`;
    case 'confusion-flip':
      return `「${event.targetNameZh}」的【混乱】抛硬币为${event.result === 'heads' ? '正面，招式成功' : `反面，招式失败并自行放置 ${event.selfDamageCounters} 个伤害指示物`}`;
    case 'pokemon-knocked-out':
      return `「${event.targetNameZh}」昏厥（对手可拿 ${event.prizeCount} 张奖赏卡）`;
    case 'prizes-taken':
      return `${seatName(view, event.seat)}拿取了 ${event.count} 张奖赏卡（剩余 ${event.remaining} 张）`;
    case 'replacement-placed':
      return `${seatName(view, event.seat)}将「${event.card.nameZh}」升为战斗宝可梦`;
    case 'conceded':
      return `${seatName(view, event.seat)}确认认输`;
    case 'match-finished':
      return event.winner === null
        ? event.reason === 'disconnect-timeout'
          ? '对局结束：双方离线且断线预算耗尽，无胜负中止'
          : '对局结束：平局'
        : `对局结束：${seatName(view, event.winner)}获胜（${
            event.reason === 'prizes'
              ? '拿取全部奖赏卡'
              : event.reason === 'no-pokemon'
                ? '对手没有能放于战斗场的宝可梦'
                : event.reason === 'deck-out'
                  ? '回合开始无法抽牌'
                  : event.reason === 'disconnect-timeout'
                    ? '对手断线超出 180 秒预算'
                    : '有一方确认认输'
          }）`;
    case 'turn-ended':
      return `第 ${event.turn} 回合结束：${seatName(view, event.seat)}`;
    case 'trainer-played':
      return `${seatName(view, event.seat)}使用了训练家卡「${event.card.nameZh}」`;
    case 'coin-flip':
      return `${seatName(view, event.seat)}的「${event.cardNameZh}」抛硬币为${event.result === 'heads' ? '正面' : '反面'}`;
    case 'cards-discarded':
      return `${seatName(view, event.seat)}将 ${event.cards.length} 张手牌放于弃牌区：${event.cards.map((card) => card.nameZh).join('、')}`;
    case 'cards-searched':
      return `${seatName(view, event.seat)}展示了${event.cards.map((card) => `「${card.nameZh}」`).join('、')}并${event.destination === 'bench' ? '放于备战区' : '加入手牌'}`;
    case 'deck-shuffled':
      return `${seatName(view, event.seat)}重洗了牌库`;
    case 'stadium-placed':
      return `${seatName(view, event.seat)}将竞技场卡「${event.card.nameZh}」放于场上${event.replaced === null ? '' : `（替换「${event.replaced.nameZh}」）`}`;
    case 'bench-switched':
      return `${seatName(view, event.seat)}将「${seatName(view, event.targetSeat)}」的「${event.active.nameZh}」与「${event.bench.nameZh}」互换`;
    case 'deck-milled':
      return `${seatName(view, event.seat)}将${seatName(view, event.targetSeat)}牌库上方的 ${event.cards.length} 张卡放于其弃牌区：${event.cards.map((card) => card.nameZh).join('、')}`;
    case 'pokemon-swapped':
      return `${seatName(view, event.seat)}将场上的「${event.fromNameZh}」与弃牌区的「${event.toNameZh}」互换（附着卡与状态继承）`;
  }
}

function CardList({ cards, emptyHint }: { cards: readonly MatchCardView[]; emptyHint: string }): ReactElement {
  if (cards.length === 0) {
    return <span className="field__hint">{emptyHint}</span>;
  }
  return (
    <ul className="catalog__list">
      {cards.map((card, index) => (
        <li key={`${card.cardId}-${index}`} className="catalog-card" data-testid={`match-card-${index}`}>
          <div className="catalog-card__head">
            <span className="catalog-card__name">{card.nameZh}</span>
            <span className="catalog-card__number">{card.printDisplayNumber}</span>
          </div>
          {card.isBasicPokemon ? <span className="badge badge--ok">基础宝可梦</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** 场上一只宝可梦的公开状态：身份、剩余 HP、伤害指示物、附着能量、招式。 */
function PokemonField(props: {
  readonly label: string;
  readonly testId: string;
  readonly pokemon: MatchPokemonView | null;
  readonly hiddenHint: string;
}): ReactElement {
  const { pokemon } = props;
  if (pokemon === null) {
    return (
      <span className="field__hint" data-testid={props.testId}>
        {props.hiddenHint}
      </span>
    );
  }
  const remainingHp = Math.max(0, pokemon.maxHp - pokemon.damageCounters * 10);
  return (
    <div className="field" data-testid={props.testId}>
      <span className="value">
        {props.label}：{pokemon.card.nameZh}
        {` · HP ${remainingHp}/${pokemon.maxHp}`}
        {pokemon.damageCounters > 0 ? ` · 伤害指示物 ${pokemon.damageCounters}` : ''}
        {pokemon.statuses.length === 0 ? '' : ` · 状态：${pokemon.statuses.join('、')}`}
        {pokemon.weakness === null ? '' : ` · 弱点 ${pokemon.weakness}`}
        {pokemon.resistance === null ? '' : ` · 抵抗 ${pokemon.resistance}`}
        {` · 撤退 ${pokemon.retreatCost}`}
      </span>
      {pokemon.tools.length === 0 ? null : (
        <span className="field__hint" data-testid={`${props.testId}-tools`}>
          宝可梦道具：{pokemon.tools.map((tool) => tool.nameZh).join('、')}
        </span>
      )}
      {pokemon.energies.length === 0 ? null : (
        <span className="field__hint" data-testid={`${props.testId}-energies`}>
          能量：{pokemon.energies.map((energy) => energy.card.nameZh).join('、')}
        </span>
      )}
      {pokemon.abilities.length === 0 ? null : (
        <span className="field__hint" data-testid={`${props.testId}-abilities`}>
          特性：
          {pokemon.abilities
            .map((ability) => `「${ability.name}」${ability.usable ? '可用' : `不可用（${ability.unusableReasonZh ?? '条件不满足'}）`}`)
            .join('；')}
        </span>
      )}
      {pokemon.attacks.length === 0 ? null : (
        <span className="field__hint" data-testid={`${props.testId}-attacks`}>
          招式：
          {pokemon.attacks
            .map((attack) => `「${attack.name}」${attack.cost.join('')}${attack.damageText === null ? '' : ` ${attack.damageText}`}`)
            .join('；')}
        </span>
      )}
    </div>
  );
}

function costCovered(attack: MatchAttackView, energies: readonly { readonly card: MatchCardView }[]): boolean {
  const pool = new Map<string, number>();
  let any = 0;
  for (const energy of energies) {
    const key = energy.card.type ?? '无';
    pool.set(key, (pool.get(key) ?? 0) + 1);
    any += 1;
  }
  let colorless = 0;
  for (const symbol of attack.cost) {
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

/**
 * 候选卡放大：优先显示已核实的卡图（可再放大），并始终显示完整简中卡面文字，
 * 因此没有卡图或加载失败时也不会阻断检索决策。
 */
function CandidateInspector(props: {
  readonly candidate: MatchChoiceCandidateView;
  readonly catalog?: ServiceCatalog | undefined;
  readonly imageCache?: ImageCache | undefined;
  readonly resolveAssetUrl?: ((path: string) => string) | undefined;
  readonly onOpenImage?: ((image: { readonly src: string; readonly labelZh: string; readonly provenanceZh: string }) => void) | undefined;
  readonly onClose: () => void;
}): ReactElement {
  const { candidate } = props;
  const card = props.catalog?.content.cards.find((entry) => entry.id === candidate.card.cardId);
  const imageStatus = props.catalog?.runtime.cardImages[candidate.card.cardId];
  const path = imageStatus?.path ?? null;
  const remoteAvailable =
    card !== undefined && card.imageSource !== null && imageStatus !== undefined && path !== null;
  const url = remoteAvailable && path !== null && props.resolveAssetUrl !== undefined ? props.resolveAssetUrl(path) : '';
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`候选卡 ${candidate.card.nameZh}（可放大）`} data-testid="match-candidate-inspector">
      <div className="viewer__bar">
        <span className="value" data-testid="match-candidate-title">
          {candidate.card.nameZh}（{candidate.card.printDisplayNumber}）
        </span>
        <button className="primary" type="button" data-testid="match-candidate-close" onClick={props.onClose}>
          关闭
        </button>
      </div>
      {props.imageCache === undefined ? null : (
        <CandidateImage
          cache={props.imageCache}
          candidate={candidate}
          remoteAvailable={remoteAvailable}
          url={url}
          sha256={imageStatus?.sha256 ?? null}
          onOpenImage={props.onOpenImage}
        />
      )}
      <h3 className="detail__heading">完整卡面文字</h3>
      <pre className="fulltext" data-testid="match-candidate-fulltext">
        {card?.fullTextZh ?? `${candidate.card.nameZh}\n${candidate.card.printDisplayNumber}\n（本机暂无该卡完整文字，仍可按名称与编号选择。）`}
      </pre>
    </div>
  );
}

function CandidateImage(props: {
  readonly cache: ImageCache;
  readonly candidate: MatchChoiceCandidateView;
  readonly remoteAvailable: boolean;
  readonly url: string;
  readonly sha256: string | null;
  readonly onOpenImage?: ((image: { readonly src: string; readonly labelZh: string; readonly provenanceZh: string }) => void) | undefined;
}): ReactElement {
  const image = useCardImage(props.cache, {
    cacheKey: `card:${props.candidate.card.cardId}`,
    expectedSha256: props.sha256,
    url: props.url,
    enabled: true,
  });
  const showImage = image.src.length > 0 && (image.status === 'ready' || image.status === 'stale');
  return (
    <div data-testid="match-candidate-image-panel">
      {showImage ? <img className="detail__thumb" src={image.src} alt={`${props.candidate.card.nameZh} 卡图`} data-testid="match-candidate-image" /> : null}
      {showImage && props.onOpenImage !== undefined ? (
        <button
          className="secondary"
          type="button"
          data-testid="match-candidate-zoom"
          onClick={() =>
            props.onOpenImage?.({
              src: image.src,
              labelZh: `${props.candidate.card.nameZh} ${props.candidate.card.printDisplayNumber}`,
              provenanceZh: '按需加载的已核实卡图（本机缓存）',
            })
          }
        >
          放大查看卡图
        </button>
      ) : null}
      {!showImage && image.status === 'loading' ? <span className="field__hint">正在按需加载卡图…</span> : null}
      {!showImage && (image.status === 'error' || image.status === 'stale') ? (
        <span className="field__hint">{image.message}完整文字卡面仍然可读。</span>
      ) : null}
      {!showImage && !props.remoteAvailable && image.status !== 'loading' ? (
        <span className="field__hint">服务端未提供该卡卡图；完整文字卡面仍然可读。</span>
      ) : null}
    </div>
  );
}

/**
 * 对局界面（#8 开局 + #9 回合 + #11 训练家卡）。
 *
 * 只呈现服务端允许公开的信息：本人手牌、双方张数、公开区身份/伤害/能量/招式、
 * 公开记录、按座位投影的待决选择。对手手牌/牌库顺序/奖赏身份从不出现在载荷里，
 * 这里也没有可渲染的数据。界面上的禁用只是操作提示，服务端不信任任何 UI 状态。
 */
export function MatchScreen(props: MatchScreenProps): ReactElement {
  const { view } = props.match;
  const pending = props.match.pending;
  const terminal = view?.result != null;
  // 对手离线期间服务端权威暂停对局：界面同步禁用回合操作与待决选择；
  // 认输是玩家自身权利，不受对手是否在线影响。
  const opponentOffline = view?.connection?.opponentOnline === false;
  const disabled = !props.connected || pending || terminal || opponentOffline;
  const concedeDisabled = !props.connected || pending || terminal;
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);
  // `place-setup` 与 `place-bench` 共用同一份勾选状态，待决选择变化时清空。
  const [bench, setBench] = useState<readonly number[]>([]);
  const [compensationDraw, setCompensationDraw] = useState<number | undefined>(undefined);
  // 昏厥结算选择：奖赏卡序号与换入的备战役。
  const [prizeSelection, setPrizeSelection] = useState<readonly number[]>([]);
  const [replacementIndex, setReplacementIndex] = useState<number | undefined>(undefined);
  // 训练家卡选择：弃牌、检索候选、效果模式与互换目标。
  const [discardSelection, setDiscardSelection] = useState<readonly number[]>([]);
  const [searchSelection, setSearchSelection] = useState<readonly string[]>([]);
  const [modeSelection, setModeSelection] = useState<string | undefined>(undefined);
  const [switchSelection, setSwitchSelection] = useState<number | undefined>(undefined);
  const [inspecting, setInspecting] = useState<MatchChoiceCandidateView | undefined>(undefined);
  // 认输需要二次确认，避免误触。
  const [concedeConfirm, setConcedeConfirm] = useState(false);
  // 回合操作选择：手牌中的能量、撤退能量与换入目标。
  const [energyHandIndex, setEnergyHandIndex] = useState<number | undefined>(undefined);
  const [retreatEnergies, setRetreatEnergies] = useState<readonly number[]>([]);
  const [retreatBenchIndex, setRetreatBenchIndex] = useState<number | undefined>(undefined);
  // 进化与宝可梦道具：先从手牌选卡，再选自己的宝可梦作为目标。
  const [evolveHandIndex, setEvolveHandIndex] = useState<number | undefined>(undefined);
  const [toolHandIndex, setToolHandIndex] = useState<number | undefined>(undefined);
  // 攻击效果待决选择：备战目标、手牌能量候选与附着能量多选。
  const [ownBenchSelection, setOwnBenchSelection] = useState<number | undefined>(undefined);
  const [handEnergySelection, setHandEnergySelection] = useState<string | undefined>(undefined);
  const [discardEnergySelection, setDiscardEnergySelection] = useState<readonly string[]>([]);
  // 「基因侵入」复制招式的选择；候选来自对手战斗宝可梦的公开招式。
  const [copyAttackSelection, setCopyAttackSelection] = useState<number | undefined>(undefined);
  const choiceId = view?.pendingChoice?.choiceId;
  const version = view?.version;

  // 待决选择或对局版本变化时清空上一次的局部选择，避免把旧选择显示成新选择的答案。
  useEffect(() => {
    setActiveIndex(undefined);
    setBench([]);
    setCompensationDraw(undefined);
    setPrizeSelection([]);
    setReplacementIndex(undefined);
    setConcedeConfirm(false);
    setEnergyHandIndex(undefined);
    setRetreatEnergies([]);
    setRetreatBenchIndex(undefined);
    setEvolveHandIndex(undefined);
    setToolHandIndex(undefined);
    setOwnBenchSelection(undefined);
    setHandEnergySelection(undefined);
    setDiscardEnergySelection([]);
    setCopyAttackSelection(undefined);
    setDiscardSelection([]);
    setSearchSelection([]);
    setModeSelection(undefined);
    setSwitchSelection(undefined);
    setInspecting(undefined);
  }, [choiceId, version]);

  const error = props.match.error;
  const isPlaying = view?.phase === 'playing';
  const myTurn = isPlaying && view?.activeSeat === view?.you.seat;
  const firstTurnRestricted = isPlaying && view !== null && view.turn === 1 && view.firstSeat === view.you.seat;
  const benchFull = (view?.you.bench.length ?? 0) >= 5;
  const resultLabel =
    view?.result == null
      ? null
      : view.result.winner === null
        ? view.result.reason === 'disconnect-timeout'
          ? '对局结束：无胜负（双方离线且断线预算耗尽）'
          : '对局结束：平局（双方同时满足胜负条件）'
        : `对局结束：${view.result.winner === view.you.seat ? '你获胜' : `${view.opponent.nickname}获胜`}`;
  const phaseLabel =
    view === null
      ? '连接对局'
      : view.phase === 'turn-order'
        ? '决定先后攻'
        : view.phase === 'setup'
          ? '盖放初始宝可梦'
          : view.phase === 'compensation'
            ? '补抽与备战'
            : `第 ${view.turn} 回合`;

  const toggleBench = (index: number, max: number): void => {
    setBench((current) => {
      if (current.includes(index)) {
        return current.filter((entry) => entry !== index);
      }
      if (current.length >= max) {
        return current;
      }
      return [...current, index];
    });
  };

  const active = view?.you.active ?? null;
  const basicHandIndices = view?.you.hand.map((card, index) => (card.isBasicPokemon ? index : -1)).filter((index) => index >= 0) ?? [];
  const energyHandIndices = view?.you.hand.map((card, index) => (card.kind === 'energy' ? index : -1)).filter((index) => index >= 0) ?? [];
  const trainerHandIndices =
    view?.you.hand
      .map((card, index) => {
        // 宝可梦道具只能通过「附着宝可梦道具」面板使用；作为训练家卡使用会被服务端以
        // 类别不匹配拒绝（T13 / #14 发现的客户端界面重复入口）。
        const catalogCard = props.catalog?.content.cards.find((entry) => entry.id === card.cardId);
        return card.kind === 'trainer' && catalogCard?.effectiveCategory !== '宝可梦道具' ? index : -1;
      })
      .filter((index) => index >= 0) ?? [];
  // 进化卡（印刷了进化前置）与宝可梦道具（类别来自目录）都可从手牌选中后指定目标。
  const evolveHandIndices = view?.you.hand.map((card, index) => (card.kind === 'pokemon' && card.evolvesFrom !== null ? index : -1)).filter((index) => index >= 0) ?? [];
  const toolHandIndices =
    view?.you.hand
      .map((card, index) => {
        const catalogCard = props.catalog?.content.cards.find((entry) => entry.id === card.cardId);
        return card.kind === 'trainer' && catalogCard?.effectiveCategory === '宝可梦道具' ? index : -1;
      })
      .filter((index) => index >= 0) ?? [];
  const ownPokemonTargets: { readonly ref: MatchPokemonRef; readonly pokemon: MatchPokemonView; readonly label: string }[] =
    view === null
      ? []
      : [
          ...(view.you.active === null ? [] : [{ ref: { slot: 'active' } as MatchPokemonRef, pokemon: view.you.active, label: '战斗宝可梦' }]),
          ...view.you.bench.map((pokemon, index) => ({
            ref: { slot: 'bench', index } as MatchPokemonRef,
            pokemon,
            label: `备战 ${index + 1} ${pokemon.card.nameZh}`,
          })),
        ];
  const evolveFromName = view !== null && evolveHandIndex !== undefined ? view.you.hand[evolveHandIndex]?.evolvesFrom ?? null : null;

  return (
    <>
      <section className="card" aria-label="对局" data-testid="match-screen">
        <h2 className="catalog__title">{isPlaying ? '对战' : '开局准备'}</h2>
        <p className="catalog__note" data-testid="match-phase">
          {phaseLabel}
        </p>
        {props.reconnecting === true ? (
          <p className="notice" role="status" data-testid="match-reconnecting">
            与服务端的连接已断开，正在自动重连；座位、版本与待决选择在服务端保留。
            {props.onRetryConnection === undefined ? null : (
              <button className="secondary" type="button" data-testid="match-reconnect-now" onClick={props.onRetryConnection}>
                立即重试
              </button>
            )}
          </p>
        ) : props.connected ? null : (
          <p className="notice" role="status" data-testid="match-disconnected">
            与服务端的连接已断开；对局操作已暂停。重连后仍会回到同一场对局。
          </p>
        )}
        {view !== null && view.result === null && view.connection?.opponentOnline === false ? (
          <p className="notice" role="status" data-testid="match-opponent-disconnected">
            等待{view.opponent.nickname}重新连接…（每人每局断线预算{' '}
            {Math.round(view.connection.disconnectBudgetMs / 1000)} 秒，重连不重置；重连后可继续未完成的待决选择）
          </p>
        ) : null}

        {error === null ? null : (
          <div className="field" data-testid="match-error">
            <span className="field__error" role="alert">
              {error.message}
            </span>
            <button className="secondary" type="button" data-testid="match-error-dismiss" onClick={props.onClearError}>
              知道了
            </button>
          </div>
        )}

        {resultLabel === null || view === null || view.result === null ? null : (
          <div className="field" data-testid="match-result" role="status">
            <span className="value__label">结果</span>
            <span className="value" data-testid="match-result-label">
              {resultLabel}（
              {view.result.reason === 'prizes'
                ? '拿取全部奖赏卡'
                : view.result.reason === 'no-pokemon'
                  ? '没有能放于战斗场的宝可梦'
                  : view.result.reason === 'deck-out'
                    ? '回合开始无法抽牌'
                    : view.result.reason === 'concede'
                      ? view.result.winner === view.you.seat
                        ? '对手确认认输'
                        : '你确认认输'
                      : view.result.reason === 'disconnect-timeout'
                        ? view.result.winner === null
                          ? '双方离线且断线预算耗尽'
                          : view.result.winner === view.you.seat
                            ? '对手断线超出 180 秒预算'
                            : '你断线超出 180 秒预算'
                        : view.result.reason === 'service-interruption'
                          ? '服务中断，无胜负'
                          : '同时满足胜负条件'}
              ）
            </span>
            <span className="field__hint">
              对局已产生唯一终态；结束后不能继续出牌。返回房间后可重新准备新局（原房间与座位保留）。
            </span>
            <div className="row">
              <button className="primary" type="button" data-testid="match-return-room" onClick={props.onReturnToRoom}>
                返回房间
              </button>
            </div>
          </div>
        )}

        {view === null ? (
          <p className="field__hint" data-testid="match-loading">
            正在进入对局…
          </p>
        ) : (
          <>
            <div className="field" data-testid="match-status">
              <span className="value__label">状态</span>
              {view.phase === 'turn-order' ? (
                view.pendingChoice?.kind === 'turn-order' ? (
                  <span className="value" data-testid="match-turn-order-prompt">
                    服务端猜拳由你获得选择权：请选择先攻或后攻。
                  </span>
                ) : (
                  <span className="value" data-testid="match-waiting">
                    等待{seatName(view, view.you.seat === 0 ? 1 : 0)}选择先后攻…
                  </span>
                )
              ) : null}
              {view.phase === 'setup' ? (
                view.pendingChoice?.kind === 'place-setup' ? (
                  <span className="value" data-testid="match-turn-order-prompt">
                    请从手牌选择 1 张基础宝可梦作为战斗宝可梦，并可选择至多 5 张基础宝可梦放入备战区（可少放或不放）。
                  </span>
                ) : (
                  <span className="value" data-testid="match-waiting">
                    等待对手盖放初始宝可梦…
                  </span>
                )
              ) : null}
              {view.phase === 'compensation' ? (
                view.pendingChoice === null ? (
                  <span className="value" data-testid="match-waiting">
                    等待对手完成补抽…
                  </span>
                ) : view.pendingChoice.kind === 'compensation-draw' ? (
                  <span className="value" data-testid="match-compensation-prompt">
                    对手单独重抽了 {view.pendingChoice.max} 次，你可以补抽 0 到 {view.pendingChoice.max} 张（也可选择不补抽）。
                  </span>
                ) : (
                  <span className="value" data-testid="match-bench-prompt">
                    还可以把选中的基础宝可梦盖放到备战区（最多 {view.pendingChoice.max} 张，也可跳过）。
                  </span>
                )
              ) : null}
              {view.phase === 'playing' ? (
                <span className="value" data-testid="match-turn-info">
                  第 {view.turn} 回合 · 轮到{seatName(view, view.activeSeat ?? view.you.seat)}
                  {myTurn ? '（你）' : '（对手）'}
                </span>
              ) : null}
            </div>

            {view.cannotDraw ? (
              <p className="notice" role="status" data-testid="match-cannot-draw">
                回合开始时牌库为空，无法抽卡；已按规则判定回合开始抽空败北。
              </p>
            ) : null}

            {view.stadium === null ? null : (
              <div className="field" data-testid="match-stadium">
                <span className="value__label">竞技场</span>
                <span className="value" data-testid="match-stadium-name">
                  {view.stadium.nameZh}（{view.stadium.printDisplayNumber}）
                </span>
                <span className="field__hint">双方玩家每个自己的回合各有 1 次机会使用其效果（由该玩家主动选择）。</span>
              </div>
            )}

            <div className="field" data-testid="match-self">
              <span className="value__label">你的场面（{view.you.nickname}）</span>
              {view.you.active === null ? (
                <span className="field__hint" data-testid="match-self-active">
                  {view.you.setupPlaced ? '战斗宝可梦已盖放（等待公开翻面）' : '尚未放置战斗宝可梦'}
                </span>
              ) : (
                <PokemonField label="战斗" testId="match-self-active" pokemon={view.you.active} hiddenHint="尚未放置战斗宝可梦" />
              )}
              {view.you.bench.length === 0 ? null : (
                <div className="field" data-testid="match-self-bench">
                  <span className="value__label">备战宝可梦</span>
                  {view.you.bench.map((pokemon, index) => (
                    <PokemonField key={`self-bench-${index}`} label={`备战 ${index + 1}`} testId={`match-self-bench-${index}`} pokemon={pokemon} hiddenHint="" />
                  ))}
                </div>
              )}
              <span className="field__hint" data-testid="match-self-zones">
                手牌 {view.you.handCount} 张 · 牌库 {view.you.deckCount} 张 · 奖赏卡 {view.you.prizeCount} 张 · 弃牌区 {view.you.discard.length} 张
                {view.you.energyAttachedThisTurn ? ' · 本回合已附能' : ''}
                {view.you.retreatedThisTurn ? ' · 本回合已撤退' : ''}
              </span>
              {view.you.discard.length === 0 ? null : (
                <span className="field__hint" data-testid="match-self-discard">
                  弃牌区：{view.you.discard.map((card) => card.nameZh).join('、')}
                </span>
              )}
            </div>

            <div className="field" data-testid="match-opponent">
              <span className="value__label">对手（{view.opponent.nickname}）</span>
              <span className="field__hint" data-testid="match-opponent-status">
                手牌 {view.opponent.handCount} 张 · 牌库 {view.opponent.deckCount} 张 · 奖赏卡 {view.opponent.prizeCount} 张 · 弃牌区 {view.opponent.discard.length} 张
                {view.opponent.mulligans > 0 ? ` · 已重抽 ${view.opponent.mulligans} 次` : ''}
              </span>
              {view.opponent.discard.length === 0 ? null : (
                <span className="field__hint" data-testid="match-opponent-discard">
                  弃牌区：{view.opponent.discard.map((card) => card.nameZh).join('、')}
                </span>
              )}
              {view.opponent.active === null ? (
                <span className="field__hint" data-testid="match-opponent-active">
                  {view.opponent.setupPlaced ? '初始宝可梦已盖放（未公开）' : '尚未放置初始宝可梦'}
                </span>
              ) : (
                <PokemonField label="战斗" testId="match-opponent-active" pokemon={view.opponent.active} hiddenHint="尚未放置初始宝可梦" />
              )}
              {view.opponent.bench.length === 0 ? null : (
                <div className="field" data-testid="match-opponent-bench">
                  <span className="value__label">备战宝可梦</span>
                  {view.opponent.bench.map((pokemon, index) => (
                    <PokemonField key={`opp-bench-${index}`} label={`备战 ${index + 1}`} testId={`match-opponent-bench-${index}`} pokemon={pokemon} hiddenHint="" />
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <span className="value__label">你的手牌</span>
              <CardList cards={view.you.hand} emptyHint="没有手牌" />
            </div>

            {/* ---------------- 开局选择 ---------------- */}

            {view.pendingChoice?.kind === 'turn-order' ? (
              <div className="row">
                <button className="primary" type="button" data-testid="match-go-first" disabled={disabled} onClick={() => props.onChooseTurnOrder(true)}>
                  先攻
                </button>
                <button className="secondary" type="button" data-testid="match-go-second" disabled={disabled} onClick={() => props.onChooseTurnOrder(false)}>
                  后攻
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'place-setup' ? (
              <div className="field" data-testid="match-setup-form">
                <span className="value__label">选择战斗宝可梦（单选）与备战宝可梦（最多 {view.pendingChoice.benchMax} 张）</span>
                <ul className="catalog__list">
                  {view.you.hand.map((card, index) => (
                    <li key={`setup-${card.cardId}-${index}`} className="catalog-card">
                      <div className="catalog-card__head">
                        <span className="catalog-card__name">{card.nameZh}</span>
                        <span className="catalog-card__number">{card.printDisplayNumber}</span>
                      </div>
                      {card.isBasicPokemon ? (
                        <div className="row">
                          <label className="field__hint">
                            <input
                              type="radio"
                              name="match-active"
                              checked={activeIndex === index}
                              disabled={disabled}
                              data-testid={`match-setup-active-${index}`}
                              onChange={() => setActiveIndex(index)}
                            />
                            战斗
                          </label>
                          <label className="field__hint">
                            <input
                              type="checkbox"
                              checked={bench.includes(index)}
                              disabled={disabled || activeIndex === index}
                              data-testid={`match-setup-bench-${index}`}
                              onChange={() => toggleBench(index, view.pendingChoice?.benchMax ?? 5)}
                            />
                            备战
                          </label>
                        </div>
                      ) : (
                        <span className="field__hint">非基础宝可梦，开局不能放置</span>
                      )}
                    </li>
                  ))}
                </ul>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-setup"
                  disabled={disabled || activeIndex === undefined}
                  onClick={() => {
                    if (activeIndex !== undefined) {
                      props.onPlaceSetup(activeIndex, bench);
                    }
                  }}
                >
                  确认盖放
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'compensation-draw' ? (
              <div className="field" data-testid="match-compensation-form">
                <span className="value__label">补抽张数</span>
                <div className="row">
                  {Array.from({ length: view.pendingChoice.max + 1 }, (_value, count) => (
                    <button
                      key={`draw-${count}`}
                      className={compensationDraw === count ? 'primary' : 'secondary'}
                      type="button"
                      data-testid={`match-compensation-draw-${count}`}
                      disabled={disabled}
                      onClick={() => setCompensationDraw(count)}
                    >
                      {count} 张
                    </button>
                  ))}
                </div>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-compensation"
                  disabled={disabled || compensationDraw === undefined}
                  onClick={() => {
                    if (compensationDraw !== undefined) {
                      props.onResolveCompensation(compensationDraw);
                    }
                  }}
                >
                  确认补抽
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'place-bench' ? (
              <div className="field" data-testid="match-bench-form">
                <span className="value__label">选择盖放到备战区的基础宝可梦（可不选）</span>
                <ul className="catalog__list">
                  {view.pendingChoice.candidates.map((index) => {
                    const card = view.you.hand[index];
                    if (card === undefined) {
                      return null;
                    }
                    return (
                      <li key={`bench-${index}`} className="catalog-card">
                        <label className="field__hint">
                          <input
                            type="checkbox"
                            checked={bench.includes(index)}
                            disabled={disabled}
                            data-testid={`match-bench-${index}`}
                            onChange={() =>
                              setBench((current) =>
                                current.includes(index)
                                  ? current.filter((entry) => entry !== index)
                                  : current.length >= (view.pendingChoice?.max ?? 1)
                                    ? current
                                    : [...current, index],
                              )
                            }
                          />
                          {card.nameZh}（{card.printDisplayNumber}）
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <button className="primary" type="button" data-testid="match-confirm-bench" disabled={disabled} onClick={() => props.onPlaceBench(bench)}>
                  确认
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'take-prizes' ? (
              <div className="field" data-testid="match-prize-form">
                <span className="value__label">
                  拿取奖赏卡：请从未公开的奖赏卡中选择 {view.pendingChoice.min} 张（拿取前不看身份）
                </span>
                <ul className="catalog__list">
                  {view.pendingChoice.candidates.map((index) => (
                    <li key={`prize-${index}`} className="catalog-card">
                      <label className="field__hint">
                        <input
                          type="checkbox"
                          checked={prizeSelection.includes(index)}
                          disabled={disabled}
                          data-testid={`match-prize-${index}`}
                          onChange={() =>
                            setPrizeSelection((current) =>
                              current.includes(index)
                                ? current.filter((entry) => entry !== index)
                                : current.length >= (view.pendingChoice?.min ?? 1)
                                  ? current
                                  : [...current, index],
                            )
                          }
                        />
                        奖赏卡 {index + 1}
                      </label>
                    </li>
                  ))}
                </ul>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-prizes"
                  disabled={disabled || prizeSelection.length !== view.pendingChoice.min}
                  onClick={() => props.onTakePrizes(prizeSelection)}
                >
                  确认拿取
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'choose-replacement' ? (
              <div className="field" data-testid="match-replacement-form">
                <span className="value__label">战斗宝可梦已昏厥，请从备战区选择 1 只升为战斗宝可梦</span>
                <ul className="catalog__list">
                  {view.pendingChoice.candidates.map((index) => {
                    const pokemon = view.you.bench[index];
                    if (pokemon === undefined) {
                      return null;
                    }
                    return (
                      <li key={`replacement-${index}`} className="catalog-card">
                        <label className="field__hint">
                          <input
                            type="radio"
                            name="match-replacement"
                            checked={replacementIndex === index}
                            disabled={disabled}
                            data-testid={`match-replacement-${index}`}
                            onChange={() => setReplacementIndex(index)}
                          />
                          {pokemon.card.nameZh}
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-replacement"
                  disabled={disabled || replacementIndex === undefined}
                  onClick={() => {
                    if (replacementIndex !== undefined) {
                      props.onChooseReplacement(replacementIndex);
                    }
                  }}
                >
                  确认升前
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'discard-hand' ? (
              <div className="field" data-testid="match-discard-form">
                <span className="value__label" data-testid="match-discard-description">
                  {view.pendingChoice.descriptionZh}（步骤 {view.pendingChoice.step}/{view.pendingChoice.stepCount}）
                </span>
                <ul className="catalog__list">
                  {view.pendingChoice.candidates.map((index) => {
                    const card = view.you.hand[index];
                    if (card === undefined) {
                      return null;
                    }
                    return (
                      <li key={`discard-${index}`} className="catalog-card">
                        <label className="field__hint">
                          <input
                            type="checkbox"
                            checked={discardSelection.includes(index)}
                            disabled={disabled}
                            data-testid={`match-discard-${index}`}
                            onChange={() =>
                              setDiscardSelection((current) =>
                                current.includes(index)
                                  ? current.filter((entry) => entry !== index)
                                  : current.length >= view.pendingChoice!.max
                                    ? current
                                    : [...current, index],
                              )
                            }
                          />
                          {card.nameZh}（{card.printDisplayNumber}）
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <span className="field__hint" data-testid="match-discard-selected-count">
                  已选 {discardSelection.length} 张（需 {view.pendingChoice.min}–{view.pendingChoice.max} 张）
                </span>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-discard"
                  disabled={disabled || discardSelection.length < view.pendingChoice.min || discardSelection.length > view.pendingChoice.max}
                  onClick={() => props.onDiscardHand(discardSelection)}
                >
                  确认弃牌
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'select-card' || view.pendingChoice?.kind === 'select-target' ? (
              <div className="field" data-testid="match-select-card-form">
                <span className="value__label" data-testid="match-select-card-description">
                  {view.pendingChoice.descriptionZh}（步骤 {view.pendingChoice.step}/{view.pendingChoice.stepCount}）
                </span>
                {view.pendingChoice.cardCandidates.length === 0 ? (
                  <span className="field__hint">没有可选择的候选。</span>
                ) : (
                  <ul className="catalog__list">
                    {view.pendingChoice.cardCandidates.map((candidate) => {
                      const selectable = candidate.selectable !== false;
                      return (
                        <li
                          key={`select-${candidate.candidateId}`}
                          className="catalog-card"
                          data-testid={`match-select-candidate-${candidate.candidateId}`}
                          data-card-id={candidate.card.cardId}
                          data-selectable={selectable ? 'true' : 'false'}
                        >
                          <div className="catalog-card__head">
                            <span className="catalog-card__name">{candidate.card.nameZh}</span>
                            <span className="catalog-card__number">{candidate.card.printDisplayNumber}</span>
                          </div>
                          {candidate.targetLabelZh === undefined || candidate.targetLabelZh === null ? null : (
                            <span className="field__hint">{candidate.targetLabelZh}</span>
                          )}
                          <div className="row">
                            <label className="field__hint">
                              <input
                                type={view.pendingChoice!.max === 1 ? 'radio' : 'checkbox'}
                                name="match-select-card"
                                checked={searchSelection.includes(candidate.candidateId)}
                                disabled={disabled || !selectable}
                                data-testid={`match-select-toggle-${candidate.candidateId}`}
                                onChange={() => {
                                  if (!selectable) {
                                    return;
                                  }
                                  setSearchSelection((current) => {
                                    if (view.pendingChoice!.max === 1) {
                                      return [candidate.candidateId];
                                    }
                                    return current.includes(candidate.candidateId)
                                      ? current.filter((entry) => entry !== candidate.candidateId)
                                      : current.length >= view.pendingChoice!.max
                                        ? current
                                        : [...current, candidate.candidateId];
                                  });
                                }}
                              />
                              {selectable ? '选择' : '不可选择（卡面文字限定）'}
                            </label>
                            <button
                              className="secondary"
                              type="button"
                              data-testid={`match-select-zoom-${candidate.candidateId}`}
                              onClick={() => setInspecting(candidate)}
                            >
                              放大候选卡
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <span className="field__hint" data-testid="match-select-selected-count">
                  已选 {searchSelection.length} 项（需 {view.pendingChoice.min}–{view.pendingChoice.max} 项）
                </span>
                {view.pendingChoice.min === 0 ? (
                  <button
                    className="secondary"
                    type="button"
                    data-testid="match-select-clear"
                    disabled={disabled || searchSelection.length === 0}
                    onClick={() => setSearchSelection([])}
                  >
                    清除选择（可不选）
                  </button>
                ) : null}
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-select"
                  disabled={disabled || searchSelection.length < view.pendingChoice.min || searchSelection.length > view.pendingChoice.max}
                  onClick={() => {
                    if (view.pendingChoice?.kind === 'select-target') {
                      props.onSelectTarget(searchSelection);
                      return;
                    }
                    props.onSelectCard(searchSelection);
                  }}
                >
                  {view.pendingChoice.kind === 'select-target' ? '确认目标' : '确认选择'}
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'copy-attack' ? (
              <div className="field" data-testid="match-copy-attack-form">
                <span className="value__label" data-testid="match-copy-attack-description">
                  {view.pendingChoice.descriptionZh}
                </span>
                {view.pendingChoice.candidates.map((attackIndex) => {
                  const attack = view.opponent.active?.attacks.find((entry) => entry.index === attackIndex);
                  if (attack === undefined) {
                    return null;
                  }
                  return (
                    <label key={`copy-${attackIndex}`} className="field__hint" data-testid={`match-copy-attack-option-${attackIndex}`}>
                      <input
                        type="radio"
                        name="match-copy-attack"
                        checked={copyAttackSelection === attackIndex}
                        disabled={disabled || !attack.supported}
                        data-testid={`match-copy-attack-${attackIndex}`}
                        onChange={() => setCopyAttackSelection(attackIndex)}
                      />
                      {attack.name}
                      {attack.damageText === null ? '' : `（${attack.damageText}）`}
                      {attack.supported ? '' : ' · 未接入，不能复制'}
                    </label>
                  );
                })}
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-copy-attack"
                  disabled={disabled || copyAttackSelection === undefined}
                  onClick={() => {
                    if (copyAttackSelection !== undefined) {
                      props.onCopyAttack(copyAttackSelection);
                    }
                  }}
                >
                  确认复制
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'search-deck' ? (
              <div className="field" data-testid="match-search-form">
                <span className="value__label" data-testid="match-search-description">
                  {view.pendingChoice.descriptionZh}（步骤 {view.pendingChoice.step}/{view.pendingChoice.stepCount}）
                </span>
                {view.pendingChoice.cardCandidates.length === 0 ? (
                  <span className="field__hint">没有满足条件的候选卡牌。</span>
                ) : (
                  <ul className="catalog__list">
                    {view.pendingChoice.cardCandidates.map((candidate) => {
                      const selectable = candidate.selectable !== false;
                      return (
                        <li
                          key={`search-${candidate.candidateId}`}
                          className="catalog-card"
                          data-testid={`match-search-candidate-${candidate.candidateId}`}
                          data-card-id={candidate.card.cardId}
                          data-card-kind={candidate.card.kind}
                          data-selectable={selectable ? 'true' : 'false'}
                        >
                          <div className="catalog-card__head">
                            <span className="catalog-card__name">{candidate.card.nameZh}</span>
                            <span className="catalog-card__number">{candidate.card.printDisplayNumber}</span>
                          </div>
                          <div className="row">
                            <label className="field__hint">
                              <input
                                type={view.pendingChoice!.max === 1 ? 'radio' : 'checkbox'}
                                name="match-search"
                                checked={searchSelection.includes(candidate.candidateId)}
                                disabled={disabled || !selectable}
                                data-testid={`match-search-select-${candidate.candidateId}`}
                                onChange={() => {
                                  if (!selectable) {
                                    return;
                                  }
                                  setSearchSelection((current) => {
                                    if (view.pendingChoice!.max === 1) {
                                      return [candidate.candidateId];
                                    }
                                    return current.includes(candidate.candidateId)
                                      ? current.filter((entry) => entry !== candidate.candidateId)
                                      : current.length >= view.pendingChoice!.max
                                        ? current
                                        : [...current, candidate.candidateId];
                                  });
                                }}
                              />
                              {selectable ? '选择' : '不可选择（卡面文字限定）'}
                            </label>
                            <button
                              className="secondary"
                              type="button"
                              data-testid={`match-candidate-zoom-${candidate.candidateId}`}
                              onClick={() => setInspecting(candidate)}
                            >
                              放大候选卡
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <span className="field__hint" data-testid="match-search-selected-count">
                  已选 {searchSelection.length} 张（需 {view.pendingChoice.min}–{view.pendingChoice.max} 张）
                </span>
                {/* 可选的检索（min=0）提供明确的清除/不选入口：单选 radio 选中后
                    再次点击不会触发 change，不能让玩家无法回到 0 张。必选 1 张
                    （min≥1）不提供此入口，只由提交按钮张数下限强制。 */}
                {view.pendingChoice.min === 0 ? (
                  <button
                    className="secondary"
                    type="button"
                    data-testid="match-search-clear"
                    disabled={disabled || searchSelection.length === 0}
                    onClick={() => setSearchSelection([])}
                  >
                    清除选择（可不选）
                  </button>
                ) : null}
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-search"
                  disabled={disabled || searchSelection.length < view.pendingChoice.min || searchSelection.length > view.pendingChoice.max}
                  onClick={() => props.onSearchDeck(searchSelection)}
                >
                  确认检索
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'choose-mode' ? (
              <div className="field" data-testid="match-mode-form">
                <span className="value__label" data-testid="match-mode-description">
                  {view.pendingChoice.descriptionZh}（步骤 {view.pendingChoice.step}/{view.pendingChoice.stepCount}）
                </span>
                {view.pendingChoice.modes.map((mode) => (
                  <label key={mode.modeId} className="field__hint" data-testid={`match-mode-option-${mode.modeId}`}>
                    <input
                      type="radio"
                      name="match-mode"
                      checked={modeSelection === mode.modeId}
                      disabled={disabled || !mode.available}
                      data-testid={`match-mode-${mode.modeId}`}
                      onChange={() => setModeSelection(mode.modeId)}
                    />
                    {mode.labelZh}
                    {mode.available ? '' : `（不可用：${mode.unavailableReasonZh ?? '无目标'}）`}
                  </label>
                ))}
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-mode"
                  disabled={disabled || modeSelection === undefined}
                  onClick={() => {
                    if (modeSelection !== undefined) {
                      props.onChooseMode(modeSelection);
                    }
                  }}
                >
                  确认效果
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'switch-opponent' ? (
              <div className="field" data-testid="match-switch-form">
                <span className="value__label" data-testid="match-switch-description">
                  {view.pendingChoice.descriptionZh}
                </span>
                <ul className="catalog__list">
                  {view.pendingChoice.candidates.map((index) => {
                    const pokemon = view.opponent.bench[index];
                    if (pokemon === undefined) {
                      return null;
                    }
                    return (
                      <li key={`switch-${index}`} className="catalog-card">
                        <label className="field__hint">
                          <input
                            type="radio"
                            name="match-switch"
                            checked={switchSelection === index}
                            disabled={disabled}
                            data-testid={`match-switch-${index}`}
                            onChange={() => setSwitchSelection(index)}
                          />
                          {pokemon.card.nameZh}（{pokemon.card.printDisplayNumber}）
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-switch"
                  disabled={disabled || switchSelection === undefined}
                  onClick={() => {
                    if (switchSelection !== undefined) {
                      props.onSwitchOpponent(switchSelection);
                    }
                  }}
                >
                  确认互换
                </button>
              </div>
            ) : null}

            {/* ---------------- 回合操作 ---------------- */}

            {view.pendingChoice?.kind === 'choose-own-bench' ? (
              <div className="field" data-testid="match-own-bench-form">
                <span className="value__label" data-testid="match-own-bench-description">
                  {view.pendingChoice.descriptionZh}（步骤 {view.pendingChoice.step}/{view.pendingChoice.stepCount}）
                </span>
                <div className="row">
                  {view.pendingChoice.candidates.map((index) => {
                    const pokemon = view.you.bench[index];
                    if (pokemon === undefined) {
                      return null;
                    }
                    return (
                      <label key={`own-bench-${index}`} className="field__hint">
                        <input
                          type="radio"
                          name="match-own-bench"
                          checked={ownBenchSelection === index}
                          disabled={disabled}
                          data-testid={`match-own-bench-${index}`}
                          onChange={() => setOwnBenchSelection(index)}
                        />
                        {pokemon.card.nameZh}（{pokemon.card.printDisplayNumber}）
                      </label>
                    );
                  })}
                </div>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-own-bench"
                  disabled={disabled || ownBenchSelection === undefined}
                  onClick={() => {
                    if (ownBenchSelection !== undefined) {
                      props.onChooseOwnBench(ownBenchSelection);
                    }
                  }}
                >
                  确认目标
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'attach-hand-energy' ? (
              <div className="field" data-testid="match-attach-energy-form">
                <span className="value__label" data-testid="match-attach-energy-description">
                  {view.pendingChoice.descriptionZh}（步骤 {view.pendingChoice.step}/{view.pendingChoice.stepCount}）
                </span>
                <div className="row">
                  {view.pendingChoice.cardCandidates.map((candidate) => (
                    <label key={`attach-energy-${candidate.candidateId}`} className="field__hint">
                      <input
                        type="radio"
                        name="match-attach-energy"
                        checked={handEnergySelection === candidate.candidateId}
                        disabled={disabled || candidate.selectable === false}
                        data-testid={`match-attach-energy-${candidate.candidateId}`}
                        onChange={() => setHandEnergySelection(candidate.candidateId)}
                      />
                      {candidate.card.nameZh}（{candidate.card.printDisplayNumber}）
                      {candidate.selectable === false ? ' · 不可选' : ''}
                    </label>
                  ))}
                </div>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-attach-energy"
                  disabled={disabled || handEnergySelection === undefined}
                  onClick={() => {
                    if (handEnergySelection !== undefined) {
                      props.onAttachHandEnergy(handEnergySelection);
                    }
                  }}
                >
                  确认附着
                </button>
              </div>
            ) : null}

            {view.pendingChoice?.kind === 'discard-energy' ? (
              <div className="field" data-testid="match-discard-energy-form">
                <span className="value__label" data-testid="match-discard-energy-description">
                  {view.pendingChoice.descriptionZh}（可选择 {view.pendingChoice.min}–{view.pendingChoice.max} 张）
                </span>
                <div className="row">
                  {view.pendingChoice.cardCandidates.map((candidate) => {
                    const checked = discardEnergySelection.includes(candidate.candidateId);
                    return (
                      <label key={`discard-energy-${candidate.candidateId}`} className="field__hint">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled || (!checked && discardEnergySelection.length >= view.pendingChoice!.max)}
                          data-testid={`match-discard-energy-${candidate.candidateId}`}
                          onChange={() =>
                            setDiscardEnergySelection((current) =>
                              current.includes(candidate.candidateId)
                                ? current.filter((entry) => entry !== candidate.candidateId)
                                : [...current, candidate.candidateId],
                            )
                          }
                        />
                        {candidate.card.nameZh}
                        {candidate.targetLabelZh === undefined || candidate.targetLabelZh === null ? '' : `（${candidate.targetLabelZh}）`}
                      </label>
                    );
                  })}
                </div>
                <span className="field__hint" data-testid="match-discard-energy-selected">
                  已选 {discardEnergySelection.length} 张
                </span>
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-discard-energy"
                  disabled={
                    disabled ||
                    discardEnergySelection.length < view.pendingChoice.min ||
                    discardEnergySelection.length > view.pendingChoice.max
                  }
                  onClick={() => props.onDiscardEnergy(discardEnergySelection)}
                >
                  确认弃置
                </button>
              </div>
            ) : null}

            {isPlaying && !terminal ? (
              <div className="field" data-testid="match-turn-actions">
                <span className="value__label">回合操作</span>
                {myTurn ? (
                  <>
                    {firstTurnRestricted ? (
                      <p className="field__hint" data-testid="match-first-turn-note">
                        你是先攻玩家：本回合可以使用物品与基础宝可梦、能量和撤退，但不能使用招式，也不能使用支援者卡。
                      </p>
                    ) : null}

                    <div className="field" data-testid="match-trainer-panel">
                      <span className="value__label">使用训练家卡（物品不限张数；支援者每回合 1 张；竞技场每回合 1 张）</span>
                      {trainerHandIndices.length === 0 ? (
                        <span className="field__hint">手牌中没有训练家卡。</span>
                      ) : (
                        <div className="row">
                          {trainerHandIndices.map((index) => {
                            const card = view.you.hand[index];
                            const catalogCard = props.catalog?.content.cards.find((entry) => entry.id === card?.cardId);
                            const unsupported = catalogCard !== undefined && !catalogCard.flags.effectSupported;
                            return (
                              <button
                                key={`play-trainer-${index}`}
                                className="secondary"
                                type="button"
                                data-testid={`match-play-trainer-${index}`}
                                disabled={disabled || unsupported}
                                title={unsupported ? '效果未接入，不能用于正式对局' : undefined}
                                onClick={() => props.onPlayTrainer(index)}
                              >
                                {card?.nameZh ?? '训练家卡'}
                                {unsupported ? ' · 未接入' : ''}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <span className="field__hint" data-testid="match-trainer-hint">
                        {view.you.supporterUsedThisTurn ? '本回合已使用过支援者卡。' : ''}
                        {view.you.stadiumPlayedThisTurn ? '本回合已放置过竞技场卡。' : ''}
                      </span>
                    </div>

                    <div className="field" data-testid="match-play-basic-panel">
                      <span className="value__label">放置基础宝可梦到备战区（每回合可放任意只，上限 5）</span>
                      {basicHandIndices.length === 0 ? (
                        <span className="field__hint">手牌中没有基础宝可梦。</span>
                      ) : (
                        <div className="row">
                          {basicHandIndices.map((index) => (
                            <button
                              key={`play-basic-${index}`}
                              className="secondary"
                              type="button"
                              data-testid={`match-play-basic-${index}`}
                              disabled={disabled || benchFull}
                              onClick={() => props.onPlayBasic(index)}
                            >
                              {view.you.hand[index]?.nameZh} 放到备战区
                            </button>
                          ))}
                        </div>
                      )}
                      {benchFull ? (
                        <span className="field__hint" data-testid="match-bench-full">
                          备战区已满 5 只。
                        </span>
                      ) : null}
                    </div>

                    <div className="field" data-testid="match-attach-panel">
                      <span className="value__label">
                        附着能量（每回合 1 张{view.you.energyAttachedThisTurn ? '，本回合已使用' : ''}）
                      </span>
                      {energyHandIndices.length === 0 ? (
                        <span className="field__hint">手牌中没有能量卡。</span>
                      ) : (
                        <div className="row">
                          {energyHandIndices.map((index) => (
                            <button
                              key={`attach-${index}`}
                              className={energyHandIndex === index ? 'primary' : 'secondary'}
                              type="button"
                              data-testid={`match-attach-hand-${index}`}
                              disabled={disabled || view.you.energyAttachedThisTurn}
                              onClick={() => setEnergyHandIndex(index)}
                            >
                              {view.you.hand[index]?.nameZh}
                            </button>
                          ))}
                        </div>
                      )}
                      {energyHandIndex === undefined ? (
                        <span className="field__hint" data-testid="match-attach-hint">
                          先选择一张能量，再选择附着目标。
                        </span>
                      ) : (
                        <div className="row" data-testid="match-attach-targets">
                          <span className="field__hint">附着目标：</span>
                          <button
                            className="secondary"
                            type="button"
                            data-testid="match-attach-target-active"
                            disabled={disabled || active === null}
                            onClick={() => props.onAttachEnergy(energyHandIndex, { slot: 'active' })}
                          >
                            战斗宝可梦
                          </button>
                          {view.you.bench.map((pokemon, index) => (
                            <button
                              key={`attach-target-${index}`}
                              className="secondary"
                              type="button"
                              data-testid={`match-attach-target-bench-${index}`}
                              disabled={disabled}
                              onClick={() => props.onAttachEnergy(energyHandIndex, { slot: 'bench', index })}
                            >
                              备战 {pokemon.card.nameZh}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="field" data-testid="match-evolve-panel">
                      <span className="value__label">进化（每回合可进化任意只；最初回合、刚出场/刚进化当回合不可）</span>
                      {evolveHandIndices.length === 0 ? (
                        <span className="field__hint">手牌中没有进化宝可梦。</span>
                      ) : (
                        <div className="row">
                          {evolveHandIndices.map((index) => (
                            <button
                              key={`evolve-hand-${index}`}
                              className={evolveHandIndex === index ? 'primary' : 'secondary'}
                              type="button"
                              data-testid={`match-evolve-hand-${index}`}
                              disabled={disabled}
                              onClick={() => setEvolveHandIndex(index)}
                            >
                              {view.you.hand[index]?.nameZh}
                            </button>
                          ))}
                        </div>
                      )}
                      {evolveHandIndex === undefined ? (
                        <span className="field__hint">先选择一张进化卡，再选择能够进化的目标。</span>
                      ) : (
                        <div className="row" data-testid="match-evolve-targets">
                          <span className="field__hint">进化目标（需要卡名「{evolveFromName}」）：</span>
                          {ownPokemonTargets.map((entry) => {
                            const matchesName = evolveFromName !== null && entry.pokemon.card.nameZh === evolveFromName;
                            const eligible = entry.pokemon.canEvolve;
                            return (
                              <button
                                key={`evolve-target-${entry.label}`}
                                className="secondary"
                                type="button"
                                data-testid={`match-evolve-target-${entry.ref.slot === 'active' ? 'active' : `bench-${entry.ref.index}`}`}
                                disabled={disabled || !matchesName || !eligible}
                                title={
                                  !eligible
                                    ? entry.pokemon.evolveBlockedReasonZh ?? '当前时机不能进化'
                                    : matchesName
                                      ? undefined
                                      : `「${entry.pokemon.card.nameZh}」不是「${evolveFromName ?? ''}」`
                                }
                                onClick={() => props.onEvolve(evolveHandIndex, entry.ref)}
                              >
                                {entry.label}
                                {!eligible ? ` · ${entry.pokemon.evolveBlockedReasonZh ?? '时机不可'}` : matchesName ? '' : ' · 卡名不符'}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="field" data-testid="match-tool-panel">
                      <span className="value__label">附着宝可梦道具（每只宝可梦至多 1 张）</span>
                      {toolHandIndices.length === 0 ? (
                        <span className="field__hint">手牌中没有宝可梦道具。</span>
                      ) : (
                        <div className="row">
                          {toolHandIndices.map((index) => (
                            <button
                              key={`tool-hand-${index}`}
                              className={toolHandIndex === index ? 'primary' : 'secondary'}
                              type="button"
                              data-testid={`match-tool-hand-${index}`}
                              disabled={disabled}
                              onClick={() => setToolHandIndex(index)}
                            >
                              {view.you.hand[index]?.nameZh}
                            </button>
                          ))}
                        </div>
                      )}
                      {toolHandIndex === undefined ? (
                        <span className="field__hint">先选择一张宝可梦道具，再选择目标。</span>
                      ) : (
                        <div className="row" data-testid="match-tool-targets">
                          <span className="field__hint">附着目标：</span>
                          {ownPokemonTargets.map((entry) => {
                            const hasTool = entry.pokemon.tools.length > 0;
                            return (
                              <button
                                key={`tool-target-${entry.label}`}
                                className="secondary"
                                type="button"
                                data-testid={`match-tool-target-${entry.ref.slot === 'active' ? 'active' : `bench-${entry.ref.index}`}`}
                                disabled={disabled || hasTool}
                                title={hasTool ? '这只宝可梦已经附着 1 张宝可梦道具' : undefined}
                                onClick={() => props.onAttachTool(toolHandIndex, entry.ref)}
                              >
                                {entry.label}
                                {hasTool ? ' · 已有道具' : ''}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="field" data-testid="match-ability-panel">
                      <span className="value__label">使用特性（每只宝可梦每回合各自记账）</span>
                      {ownPokemonTargets.every((entry) => entry.pokemon.abilities.length === 0) ? (
                        <span className="field__hint">你的场上宝可梦没有特性。</span>
                      ) : (
                        ownPokemonTargets.flatMap((entry) =>
                          entry.pokemon.abilities.map((ability) => (
                            <div key={`ability-${entry.label}-${ability.index}`} className="row">
                              <span className="field__hint" data-testid={`match-ability-hint-${entry.ref.slot === 'active' ? 'active' : `bench-${entry.ref.index}`}-${ability.index}`}>
                                {entry.label}「{ability.name}」：{ability.usable ? ability.textZh : ability.unusableReasonZh ?? '当前不可用'}
                              </span>
                              <button
                                className="secondary"
                                type="button"
                                data-testid={`match-use-ability-${entry.ref.slot === 'active' ? 'active' : `bench-${entry.ref.index}`}-${ability.index}`}
                                disabled={disabled || !ability.usable}
                                onClick={() => props.onUseAbility(ability.index, entry.ref)}
                              >
                                使用「{ability.name}」
                              </button>
                            </div>
                          )),
                        )
                      )}
                    </div>

                    <div className="field" data-testid="match-retreat-panel">
                      <span className="value__label">
                        撤退（每回合 1 次{view.you.retreatedThisTurn ? '，本回合已使用' : ''}）
                      </span>
                      {active === null || view.you.bench.length === 0 ? (
                        <span className="field__hint" data-testid="match-retreat-unavailable">
                          需要战斗宝可梦且有至少 1 只备战宝可梦才能撤退。
                        </span>
                      ) : (
                        <>
                          <span className="field__hint">支付撤退能量（需要 {active.retreatCost} 个）：</span>
                          <div className="row">
                            {active.energies.map((energy) => (
                              <label key={`retreat-energy-${energy.energyIndex}`} className="field__hint">
                                <input
                                  type="checkbox"
                                  checked={retreatEnergies.includes(energy.energyIndex)}
                                  disabled={disabled || view.you.retreatedThisTurn}
                                  data-testid={`match-retreat-energy-${energy.energyIndex}`}
                                  onChange={() =>
                                    setRetreatEnergies((current) =>
                                      current.includes(energy.energyIndex)
                                        ? current.filter((entry) => entry !== energy.energyIndex)
                                        : current.length >= active.retreatCost
                                          ? current
                                          : [...current, energy.energyIndex],
                                    )
                                  }
                                />
                                {energy.card.nameZh}
                              </label>
                            ))}
                          </div>
                          <span className="field__hint">换入的备战宝可梦：</span>
                          <div className="row">
                            {view.you.bench.map((pokemon, index) => (
                              <label key={`retreat-bench-${index}`} className="field__hint">
                                <input
                                  type="radio"
                                  name="retreat-bench"
                                  checked={retreatBenchIndex === index}
                                  disabled={disabled || view.you.retreatedThisTurn}
                                  data-testid={`match-retreat-bench-${index}`}
                                  onChange={() => setRetreatBenchIndex(index)}
                                />
                                {pokemon.card.nameZh}
                              </label>
                            ))}
                          </div>
                          <button
                            className="primary"
                            type="button"
                            data-testid="match-confirm-retreat"
                            disabled={
                              disabled ||
                              view.you.retreatedThisTurn ||
                              retreatBenchIndex === undefined ||
                              retreatEnergies.length !== active.retreatCost
                            }
                            onClick={() => {
                              if (retreatBenchIndex !== undefined) {
                                props.onRetreat(retreatEnergies, retreatBenchIndex);
                              }
                            }}
                          >
                            确认撤退
                          </button>
                        </>
                      )}
                    </div>

                    <div className="field" data-testid="match-stadium-panel">
                      <span className="value__label">竞技场效果：{view.stadium?.nameZh ?? '无'}</span>
                      {view.stadium === null ? (
                        <span className="field__hint">场上没有竞技场卡。</span>
                      ) : (
                        <button
                          className="secondary"
                          type="button"
                          data-testid="match-use-stadium"
                          disabled={disabled || view.you.stadiumUsedThisTurn || benchFull}
                          onClick={props.onUseStadium}
                        >
                          使用竞技场效果{view.you.stadiumUsedThisTurn ? '（本回合已使用）' : ''}
                        </button>
                      )}
                    </div>

                    <div className="field" data-testid="match-attack-panel">
                      <span className="value__label">使用招式（使用后回合结束）</span>
                      {active === null || active.attacks.length === 0 ? (
                        <span className="field__hint">战斗宝可梦没有可用招式。</span>
                      ) : (
                        <div className="row">
                          {active.attacks.map((attack) => {
                            const usable = attack.supported && costCovered(attack, active.energies) && !firstTurnRestricted;
                            return (
                              <button
                                key={`attack-${attack.index}`}
                                className="secondary"
                                type="button"
                                data-testid={`match-attack-${attack.index}`}
                                disabled={disabled || !usable}
                                title={attack.supported ? undefined : '效果未接入'}
                                onClick={() => props.onAttack(attack.index, { slot: 'active' })}
                              >
                                {attack.name}（{attack.cost.length === 0 ? '无费用' : attack.cost.join('')}
                                {attack.damageText === null ? ' · 效果' : ` · ${attack.damageText}`}
                                {attack.supported ? '' : ' · 未接入'}）
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="row">
                      <button className="primary" type="button" data-testid="match-end-turn" disabled={disabled} onClick={props.onEndTurn}>
                        结束回合
                      </button>
                    </div>
                  </>
                ) : (
                  <span className="value" data-testid="match-waiting">
                    等待{seatName(view, view.activeSeat ?? view.you.seat)}完成回合…
                  </span>
                )}
              </div>
            ) : null}

            <div className="field" data-testid="match-log">
              <span className="value__label">公开记录</span>
              {view.events.length === 0 ? (
                <span className="field__hint">暂无记录</span>
              ) : (
                <ul className="catalog__list">
                  {view.events.map((event) => (
                    <li key={event.seq} className="field__hint" data-testid={`match-event-${event.seq}`}>
                      {describeEvent(event, view)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      <div className="row">
        {view !== null && view.result === null ? (
          concedeConfirm ? (
            <>
              <button className="primary" type="button" data-testid="match-confirm-concede" disabled={concedeDisabled} onClick={props.onConcede}>
                确认认输
              </button>
              <button className="secondary" type="button" data-testid="match-cancel-concede" disabled={concedeDisabled} onClick={() => setConcedeConfirm(false)}>
                取消
              </button>
            </>
          ) : (
            <button className="secondary" type="button" data-testid="match-concede" disabled={concedeDisabled} onClick={() => setConcedeConfirm(true)}>
              认输
            </button>
          )
        ) : null}
        <button className="secondary" type="button" data-testid="match-back-home" onClick={props.onBack}>
          返回首页（不认输）
        </button>
      </div>

      {inspecting === undefined ? null : (
        <CandidateInspector
          candidate={inspecting}
          catalog={props.catalog}
          imageCache={props.imageCache}
          resolveAssetUrl={props.resolveAssetUrl}
          onOpenImage={props.onOpenImage}
          onClose={() => setInspecting(undefined)}
        />
      )}
    </>
  );
}
