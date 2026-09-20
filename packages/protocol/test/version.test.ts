import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_MAX_SUPPORTED,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  describeProtocolIncompatibility,
  isProtocolCompatible,
  supportedProtocolRange,
} from '../src/version.ts';

describe('协议版本契约', () => {
  it('当前实现版本落在声明支持区间内', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(PROTOCOL_MIN_SUPPORTED);
    expect(PROTOCOL_VERSION).toBeLessThanOrEqual(PROTOCOL_MAX_SUPPORTED);
    expect(supportedProtocolRange()).toEqual({ min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_MAX_SUPPORTED });
  });

  it('只接受区间内的整数版本', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolCompatible(PROTOCOL_MAX_SUPPORTED + 1)).toBe(false);
    expect(isProtocolCompatible(PROTOCOL_MIN_SUPPORTED - 1)).toBe(false);
    expect(isProtocolCompatible(1.5)).toBe(false);
    expect(isProtocolCompatible(Number.NaN)).toBe(false);
  });

  it('不兼容说明指出方向且不包含凭据类字眼', () => {
    const tooNew = describeProtocolIncompatibility(PROTOCOL_MAX_SUPPORTED + 1);
    const tooOld = describeProtocolIncompatibility(PROTOCOL_MIN_SUPPORTED - 1);
    expect(tooNew).toContain('请更新客户端');
    expect(tooOld).toContain('请更新服务');
    for (const text of [tooNew, tooOld]) {
      expect(text).not.toMatch(/secret|private|d=|凭据/iu);
    }
  });
});
