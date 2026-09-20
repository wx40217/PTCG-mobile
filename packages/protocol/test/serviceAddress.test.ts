import { describe, expect, it } from 'vitest';
import { parseServiceAddress } from '../src/serviceAddress.ts';

const dev = { allowInsecure: true };
const release = { allowInsecure: false };

describe('服务地址解析与传输安全策略', () => {
  it('未写协议时按构建模式补全', () => {
    const inDev = parseServiceAddress('192.168.1.8:8787', dev);
    expect(inDev.ok).toBe(true);
    if (inDev.ok) {
      expect(inDev.httpUrl.protocol).toBe('http:');
      expect(inDev.wsUrl.protocol).toBe('ws:');
      expect(inDev.insecure).toBe(true);
    }

    const inRelease = parseServiceAddress('ptcg.example.com', release);
    expect(inRelease.ok).toBe(true);
    if (inRelease.ok) {
      expect(inRelease.httpUrl.protocol).toBe('https:');
      expect(inRelease.wsUrl.protocol).toBe('wss:');
      expect(inRelease.insecure).toBe(false);
    }
  });

  it('发布配置拒绝明文地址，开发配置允许', () => {
    const rejected = parseServiceAddress('http://192.168.1.8:8787', release);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.problem).toBe('insecure-not-allowed');
    }
    expect(parseServiceAddress('http://192.168.1.8:8787', dev).ok).toBe(true);

    const wsRejected = parseServiceAddress('ws://192.168.1.8:8787', release);
    expect(wsRejected.ok).toBe(false);
  });

  it('ws/wss 归一化为 http/https 基地址', () => {
    const result = parseServiceAddress('wss://ptcg.example.com:9443/room-a', release);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.base.protocol).toBe('https:');
      expect(result.httpUrl.pathname).toBe('/room-a/');
      expect(result.wsUrl.pathname).toBe('/room-a/');
      expect(result.wsUrl.protocol).toBe('wss:');
    }
  });

  it('保留路径前缀并统一以斜杠结尾，便于反向代理部署', () => {
    const result = parseServiceAddress('https://example.com/ptcg', release);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.base.pathname).toBe('/ptcg/');
    }
    const root = parseServiceAddress('https://example.com', release);
    expect(root.ok).toBe(true);
    if (root.ok) {
      expect(root.base.pathname).toBe('/');
    }
  });

  it('丢弃查询串与片段，避免把界面噪声带进连接', () => {
    const result = parseServiceAddress('https://example.com:8443/base?token=1#frag', release);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.base.search).toBe('');
      expect(result.base.hash).toBe('');
      expect(result.base.pathname).toBe('/base/');
    }
  });

  it('拒绝空值、非法格式与不支持的协议', () => {
    expect(parseServiceAddress('   ', dev).ok).toBe(false);
    const empty = parseServiceAddress('', dev);
    if (!empty.ok) {
      expect(empty.problem).toBe('empty');
    }
    const badScheme = parseServiceAddress('ftp://example.com', dev);
    if (!badScheme.ok) {
      expect(badScheme.problem).toBe('unsupported-scheme');
    }
    expect(parseServiceAddress('https://', dev).ok).toBe(false);
  });

  it('失败信息面向用户且不含实现细节', () => {
    const rejected = parseServiceAddress('http://192.168.1.8:8787', release);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.message).toContain('https');
      expect(rejected.message).not.toMatch(/stack|Error:|undefined/iu);
    }
  });
});
