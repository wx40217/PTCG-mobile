import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DECK_FORMAT_VERSION,
  type ClientMessage,
  type ConnectResult,
  type ConnectionClosedEvent,
  type DeckValidationResponse,
  type LiveConnection,
  type RoomView,
  type ServerMessage,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';
import { App } from '../src/App.tsx';
import type { CopyText } from '../src/app/clipboard.ts';
import type { ConnectFn } from '../src/connection/connection.ts';
import { createCatalogCache, createMemoryCatalogStorage, CATALOG_CACHE_KEY } from '../src/catalog/cache.ts';
import type { CatalogSource } from '../src/catalog/source.ts';
import { createDraft, createMemoryDeckDraftStore } from '../src/decks/draftStore.ts';
import { catalogDocumentWithRuntime, createFakeCatalogSource } from './catalogHelpers.ts';
import { deckDocumentOf, realCatalog } from './deckHelpers.ts';
import { matchView } from './matchHelpers.ts';

const DEV_POLICY: ServiceAddressPolicy = { allowInsecure: true };
const catalog = realCatalog();

const readyValidation: DeckValidationResponse = {
  formatVersion: DECK_FORMAT_VERSION,
  environmentId: catalog.content.environment.id,
  catalogVersion: catalog.catalogVersion,
  dataRevision: catalog.content.dataRevision.sourceDigest,
  totalCards: 60,
  legal: true,
  ready: true,
  problems: [],
};

function roomView(overrides: Partial<RoomView> = {}): RoomView {
  return {
    roomId: 'room-instance-1',
    code: '042000',
    version: 1,
    status: 'waiting',
    you: {
      seat: 0,
      occupied: true,
      host: true,
      nickname: '小智',
      ready: false,
      online: true,
      deckSelected: false,
      deck: null,
    },
    opponent: {
      seat: 1,
      occupied: false,
      host: false,
      nickname: null,
      ready: false,
      online: false,
      deckSelected: false,
      deck: null,
    },
    match: null,
    ...overrides,
  };
}

interface FakeConnection {
  readonly connection: LiveConnection;
  readonly sent: ClientMessage[];
  emit(message: ServerMessage): void;
  emitClosed(event?: ConnectionClosedEvent): void;
}

function createFakeConnection(nickname: string): FakeConnection {
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const closedListeners = new Set<(event: ConnectionClosedEvent) => void>();
  const sent: ClientMessage[] = [];
  let closed = false;
  const connection: LiveConnection = {
    session: {
      protocolVersion: 1,
      serverVersion: '0.1.0',
      sessionId: 'session-room',
      deviceId: 'dev_room_client',
      nickname,
      registered: true,
    },
    get closed() {
      return closed;
    },
    send(message) {
      sent.push(message);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClosed(listener) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    close() {
      closed = true;
    },
  };
  return {
    connection,
    sent,
    emit(message) {
      for (const listener of [...messageListeners]) {
        listener(message);
      }
    },
    emitClosed(event = { kind: 'disconnected' }) {
      closed = true;
      for (const listener of [...closedListeners]) {
        listener(event);
      }
    },
  };
}

interface RenderOptions {
  readonly drafts?: ReturnType<typeof createDraft>[];
  readonly source?: CatalogSource;
  readonly copyText?: CopyText;
}

async function renderRoomApp(options: RenderOptions = {}) {
  const fake = createFakeConnection('小智');
  const connect: ConnectFn = async (): Promise<ConnectResult> => ({ ok: true, connection: fake.connection });
  const storage = createMemoryCatalogStorage();
  const { document } = catalogDocumentWithRuntime();
  storage.set(CATALOG_CACHE_KEY, JSON.stringify(document));
  const drafts =
    options.drafts ??
    [
      createDraft({ name: '预设A草稿', document: deckDocumentOf('A', catalog), id: 'draft-a' }),
      createDraft({ name: '预设B草稿', document: deckDocumentOf('B', catalog), id: 'draft-b' }),
    ];
  const view = render(
    <App
      dependencies={{
        store: {
          read: async () => ({ nickname: '', serviceAddress: '' }),
          write: async () => undefined,
        },
        connect,
        policy: DEV_POLICY,
        defaultServiceAddress: 'http://127.0.0.1:8787',
        createCatalogSource: () => options.source ?? createFakeCatalogSource(() => catalogDocumentWithRuntime()),
        catalogCache: createCatalogCache(storage),
        deckStore: createMemoryDeckDraftStore(drafts),
        copyText: options.copyText,
      }}
    />,
  );
  await screen.findByLabelText('昵称（仅用于显示）');
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('昵称（仅用于显示）'), '小智');
  await user.click(screen.getByRole('button', { name: '保存并连接' }));
  await screen.findByTestId('open-room');
  return { fake, user, unmount: () => view.unmount() };
}

async function openRoom(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('open-room'));
  await screen.findByTestId('room-service-address');
}

async function createRoom(user: ReturnType<typeof userEvent.setup>, fake: FakeConnection): Promise<void> {
  await user.click(screen.getByTestId('room-create'));
  await waitFor(() => expect(fake.sent.some((message) => message.type === 'create-room')).toBe(true));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('朋友房间入口与房间码展示', () => {
  it('服务地址与房间码分开；建房显示 6 位码与复制操作', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);
    expect(screen.getByTestId('room-service-address')).toHaveTextContent('http://127.0.0.1:8787');
    // 房间码是独立输入，不与服务地址混用。
    expect(screen.getByTestId('room-code-input')).toHaveAttribute('maxlength', '6');

    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });

    await createRoom(user, fake);
    fake.emit({ type: 'room', room: roomView() });
    await screen.findByTestId('room-code');
    expect(screen.getByTestId('room-code')).toHaveTextContent('042000');
    expect(screen.getByTestId('room-opponent-status')).toHaveTextContent('等待朋友加入');

    await user.click(screen.getByTestId('room-copy-code'));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('042000'));
    expect(await screen.findByTestId('room-copy-notice')).toHaveTextContent('已复制房间码');
  });

  it('复制走注入的剪贴板实现并提供成功反馈', async () => {
    const copyText = vi.fn(async () => undefined);
    const { fake, user } = await renderRoomApp({ copyText });
    await openRoom(user);
    await createRoom(user, fake);
    fake.emit({ type: 'room', room: roomView() });
    await screen.findByTestId('room-code');

    await user.click(screen.getByTestId('room-copy-code'));
    await waitFor(() => expect(copyText).toHaveBeenCalledExactlyOnceWith('042000'));
    expect(await screen.findByTestId('room-copy-notice')).toHaveTextContent('已复制房间码');
  });

  it('复制失败时提示手动抄写且保留房间码', async () => {
    const copyText = vi.fn(async () => {
      throw new Error('denied');
    });
    const { fake, user } = await renderRoomApp({ copyText });
    await openRoom(user);
    await createRoom(user, fake);
    fake.emit({ type: 'room', room: roomView() });
    await screen.findByTestId('room-code');

    await user.click(screen.getByTestId('room-copy-code'));
    expect(await screen.findByTestId('room-copy-notice')).toHaveTextContent('复制失败，请手动抄写：042000');
  });

  it('加入房间发送独立房间码；错误房间码与服务端错误都有明确提示', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);

    const codeInput = screen.getByTestId('room-code-input');
    await user.type(codeInput, '123456');
    await user.click(screen.getByTestId('room-join'));
    await waitFor(() => expect(fake.sent.some((message) => message.type === 'join-room')).toBe(true));
    const join = fake.sent.find((message) => message.type === 'join-room');
    expect(join).toMatchObject({ type: 'join-room', code: '123456' });
    // 首次加入还不知道房间实例，不应凭空伪造 roomId。
    expect(join).not.toHaveProperty('roomId');

    fake.emit({ type: 'room-error', code: 'room-not-found', message: '没有找到这个房间，请确认房间码与服务地址。' });
    expect(await screen.findByTestId('room-error')).toHaveTextContent('没有找到这个房间');
    expect(screen.queryByTestId('room-code')).not.toBeInTheDocument();

    // 本地格式错误不发请求；服务端未确认前不显示任何房间可用状态。
    await user.clear(codeInput);
    await user.type(codeInput, '12');
    const sentBefore = fake.sent.length;
    await user.click(screen.getByTestId('room-join'));
    expect(fake.sent.length).toBe(sentBefore);
    expect(screen.getByTestId('room-error')).toHaveTextContent('6 位数字');
  });

  it('第三人/满座明确拒绝，不渲染任何房间状态', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);
    await user.type(screen.getByTestId('room-code-input'), '123456');
    await user.click(screen.getByTestId('room-join'));
    fake.emit({ type: 'room-error', code: 'room-full', message: '房间的两个座位都已被占用。' });
    expect(await screen.findByTestId('room-error')).toHaveTextContent('两个座位都已被占用');
    expect(screen.queryByTestId('room-self')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-code')).not.toBeInTheDocument();
  });
});

describe('选卡组、准备与开局', () => {
  it('备选卡组以服务端校验为准，准备后只显示对手准备状态而非卡表', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);
    await createRoom(user, fake);

    const opponent = {
      seat: 1 as const,
      occupied: true,
      host: false,
      nickname: '小茂',
      ready: false,
      online: true,
      deckSelected: false,
      deck: null,
    };
    fake.emit({ type: 'room', room: roomView({ opponent }) });
    await screen.findByTestId('room-opponent-name');
    expect(screen.getByTestId('room-opponent-status')).toHaveTextContent('未准备');

    await user.click(screen.getByTestId('room-select-deck-draft-a'));
    const select = fake.sent.find((message) => message.type === 'select-deck');
    expect(select).toMatchObject({ type: 'select-deck', roomId: 'room-instance-1', expectedVersion: 1 });
    if (select?.type !== 'select-deck') {
      throw new Error('测试没有发送 select-deck 命令');
    }
    expect(select.deck.cards.reduce((sum, entry) => sum + entry.count, 0)).toBe(60);

    // 服务端的直接回答携带原始 commandId；无命令关联的对手广播不会结束等待。
    fake.emit({
      type: 'room',
      room: roomView({
        version: 2,
        opponent,
        you: {
          seat: 0,
          occupied: true,
          host: true,
          nickname: '小智',
          ready: false,
          online: true,
          deckSelected: true,
          deck: { totalCards: 60, validation: readyValidation },
        },
      }),
      commandId: select.commandId,
    });
    expect(await screen.findByTestId('room-deck-validation-summary')).toHaveTextContent('可以正式对战');

    await user.click(screen.getByTestId('room-ready'));
    await waitFor(() => expect(fake.sent.some((message) => message.type === 'set-ready' && message.ready === true)).toBe(true));
    expect(fake.sent.filter((message) => message.type === 'set-ready').at(-1)).toMatchObject({
      type: 'set-ready',
      roomId: 'room-instance-1',
      expectedVersion: 2,
      ready: true,
    });

    // 对手准备：只显示状态，不渲染对手卡表内容。
    fake.emit({
      type: 'room',
      room: roomView({
        version: 3,
        opponent: { ...opponent, ready: true, deckSelected: true },
        you: {
          seat: 0,
          occupied: true,
          host: true,
          nickname: '小智',
          ready: true,
          online: true,
          deckSelected: true,
          deck: { totalCards: 60, validation: readyValidation },
        },
      }),
    });
    expect((await screen.findByTestId('room-opponent')).textContent).not.toContain('古剑豹');
    expect(screen.getByTestId('room-opponent-status')).toHaveTextContent('已准备');

    // 对手广播先到不会结束本机等待；匹配的准备结果随后到达才结束等待。
    const ready = fake.sent.filter((message) => message.type === 'set-ready').at(-1);
    if (ready?.type !== 'set-ready') {
      throw new Error('测试没有发送 set-ready 命令');
    }
    fake.emit({
      type: 'room',
      room: roomView({
        version: 4,
        opponent: { ...opponent, ready: true, deckSelected: true },
        you: {
          seat: 0,
          occupied: true,
          host: true,
          nickname: '小智',
          ready: true,
          online: true,
          deckSelected: true,
          deck: { totalCards: 60, validation: readyValidation },
        },
      }),
      commandId: ready.commandId,
    });
    await waitFor(() => expect(screen.getByTestId('room-unready')).toBeEnabled());
  });

  it('换卡组立即撤销准备；双方准备后进入开局准备界面，返回首页不发认输/离开命令', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);
    await createRoom(user, fake);

    const waitingYour = {
      seat: 0 as const,
      occupied: true,
      host: true,
      nickname: '小智',
      ready: true,
      online: true,
      deckSelected: true,
      deck: { totalCards: 60, validation: readyValidation },
    };
    const opponentReady = {
      seat: 1 as const,
      occupied: true,
      host: false,
      nickname: '小茂',
      ready: true,
      online: true,
      deckSelected: true,
      deck: null,
    };
    fake.emit({ type: 'room', room: roomView({ version: 4, you: waitingYour, opponent: opponentReady }) });
    await screen.findByTestId('room-unready');

    // 换卡组：发送 select-deck，服务端返回 ready=false，界面回到未准备。
    await user.click(screen.getByTestId('room-select-deck-draft-b'));
    await waitFor(() => expect(fake.sent.filter((message) => message.type === 'select-deck').length).toBe(1));
    expect(fake.sent.filter((message) => message.type === 'select-deck').at(-1)).toMatchObject({
      type: 'select-deck',
      roomId: 'room-instance-1',
      expectedVersion: 4,
    });
    fake.emit({
      type: 'room',
      room: roomView({
        version: 5,
        you: { ...waitingYour, ready: false, deckSelected: true },
        opponent: opponentReady,
      }),
    });
    expect(await screen.findByTestId('room-ready')).toBeInTheDocument();
    expect(screen.getByTestId('room-self-ready')).toHaveTextContent('未准备');

    // 重新准备，双方就绪 → 唯一会话。
    await user.click(screen.getByTestId('room-ready'));
    fake.emit({
      type: 'room',
      room: roomView({
        version: 6,
        status: 'started',
        match: { sessionId: 'match-unique-1', version: 1 },
        you: waitingYour,
        opponent: opponentReady,
      }),
    });
    expect(await screen.findByTestId('match-screen')).toBeInTheDocument();
    // 对局视图到达前显示加载；选择权视图到达后提供明确选择入口。
    fake.emit({
      type: 'match',
      view: matchView({
        sessionId: 'match-unique-1',
        phase: 'turn-order',
        pendingChoice: { choiceId: 'choice-1', seat: 0, kind: 'turn-order', min: 1, max: 1, benchMin: 0, benchMax: 0, candidates: [] },
      }),
    });
    expect(await screen.findByTestId('match-go-first')).toBeInTheDocument();
    expect(screen.queryByTestId('room-ready')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-leave')).not.toBeInTheDocument();

    const sentBefore = fake.sent.length;
    await user.click(screen.getByTestId('match-back-home'));
    await screen.findByTestId('open-room');
    expect(screen.getByTestId('home-room-summary')).toHaveTextContent('对局已建立');
    expect(fake.sent.length).toBe(sentBefore);
    expect(fake.sent.some((message) => message.type === 'leave-room')).toBe(false);
  });

  it('未就绪卡组的准备请求显示服务端具体问题', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);
    await createRoom(user, fake);
    fake.emit({
      type: 'room',
      room: roomView({
        you: {
          seat: 0,
          occupied: true,
          host: true,
          nickname: '小智',
          ready: false,
          online: true,
          deckSelected: true,
          deck: {
            totalCards: 60,
            validation: {
              ...readyValidation,
              ready: false,
              problems: [{ code: 'effect-unsupported', kind: 'readiness', message: '1 种卡效果未接入，不能用于正式对战：古剑豹ex（csv3c-043）。', cardIds: ['csv3c-043'] }],
            },
          },
        },
      }),
    });
    await screen.findByTestId('room-deck-validation');
    await user.click(await screen.findByTestId('room-ready'));
    fake.emit({
      type: 'room-error',
      code: 'deck-not-ready',
      message: '卡组还不能用于正式对战，请根据校验结果调整。',
      validation: {
        ...readyValidation,
        ready: false,
        problems: [{ code: 'effect-unsupported', kind: 'readiness', message: '1 种卡效果未接入：古剑豹ex（csv3c-043）。', cardIds: ['csv3c-043'] }],
      },
    });
    expect(await screen.findByTestId('room-error')).toHaveTextContent('卡组还不能用于正式对战');
    expect(screen.getByTestId('room-error-problems')).toHaveTextContent('效果未接入');
  });

  it('过期命令被拒绝后按最新快照重新确认；本地选择高亮被清除', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);
    await createRoom(user, fake);
    fake.emit({ type: 'room', room: roomView({ version: 2 }) });
    await screen.findByTestId('room-code');

    await user.click(screen.getByTestId('room-select-deck-draft-a'));
    expect(fake.sent.filter((message) => message.type === 'select-deck').at(-1)).toMatchObject({
      type: 'select-deck',
      roomId: 'room-instance-1',
      expectedVersion: 2,
    });

    // 服务端拒绝过期命令并回传更新后的当前快照（版本 3，尚无卡组）。
    fake.emit({
      type: 'room-error',
      code: 'version-conflict',
      message: '房间状态已更新，请按最新状态重新确认。',
      room: roomView({ version: 3 }),
    });
    expect(await screen.findByTestId('room-error')).toHaveTextContent('最新状态');
    // 本地高亮不得继续冒充已确认的选择。
    expect(screen.getByTestId('room-select-deck-draft-a')).toHaveTextContent('选择这副卡组');

    await user.click(screen.getByTestId('room-select-deck-draft-a'));
    expect(fake.sent.filter((message) => message.type === 'select-deck').at(-1)).toMatchObject({
      type: 'select-deck',
      roomId: 'room-instance-1',
      expectedVersion: 3,
    });
  });

  it('旧房间实例的离开/关闭重放不会清空当前房间状态', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);
    await createRoom(user, fake);
    fake.emit({ type: 'room', room: roomView({ roomId: 'room-A', version: 4 }) });
    await screen.findByTestId('room-code');

    // 不同实例的关闭通知：忽略。
    fake.emit({ type: 'room-closed', roomId: 'room-B', code: '042000', version: 9, reason: 'host-left' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('room-code')).toBeInTheDocument();

    // 同一实例但版本更旧的离开重放：忽略。
    fake.emit({ type: 'room-left', roomId: 'room-A', code: '042000', version: 3, reason: 'left', commandId: 'old-leave' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('room-code')).toBeInTheDocument();

    // 属于当前状态之后的真实离开：生效。
    fake.emit({ type: 'room-left', roomId: 'room-A', code: '042000', version: 4, reason: 'left' });
    expect(await screen.findByTestId('room-left-notice')).toHaveTextContent('042000');
  });

  it('服务端断开后不再冒充房间可用：进入失败页并可返回设置', async () => {
    const { fake, user } = await renderRoomApp();
    await openRoom(user);
    await createRoom(user, fake);
    fake.emit({ type: 'room', room: roomView() });
    await screen.findByTestId('room-code');

    fake.emitClosed();
    await screen.findByRole('button', { name: '重试' });
    expect(screen.queryByTestId('room-code')).not.toBeInTheDocument();
  });
});
