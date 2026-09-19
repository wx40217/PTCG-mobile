/**
 * 连接失败的分类契约。
 *
 * 客户端必须让用户区分「服务不可达」「证书问题」「协议不兼容」三类原因，
 * 因为它们的处置方式不同：换地址、检查证书、升级另一端。
 *
 * 分类输入是传输层给出的原始信号（错误名/错误码/错误文本）。不同平台的信号
 * 形态不同：Node/undici 用 `code`；Android WebView 原生 HTTP 会把 Java 异常
 * 类名带进消息；浏览器只有不透明的 `Failed to fetch`。
 */
export type TransportFailureKind = 'unreachable' | 'certificate';

export interface TransportFailureSignal {
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
  /** 递归的 cause 文本，例如 Node fetch 把真实原因放在 cause.code。 */
  readonly cause?: TransportFailureSignal;
}

const CERTIFICATE_PATTERNS: readonly RegExp[] = [
  /certpathvalidator/iu,
  /certificate/iu,
  /certn(?:ot)?yetvalid/iu,
  /certexpired/iu,
  /ss(?:l|handshake)exception/iu,
  /sslhandshake/iu,
  /sslpeerunverified/iu,
  /sslcertificate/iu,
  /trust\s*anchor/iu,
  /self[-\s]?signed/iu,
  /x509/iu,
  /hostname\s*mismatch/iu,
  /\btls\b/iu,
  /err_cert/iu,
  /unable_to_verify_leaf_signature/iu,
  /depth_zero_self_signed_cert/iu,
  /cert_(?:has_expired|untrusted|revoked|invalid)/iu,
];

const UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /econnrefused/iu,
  /econnreset/iu,
  /enotfound/iu,
  /eai_again/iu,
  /etimedout/iu,
  /ehostunreach/iu,
  /enetunreach/iu,
  /connectexception/iu,
  /connecttimeoutexception/iu,
  /unknownhostexception/iu,
  /sockettimeoutexception/iu,
  /nosuchhost/iu,
  /network\s*is\s*unreachable/iu,
  /failed\s*to\s*fetch/iu,
  /networkerror/iu,
  /err_(?:connection|name|address|internet|network|empty)/iu,
  /aborted?/iu,
  /time(?:d)?\s*out/iu,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SIGNAL_DEPTH_LIMIT = 4;

/**
 * 把任意平台的错误对象归一化成分类信号。
 *
 * 平台形态差异很大：Node/undici 用 `Error.cause.code`；浏览器只有不透明的
 * `TypeError`/`NetworkError`；Android 原生插件（Capacitor）会 reject 一个带
 * `message`/`code`/`data` 的错误对象，`data` 里才可能有 Java 异常文本。
 *
 * 这里保证两件事：
 * 1. 结构化错误不会被压成 `"[object Object]"`，从而丢掉证书证据；
 * 2. 递归提取 `cause`/`data`，让嵌套的 TLS 异常文本参与分类。
 */
export function transportFailureSignal(error: unknown, depth = 0): TransportFailureSignal {
  if (depth > SIGNAL_DEPTH_LIMIT || error === undefined || error === null) {
    return {};
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  const record: Record<string, unknown> = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        code: (error as { code?: unknown }).code,
        cause: (error as { cause?: unknown }).cause,
        data: (error as { data?: unknown }).data,
      }
    : isRecord(error)
      ? error
      : { message: String(error) };

  const signal: { name?: string; message?: string; code?: string; cause?: TransportFailureSignal } = {};
  if (typeof record['name'] === 'string') {
    signal.name = record['name'];
  }
  if (typeof record['message'] === 'string') {
    signal.message = record['message'];
  }
  if (typeof record['code'] === 'string') {
    signal.code = record['code'];
  }

  const nestedSource =
    record['cause'] !== undefined && record['cause'] !== error
      ? record['cause']
      : record['data'] !== undefined && record['data'] !== error
        ? record['data']
        : undefined;
  if (nestedSource !== undefined) {
    const nested = transportFailureSignal(nestedSource, depth + 1);
    if (
      nested.name !== undefined ||
      nested.message !== undefined ||
      nested.code !== undefined ||
      nested.cause !== undefined
    ) {
      signal.cause = nested;
    }
  }
  return signal;
}

function collect(signal: TransportFailureSignal | undefined, depth = 0): string[] {
  if (signal === undefined || depth > 4) {
    return [];
  }
  const parts: string[] = [];
  for (const value of [signal.code, signal.name, signal.message]) {
    if (typeof value === 'string' && value.length > 0) {
      parts.push(value);
    }
  }
  parts.push(...collect(signal.cause, depth + 1));
  return parts;
}

function matchesAny(patterns: readonly RegExp[], haystack: string): boolean {
  return patterns.some((pattern) => pattern.test(haystack));
}

/**
 * 把传输层错误归类。
 *
 * 只有当信号里出现明确的证书/TLS 证据时才判定为 `certificate`；否则一律退回
 * `unreachable`，避免把网络故障误报成证书问题。
 */
export function classifyTransportFailure(signal: TransportFailureSignal): TransportFailureKind {
  const parts = collect(signal);
  if (parts.length === 0) {
    return 'unreachable';
  }
  const haystack = parts.join(' | ');
  if (matchesAny(CERTIFICATE_PATTERNS, haystack)) {
    return 'certificate';
  }
  if (matchesAny(UNREACHABLE_PATTERNS, haystack)) {
    return 'unreachable';
  }
  return 'unreachable';
}
