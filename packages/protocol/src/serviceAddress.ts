/**
 * 服务地址解析与传输安全策略。
 *
 * 发布配置只允许 HTTPS/WSS；局域网明文只在开发配置中允许。正式包不得内置
 * localhost 之类的默认地址，因此默认值由调用方按构建模式显式传入。
 */

export interface ServiceAddressPolicy {
  /** 是否允许 http/ws 明文（仅开发配置应为 true）。 */
  readonly allowInsecure: boolean;
}

export type ServiceAddressProblem =
  | 'empty'
  | 'unparsable'
  | 'unsupported-scheme'
  | 'missing-host'
  | 'insecure-not-allowed';

export type ServiceAddressResult =
  | {
      readonly ok: true;
      /** 归一化后的 HTTP(S) 基地址，始终以 `/` 结尾。 */
      readonly base: URL;
      readonly httpUrl: URL;
      readonly wsUrl: URL;
      readonly insecure: boolean;
    }
  | { readonly ok: false; readonly problem: ServiceAddressProblem; readonly message: string };

const PROBLEM_MESSAGES: Record<ServiceAddressProblem, string> = {
  empty: '请填写服务地址。',
  unparsable: '地址格式无法解析，请检查是否写错端口或有多余字符。',
  'unsupported-scheme': '只支持 http、https、ws、wss 四种协议。',
  'missing-host': '地址缺少主机名。',
  'insecure-not-allowed': '正式版本只允许 https/wss。明文地址仅限开发调试使用。',
};

function fail(problem: ServiceAddressProblem): ServiceAddressResult {
  return { ok: false, problem, message: PROBLEM_MESSAGES[problem] };
}

/**
 * 解析用户输入的服务地址。
 *
 * - 未写协议时按策略补全：开发用 http，发布用 https。
 * - `ws://` / `wss://` 会被归一化为对应的 `http://` / `https://` 基地址。
 * - 保留用户填写的路径前缀，便于反向代理下的部署。
 */
export function parseServiceAddress(raw: string, policy: ServiceAddressPolicy): ServiceAddressResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fail('empty');
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed);
  const candidate = hasScheme ? trimmed : `${policy.allowInsecure ? 'http' : 'https'}://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return fail('unparsable');
  }

  const scheme = parsed.protocol.toLowerCase();
  let normalizedScheme: 'http:' | 'https:';
  switch (scheme) {
    case 'http:':
    case 'ws:':
      normalizedScheme = 'http:';
      break;
    case 'https:':
    case 'wss:':
      normalizedScheme = 'https:';
      break;
    default:
      return fail('unsupported-scheme');
  }

  if (parsed.hostname.length === 0) {
    return fail('missing-host');
  }

  const insecure = normalizedScheme === 'http:';
  if (insecure && !policy.allowInsecure) {
    return fail('insecure-not-allowed');
  }

  const base = new URL(parsed.toString());
  base.protocol = normalizedScheme;
  base.hash = '';
  base.search = '';
  if (!base.pathname.endsWith('/')) {
    base.pathname = `${base.pathname}/`;
  }

  const httpUrl = new URL(base.toString());
  const wsUrl = new URL(base.toString());
  wsUrl.protocol = normalizedScheme === 'https:' ? 'wss:' : 'ws:';

  return { ok: true, base, httpUrl, wsUrl, insecure };
}

export function joinPath(base: URL, path: string): URL {
  const relative = path.startsWith('/') ? path.slice(1) : path;
  return new URL(relative, base);
}
