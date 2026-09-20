/**
 * 服务端 WebSocket 半开连接活性看门狗（#15）。
 *
 * 断网、掉电或 NAT/运营商路径失效可能让 TCP 连接进入半开状态：对端已经不可达，
 * 但服务端收不到 FIN/RST，`close` 事件永远不来。只依赖 `close` 时，座位会被一直
 * 视为在线，断线预算也不会开始。WebSocket 协议层的 ping/pong 是不依赖任何业务
 * 消息、也不依赖前端主动上报的活性判据；浏览器 WebView 与 `ws` 客户端都会自动
 * 回 pong，因此客户端业务代码无需改动。
 *
 * 检测上界：启动后 `intervalMs` 发一次 ping；收到 pong 后重新按 `intervalMs`
 * 安排下一次。若一次 ping 之后 `pongTimeoutMs` 内没有 pong，就判为无响应。
 * 最坏情况是断链恰好发生在一次 pong 之后：下一次 ping 在 `intervalMs` 后发出，
 * 再过 `pongTimeoutMs` 判定超时，因此从真实断链到服务端登记的检测延迟不超过
 * `intervalMs + pongTimeoutMs`。调用方在超时回调里走现有幂等 detach 登记离线，
 * 预算从登记时刻开始，故实际断网时长中最多 `intervalMs + pongTimeoutMs` 不计入。
 */
export interface HeartbeatTimers {
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_HEARTBEAT_PONG_TIMEOUT_MS = 10_000;

/** 从真实断链到看门狗判定的最坏延迟上界。 */
export function heartbeatDetectionBoundMs(intervalMs: number, pongTimeoutMs: number): number {
  return intervalMs + pongTimeoutMs;
}

export interface HeartbeatWatchdogOptions {
  readonly intervalMs: number;
  readonly pongTimeoutMs: number;
  /** 发送一次 ping；返回 false 表示底层已不可发送，看门狗自行停止。 */
  readonly ping: () => boolean;
  /** 判定无响应：调用方必须终止套接字并执行幂等清理。 */
  readonly onTimeout: () => void;
  readonly timers?: HeartbeatTimers;
}

export interface HeartbeatWatchdog {
  /** 启动心跳；重复调用无操作。 */
  start(): void;
  /** 收到 pong：重置检测窗口并安排下一次 ping；未启动/已停止时无操作。 */
  notePong(): void;
  /** 停止并清理全部定时器；幂等，超时路径与 close 路径可先后调用。 */
  stop(): void;
}

const DEFAULT_TIMERS: HeartbeatTimers = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function createHeartbeatWatchdog(options: HeartbeatWatchdogOptions): HeartbeatWatchdog {
  const timers = options.timers ?? DEFAULT_TIMERS;
  let active = false;
  let pingTimer: unknown = null;
  let pongTimer: unknown = null;

  const clearPingTimer = (): void => {
    if (pingTimer !== null) {
      timers.clearTimer(pingTimer);
      pingTimer = null;
    }
  };

  const clearPongTimer = (): void => {
    if (pongTimer !== null) {
      timers.clearTimer(pongTimer);
      pongTimer = null;
    }
  };

  const stop = (): void => {
    active = false;
    clearPingTimer();
    clearPongTimer();
  };

  const schedulePing = (): void => {
    pingTimer = timers.setTimer(sendPing, options.intervalMs);
  };

  function sendPing(): void {
    pingTimer = null;
    if (!active) {
      return;
    }
    let sent = false;
    try {
      sent = options.ping();
    } catch {
      sent = false;
    }
    if (!sent) {
      // 底层已不可发送（例如连接正在关闭）：立刻停止，不制造假的超时事件。
      stop();
      return;
    }
    pongTimer = timers.setTimer(() => {
      pongTimer = null;
      if (!active) {
        return;
      }
      stop();
      options.onTimeout();
    }, options.pongTimeoutMs);
  }

  return {
    start(): void {
      if (active) {
        return;
      }
      active = true;
      schedulePing();
    },
    notePong(): void {
      if (!active) {
        return;
      }
      clearPongTimer();
      clearPingTimer();
      schedulePing();
    },
    stop,
  };
}
