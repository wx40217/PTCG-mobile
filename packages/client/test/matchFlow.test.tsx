import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MatchPendingChoiceView } from '@ptcg/protocol';
import { MatchScreen, type MatchScreenProps } from '../src/ui/MatchScreen.tsx';
import { INITIAL_MATCH_STATE, type MatchState } from '../src/rooms/matchController.ts';
import { matchAttack, matchCard, matchEvent, matchPokemon, matchSide, matchView } from './matchHelpers.ts';
import { catalogDocumentWithRuntime } from './catalogHelpers.ts';

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

/** 一个 playing 状态的视图：座位 0 的回合，场上有能量/备战，手牌含基础与能量。 */
function playingView(overrides: Parameters<typeof matchView>[0] = {}) {
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
      active: matchPokemon({
        card: matchCard({ cardId: 'csv3c-043', nameZh: '古剑豹ex', type: '水' }),
        weakness: '钢×2',
      }),
      prizeCount: 6,
      revealed: true,
      deckCount: 40,
      discard: [WATER_ENERGY],
    }),
    events: [matchEvent(1, { type: 'turn-started', seat: 0, turn: 2 })],
    ...overrides,
  });
}

describe('开局准备界面（#8）', () => {
  it('获得选择权时提供先攻/后攻按钮；等待时说明在等谁', async () => {
    const turnOrderChoice: MatchPendingChoiceView = {
      choiceId: 'choice-1',
      seat: 0,
      kind: 'turn-order',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 1,
      source: 'none',
      descriptionZh: '测试待决选择',
      cardCandidates: [],
      modes: [],
    };
    const mine = renderScreen(stateWith(matchView({ phase: 'turn-order', pendingChoice: turnOrderChoice })));
    await userEvent.click(screen.getByTestId('match-go-first'));
    expect(mine.onChooseTurnOrder).toHaveBeenCalledWith(true);

    screen.getByTestId('match-go-second');
    const waitingView = matchView({ phase: 'turn-order', pendingChoice: null, waitingForOpponentChoice: true });
    renderScreen(stateWith(waitingView));
    expect(screen.getAllByTestId('match-waiting')[0]?.textContent).toContain('等待小茂选择先后攻');
  });

  it('初始放置：只能勾选基础宝可梦，确认时提交战斗与备战序号', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-2',
      seat: 0,
      kind: 'place-setup',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 5,
      candidates: [0, 1],
      step: 1,
      stepCount: 1,
      source: 'none',
      descriptionZh: '测试待决选择',
      cardCandidates: [],
      modes: [],
    };
    const view = matchView({
      you: matchSide(0, { hand: HAND, handCount: HAND.length }),
      pendingChoice: choice,
    });
    const handlers = renderScreen(stateWith(view));

    await userEvent.click(screen.getByTestId('match-setup-active-0'));
    await userEvent.click(screen.getByTestId('match-setup-bench-1'));
    // 能量卡不提供任何放置入口。
    expect(screen.queryByTestId('match-setup-active-2')).toBeNull();
    await userEvent.click(screen.getByTestId('match-confirm-setup'));
    expect(handlers.onPlaceSetup).toHaveBeenCalledWith(0, [1]);
  });

  it('补抽：可选 0 到上限；最终备战选择展示当前手牌中所有可放基础宝可梦', async () => {
    const drawChoice: MatchPendingChoiceView = {
      choiceId: 'choice-3',
      seat: 1,
      kind: 'compensation-draw',
      min: 0,
      max: 2,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 1,
      source: 'none',
      descriptionZh: '测试待决选择',
      cardCandidates: [],
      modes: [],
    };
    const drawHandlers = renderScreen(
      stateWith(matchView({ phase: 'compensation', you: matchSide(1, { hand: HAND, handCount: HAND.length }), pendingChoice: drawChoice })),
    );
    screen.getByText(/对手单独重抽了 2 次/);
    await userEvent.click(screen.getByTestId('match-compensation-draw-2'));
    await userEvent.click(screen.getByTestId('match-confirm-compensation'));
    expect(drawHandlers.onResolveCompensation).toHaveBeenCalledWith(2);

    // G6：最终备战阶段不限于本次补抽，手牌中已有的基础宝可梦也可盖放。
    const benchChoice: MatchPendingChoiceView = {
      choiceId: 'choice-4',
      seat: 0,
      kind: 'place-bench',
      min: 0,
      max: 2,
      benchMin: 0,
      benchMax: 2,
      candidates: [0, 1],
      step: 1,
      stepCount: 1,
      source: 'none',
      descriptionZh: '测试待决选择',
      cardCandidates: [],
      modes: [],
    };
    const benchHandlerView = matchView({ phase: 'compensation', you: matchSide(0, { hand: HAND, handCount: HAND.length }), pendingChoice: benchChoice });
    const benchHandlers = renderScreen(stateWith(benchHandlerView));
    expect(screen.queryByTestId('match-bench-2')).toBeNull();
    await userEvent.click(screen.getByTestId('match-bench-1'));
    await userEvent.click(screen.getByTestId('match-confirm-bench'));
    expect(benchHandlers.onPlaceBench).toHaveBeenCalledWith([1]);
  });

  it('公开翻面后展示双方战斗/备战、各项数量与首回合归属；对方手牌身份从不渲染', () => {
    const revealed = matchView({
      phase: 'playing',
      turn: 1,
      activeSeat: 0,
      you: matchSide(0, {
        hand: HAND,
        handCount: HAND.length,
        active: matchPokemon(),
        bench: [matchPokemon({ card: matchCard({ cardId: 'csve1-057', nameZh: '月石' }) })],
        prizeCount: 6,
        discard: [matchCard({ cardId: 'cbb1c-1803', nameZh: '基本水能量' })],
      }),
      opponent: matchSide(1, {
        handCount: 7,
        active: matchPokemon({ card: matchCard({ cardId: 'csv3c-043', nameZh: '古剑豹ex' }) }),
        bench: [],
        prizeCount: 6,
        revealed: true,
      }),
      events: [matchEvent(1, { type: 'setup-revealed', seat: 1, active: matchCard({ cardId: 'csv3c-043', nameZh: '古剑豹ex' }), bench: [] })],
    });
    renderScreen(stateWith(revealed));
    expect(screen.getByTestId('match-turn-info').textContent).toContain('第 1 回合');
    expect(screen.getByTestId('match-turn-info').textContent).toContain('小智');
    expect(screen.getByTestId('match-opponent-active').textContent).toContain('古剑豹ex');
    expect(screen.getByTestId('match-self-active').textContent).toContain('荧光鱼');
    expect(screen.getByTestId('match-self-bench-0').textContent).toContain('月石');
    // 对手手牌只有张数；界面没有任何可渲染的对手手牌身份。
    expect(screen.getByTestId('match-opponent-status').textContent).toContain('手牌 7 张');
    expect(screen.getByTestId('match-self-zones').textContent).toContain('弃牌区 1 张');
    expect(screen.queryByText('对手手牌荧光鱼')).toBeNull();
  });

  it('等待对手时显示等待说明；错误有明确反馈', async () => {
    const waiting = matchView({ phase: 'setup', pendingChoice: null, waitingForOpponentChoice: true });
    const handlers = renderScreen(stateWith(waiting, { error: { code: 'stale-version', message: '版本已更新，请重新确认。' } }));
    expect(screen.getAllByTestId('match-waiting').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId('match-error-dismiss'));
    expect(handlers.onClearError).toHaveBeenCalled();
  });

  it('断线、连接中与返回入口都有明确反馈', async () => {
    const waiting = matchView({ phase: 'setup', pendingChoice: null, waitingForOpponentChoice: true });
    const disconnected = renderScreen(stateWith(waiting), { connected: false });
    expect(screen.getByTestId('match-disconnected')).toBeDefined();
    await userEvent.click(screen.getByTestId('match-back-home'));
    expect(disconnected.onBack).toHaveBeenCalled();

    cleanup();
    renderScreen(stateWith(null));
    expect(screen.getByTestId('match-loading')).toBeDefined();
  });
});

describe('回合内操作界面（#9）', () => {
  it('我的回合显示操作面板；放基础、附能（选能量再选目标）、撤退与结束回合都有入口', async () => {
    const handlers = renderScreen(stateWith(playingView()));
    expect(screen.getByTestId('match-turn-actions')).toBeDefined();
    // 弃牌区是公开区域：双方弃牌身份都可展示。
    expect(screen.getByTestId('match-opponent-discard').textContent).toContain('基本水能量');

    await userEvent.click(screen.getByTestId('match-play-basic-0'));
    expect(handlers.onPlayBasic).toHaveBeenCalledWith(0);

    // 附能：先点手牌能量，再点目标。
    await userEvent.click(screen.getByTestId('match-attach-hand-2'));
    await userEvent.click(screen.getByTestId('match-attach-target-active'));
    expect(handlers.onAttachEnergy).toHaveBeenCalledWith(2, { slot: 'active' });
    await userEvent.click(screen.getByTestId('match-attach-target-bench-0'));
    expect(handlers.onAttachEnergy).toHaveBeenCalledWith(2, { slot: 'bench', index: 0 });

    // 撤退：勾选 1 个能量（费用 1）、选备战目标、确认。
    await userEvent.click(screen.getByTestId('match-retreat-energy-0'));
    await userEvent.click(screen.getByTestId('match-retreat-bench-0'));
    await userEvent.click(screen.getByTestId('match-confirm-retreat'));
    expect(handlers.onRetreat).toHaveBeenCalledWith([0], 0);

    await userEvent.click(screen.getByTestId('match-end-turn'));
    expect(handlers.onEndTurn).toHaveBeenCalled();
  });

  it('已附能/已撤退时对应面板整体禁用；非我的回合只显示等待', () => {
    renderScreen(
      stateWith(
        playingView({
          you: matchSide(0, {
            hand: HAND,
            handCount: HAND.length,
            active: matchPokemon({ energies: [{ energyIndex: 0, card: WATER_ENERGY }] }),
            bench: [matchPokemon()],
            energyAttachedThisTurn: true,
            retreatedThisTurn: true,
          }),
        }),
      ),
    );
    expect((screen.getByTestId('match-attach-hand-2') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('match-confirm-retreat') as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    renderScreen(stateWith(playingView({ activeSeat: 1 })));
    expect(screen.getByTestId('match-waiting').textContent).toContain('等待小茂完成回合');
    expect(screen.queryByTestId('match-end-turn')).toBeNull();
  });

  it('对手离线时服务端权威暂停：等待说明、回合操作禁用，认输仍可用', async () => {
    renderScreen(
      stateWith(
        playingView({
          connection: { youOnline: true, opponentOnline: false, yourDisconnectMs: 0, disconnectBudgetMs: 180_000 },
        }),
      ),
    );
    expect(screen.getByTestId('match-opponent-disconnected').textContent).toContain('重新连接');
    // 服务端会拒绝新的对局操作；界面同步禁用，避免误导用户。
    expect((screen.getByTestId('match-end-turn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('match-play-basic-0') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('match-attack-0') as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    // 待决选择同样被暂停锁定；认输是玩家自身权利，仍可发起并确认。
    const handlers = renderScreen(
      stateWith(
        matchView({
          phase: 'turn-order',
          pendingChoice: { choiceId: 'choice-pause', seat: 0, kind: 'turn-order', min: 1, max: 1, benchMin: 0, benchMax: 0, candidates: [], step: 1, stepCount: 1, source: 'none', descriptionZh: '测试待决选择', cardCandidates: [], modes: [] },
          you: matchSide(0, { hand: HAND, handCount: HAND.length }),
          connection: { youOnline: true, opponentOnline: false, yourDisconnectMs: 0, disconnectBudgetMs: 180_000 },
        }),
      ),
    );
    expect((screen.getByTestId('match-go-first') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('match-concede') as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByTestId('match-concede'));
    await userEvent.click(screen.getByTestId('match-confirm-concede'));
    expect(handlers.onConcede).toHaveBeenCalled();
  });

  it('招式按钮：已接入且有费用才可用；未接入与先攻首回合显示禁用并说明原因', () => {
    // 正常已接入招式 + 费用足够。
    const handlers = renderScreen(stateWith(playingView()));
    expect((screen.getByTestId('match-attack-0') as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    // 效果未接入：禁用且标注。
    renderScreen(
      stateWith(
        playingView({
          you: matchSide(0, {
            hand: HAND,
            handCount: HAND.length,
            active: matchPokemon({ attacks: [matchAttack({ name: '极巨和弦', supported: false, effectTextZh: '……' })] }),
            bench: [matchPokemon()],
          }),
        }),
      ),
    );
    const unsupported = screen.getByTestId('match-attack-0') as HTMLButtonElement;
    expect(unsupported.disabled).toBe(true);
    expect(unsupported.textContent).toContain('未接入');
    cleanup();

    // 先攻玩家最初回合：禁用并有明确提示。
    renderScreen(
      stateWith(
        playingView({
          turn: 1,
          firstSeat: 0,
          you: matchSide(0, {
            hand: HAND,
            handCount: HAND.length,
            active: matchPokemon(),
            bench: [matchPokemon()],
          }),
        }),
      ),
    );
    expect((screen.getByTestId('match-attack-0') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('match-first-turn-note').textContent).toContain('不能使用招式');
  });

  it('服务端的非法操作原因按错误条显示；牌库为空时暂停操作', async () => {
    renderScreen(stateWith(playingView(), { error: { code: 'insufficient-energy', message: '能量不足，无法使用「水枪」。' } }));
    expect(screen.getByTestId('match-error').textContent).toContain('能量不足');
    cleanup();

    renderScreen(stateWith(playingView({ cannotDraw: true })));
    expect(screen.getByTestId('match-cannot-draw').textContent).toContain('无法抽卡');
    expect((screen.getByTestId('match-end-turn') as HTMLButtonElement).disabled).toBe(false); // server 才是权威拒绝方
  });
});

describe('昏厥结算与终局界面（#10）', () => {
  it('取奖赏卡：只能按上限勾选未公开序号，确认后回调选中的序号', async () => {
    const handlers = renderScreen(
      stateWith(
        playingView({
          pendingChoice: { choiceId: 'choice-7', seat: 0, kind: 'take-prizes', min: 1, max: 1, benchMin: 0, benchMax: 0, candidates: [0, 1, 2],
        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
          you: matchSide(0, { hand: HAND, handCount: HAND.length, active: matchPokemon(), bench: [matchPokemon()], prizeCount: 3 }),
        }),
      ),
    );
    expect(screen.getByTestId('match-prize-form')).toBeDefined();
    // 奖赏卡在拿取前不显示身份，只有序号。
    expect(screen.getByTestId('match-prize-0').closest('label')?.textContent).toContain('奖赏卡 1');
    expect((screen.getByTestId('match-confirm-prizes') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('match-prize-1'));
    await userEvent.click(screen.getByTestId('match-confirm-prizes'));
    expect(handlers.onTakePrizes).toHaveBeenCalledWith([1]);
  });

  it('补充战斗宝可梦：从备战区单选并按序号确认', async () => {
    const handlers = renderScreen(
      stateWith(
        playingView({
          pendingChoice: { choiceId: 'choice-8', seat: 0, kind: 'choose-replacement', min: 1, max: 1, benchMin: 0, benchMax: 0, candidates: [0],
        step: 1,
        stepCount: 1,
        source: 'none',
        descriptionZh: '测试待决选择',
        cardCandidates: [],
        modes: [],
      },
          you: matchSide(0, { hand: HAND, handCount: HAND.length, active: null, bench: [matchPokemon({ card: matchCard({ cardId: 'csve1-057', nameZh: '月石' }) })] }),
        }),
      ),
    );
    expect(screen.getByTestId('match-replacement-form')).toBeDefined();
    expect((screen.getByTestId('match-confirm-replacement') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('match-replacement-0'));
    await userEvent.click(screen.getByTestId('match-confirm-replacement'));
    expect(handlers.onChooseReplacement).toHaveBeenCalledWith(0);
  });

  it('终局结果条：结果与原因可理解、回合与认输入口消失、可返回房间', async () => {
    const handlers = renderScreen(
      stateWith(
        playingView({
          pendingChoice: null,
          result: { winner: 0, reason: 'prizes', conditions: [{ seat: 0, condition: 'prizes' }] },
        }),
      ),
    );
    expect(screen.getByTestId('match-result-label').textContent).toContain('你获胜');
    expect(screen.getByTestId('match-result-label').textContent).toContain('拿取全部奖赏卡');
    expect(screen.queryByTestId('match-end-turn')).toBeNull();
    expect(screen.queryByTestId('match-concede')).toBeNull();
    await userEvent.click(screen.getByTestId('match-return-room'));
    expect(handlers.onReturnToRoom).toHaveBeenCalled();
  });

  it('特殊状态在场上公开显示；认输需要二次确认', async () => {
    const handlers = renderScreen(
      stateWith(
        playingView({
          you: matchSide(0, {
            hand: HAND,
            handCount: HAND.length,
            active: matchPokemon({ statuses: ['中毒', '灼伤'] }),
            bench: [matchPokemon()],
          }),
        }),
      ),
    );
    expect(screen.getByTestId('match-self-active').textContent).toContain('状态：中毒、灼伤');
    await userEvent.click(screen.getByTestId('match-concede'));
    expect(handlers.onConcede).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('match-confirm-concede'));
    expect(handlers.onConcede).toHaveBeenCalledTimes(1);
  });
});

describe('训练家卡与多步选择界面（T10 / #11）', () => {
  const TRAINER_CARDS = [
    matchCard({ cardId: 'cbb1c-1701', nameZh: '精灵球', kind: 'trainer', isBasicPokemon: false, type: null, hp: null }),
    matchCard({ cardId: 'csve1-138', nameZh: '珠贝', kind: 'trainer', isBasicPokemon: false, type: null, hp: null }),
  ];
  const STADIUM = matchCard({ cardId: 'csv2c-127', nameZh: '深钵镇', kind: 'trainer', isBasicPokemon: false, type: null, hp: null });

  function trainerView(overrides: Parameters<typeof playingView>[0] = {}) {
    return playingView({
      you: matchSide(0, {
        hand: [...TRAINER_CARDS, ...HAND],
        handCount: TRAINER_CARDS.length + HAND.length,
        active: matchPokemon(),
        bench: [],
        prizeCount: 6,
        deckCount: 40,
      }),
      stadium: STADIUM,
      ...overrides,
    });
  }

  it('手牌训练家卡可点击出牌；未接入的卡禁用并标注，竞技场可主动使用', async () => {
    const { catalog } = catalogDocumentWithRuntime();
    const handlers = renderScreen(stateWith(trainerView()), { catalog });
    const supported = screen.getByTestId('match-play-trainer-0') as HTMLButtonElement;
    expect(supported.disabled).toBe(false);
    await userEvent.click(supported);
    expect(handlers.onPlayTrainer).toHaveBeenCalledWith(0);

    const unsupported = screen.getByTestId('match-play-trainer-1') as HTMLButtonElement;
    expect(unsupported.disabled).toBe(true);
    expect(unsupported.textContent).toContain('未接入');

    expect(screen.getByTestId('match-stadium-name').textContent).toContain('深钵镇');
    await userEvent.click(screen.getByTestId('match-use-stadium'));
    expect(handlers.onUseStadium).toHaveBeenCalled();
  });

  it('检索候选显示数量范围、已选计数与显式提交，并能放大查看完整卡面', async () => {
    const { catalog } = catalogDocumentWithRuntime();
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-21',
      seat: 0,
      kind: 'search-deck',
      min: 0,
      max: 3,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 1,
      source: 'deck',
      descriptionZh: '鼓励信：选择自己牌库中最多 3 张基本能量。',
      cardCandidates: [
        { candidateId: 'c1', card: matchCard({ cardId: 'csve1-035', nameZh: '荧光鱼' }) },
        { candidateId: 'c2', card: matchCard({ cardId: 'csve1-057', nameZh: '月石' }), selectable: false },
      ],
      modes: [],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })), { catalog });
    expect(screen.getByTestId('match-search-selected-count').textContent).toContain('已选 0 张');
    // 被查看但不满足卡面文字限定的卡展示但不可选，仍可放大阅读完整文字。
    expect((screen.getByTestId('match-search-select-c2') as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('match-candidate-zoom-c2'));
    expect(screen.getByTestId('match-candidate-inspector').textContent).toContain('月石');
    await userEvent.click(screen.getByTestId('match-candidate-close'));
    await userEvent.click(screen.getByTestId('match-search-select-c1'));
    expect(screen.getByTestId('match-search-selected-count').textContent).toContain('已选 1 张');
    await userEvent.click(screen.getByTestId('match-candidate-zoom-c1'));
    expect(screen.getByTestId('match-candidate-inspector').textContent).toContain('荧光鱼');
    expect(screen.getByTestId('match-candidate-fulltext').textContent).toContain('水枪');
    await userEvent.click(screen.getByTestId('match-candidate-close'));
    await userEvent.click(screen.getByTestId('match-confirm-search'));
    expect(handlers.onSearchDeck).toHaveBeenCalledWith(['c1']);
  });

  it('查看后无可选目标时仍展示全部被查看卡，可提交 0 张', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-21b',
      seat: 0,
      kind: 'search-deck',
      min: 0,
      max: 0,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 1,
      source: 'top-deck',
      descriptionZh: '超级球：查看自己牌库上方 7 张卡牌。',
      cardCandidates: [
        { candidateId: 'c1', card: matchCard({ cardId: 'csve1-035', nameZh: '荧光鱼' }), selectable: false },
        { candidateId: 'c2', card: matchCard({ cardId: 'cbb1c-1803', nameZh: '基本水能量' }), selectable: false },
      ],
      modes: [],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })));
    expect(screen.getAllByTestId(/^match-search-candidate-/u)).toHaveLength(2);
    expect((screen.getByTestId('match-search-select-c1') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('match-search-select-c2') as HTMLInputElement).disabled).toBe(true);
    const confirm = screen.getByTestId('match-confirm-search') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    expect(handlers.onSearchDeck).toHaveBeenCalledWith([]);
  });

  it('可选的单选检索：选中后可清除，回到 0 张并明确提交', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-21c',
      seat: 0,
      kind: 'search-deck',
      min: 0,
      max: 1,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 1,
      source: 'deck',
      descriptionZh: '精灵球：选择自己牌库中的 1 张宝可梦，向对手展示后加入手牌，并重洗牌库（可以不选）。',
      cardCandidates: [{ candidateId: 'c1', card: matchCard({ cardId: 'csve1-035', nameZh: '荧光鱼' }) }],
      modes: [],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })));
    expect((screen.getByTestId('match-confirm-search') as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByTestId('match-search-select-c1'));
    expect(screen.getByTestId('match-search-selected-count').textContent).toContain('已选 1 张');
    const clear = screen.getByTestId('match-search-clear') as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    await userEvent.click(clear);
    expect(screen.getByTestId('match-search-selected-count').textContent).toContain('已选 0 张');
    await userEvent.click(screen.getByTestId('match-confirm-search'));
    expect(handlers.onSearchDeck).toHaveBeenCalledWith([]);
  });

  it('必选的单选检索：没有清除入口，必须选满 1 张才能提交', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-21d',
      seat: 0,
      kind: 'search-deck',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 1,
      source: 'deck',
      descriptionZh: '从牌库中选择 1 张卡牌。',
      cardCandidates: [{ candidateId: 'c1', card: matchCard({ cardId: 'csve1-035', nameZh: '荧光鱼' }) }],
      modes: [],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })));
    expect(screen.queryByTestId('match-search-clear')).toBeNull();
    expect((screen.getByTestId('match-confirm-search') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('match-search-select-c1'));
    expect(screen.getByTestId('match-search-selected-count').textContent).toContain('已选 1 张');
    expect((screen.getByTestId('match-confirm-search') as HTMLButtonElement).disabled).toBe(false);
    // 已选中的必选单选再次点击不会取消（radio 语义）。
    await userEvent.click(screen.getByTestId('match-search-select-c1'));
    expect(screen.getByTestId('match-search-selected-count').textContent).toContain('已选 1 张');
    await userEvent.click(screen.getByTestId('match-confirm-search'));
    expect(handlers.onSearchDeck).toHaveBeenCalledWith(['c1']);
  });

  it('弃牌选择显示张数上下限并以明确提交发送', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-22',
      seat: 0,
      kind: 'discard-hand',
      min: 1,
      max: 3,
      benchMin: 0,
      benchMax: 0,
      candidates: [0, 1, 2],
      step: 2,
      stepCount: 2,
      source: 'hand',
      descriptionZh: '莎莉娜：选择 1 到 3 张手牌放于弃牌区。',
      cardCandidates: [],
      modes: [],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })));
    expect((screen.getByTestId('match-confirm-discard') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('match-discard-0'));
    await userEvent.click(screen.getByTestId('match-discard-2'));
    expect(screen.getByTestId('match-discard-selected-count').textContent).toContain('已选 2 张');
    await userEvent.click(screen.getByTestId('match-confirm-discard'));
    expect(handlers.onDiscardHand).toHaveBeenCalledWith([0, 2]);
  });

  it('二选一效果：不可用模式禁用并说明原因，可用模式确认后提交', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-23',
      seat: 0,
      kind: 'choose-mode',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 2,
      source: 'none',
      descriptionZh: '莎莉娜：从 2 个效果中选择 1 个使用。',
      cardCandidates: [],
      modes: [
        { modeId: 'discard-draw-five', labelZh: '弃置手牌后抽到 5 张', available: true, unavailableReasonZh: null },
        { modeId: 'switch-opponent-v', labelZh: '互换对手备战宝可梦V', available: false, unavailableReasonZh: '对手备战区没有「宝可梦V」' },
      ],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })));
    expect((screen.getByTestId('match-mode-switch-opponent-v') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('match-mode-option-switch-opponent-v').textContent).toContain('对手备战区没有');
    await userEvent.click(screen.getByTestId('match-mode-discard-draw-five'));
    await userEvent.click(screen.getByTestId('match-confirm-mode'));
    expect(handlers.onChooseMode).toHaveBeenCalledWith('discard-draw-five');
  });

  it('互换对手备战宝可梦：只列出候选并确认提交', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-24',
      seat: 0,
      kind: 'switch-opponent',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 0,
      candidates: [0],
      step: 2,
      stepCount: 2,
      source: 'opponent-bench',
      descriptionZh: '选择对手备战区的 1 只「宝可梦V」，将其与战斗宝可梦互换。',
      cardCandidates: [],
      modes: [],
    };
    const view = playingView({
      pendingChoice: choice,
      opponent: matchSide(1, {
        handCount: 7,
        deckCount: 40,
        prizeCount: 6,
        revealed: true,
        active: matchPokemon(),
        bench: [matchPokemon({ card: matchCard({ cardId: 'csve1-062', nameZh: '仙子伊布V' }) })],
      }),
    });
    const handlers = renderScreen(stateWith(view));
    expect(screen.getByTestId('match-switch-0').closest('label')?.textContent).toContain('仙子伊布V');
    await userEvent.click(screen.getByTestId('match-switch-0'));
    await userEvent.click(screen.getByTestId('match-confirm-switch'));
    expect(handlers.onSwitchOpponent).toHaveBeenCalledWith(0);
  });
});

describe('进化、特性与附加卡界面（T11 / #12）', () => {
  it('进化卡先选卡再选目标；卡名不符的目标禁用并说明原因', async () => {
    const view = playingView({
      you: matchSide(0, {
        hand: [
          matchCard({ cardId: 'csve1-063', nameZh: '仙子伊布VMAX', evolvesFrom: '仙子伊布V' }),
          matchCard({ cardId: 'csve1-057', nameZh: '月石' }),
        ],
        handCount: 2,
        active: matchPokemon({ card: matchCard({ cardId: 'csve1-062', nameZh: '仙子伊布V' }) }),
        bench: [matchPokemon({ card: matchCard({ cardId: 'csve1-057', nameZh: '月石' }) })],
        prizeCount: 6,
        deckCount: 40,
      }),
    });
    const handlers = renderScreen(stateWith(view));
    await userEvent.click(screen.getByTestId('match-evolve-hand-0'));
    expect(screen.getByTestId('match-evolve-target-active')).not.toBeDisabled();
    expect(screen.getByTestId('match-evolve-target-bench-0')).toBeDisabled();
    expect(screen.getByTestId('match-evolve-target-bench-0').getAttribute('title')).toContain('不是「仙子伊布V');
    expect(screen.getByTestId('match-evolve-target-bench-0').textContent).toContain('卡名不符');
    await userEvent.click(screen.getByTestId('match-evolve-target-active'));
    expect(handlers.onEvolve).toHaveBeenCalledWith(0, { slot: 'active' });
  });

  it('特性按服务端可用性启用；不可用时显示原因', async () => {
    const view = playingView({
      you: matchSide(0, {
        hand: [],
        handCount: 0,
        active: matchPokemon({
          card: matchCard({ cardId: 'csve1-062', nameZh: '仙子伊布V' }),
          abilities: [{ index: 0, labelZh: '特性', name: '梦中赠礼', textZh: '检索 1 张物品后回合结束。', supported: true, usable: true, unusableReasonZh: null }],
        }),
        bench: [
          matchPokemon({
            card: matchCard({ cardId: 'csv3c-043', nameZh: '古剑豹ex' }),
            abilities: [
              {
                index: 0,
                labelZh: '特性',
                name: '战栗冷气',
                textZh: '检索最多 2 张基本水能量。',
                supported: true,
                usable: false,
                unusableReasonZh: '「战栗冷气」只有在这只宝可梦位于战斗场上时才能使用。',
              },
            ],
          }),
        ],
        prizeCount: 6,
        deckCount: 40,
      }),
    });
    const handlers = renderScreen(stateWith(view));
    await userEvent.click(screen.getByTestId('match-use-ability-active-0'));
    expect(handlers.onUseAbility).toHaveBeenCalledWith(0, { slot: 'active' });
    expect(screen.getByTestId('match-use-ability-bench-0-0')).toBeDisabled();
    expect(screen.getByTestId('match-ability-hint-bench-0-0').textContent).toContain('战斗场');
  });

  it('宝可梦道具只在目标没有道具时可选；附着提交目标', async () => {
    const tool = matchCard({ cardId: 'csv1c-118', nameZh: '勇气护符', kind: 'trainer', isBasicPokemon: false, hp: null, type: null });
    const view = playingView({
      you: matchSide(0, {
        hand: [tool],
        handCount: 1,
        active: matchPokemon({ card: matchCard({ cardId: 'csve1-062', nameZh: '仙子伊布V' }), tools: [matchCard({ cardId: 'csv1c-118', nameZh: '勇气护符', kind: 'trainer' })] }),
        bench: [matchPokemon({ card: matchCard({ cardId: 'csve1-057', nameZh: '月石' }) })],
        prizeCount: 6,
        deckCount: 40,
      }),
    });
    const handlers = renderScreen(stateWith(view), { catalog: catalogDocumentWithRuntime().catalog });
    await userEvent.click(screen.getByTestId('match-tool-hand-0'));
    expect(screen.getByTestId('match-tool-target-active')).toBeDisabled();
    expect(screen.getByTestId('match-tool-target-active').getAttribute('title')).toContain('已经附着');
    expect(screen.getByTestId('match-tool-target-bench-0')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('match-tool-target-bench-0'));
    expect(handlers.onAttachTool).toHaveBeenCalledWith(0, { slot: 'bench', index: 0 });
  });

  it('珍贵一触两步选择：先选备战目标，再选手中能量', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-30',
      seat: 0,
      kind: 'choose-own-bench',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 0,
      candidates: [0],
      step: 1,
      stepCount: 2,
      source: 'own-bench',
      descriptionZh: '选择自己备战区的 1 只宝可梦，作为附着能量与回复 HP 的目标。',
      cardCandidates: [],
      modes: [],
    };
    const view = playingView({
      you: matchSide(0, {
        hand: [],
        handCount: 0,
        active: matchPokemon({ card: matchCard({ cardId: 'csve1-063', nameZh: '仙子伊布VMAX' }) }),
        bench: [matchPokemon({ card: matchCard({ cardId: 'csve1-062', nameZh: '仙子伊布V' }) })],
        prizeCount: 6,
        deckCount: 40,
      }),
      pendingChoice: choice,
    });
    const handlers = renderScreen(stateWith(view));
    expect(screen.getByTestId('match-own-bench-description').textContent).toContain('步骤 1/2');
    await userEvent.click(screen.getByTestId('match-own-bench-0'));
    await userEvent.click(screen.getByTestId('match-confirm-own-bench'));
    expect(handlers.onChooseOwnBench).toHaveBeenCalledWith(0);
  });

  it('冰雹利刃弃置附着能量：候选标注所属宝可梦并可提交 0 张', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-31',
      seat: 0,
      kind: 'discard-energy',
      min: 0,
      max: 2,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 1,
      source: 'own-field-energy',
      descriptionZh: '选择自己场上宝可梦附着的任意数量基本水能量放于弃牌区。',
      cardCandidates: [
        { candidateId: 'active:0', card: matchCard({ cardId: 'cbb1c-1803', nameZh: '基本水能量', kind: 'energy' }), targetLabelZh: '战斗宝可梦' },
        { candidateId: 'bench-0:0', card: matchCard({ cardId: 'cbb1c-1803', nameZh: '基本水能量', kind: 'energy' }), targetLabelZh: '备战区 1' },
      ],
      modes: [],
    };
    const view = playingView({ pendingChoice: choice });
    const handlers = renderScreen(stateWith(view));
    expect(screen.getByTestId('match-discard-energy-active:0').closest('label')?.textContent).toContain('战斗宝可梦');
    expect(screen.getByTestId('match-confirm-discard-energy')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('match-discard-energy-active:0'));
    expect(screen.getByTestId('match-discard-energy-selected').textContent).toContain('已选 1 张');
    await userEvent.click(screen.getByTestId('match-confirm-discard-energy'));
    expect(handlers.onDiscardEnergy).toHaveBeenCalledWith(['active:0']);
  });

  it('莉佳的邀请/捩木的私有候选：不可选展示但禁用，确认提交候选', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-40',
      seat: 0,
      kind: 'select-card',
      min: 0,
      max: 1,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 2,
      source: 'opponent-hand',
      descriptionZh: '莉佳的邀请：查看对手的手牌，选择其中 1 张基础宝可梦（可以选择 0 张）。',
      cardCandidates: [
        { candidateId: 'h1', card: matchCard({ cardId: 'csve1-056', nameZh: '梦幻ex' }) },
        { candidateId: 'h2', card: WATER_ENERGY, selectable: false },
      ],
      modes: [],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })));
    expect(screen.getByTestId('match-select-card-description').textContent).toContain('步骤 1/2');
    expect(screen.getByTestId('match-select-toggle-h2')).toBeDisabled();
    expect(screen.getByTestId('match-select-toggle-h1')).not.toBeDisabled();
    expect(screen.getByTestId('match-select-clear')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('match-select-toggle-h1'));
    await userEvent.click(screen.getByTestId('match-confirm-select'));
    expect(handlers.onSelectCard).toHaveBeenCalledWith(['h1']);
  });

  it('刺穿/火焰巨浪的场上目标选择：展示目标标签并可提交 0 项', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-41',
      seat: 0,
      kind: 'select-target',
      min: 0,
      max: 3,
      benchMin: 0,
      benchMax: 0,
      candidates: [],
      step: 1,
      stepCount: 1,
      source: 'own-bench',
      descriptionZh: '火焰巨浪：选择自己最多 3 只备战宝可梦（可以选择 0 只）。',
      cardCandidates: [
        { candidateId: 'bench-0', card: matchCard({ cardId: 'csv3c-031', nameZh: '古玉鱼ex' }), targetLabelZh: '备战区 1' },
        { candidateId: 'bench-1', card: WATER_ENERGY, selectable: false, targetLabelZh: '备战区 2' },
      ],
      modes: [],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })));
    expect(screen.getByTestId('match-select-candidate-bench-0').textContent).toContain('备战区 1');
    expect(screen.getByTestId('match-select-toggle-bench-1')).toBeDisabled();
    await userEvent.click(screen.getByTestId('match-select-toggle-bench-0'));
    await userEvent.click(screen.getByTestId('match-confirm-select'));
    expect(handlers.onSelectTarget).toHaveBeenCalledWith(['bench-0']);
  });

  it('基因侵入：列出对手战斗宝可梦的公开招式，未接入的不可选', async () => {
    const choice: MatchPendingChoiceView = {
      choiceId: 'choice-42',
      seat: 0,
      kind: 'copy-attack',
      min: 1,
      max: 1,
      benchMin: 0,
      benchMax: 0,
      candidates: [0, 1],
      step: 1,
      stepCount: 1,
      source: 'opponent-active',
      descriptionZh: '基因侵入：选择对手战斗宝可梦拥有的 1 个招式。',
      cardCandidates: [],
      modes: [],
    };
    const opponentActive = matchPokemon({
      card: matchCard({ cardId: 'csv3c-043', nameZh: '古剑豹ex', type: '水' }),
      attacks: [
        { index: 0, name: '冰雹利刃', cost: ['水'], damageText: '60×', effectTextZh: '弃置任意数量水能量。', supported: true },
        { index: 1, name: '未接入招式', cost: [], damageText: null, effectTextZh: '尚未接入。', supported: false },
      ],
    });
    const handlers = renderScreen(
      stateWith(playingView({ pendingChoice: choice, opponent: matchSide(1, { handCount: 7, active: opponentActive, revealed: true, prizeCount: 6, deckCount: 40 }) })),
    );
    expect(screen.getByTestId('match-copy-attack-0')).not.toBeDisabled();
    expect(screen.getByTestId('match-copy-attack-1')).toBeDisabled();
    await userEvent.click(screen.getByTestId('match-copy-attack-0'));
    await userEvent.click(screen.getByTestId('match-confirm-copy-attack'));
    expect(handlers.onCopyAttack).toHaveBeenCalledWith(0);
  });
});
