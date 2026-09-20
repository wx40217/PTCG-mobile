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
    onAttack: vi.fn(),
    onEndTurn: vi.fn(),
    onPlayTrainer: vi.fn(),
    onUseStadium: vi.fn(),
    onDiscardHand: vi.fn(),
    onSearchDeck: vi.fn(),
    onChooseMode: vi.fn(),
    onSwitchOpponent: vi.fn(),
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
        { candidateId: 'c2', card: matchCard({ cardId: 'csve1-057', nameZh: '月石' }) },
      ],
      modes: [],
    };
    const handlers = renderScreen(stateWith(playingView({ pendingChoice: choice })), { catalog });
    expect(screen.getByTestId('match-search-selected-count').textContent).toContain('已选 0 张');
    await userEvent.click(screen.getByTestId('match-search-select-c1'));
    expect(screen.getByTestId('match-search-selected-count').textContent).toContain('已选 1 张');
    await userEvent.click(screen.getByTestId('match-candidate-zoom-c1'));
    expect(screen.getByTestId('match-candidate-inspector').textContent).toContain('荧光鱼');
    expect(screen.getByTestId('match-candidate-fulltext').textContent).toContain('水枪');
    await userEvent.click(screen.getByTestId('match-candidate-close'));
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
