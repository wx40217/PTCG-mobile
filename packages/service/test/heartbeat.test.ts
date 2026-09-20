import { describe, expect, it } from 'vitest';
import {
  createHeartbeatWatchdog,
  heartbeatDetectionBoundMs,
  type HeartbeatTimers,
} from '../src/heartbeat.ts';

/**
 * 看门狗状态机的受控时钟测试（#15 半开连接活性）。
 *
 * 真实 socket 行为由 `matchRecovery.integration.test.ts` 与设备验收覆盖；这里
 * 精确固定 `intervalMs + pongTimeoutMs` 上界与 pong/stop 的重置语义。
 */
class ManualClock implements HeartbeatTimers {
  private current = 0;
  private readonly timers = new Map<object, { readonly at: number; readonly callback: () => void }>();

  public now(): number {
    return this.current;
  }

  public pending(): number {
    return this.timers.size;
  }

  public setTimer(callback: () => void, delayMs: number): object {
    const handle: object = {};
    this.timers.set(handle, { at: this.current + delayMs, callback });
    return handle;
  }

  public clearTimer(handle: unknown): void {
    if (handle !== null && typeof handle === 'object') {
      this.timers.delete(handle);
    }
  }

  /** 逐步推进到目标时刻，并在每个到期点先更新 now 再执行回调。 */
  public advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) {
        break;
      }
      this.timers.delete(due[0]);
      this.current = due[1].at;
      due[1].callback();
    }
    this.current = target;
  }
}

describe('WebSocket 心跳看门狗（#15）', () => {
  it('检测上界就是 interval + pongTimeout', () => {
    expect(heartbeatDetectionBoundMs(10_000, 10_000)).toBe(20_000);
    expect(heartbeatDetectionBoundMs(300, 300)).toBe(600);
  });

  it('无 pong 时恰好在 interval + pongTimeout 触发一次超时，之后不再 ping', () => {
    const clock = new ManualClock();
    const pings: number[] = [];
    const timeouts: number[] = [];
    const watchdog = createHeartbeatWatchdog({
      intervalMs: 1_000,
      pongTimeoutMs: 2_000,
      timers: clock,
      ping: () => {
        pings.push(clock.now());
        return true;
      },
      onTimeout: () => timeouts.push(clock.now()),
    });

    watchdog.start();
    clock.advance(999);
    expect(pings).toEqual([]);
    expect(timeouts).toEqual([]);

    clock.advance(1);
    expect(pings).toEqual([1_000]);
    expect(timeouts).toEqual([]);

    clock.advance(1_999);
    expect(timeouts).toEqual([]);
    expect(clock.pending()).toBe(1);

    clock.advance(1);
    expect(timeouts).toEqual([3_000]);
    expect(clock.pending()).toBe(0);

    clock.advance(60_000);
    expect(pings).toHaveLength(1);
    expect(timeouts).toHaveLength(1);
  });

  it('每次 pong 重置检测窗口；健康空闲不会触发超时', () => {
    const clock = new ManualClock();
    const pings: number[] = [];
    const timeouts: number[] = [];
    const watchdog = createHeartbeatWatchdog({
      intervalMs: 1_000,
      pongTimeoutMs: 2_000,
      timers: clock,
      ping: () => {
        pings.push(clock.now());
        return true;
      },
      onTimeout: () => timeouts.push(clock.now()),
    });

    watchdog.start();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      clock.advance(1_000);
      watchdog.notePong();
    }
    expect(pings).toEqual([1_000, 2_000, 3_000]);
    expect(timeouts).toEqual([]);

    // 最后一次 ping 没有 pong：到上界才超时。
    clock.advance(2_000);
    expect(pings).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(timeouts).toEqual([]);
    clock.advance(1_000);
    expect(timeouts).toEqual([6_000]);
  });

  it('stop 幂等；超时后迟到的 pong 不产生第二次影响', () => {
    const clock = new ManualClock();
    const pings: number[] = [];
    const timeouts: number[] = [];
    const watchdog = createHeartbeatWatchdog({
      intervalMs: 1_000,
      pongTimeoutMs: 1_000,
      timers: clock,
      ping: () => {
        pings.push(clock.now());
        return true;
      },
      onTimeout: () => timeouts.push(clock.now()),
    });

    watchdog.start();
    clock.advance(1_000);
    clock.advance(1_000);
    expect(timeouts).toEqual([2_000]);

    watchdog.notePong();
    watchdog.stop();
    watchdog.stop();
    clock.advance(60_000);
    expect(pings).toHaveLength(1);
    expect(timeouts).toHaveLength(1);
  });

  it('ping 返回 false（套接字已不可发送）时停止，且不误报超时', () => {
    const clock = new ManualClock();
    const timeouts: number[] = [];
    const watchdog = createHeartbeatWatchdog({
      intervalMs: 1_000,
      pongTimeoutMs: 1_000,
      timers: clock,
      ping: () => false,
      onTimeout: () => timeouts.push(clock.now()),
    });

    watchdog.start();
    clock.advance(1_000);
    expect(timeouts).toEqual([]);
    expect(clock.pending()).toBe(0);
    clock.advance(60_000);
    expect(timeouts).toEqual([]);
  });
});
