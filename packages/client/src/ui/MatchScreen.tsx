import { useEffect, useState, type ReactElement } from 'react';
import type { MatchAttackView, MatchCardView, MatchPokemonRef, MatchPokemonView, MatchPublicEvent, MatchSeat, MatchView } from '@ptcg/protocol';
import type { MatchState } from '../rooms/matchController.ts';

export interface MatchScreenProps {
  /** 联机会话是否仍然存活；断线时禁用开局与回合操作。 */
  readonly connected: boolean;
  readonly match: MatchState;
  readonly onChooseTurnOrder: (goFirst: boolean) => void;
  readonly onPlaceSetup: (active: number, bench: readonly number[]) => void;
  readonly onResolveCompensation: (draw: number) => void;
  readonly onPlaceBench: (bench: readonly number[]) => void;
  readonly onPlayBasic: (handIndex: number) => void;
  readonly onAttachEnergy: (handIndex: number, target: MatchPokemonRef) => void;
  readonly onRetreat: (energyIndices: readonly number[], benchIndex: number) => void;
  readonly onAttack: (attackIndex: number, target: MatchPokemonRef) => void;
  readonly onEndTurn: () => void;
  readonly onBack: () => void;
  readonly onClearError: () => void;
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
    case 'retreat':
      return `${seatName(view, event.seat)}撤退：「${event.bench.nameZh}」回到备战区，「${event.active.nameZh}」上场`;
    case 'attack-used':
      return `${seatName(view, event.seat)}使用「${event.attackName}」造成 ${event.damage} 点伤害（基础 ${event.baseDamage}）`;
    case 'damage-counters-placed':
      return `「${seatName(view, event.targetSeat)}」的宝可梦身上放置 ${event.count} 个伤害指示物`;
    case 'turn-ended':
      return `第 ${event.turn} 回合结束：${seatName(view, event.seat)}`;
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
  const remainingHp = pokemon.card.hp === null ? null : Math.max(0, pokemon.card.hp - pokemon.damageCounters * 10);
  return (
    <div className="field" data-testid={props.testId}>
      <span className="value">
        {props.label}：{pokemon.card.nameZh}
        {remainingHp === null ? '' : ` · HP ${remainingHp}/${pokemon.card.hp}`}
        {pokemon.damageCounters > 0 ? ` · 伤害指示物 ${pokemon.damageCounters}` : ''}
        {pokemon.weakness === null ? '' : ` · 弱点 ${pokemon.weakness}`}
        {pokemon.resistance === null ? '' : ` · 抵抗 ${pokemon.resistance}`}
        {` · 撤退 ${pokemon.retreatCost}`}
      </span>
      {pokemon.energies.length === 0 ? null : (
        <span className="field__hint" data-testid={`${props.testId}-energies`}>
          能量：{pokemon.energies.map((energy) => energy.card.nameZh).join('、')}
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
 * 对局界面（#8 开局 + #9 回合）。
 *
 * 只呈现服务端允许公开的信息：本人手牌、双方张数、公开区身份/伤害/能量/招式、
 * 公开记录、按座位投影的待决选择。对手手牌/牌库顺序/奖赏身份从不出现在载荷里，
 * 这里也没有可渲染的数据。界面上的禁用只是操作提示，服务端不信任任何 UI 状态。
 */
export function MatchScreen(props: MatchScreenProps): ReactElement {
  const { view } = props.match;
  const pending = props.match.pending;
  const disabled = !props.connected || pending;
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);
  // `place-setup` 与 `place-bench` 共用同一份勾选状态，待决选择变化时清空。
  const [bench, setBench] = useState<readonly number[]>([]);
  const [compensationDraw, setCompensationDraw] = useState<number | undefined>(undefined);
  // 回合操作选择：手牌中的能量、撤退能量与换入目标。
  const [energyHandIndex, setEnergyHandIndex] = useState<number | undefined>(undefined);
  const [retreatEnergies, setRetreatEnergies] = useState<readonly number[]>([]);
  const [retreatBenchIndex, setRetreatBenchIndex] = useState<number | undefined>(undefined);
  const choiceId = view?.pendingChoice?.choiceId;
  const version = view?.version;

  // 待决选择或对局版本变化时清空上一次的局部选择，避免把旧选择显示成新选择的答案。
  useEffect(() => {
    setActiveIndex(undefined);
    setBench([]);
    setCompensationDraw(undefined);
    setEnergyHandIndex(undefined);
    setRetreatEnergies([]);
    setRetreatBenchIndex(undefined);
  }, [choiceId, version]);

  const error = props.match.error;
  const isPlaying = view?.phase === 'playing';
  const myTurn = isPlaying && view?.activeSeat === view?.you.seat;
  const firstTurnRestricted = isPlaying && view !== null && view.turn === 1 && view.firstSeat === view.you.seat;
  const benchFull = (view?.you.bench.length ?? 0) >= 5;
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

  return (
    <>
      <section className="card" aria-label="对局" data-testid="match-screen">
        <h2 className="catalog__title">{isPlaying ? '对战' : '开局准备'}</h2>
        <p className="catalog__note" data-testid="match-phase">
          {phaseLabel}
        </p>
        {props.connected ? null : (
          <p className="notice" role="status" data-testid="match-disconnected">
            与服务端的连接已断开；对局操作已暂停。重连后仍会回到同一场对局。
          </p>
        )}

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
                回合开始时牌库为空，无法抽卡；完整胜负结算属于后续版本，本局暂停操作。
              </p>
            ) : null}

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

            {/* ---------------- 回合操作 ---------------- */}

            {isPlaying ? (
              <div className="field" data-testid="match-turn-actions">
                <span className="value__label">回合操作</span>
                {myTurn ? (
                  <>
                    {firstTurnRestricted ? (
                      <p className="field__hint" data-testid="match-first-turn-note">
                        你是先攻玩家：本回合可以使用基础宝可梦、能量与撤退，但不能使用招式。
                      </p>
                    ) : null}

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
        <button className="secondary" type="button" data-testid="match-back-home" onClick={props.onBack}>
          返回首页（不认输）
        </button>
      </div>
    </>
  );
}
