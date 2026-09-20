import { useEffect, useState, type ReactElement } from 'react';
import type { MatchCardView, MatchPublicEvent, MatchSeat, MatchView } from '@ptcg/protocol';
import type { MatchState } from '../rooms/matchController.ts';

export interface MatchScreenProps {
  /** 联机会话是否仍然存活；断线时禁用开局操作。 */
  readonly connected: boolean;
  readonly match: MatchState;
  readonly onChooseTurnOrder: (goFirst: boolean) => void;
  readonly onPlaceSetup: (active: number, bench: readonly number[]) => void;
  readonly onResolveCompensation: (draw: number) => void;
  readonly onPlaceCompensationBench: (bench: readonly number[]) => void;
  readonly onBack: () => void;
  readonly onClearError: () => void;
}

function seatName(view: MatchView, seat: MatchSeat): string {
  return seat === view.you.seat ? view.you.nickname : view.opponent.nickname;
}

/** 公开记录说明：只使用合法公开信息（重抽展示、补抽张数、公开翻面等）。 */
function describeEvent(event: MatchPublicEvent, view: MatchView): string {
  switch (event.type) {
    case 'match-created':
      return `对局建立：${event.seats[0]} vs ${event.seats[1]}`;
    case 'turn-order-flip':
      return `服务端猜拳：${seatName(view, event.winner)}获得先后攻选择权`;
    case 'turn-order-chosen':
      return `${seatName(view, event.seat)}选择${event.goFirst ? '先攻' : '后攻'}`;
    case 'mulligan':
      return `${seatName(view, event.seat)}第 ${event.count} 次重抽，展示：${event.cards.map((card) => card.nameZh).join('、')}`;
    case 'setup-placed':
      return `${seatName(view, event.seat)}已盖放初始宝可梦`;
    case 'prizes-placed':
      return `${seatName(view, event.seat)}已放置 6 张奖赏卡`;
    case 'compensation-declared':
      return `${seatName(view, event.seat)}补抽 ${event.count} 张`;
    case 'compensation-benched':
      return `${seatName(view, event.seat)}将补抽到的 ${event.count} 张基础宝可梦放入备战区`;
    case 'setup-revealed':
      return `${seatName(view, event.seat)}公开翻面：战斗 ${event.active.nameZh}${event.bench.length === 0 ? '' : ` · 备战 ${event.bench.map((card) => card.nameZh).join('、')}`}`;
    case 'turn-started':
      return `第 ${event.turn} 回合开始：轮到${seatName(view, event.seat)}`;
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

/**
 * 开局准备界面（#8）。
 *
 * 只呈现服务端允许公开的信息：本人手牌、双方张数、公开记录、按座位投影的
 * 待决选择。对手手牌/牌库顺序/奖赏身份与翻面前的盖放身份从不出现在载荷里，
 * 这里也没有可渲染的数据。第一回合开始后不提供出牌操作（属于后续票）。
 */
export function MatchScreen(props: MatchScreenProps): ReactElement {
  const { view } = props.match;
  const pending = props.match.pending;
  const disabled = !props.connected || pending;
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);
  const [bench, setBench] = useState<readonly number[]>([]);
  const [compensationDraw, setCompensationDraw] = useState<number | undefined>(undefined);
  const [compensationBench, setCompensationBench] = useState<readonly number[]>([]);
  const choiceId = view?.pendingChoice?.choiceId;

  // 待决选择变化时清空上一次的局部选择，避免把旧选择显示成新选择的答案。
  useEffect(() => {
    setActiveIndex(undefined);
    setBench([]);
    setCompensationDraw(undefined);
    setCompensationBench([]);
  }, [choiceId]);

  const error = props.match.error;
  const phaseLabel =
    view === null
      ? '连接对局'
      : view.phase === 'turn-order'
        ? '决定先后攻'
        : view.phase === 'setup'
          ? '盖放初始宝可梦'
          : view.phase === 'compensation'
            ? '补抽'
            : '第 1 回合';

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

  return (
    <>
      <section className="card" aria-label="开局准备" data-testid="match-screen">
        <h2 className="catalog__title">开局准备</h2>
        <p className="catalog__note" data-testid="match-phase">
          {phaseLabel}
        </p>
        {props.connected ? null : (
          <p className="notice" role="status" data-testid="match-disconnected">
            与服务端的连接已断开；开局操作已暂停。重连后仍会回到同一场对局。
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
                    对手重抽了 {view.pendingChoice.max} 次，你可以补抽 0 到 {view.pendingChoice.max} 张（也可选择不补抽）。
                  </span>
                ) : (
                  <span className="value" data-testid="match-compensation-prompt">
                    补抽到基础宝可梦：可选择放入备战区（最多 {view.pendingChoice.max} 张）。
                  </span>
                )
              ) : null}
              {view.phase === 'playing' ? (
                <span className="value" data-testid="match-turn-info">
                  第 {view.turn} 回合 · 轮到{seatName(view, view.activeSeat ?? view.you.seat)}
                  {view.activeSeat === view.you.seat ? '（你）' : '（对手）'}
                </span>
              ) : null}
            </div>

            <div className="field" data-testid="match-self">
              <span className="value__label">你的场面（{view.you.nickname}）</span>
              {view.you.active === null ? (
                <span className="field__hint" data-testid="match-self-active">
                  {view.you.setupPlaced ? '战斗宝可梦已盖放（等待公开翻面）' : '尚未放置战斗宝可梦'}
                </span>
              ) : (
                <span className="value" data-testid="match-self-active">
                  战斗：{view.you.active.card.nameZh}
                </span>
              )}
              {view.you.bench.length === 0 ? null : (
                <span className="field__hint" data-testid="match-self-bench">
                  备战：{view.you.bench.map((entry) => entry.card.nameZh).join('、')}
                </span>
              )}
              <span className="field__hint">
                手牌 {view.you.handCount} 张 · 牌库 {view.you.deckCount} 张 · 奖赏卡 {view.you.prizeCount} 张
              </span>
            </div>

            <div className="field" data-testid="match-opponent">
              <span className="value__label">对手（{view.opponent.nickname}）</span>
              <span className="field__hint" data-testid="match-opponent-status">
                手牌 {view.opponent.handCount} 张 · 牌库 {view.opponent.deckCount} 张 · 奖赏卡 {view.opponent.prizeCount} 张
                {view.opponent.mulligans > 0 ? ` · 已重抽 ${view.opponent.mulligans} 次` : ''}
              </span>
              {view.opponent.active === null ? (
                <span className="field__hint" data-testid="match-opponent-active">
                  {view.opponent.setupPlaced ? '初始宝可梦已盖放（未公开）' : '尚未放置初始宝可梦'}
                </span>
              ) : (
                <span className="value" data-testid="match-opponent-active">
                  战斗：{view.opponent.active.card.nameZh}
                  {view.opponent.bench.length === 0 ? '' : ` · 备战：${view.opponent.bench.map((entry) => entry.card.nameZh).join('、')}`}
                </span>
              )}
            </div>

            <div className="field">
              <span className="value__label">你的手牌</span>
              <CardList cards={view.you.hand} emptyHint="没有手牌" />
            </div>

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

            {view.pendingChoice?.kind === 'compensation-bench' ? (
              <div className="field" data-testid="match-compensation-bench-form">
                <span className="value__label">选择放入备战区的基础宝可梦（可不选）</span>
                <ul className="catalog__list">
                  {view.pendingChoice.candidates.map((index) => {
                    const card = view.you.hand[index];
                    if (card === undefined) {
                      return null;
                    }
                    return (
                      <li key={`comp-bench-${index}`} className="catalog-card">
                        <label className="field__hint">
                          <input
                            type="checkbox"
                            checked={compensationBench.includes(index)}
                            disabled={disabled}
                            data-testid={`match-compensation-bench-${index}`}
                            onChange={() =>
                              setCompensationBench((current) =>
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
                <button
                  className="primary"
                  type="button"
                  data-testid="match-confirm-compensation-bench"
                  disabled={disabled}
                  onClick={() => props.onPlaceCompensationBench(compensationBench)}
                >
                  确认
                </button>
              </div>
            ) : null}

            {view.phase === 'playing' ? (
              <p className="field__hint" data-testid="match-scope-note">
                双方初始准备已完成，首回合已经建立。回合内的出牌、附能与招式操作将在后续版本提供。
              </p>
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
