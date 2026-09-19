/** 敏感字段名：出现即整体替换，绝不落盘。 */
const SENSITIVE_KEY = /^(d|secret|signature|proof|credential|recovery|privatekey|private_key|recoverysecret|token)$/iu;

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface ServiceLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const REDACTED = '[redacted]';

/**
 * 递归脱敏。
 *
 * 服务端在设计上不会收到设备私钥，但日志管道必须自己兜底：任何名为 d/secret/
 * signature 的字段一律替换，避免上游实现失误时把凭据写进日志。
 */
export function redactFields(fields: LogFields, depth = 0): LogFields {
  if (depth > 4) {
    return {};
  }
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        typeof item === 'object' && item !== null ? redactFields(item as LogFields, depth + 1) : item,
      );
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      out[key] = redactFields(value as LogFields, depth + 1);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function serialize(level: LogLevel, event: string, fields: LogFields): string {
  return JSON.stringify({ level, event, ...redactFields(fields) });
}

export function createLogger(sink: (line: string) => void, now: () => number = Date.now): ServiceLogger {
  const emit = (level: LogLevel) => (event: string, fields: LogFields = {}) => {
    sink(serialize(level, event, { at: new Date(now()).toISOString(), ...fields }));
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export function createSilentLogger(): ServiceLogger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop };
}
