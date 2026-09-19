import { describe, expect, it } from 'vitest';
import { classifyTransportFailure } from '../src/connectionFailure.ts';

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
