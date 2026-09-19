import {
  connectToService,
  fetchHealthProbe,
  parseServiceAddress,
  transportFailureSignal,
  type ConnectResult,
  type DeviceIdentity,
  type HealthProbe,
  type ProbeOutcome,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';

export interface ConnectInput {
  readonly serviceAddress: string;
  readonly nickname: string;
  readonly identity: DeviceIdentity;
}

export type ConnectFn = (input: ConnectInput, policy: ServiceAddressPolicy) => Promise<ConnectResult>;

export interface ConnectorDependencies {
  readonly probe?: HealthProbe;
  readonly timeoutMs?: number;
}

/**
 * 原生端健康检查。
 *
 * Android WebView 里 fetch 只会给出不透明的失败，无法区分证书与网络问题；
 * Capacitor 的原生 HTTP 会把 Java 异常类名带回，从而让分类可靠。
 * Web 上没有原生层时退回 fetch 实现。
 */
export async function createNativeHealthProbe(): Promise<HealthProbe> {
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) {
    return fetchHealthProbe;
  }
  const { CapacitorHttp } = await import('@capacitor/core');
  return async (url, timeoutMs): Promise<ProbeOutcome> => {
    try {
      const response = await CapacitorHttp.request({
        url: url.toString(),
        method: 'GET',
        headers: { accept: 'application/json' },
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      const payload = typeof response.data === 'string' ? safeJson(response.data) : response.data;
      const { parseHealthPayload } = await import('@ptcg/protocol');
      const parsed = parseHealthPayload(payload);
      if (parsed === null || response.status !== 200) {
        return { kind: 'http-error', status: response.status };
      }
      return { kind: 'ok', payload: parsed };
    } catch (error) {
      return { kind: 'transport-error', signal: transportFailureSignal(error) };
    }
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 真实连接器：先解析地址（含明文策略），再做健康检查与身份握手。
 *
 * 地址不合法时不会发起任何网络请求，界面可以直接指出该改哪一项。
 */
export function createServiceConnector(dependencies: ConnectorDependencies = {}): ConnectFn {
  let probePromise: Promise<HealthProbe> | undefined;

  return async (input, policy) => {
    const address = parseServiceAddress(input.serviceAddress, policy);
    if (!address.ok) {
      return {
        ok: false,
        failure: { kind: 'invalid-address', message: address.message },
      };
    }
    probePromise ??= createNativeHealthProbe();
    const probe = dependencies.probe ?? (await probePromise);

    return connectToService(
      {
        httpUrl: address.httpUrl,
        wsUrl: address.wsUrl,
        identity: input.identity,
        nickname: input.nickname,
      },
      dependencies.timeoutMs === undefined ? { probe } : { probe, timeoutMs: dependencies.timeoutMs },
    );
  };
}
