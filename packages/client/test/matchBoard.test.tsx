import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatchScreen, type MatchScreenProps } from '../src/ui/MatchScreen.tsx';
import { INITIAL_MATCH_STATE, type MatchState } from '../src/rooms/matchController.ts';
import { matchCard, matchEvent, matchPokemon, matchSide, matchView } from './matchHelpers.ts';

/**
 * #17 可交互 2D 牌桌的回归：卡面点选与放大、从卡牌发起动作、牌桌目标高亮与点选、
 * 公开记录默认收起、缺图时的文字卡面。全部通过牌桌元素操作，不依赖全局命令表。
 */

function renderScreen(match: MatchState, overrides: Partial<MatchScreenProps> = {}) {
  const handlers = {
    onChooseTurnOrder: vi.fn(),
    onPlaceSetup: vi.fn(),
    onResolveCompensation: vi.fn(),
    onPlaceBench: vi.fn(),
    onPlayBasic: vi.fn(),
    onAttachEnergy: vi.fn(),
    onRetreat: vi.fn(),
    onEvolve: vi.fn(),
    onUseAbility: vi.fn(),
    onAttachTool: vi.fn(),
    onAttack: vi.fn(),
    onEndTurn: vi.fn(),
    onPlayTrainer: vi.fn(),
    onUseStadium: vi.fn(),
    onDiscardHand: vi.fn(),
    onSearchDeck: vi.fn(),
    onChooseMode: vi.fn(),
    onSwitchOpponent: vi.fn(),
    onChooseOwnBench: vi.fn(),
    onAttachHandEnergy: vi.fn(),
    onDiscardEnergy: vi.fn(),
    onSelectCard: vi.fn(),
    onSelectTarget: vi.fn(),
    onCopyAttack: vi.fn(),
    onTakePrizes: vi.fn(),
    onChooseReplacement: vi.fn(),
    onConcede: vi.fn(),
    onReturnToRoom: vi.fn(),
    onBack: vi.fn(),
    onClearError: vi.fn(),
  };
  render(<MatchScreen connected match={match} {...handlers} {...overrides} />);
  return handlers;
}

function stateWith(view: MatchState['view'], extra: Partial<MatchState> = {}): MatchState {
  return { ...INITIAL_MATCH_STATE, sessionId: view?.sessionId ?? null, view, ...extra };
}

const WATER_ENERGY = matchCard({
  cardId: 'cbb1c-1803',
  nameZh: '基本水能量',
  kind: 'energy',
  classLabelZh: '能量',
  isBasicPokemon: false,
  printDisplayNumber: 'CBB1C 1803/06',
  hp: null,
  type: '水',
});

const HAND = [matchCard({ cardId: 'csve1-035', nameZh: '荧光鱼' }), matchCard({ cardId: 'csve1-057', nameZh: '月石' }), WATER_ENERGY];

/** 座位 0 的回合：手牌含基础宝可梦与能量，场上有战斗宝可梦与备战。 */
function playingView() {
  return matchView({
    phase: 'playing',
    turn: 2,
    activeSeat: 0,
    you: matchSide(0, {
      hand: HAND,
      handCount: HAND.length,
      active: matchPokemon({ energies: [{ energyIndex: 0, card: WATER_ENERGY }] }),
      bench: [matchPokemon({ card: matchCard({ cardId: 'csve1-057', nameZh: '月石' }) })],
      prizeCount: 6,
      deckCount: 40,
    }),
    opponent: matchSide(1, {
      handCount: 7,
      active: matchPokemon({ card: matchCard({ cardId: 'csv3c-043', nameZh: '古剑豹ex', type: '水' }) }),
      prizeCount: 6,
      deckCount: 40,
      discard: [WATER_ENERGY],
    }),
    events: [matchEvent(1, { type: 'turn-started', seat: 0, turn: 2 })],
  });
}

afterEach(() => {
  cleanup();
});

describe('可交互 2D 牌桌（#17）', () => {
  it('公开记录默认收起；展开后才渲染记录内容', async () => {
    renderScreen(stateWith(playingView()));
    expect(screen.getByTestId('match-log-toggle')).toBeDefined();
    expect(screen.getByTestId('match-log-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('match-log')).toBeNull();

    await userEvent.click(screen.getByTestId('match-log-toggle'));
    expect(screen.getByTestId('match-log')).toBeDefined();
    expect(screen.getByTestId('match-event-1')).toBeDefined();
  });

  it('手牌是牌桌卡面：点选后放大阅读，并可按卡牌显示可用操作', async () => {
    renderScreen(stateWith(playingView()));
    expect(screen.getByTestId('match-hand-strip')).toBeDefined();

    await userEvent.click(screen.getByTestId('match-hand-0'));
    expect(screen.getByTestId('match-hand-actions').textContent).toContain('荧光鱼');

    await userEvent.click(screen.getByTestId('match-hand-inspect'));
    expect(screen.getByTestId('match-card-inspector').textContent).toContain('荧光鱼');
    expect(screen.getByTestId('match-card-title').textContent).toContain('CSVE1C 035/177');

    await userEvent.click(screen.getByTestId('match-card-close'));
    expect(screen.queryByTestId('match-card-inspector')).toBeNull();
  });

  it('从手牌卡面直接发起放置，而不是通过全局命令表', async () => {
    const handlers = renderScreen(stateWith(playingView()));
    await userEvent.click(screen.getByTestId('match-hand-0'));
    await userEvent.click(screen.getByTestId('match-hand-play-basic'));
    expect(handlers.onPlayBasic).toHaveBeenCalledWith(0);
  });

  it('附能：牌桌上合法目标高亮，点选目标即提交', async () => {
    const handlers = renderScreen(stateWith(playingView()));
    // 能量在第 3 张手牌（索引 2）。
    await userEvent.click(screen.getByTestId('match-hand-2'));
    await userEvent.click(screen.getByTestId('match-hand-attach'));

    expect(screen.getByTestId('match-self-active').getAttribute('class')).toContain('is-target');
    expect(screen.getByTestId('match-self-bench-0').getAttribute('class')).toContain('is-target');

    await userEvent.click(screen.getByTestId('match-self-active-target'));
    expect(handlers.onAttachEnergy).toHaveBeenCalledWith(2, { slot: 'active' });

    await userEvent.click(screen.getByTestId('match-self-bench-0-target'));
    expect(handlers.onAttachEnergy).toHaveBeenCalledWith(2, { slot: 'bench', index: 0 });
  });

  it('缺图时文字卡面仍显示名称与编号，且牌桌操作可用', async () => {
    renderScreen(stateWith(playingView()));
    const face = screen.getByTestId('match-self-active-face');
    expect(face.textContent).toContain('荧光鱼');
    expect(face.textContent).toContain('CSVE1C 035/177');
    // 没有卡图缓存/目录时不应渲染 <img>，但卡面与动作入口仍在。
    expect(face.querySelector('img')).toBeNull();
    expect(screen.getByTestId('match-hand-0').textContent).toContain('宝可梦');
  });

  it('对手手牌只以数量出现，卡面不渲染对手隐藏手牌身份', () => {
    renderScreen(stateWith(playingView()));
    expect(screen.getByTestId('match-opponent-status').textContent).toContain('手牌 7 张');
    expect(screen.queryByTestId('match-opponent-hand')).toBeNull();
  });

  it('点选自己的战斗宝可梦后，招式/特性/撤退都在牌桌上下文中完成', async () => {
    const handlers = renderScreen(
      stateWith(
        matchView({
          phase: 'playing',
          turn: 2,
          activeSeat: 0,
          you: matchSide(0, {
            hand: HAND,
            handCount: HAND.length,
            active: matchPokemon({
              energies: [{ energyIndex: 0, card: WATER_ENERGY }],
              abilities: [
                { index: 0, labelZh: '特性', name: '水之守护', textZh: '每回合可以使用一次。', supported: true, usable: true, unusableReasonZh: null },
              ],
            }),
            bench: [matchPokemon({ card: matchCard({ cardId: 'csve1-057', nameZh: '月石' }) })],
          }),
          opponent: matchSide(1, { handCount: 7, active: matchPokemon(), deckCount: 40 }),
          events: [],
        }),
      ),
    );

    await userEvent.click(screen.getByTestId('match-self-active-face'));
    expect(screen.getByTestId('match-field-selected').textContent).toContain('荧光鱼');

    await userEvent.click(screen.getByTestId('match-field-attack-0'));
    expect(handlers.onAttack).toHaveBeenCalledWith(0, { slot: 'active' });

    await userEvent.click(screen.getByTestId('match-field-ability-0'));
    expect(handlers.onUseAbility).toHaveBeenCalledWith(0, { slot: 'active' });

    await userEvent.click(screen.getByTestId('match-field-retreat-energy-0'));
    await userEvent.click(screen.getByTestId('match-field-retreat-bench-0'));
    await userEvent.click(screen.getByTestId('match-field-confirm-retreat'));
    expect(handlers.onRetreat).toHaveBeenCalledWith([0], 0);
  });

  it('撤退条件不足时不提供确认路径', async () => {
    const handlers = renderScreen(
      stateWith(
        matchView({
          phase: 'playing',
          turn: 2,
          activeSeat: 0,
          you: matchSide(0, { hand: HAND, handCount: HAND.length, active: matchPokemon() }),
          opponent: matchSide(1, { handCount: 7, active: matchPokemon(), deckCount: 40 }),
        }),
      ),
    );
    await userEvent.click(screen.getByTestId('match-self-active-face'));
    expect(screen.getByTestId('match-field-retreat-unavailable')).toBeDefined();
    expect(screen.queryByTestId('match-field-confirm-retreat')).toBeNull();
    expect(handlers.onRetreat).not.toHaveBeenCalled();
  });

  it('开局由手牌卡面发起：选择战斗宝可梦与备战后可确认', async () => {
    const handlers = renderScreen(
      stateWith(
        matchView({
          phase: 'setup',
          turn: 0,
          activeSeat: null,
          you: matchSide(0, { hand: HAND, handCount: HAND.length }),
          opponent: matchSide(1, { revealed: false }),
          pendingChoice: {
            choiceId: 'setup-1',
            seat: 0,
            kind: 'place-setup',
            min: 1,
            max: 1,
            benchMin: 0,
            benchMax: 5,
            candidates: [0, 1],
            step: 1,
            stepCount: 1,
            source: 'hand',
            descriptionZh: '选择战斗宝可梦并可放入备战区。',
            cardCandidates: [],
            modes: [],
          },
        }),
      ),
    );

    await userEvent.click(screen.getByTestId('match-hand-0'));
    await userEvent.click(screen.getByTestId('match-hand-setup-active'));
    await userEvent.click(screen.getByTestId('match-hand-clear'));
    await userEvent.click(screen.getByTestId('match-hand-1'));
    await userEvent.click(screen.getByTestId('match-hand-setup-bench'));
    await userEvent.click(screen.getByTestId('match-hand-clear'));
    await userEvent.click(screen.getByTestId('match-confirm-setup'));
    expect(handlers.onPlaceSetup).toHaveBeenCalledWith(0, [1]);
  });

  it('提交中（pending）时牌桌按钮禁用，重复点击不产生第二次提交', async () => {
    const handlers = renderScreen(stateWith(playingView(), { pending: true }));
    await userEvent.click(screen.getByTestId('match-hand-0'));
    const play = screen.getByTestId('match-hand-play-basic');
    expect(play).toBeDisabled();
    expect(handlers.onPlayBasic).not.toHaveBeenCalled();
    // 认输同样在提交中禁用，避免等待/断线期间误触。
    expect(screen.getByTestId('match-concede')).toBeDisabled();
  });
});
