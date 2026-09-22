import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOLO_OPPONENTS, SOLO_PRESETS } from '@ptcg/protocol';
import { App, type AppDependencies } from '../src/App.tsx';
import { createSoloSessionManager } from '../src/solo/soloSession.ts';
import { SOLO_AI_VERSION } from '../src/solo/aiDecision.ts';
import type { SoloRawRecord, SoloStorage } from '../src/solo/soloStorage.ts';
import type { SoloPreferences } from '../src/solo/preferences.ts';

afterEach(() => vi.restoreAllMocks());

function harness() {
  let raw: SoloRawRecord = { current: null, previous: null, ledger: null };
  let fail = false;
  let gate: { entered: () => void; finish: Promise<void> } | undefined;
  let prefs: SoloPreferences = { nickname: '离线玩家', dialogue: true };
  const storage: SoloStorage = {
    read: async () => structuredClone(raw),
    commit: async input => {
      if (gate) { const current = gate; gate = undefined; current.entered(); await current.finish; }
      if (fail) throw new Error('disk full');
      if (input.expected !== raw.current) throw new Error('conflict');
      raw = { current: input.next, previous: input.preservePrevious ? raw.previous : raw.current, ledger: input.ledger };
    },
  };
  const manager = createSoloSessionManager({ strategyVersion: SOLO_AI_VERSION, storage });
  let lifecycle: (active: boolean) => void = () => undefined;
  const dependencies: AppDependencies = {
    store: { read: vi.fn(async () => { throw new Error('online identity broken'); }), write: vi.fn() },
    connect: vi.fn(async () => ({ ok: false as const, failure: { kind: 'unreachable' as const, message: 'offline' } })),
    policy: { allowInsecure: false }, defaultServiceAddress: 'invalid-address',
    soloManager: manager,
    soloPreferences: { read: async () => prefs, write: async value => { prefs = value; } },
    soloLifecycle: { subscribe(listener) { lifecycle = listener; return () => { lifecycle = () => undefined; }; } },
    backButton: { subscribe: () => () => undefined },
  };
  return { dependencies, manager, storage, get raw() { return raw; }, get prefs() { return prefs; }, fail: () => { fail = true; }, active: (value: boolean) => act(() => lifecycle(value)),
    blockNext() {
      let entered!: () => void; let release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const finish = new Promise<void>(resolve => { release = resolve; });
      gate = { entered, finish }; return { waiting, release };
    },
  };
}
async function start() {
  const button = await screen.findByRole('button', { name: '开始单人对战' });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await screen.findByTestId('match-concede');
}
async function concede() {
  await waitFor(() => expect(screen.getByTestId('match-concede')).toBeEnabled());
  await userEvent.click(screen.getByTestId('match-concede'));
  expect(screen.queryByTestId('match-result')).toBeNull();
  await userEvent.click(screen.getByTestId('match-confirm-concede'));
  await screen.findByTestId('match-result');
}
async function reachSetup() {
  await waitFor(async () => {
    const first = screen.queryByTestId('match-go-first');
    if (first && !(first as HTMLButtonElement).disabled) await userEvent.click(first);
    expect(screen.getByTestId('match-confirm-setup')).toBeInTheDocument();
  });
}
async function placeActive() {
  // Read only card faces visible to the player and click the board's own setup action.
  const cards = screen.getAllByTestId(/^match-hand-\d+$/);
  for (const card of cards) {
    await userEvent.click(card);
    const action = screen.queryByTestId('match-hand-setup-active');
    if (action && !(action as HTMLButtonElement).disabled) {
      await userEvent.click(action);
      await userEvent.click(screen.getByTestId('match-hand-clear'));
      await userEvent.click(screen.getByTestId('match-confirm-setup'));
      return;
    }
    const clear = screen.queryByTestId('match-hand-clear');
    if (clear) await userEvent.click(clear);
  }
  throw new Error('No basic card action on the real setup board');
}

describe('offline solo entry and real saved session UI', () => {
  it('does not overwrite unread preferences; retry restores them and an explicit edit can save', async () => {
    const h = harness();
    const read = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ nickname: '原昵称', dialogue: false });
    const write = vi.fn(async (_value: SoloPreferences) => undefined);
    render(<App dependencies={{ ...h.dependencies, soloPreferences: { read, write } }} />);
    await screen.findByRole('button', { name: '重新读取单人偏好' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '单人昵称' })).toBeEnabled());
    expect(write).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '重新读取单人偏好' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '单人昵称' })).toHaveValue('原昵称'));
    expect(screen.getByRole('checkbox', { name: '角色台词' })).not.toBeChecked(); expect(write).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox', { name: '角色台词' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ nickname: '原昵称', dialogue: true }));
  });

  it('a deliberate edit after preference read failure enables saving without a default write', async () => {
    const h = harness(); const write = vi.fn(async (_value: SoloPreferences) => undefined);
    render(<App dependencies={{ ...h.dependencies, soloPreferences: { read: async () => { throw new Error('unavailable'); }, write } }} />);
    await screen.findByRole('button', { name: '重新读取单人偏好' }); expect(write).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox', { name: '角色台词' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ nickname: '玩家', dialogue: false }));
  });

  it.each(SOLO_PRESETS.flatMap(preset => SOLO_OPPONENTS.map(opponent => ({ preset, opponent }))))('starts and settles $preset.id against $opponent.id through the UI', async ({ preset, opponent }) => {
    const h = harness(); render(<App dependencies={h.dependencies} />);
    await screen.findByRole('button', { name: '开始单人对战' });
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(preset.nameZh) }));
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(opponent.nameZh) }));
    await start(); await reachSetup(); await concede();
    await userEvent.click(screen.getByRole('button', { name: '保存并返回首页' }));
    await screen.findByRole('button', { name: '查看结算' });
    const saved = await h.manager.inspect();
    expect(saved.summary).toMatchObject({ presetId: preset.id, opponentId: opponent.id });
    expect(saved.stats[opponent.id].losses).toBe(1);
  });
  it('new install ignores broken online identity/address, opens all 9 pairings, and preserves dialogue preference', async () => {
    const h = harness(); const ui = render(<App dependencies={h.dependencies} />);
    await screen.findByRole('button', { name: '开始单人对战' });
    for (const preset of SOLO_PRESETS) for (const opponent of SOLO_OPPONENTS) {
      await userEvent.click(screen.getByRole('radio', { name: new RegExp(preset.nameZh) }));
      await userEvent.click(screen.getByRole('radio', { name: new RegExp(opponent.nameZh) }));
      expect(screen.getByRole('radio', { name: new RegExp(opponent.nameZh) })).toBeChecked();
    }
    await userEvent.click(screen.getByRole('checkbox', { name: '角色台词' }));
    await waitFor(() => expect(h.prefs.dialogue).toBe(false));
    await start();
    expect(screen.queryByText(/看看这次，机会会落在哪里/)).toBeNull();
    expect(h.dependencies.store.read).not.toHaveBeenCalled(); expect(h.dependencies.connect).not.toHaveBeenCalled();
    await concede();
    expect(screen.getByTestId('match-result')).toHaveTextContent('你确认认输');
    await userEvent.click(screen.getByRole('button', { name: '更换对手' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '开始单人对战' })).toBeEnabled());
    expect(screen.getByRole('radio', { name: /岩森/ }).closest('label')).toHaveTextContent('0 胜 / 1 负 / 0 平');
    ui.unmount(); render(<App dependencies={h.dependencies} />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '角色台词' })).not.toBeChecked());
  });

  it('restores a setup choice after unmount, confirms abandon, and does not count abandonment as a loss', async () => {
    const h = harness(); let ui = render(<App dependencies={h.dependencies} />);
    await start(); await reachSetup();
    const hand = screen.getAllByTestId(/^match-hand-\d+$/).map(card => card.textContent);
    await userEvent.click(screen.getByRole('button', { name: '保存并返回首页' }));
    await screen.findByRole('button', { name: '继续存档' });
    const id = (await h.manager.inspect()).summary!.sessionId;
    ui.unmount(); ui = render(<App dependencies={h.dependencies} />);
    await userEvent.click(await screen.findByRole('button', { name: '继续存档' }));
    await screen.findByTestId('match-confirm-setup');
    expect(screen.getAllByTestId(/^match-hand-\d+$/).map(card => card.textContent)).toEqual(hand);
    await userEvent.click(screen.getByRole('button', { name: '保存并返回首页' }));
    await userEvent.click(await screen.findByRole('button', { name: '放弃存档' }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect((await h.manager.inspect()).summary!.sessionId).toBe(id);
    await userEvent.click(screen.getByRole('button', { name: '放弃存档' }));
    await userEvent.click(screen.getByRole('button', { name: '确认放弃' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '开始单人对战' })).toBeEnabled());
    expect((await h.manager.inspect()).stats.linyue).toEqual({ wins: 0, losses: 0, draws: 0 });
  });

  it('a player save failure stops the board and displays the durable lifecycle error; no false loss', async () => {
    const h = harness(); render(<App dependencies={h.dependencies} />);
    await start(); await reachSetup(); h.fail();
    await userEvent.click(screen.getByTestId('match-concede'));
    await userEvent.click(screen.getByTestId('match-confirm-concede'));
    await screen.findByRole('button', { name: '返回首页重读存档' });
    expect(screen.getAllByRole('alert').some(item => item.textContent?.includes('存档写入失败'))).toBe(true);
    expect(screen.getByTestId('match-confirm-concede')).toBeDisabled();
    expect(screen.queryByTestId('match-result')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '返回首页重读存档' }));
    await screen.findByRole('button', { name: '继续存档' });
    expect((await h.manager.inspect()).stats.linyue.losses).toBe(0);
  });

  it('background pauses input and resumes the same choice; replay starts one new match and counts once', async () => {
    const h = harness(); render(<App dependencies={h.dependencies} />);
    await start(); await reachSetup();
    h.active(false);
    expect(screen.getByTestId('match-concede')).toBeDisabled();
    h.active(true);
    await waitFor(() => expect(screen.getByTestId('match-concede')).toBeEnabled());
    await concede();
    const id = (await h.manager.inspect()).summary!.sessionId;
    await userEvent.dblClick(screen.getByRole('button', { name: '再来一局' }));
    await waitFor(() => expect(screen.queryByTestId('match-result')).toBeNull());
    await screen.findByTestId('match-concede');
    await userEvent.click(screen.getByRole('button', { name: '保存并返回首页' }));
    await screen.findByRole('button', { name: '继续存档' });
    const next = await h.manager.inspect();
    expect(next.summary!.sessionId).not.toBe(id); expect(next.stats.linyue.losses).toBe(1);
  });

  it('foreground return waits for an in-flight human save before enabling the board', async () => {
    const h = harness(); render(<App dependencies={h.dependencies} />);
    await start(); await reachSetup();
    const gate = h.blockNext();
    await userEvent.click(screen.getByTestId('match-concede'));
    await userEvent.click(screen.getByTestId('match-confirm-concede'));
    await gate.waiting;
    h.active(false); h.active(true);
    expect(screen.getByTestId('match-confirm-concede')).toBeDisabled();
    expect(screen.queryByTestId('match-result')).toBeNull();
    await act(async () => { gate.release(); });
    await screen.findByTestId('match-result');
    await waitFor(() => expect(screen.getByRole('button', { name: '再来一局' })).toBeEnabled());
    expect((await h.manager.inspect()).stats.linyue.losses).toBe(1);
  });

  it.each([0, 1])('opening seat %i: concession waits for the real AI save and then settles once', async openingSeat => {
    // Control only the first authority entropy word, never a client seed or hidden-state driver.
    const entropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let firstPool = true;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView<ArrayBuffer>>(array: T): T => {
      entropy(array);
      if (firstPool && array instanceof Uint32Array && array.length === 256) { array[0] = openingSeat; firstPool = false; }
      return array;
    });
    const h = harness(); const original = h.manager.start.bind(h.manager);
    let gate: ReturnType<typeof h.blockNext> | undefined;
    vi.spyOn(h.manager, 'start').mockImplementation(async input => {
      const saved = await original(input); const port = saved.players[1];
      return { ...saved, get summary() { return saved.summary; }, players: [saved.players[0], { ...port, submit(command) {
        if (!gate) gate = h.blockNext();
        return port.submit(command);
      } }] };
    });
    render(<App dependencies={h.dependencies} />); await start();
    // The authority randomly assigns opening order. Act only on the player's visible choice.
    await waitFor(async () => {
      const first = screen.queryByTestId('match-go-first');
      if (first && !(first as HTMLButtonElement).disabled) await userEvent.click(first);
      if (!gate && screen.queryByTestId('match-confirm-setup')) await placeActive();
      expect(gate).toBeDefined();
    });
    await gate!.waiting;
    await userEvent.click(screen.getByTestId('match-concede'));
    expect(screen.getByTestId('match-confirm-concede')).toBeDisabled();
    expect(screen.getByTestId('match-cancel-concede')).toBeEnabled();
    await act(async () => { gate!.release(); });
    await waitFor(() => expect(screen.getByTestId('match-confirm-concede')).toBeEnabled());
    await userEvent.click(screen.getByTestId('match-confirm-concede'));
    await screen.findByTestId('match-result');
    expect((await h.manager.inspect()).stats.linyue.losses).toBe(1);
    expect(screen.queryByTestId('match-error')).toBeNull();
  });

  it('completes a real game through card faces and choice panels with the log closed', async () => {
    const h = harness(); render(<App dependencies={h.dependencies} />);
    await start(); await reachSetup();
    await userEvent.click(screen.getByTestId('match-concede'));
    await userEvent.click(screen.getByTestId('match-cancel-concede'));
    await placeActive(); // Cancelling confirmation must release AI scheduling again.
    // A simple human strategy: keep a single active and pass. The real AI must finish the game.
    // No rule commands, injected winner or hidden state are used by this UI driver.
    for (let step = 0; step < 160 && !screen.queryByTestId('match-result'); step++) {
      const compensation = screen.queryByTestId('match-compensation-draw-0');
      if (compensation && !(compensation as HTMLInputElement).disabled) {
        await userEvent.click(compensation); await userEvent.click(screen.getByTestId('match-confirm-compensation'));
      }
      for (const id of ['match-confirm-bench', 'match-end-turn']) {
        const button = screen.queryByTestId(id);
        if (button && !(button as HTMLButtonElement).disabled) await userEvent.click(button);
      }
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    }
    expect(screen.getByTestId('match-result')).toHaveTextContent(/败|负|获胜|平局/);
    expect(screen.queryByTestId('match-log')).toBeNull();
    expect(screen.queryByRole('button', { name: '返回首页重读存档' })).toBeNull();
  }, 30_000);

  it('unavailable stats are not rendered as zero and friend errors can return to solo', async () => {
    const h = harness(); const inspect = h.manager.inspect.bind(h.manager);
    vi.spyOn(h.manager, 'inspect').mockImplementation(async () => ({ ...await inspect(), status: 'io-error', statsAvailable: false, message: '无法读取胜负账本。' }));
    render(<App dependencies={h.dependencies} />);
    expect(await screen.findAllByText('胜负记录暂不可读取')).toHaveLength(3);
    expect(screen.queryByText(/0 胜/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '进入朋友联机' }));
    await screen.findByText(/无法读取本机身份资料/);
    await userEvent.click(screen.getByRole('button', { name: '返回单人首页' }));
    expect(await screen.findByRole('heading', { name: '单人对战' })).toBeInTheDocument();
  });
});
