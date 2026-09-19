import { describe, expect, it } from 'vitest';
import { classifyTransportFailure, transportFailureSignal } from '../src/connectionFailure.ts';

/** 模拟 Capacitor 原生插件 reject 后的错误对象：message/code/data 三元组。 */
function capacitorError(message: string, code: string, data?: unknown): Error {
  const error = new Error(message) as Error & { code: string; data?: unknown };
  error.code = code;
  if (data !== undefined) {
    error.data = data;
  }
  return error;
}

describe('传输错误信号归一化', () => {
  it('保留 Error 的 name/message/code 并递归 cause', () => {
    const cause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const signal = transportFailureSignal(new Error('fetch failed', { cause }));
    expect(signal.message).toBe('fetch failed');
    expect(signal.cause?.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('Capacitor 插件错误（Error + code）被识别为证书问题', () => {
    const signal = transportFailureSignal(
      capacitorError('Trust anchor for certification path not found.', 'SSLHandshakeException'),
    );
    expect(signal.message).toContain('Trust anchor');
    expect(signal.code).toBe('SSLHandshakeException');
    expect(classifyTransportFailure(signal)).toBe('certificate');
  });

  it('Android 异常文本藏在 data 字段时也能分类', () => {
    const signal = transportFailureSignal(
      capacitorError('网络请求失败', 'ConnectException', {
        message: 'javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.',
      }),
    );
    expect(signal.cause?.message).toContain('CertPathValidatorException');
    expect(classifyTransportFailure(signal)).toBe('certificate');
  });

  it('普通对象错误不会被压成 [object Object] 而丢失证书证据', () => {
    const signal = transportFailureSignal({
      message: 'Certificate expired',
      code: 'CERT_HAS_EXPIRED',
    });
    expect(signal.message).toBe('Certificate expired');
    expect(classifyTransportFailure(signal)).toBe('certificate');
  });

  it('非结构化错误退回字符串描述', () => {
    expect(transportFailureSignal('boom').message).toBe('boom');
    expect(transportFailureSignal(42).message).toBe('42');
    expect(transportFailureSignal(undefined)).toEqual({});
  });

  it('最多递归四层，且循环引用不会死循环', () => {
    const loop: Record<string, unknown> = { message: 'loop' };
    loop['cause'] = loop;
    expect(() => transportFailureSignal(loop)).not.toThrow();
    expect(transportFailureSignal(loop).message).toBe('loop');
  });
});

describe('连接失败分类', () => {
  it('把 Android/Java 的 TLS 异常识别为证书问题', () => {
    expect(
      classifyTransportFailure({
        message: 'javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.',
      }),
    ).toBe('certificate');
    expect(classifyTransportFailure({ message: 'java.security.cert.CertificateException: self-signed certificate' })).toBe(
      'certificate',
    );
  });

  it('把 Node/undici 的证书错误码识别为证书问题（含嵌套 cause）', () => {
    expect(
      classifyTransportFailure({
        message: 'fetch failed',
        cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' },
      }),
    ).toBe('certificate');
    expect(classifyTransportFailure({ cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })).toBe('certificate');
    expect(classifyTransportFailure({ code: 'ERR_CERT_HAS_EXPIRED' })).toBe('certificate');
  });

  it('把连接被拒、DNS 失败与超时识别为不可达', () => {
    expect(
      classifyTransportFailure({ message: 'fetch failed', cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8787' } }),
    ).toBe('unreachable');
    expect(classifyTransportFailure({ message: 'java.net.ConnectException: Connection refused' })).toBe('unreachable');
    expect(classifyTransportFailure({ message: 'java.net.UnknownHostException: ptcg.local' })).toBe('unreachable');
    expect(classifyTransportFailure({ cause: { code: 'ENOTFOUND' } })).toBe('unreachable');
    expect(classifyTransportFailure({ message: 'java.net.SocketTimeoutException: timeout' })).toBe('unreachable');
    expect(classifyTransportFailure({ name: 'AbortError', message: 'The operation was aborted.' })).toBe('unreachable');
  });

  it('浏览器不透明的网络错误退回不可达，不臆断为证书问题', () => {
    expect(classifyTransportFailure({ name: 'TypeError', message: 'Failed to fetch' })).toBe('unreachable');
    expect(classifyTransportFailure({ name: 'NetworkError', message: 'NetworkError when attempting to fetch resource.' })).toBe(
      'unreachable',
    );
  });

  it('空信号与未知信号一律退回不可达', () => {
    expect(classifyTransportFailure({})).toBe('unreachable');
    expect(classifyTransportFailure({ message: 'something odd happened' })).toBe('unreachable');
  });

  it('证书证据优先于不可达证据（TLS 失败同时含连接字眼）', () => {
    expect(
      classifyTransportFailure({
        message: 'connect failed: TLS handshake failed because of certificate',
      }),
    ).toBe('certificate');
  });
});
