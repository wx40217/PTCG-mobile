import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectResult,
  ConnectionClosedEvent,
  ConnectionFailure,
  DeviceIdentity,
  LiveConnection,
  ServiceAddressPolicy,
} from '@ptcg/protocol';
import { App } from '../src/App.tsx';
import type { ConnectFn } from '../src/connection/connection.ts';
import { createMemoryProfileStore, type ProfileStore } from '../src/storage/profileStore.ts';
import type { BackButtonSource } from '../src/app/backButton.ts';

const DEV_POLICY: ServiceAddressPolicy = { allowInsecure: true };
const RELEASE_POLICY: ServiceAddressPolicy = { allowInsecure: false };

/**
 * 可手动触发断线的连接替身。
 *
 * `close()` 与真实协议一致：只标记终止、不发出 onClosed；`emitClosed()` 用来
 * 模拟「服务端断开」这类非预期终止。
 */
function fakeConnection(nickname: string, deviceId: string): {
  readonly connection: LiveConnection;
  readonly closeCount: () => number;
  readonly emitClosed: (event?: ConnectionClosedEvent) => void;
} {
  const listeners = new Set<(event: ConnectionClosedEvent) => void>();
  let closed = false;
  let closeCount = 0;
  const connection: LiveConnection = {
    session: {
      protocolVersion: 1,
      serverVersion: '0.1.0',
      sessionId: 'session-1',
      deviceId,
      nickname,
      registered: true,
    },
    get closed() {
      return closed;
    },
    onClosed(listener) {
      if (closed) {
        queueMicrotask(() => listener({ kind: 'disconnected' }));
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      closeCount += 1;
    },
  };
  return {
    connection,
    closeCount: () => closeCount,
    emitClosed(event = { kind: 'disconnected' }) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

function successResult(nickname: string, deviceId: string): ConnectResult {
  return { ok: true, connection: fakeConnection(nickname, deviceId).connection };
}

function failResult(failure: ConnectionFailure): ConnectResult {
  return { ok: false, failure };
}

interface RenderOptions {
  connect?: ConnectFn;
  store?: ProfileStore;
  policy?: ServiceAddressPolicy;
  defaultServiceAddress?: string;
  backButton?: BackButtonSource;
}

async function renderApp(options: RenderOptions = {}) {
  const store = options.store ?? createMemoryProfileStore();
  const connect = options.connect ?? (async () => failResult({ kind: 'unreachable', message: '默认失败' }));
  const view = render(
    <App
      dependencies={{
        store,
        connect,
        policy: options.policy ?? DEV_POLICY,
        defaultServiceAddress: options.defaultServiceAddress ?? '',
        ...(options.backButton === undefined ? {} : { backButton: options.backButton }),
      }}
    />,
  );
  await screen.findByLabelText('昵称（仅用于显示）');
  return { store, connect, unmount: view.unmount };
}

async function fillProfile(user: ReturnType<typeof userEvent.setup>, nickname: string, address: string) {
  const nicknameInput = screen.getByLabelText('昵称（仅用于显示）');
  await user.clear(nicknameInput);
  await user.type(nicknameInput, nickname);
  const addressInput = screen.getByLabelText('服务地址');
  await user.clear(addressInput);
  await user.type(addressInput, address);
}

async function connectFromSettings(user: ReturnType<typeof userEvent.setup>, nickname: string, address: string) {
  await fillProfile(user, nickname, address);
  await user.click(screen.getByRole('button', { name: '保存并连接' }));
}

describe('干净启动进入设置', () => {
  it('未连接任何服务时也能渲染设置页并生成本机身份', async () => {
    await renderApp();
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument();
    expect(screen.getByLabelText('设备身份')).toBeInTheDocument();
    const deviceId = await screen.findByTestId('device-id');
    expect(deviceId.textContent).toMatch(/^dev_/u);
  });

  it('正式配置下不预填任何服务地址', async () => {
    await renderApp({ policy: RELEASE_POLICY, defaultServiceAddress: '' });
    expect(screen.getByLabelText('服务地址')).toHaveValue('');
    expect(screen.getByText(/只允许 https\/wss/u)).toBeInTheDocument();
  });

  it('本地输入不合法时不发起连接', async () => {
    const connect = vi.fn<ConnectFn>();
    const user = userEvent.setup();
    await renderApp({ connect: connect as unknown as ConnectFn });
    await user.click(screen.getByRole('button', { name: '保存并连接' }));
    expect(connect).not.toHaveBeenCalled();
    expect(screen.getByText(/昵称需为 1-24 个字符/u)).toBeInTheDocument();
  });
});

describe('有效恢复身份与兼容版本', () => {
  it('连接成功后进入已连接首页并显示昵称', async () => {
    const user = userEvent.setup();
    let captured: DeviceIdentity | undefined;
    const connect: ConnectFn = async (input) => {
      captured = input.identity;
      return successResult('小智', input.identity.deviceId);
    };
    await renderApp({ connect });

    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');

    const nickname = await screen.findByTestId('home-nickname');
    expect(nickname).toHaveTextContent('小智');
    expect(screen.getByTestId('home-device-id')).toHaveTextContent(captured!.deviceId);
    expect(screen.getByText(/已连接/u)).toBeInTheDocument();
  });

  it('重启后保留昵称、地址与设备身份', async () => {
    const user = userEvent.setup();
    const store = createMemoryProfileStore();
    const connect: ConnectFn = async (input) => successResult('小智', input.identity.deviceId);

    const first = await renderApp({ connect, store });
    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    await screen.findByTestId('home-nickname');
    const deviceId = screen.getByTestId('home-device-id').textContent ?? '';
    first.unmount();

    await renderApp({ connect, store });
    expect(screen.getByLabelText('昵称（仅用于显示）')).toHaveValue('小智');
    expect(await screen.findByTestId('device-id')).toHaveTextContent(deviceId);
  });
});

describe('连接失败 UI 流程', () => {
  const cases: ReadonlyArray<{ kind: ConnectionFailure['kind']; expected: RegExp }> = [
    { kind: 'unreachable', expected: /无法连接服务/u },
    { kind: 'certificate', expected: /证书无法验证/u },
    { kind: 'incompatible', expected: /协议不兼容/u },
    { kind: 'identity-rejected', expected: /设备身份被拒绝/u },
    { kind: 'invalid-address', expected: /地址无法使用/u },
  ];

  for (const { kind, expected } of cases) {
    it(`${kind} 显示专属说明且可返回设置，不出现空白页`, async () => {
      const user = userEvent.setup();
      const connect: ConnectFn = async () => failResult({ kind, message: `测试原因：${kind}` });
      await renderApp({ connect });

      await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(expected);
      expect(screen.getByTestId('failure-detail')).toHaveTextContent(`测试原因：${kind}`);

      await user.click(screen.getByRole('button', { name: '返回设置' }));
      expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument();
      // 失败原因对用户可见，且表单值没有被清空。
      expect(screen.getByLabelText('服务地址')).toHaveValue('http://192.168.1.8:8787');
    });
  }

  it('协议不兼容会说明服务端支持区间', async () => {
    const user = userEvent.setup();
    const connect: ConnectFn = async () =>
      failResult({ kind: 'incompatible', message: '版本不一致', supported: { min: 2, max: 3 } });
    await renderApp({ connect });
    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    expect(await screen.findByTestId('failure-detail')).toHaveTextContent('服务端支持协议版本 2-3');
  });

  it('重试会再次发起连接并可成功', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const connect: ConnectFn = async (input) => {
      calls += 1;
      return calls === 1
        ? failResult({ kind: 'unreachable', message: '第一次失败' })
        : successResult('小智', input.identity.deviceId);
    };
    await renderApp({ connect });
    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('home-nickname')).toHaveTextContent('小智');
    expect(calls).toBe(2);
  });

  it('正式配置下拒绝明文地址且不发起网络请求', async () => {
    const connect = vi.fn<ConnectFn>();
    const user = userEvent.setup();
    await renderApp({ policy: RELEASE_POLICY, connect: connect as unknown as ConnectFn });
    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    expect(connect).not.toHaveBeenCalled();
    expect(screen.getByText(/明文地址仅限开发调试使用/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument();
  });
});

describe('连接生命周期', () => {
  it('服务端断开后首页切到「连接已断开」，并可重试成功', async () => {
    const user = userEvent.setup();
    let fake: ReturnType<typeof fakeConnection> | undefined;
    let calls = 0;
    const connect: ConnectFn = async (input) => {
      calls += 1;
      fake = fakeConnection(calls === 1 ? '小智' : '小茂', input.identity.deviceId);
      return { ok: true, connection: fake.connection };
    };
    await renderApp({ connect });
    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    await screen.findByTestId('home-nickname');

    fake!.emitClosed();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/连接已断开/u);
    // 首页不应再显示「已连接」。
    expect(screen.queryByText(/已连接/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('home-nickname')).toHaveTextContent('小茂');
    expect(calls).toBe(2);
  });

  it('返回设置会主动关闭连接，且不弹出故障页', async () => {
    const user = userEvent.setup();
    let fake: ReturnType<typeof fakeConnection> | undefined;
    const connect: ConnectFn = async (input) => {
      fake = fakeConnection('小智', input.identity.deviceId);
      return { ok: true, connection: fake.connection };
    };
    await renderApp({ connect });
    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    await screen.findByTestId('home-nickname');

    await user.click(screen.getByRole('button', { name: '返回设置' }));
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument();
    const first = fake!;
    expect(first.closeCount()).toBe(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // 重新连接会替换旧连接；旧连接已经关闭且不会再次计数。
    await user.click(screen.getByRole('button', { name: '保存并连接' }));
    expect(first.closeCount()).toBe(1);
    expect(fake!.closeCount()).toBe(0);
  });

  it('组件卸载会释放连接', async () => {
    const user = userEvent.setup();
    let fake: ReturnType<typeof fakeConnection> | undefined;
    const connect: ConnectFn = async (input) => {
      fake = fakeConnection('小智', input.identity.deviceId);
      return { ok: true, connection: fake.connection };
    };
    const app = await renderApp({ connect });
    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    await screen.findByTestId('home-nickname');

    app.unmount();
    expect(fake!.closeCount()).toBe(1);
  });

  it('本机资料读取失败时仍进入设置页并显示错误，而不是空白页', async () => {
    const failingStore: ProfileStore = {
      read: async () => {
        throw new Error('存储不可用');
      },
      write: async () => undefined,
    };
    await renderApp({ store: failingStore });

    expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/无法读取本机身份资料/u);
    // 身份不可用时连接按钮应禁用，避免无反馈的点击。
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeDisabled();
  });

  it('过期连接的断开事件不会影响新会话', async () => {
    const user = userEvent.setup();
    const fakes: Array<ReturnType<typeof fakeConnection>> = [];
    const connect: ConnectFn = async (input) => {
      const fake = fakeConnection(fakes.length === 0 ? '小智' : '小茂', input.identity.deviceId);
      fakes.push(fake);
      return { ok: true, connection: fake.connection };
    };
    await renderApp({ connect });

    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    await screen.findByTestId('home-nickname');
    await user.click(screen.getByRole('button', { name: '返回设置' }));

    await connectFromSettings(user, '小茂', 'http://192.168.1.8:8787');
    expect(await screen.findByTestId('home-nickname')).toHaveTextContent('小茂');

    // 旧连接迟到的断线事件不得把界面切到失败页。
    fakes[0]!.emitClosed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('home-nickname')).toHaveTextContent('小茂');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Android 返回键', () => {
  function fakeBackButton(): { source: BackButtonSource; press: () => void } {
    let handler: (() => void) | undefined;
    return {
      source: {
        subscribe(next) {
          handler = next;
          return () => {
            handler = undefined;
          };
        },
      },
      press: () => handler?.(),
    };
  }

  it('已连接页按返回键回到设置而不是退出，并释放连接', async () => {
    const user = userEvent.setup();
    const back = fakeBackButton();
    let fake: ReturnType<typeof fakeConnection> | undefined;
    const connect: ConnectFn = async (input) => {
      fake = fakeConnection('小智', input.identity.deviceId);
      return { ok: true, connection: fake.connection };
    };
    await renderApp({ connect, backButton: back.source });

    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    await screen.findByTestId('home-nickname');

    back.press();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument();
    });
    expect(fake!.closeCount()).toBe(1);
  });

  it('失败页按返回键回到设置', async () => {
    const user = userEvent.setup();
    const back = fakeBackButton();
    const connect: ConnectFn = async () => failResult({ kind: 'unreachable', message: '离线' });
    await renderApp({ connect, backButton: back.source });

    await connectFromSettings(user, '小智', 'http://192.168.1.8:8787');
    await screen.findByRole('alert');

    back.press();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument();
    });
  });
});
