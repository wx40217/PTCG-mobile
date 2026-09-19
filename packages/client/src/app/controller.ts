import {
  NICKNAME_MAX_LENGTH,
  isValidNickname,
  normalizeNickname,
  parseServiceAddress,
  type ConnectionFailure,
  type ConnectionFailureKind,
  type ServiceAddressPolicy,
} from '@ptcg/protocol';

/** 界面视图。`loading` 只在读取本地资料期间出现，避免闪出空表单。 */
export type AppView = 'loading' | 'settings' | 'connecting' | 'failure' | 'home';

export type BackAction = 'to-settings' | 'exit';

/**
 * Android 返回键行为。
 *
 * 除设置页外的任何页面都先回到设置页，保证用户永远能改地址或换设备身份；
 * 只有设置页的返回才交给系统退出应用。
 */
export function resolveBackAction(view: AppView): BackAction {
  return view === 'settings' || view === 'loading' ? 'exit' : 'to-settings';
}

const FAILURE_TITLES: Record<ConnectionFailureKind, string> = {
  'invalid-address': '地址无法使用',
  unreachable: '无法连接服务',
  certificate: '证书无法验证',
  incompatible: '协议不兼容',
  'identity-rejected': '设备身份被拒绝',
  'server-error': '服务端错误',
};

const FAILURE_HINTS: Record<ConnectionFailureKind, string> = {
  'invalid-address': '检查地址格式；正式版本只接受 https 或 wss。',
  unreachable: '确认服务已启动、端口正确，且手机与服务在同一局域网。',
  certificate: '服务证书不受信任。请更换受信任证书，或在开发配置下使用明文地址。',
  incompatible: '客户端与服务端协议版本不一致，需要升级其中一端。',
  'identity-rejected': '本机恢复身份被服务拒绝；可在设置中重置本机身份后重新登记。',
  'server-error': '服务返回了错误，请稍后重试或查看服务日志。',
};

export function failureTitle(kind: ConnectionFailureKind): string {
  return FAILURE_TITLES[kind];
}

export function failureHint(kind: ConnectionFailureKind): string {
  return FAILURE_HINTS[kind];
}

export interface ProfileInput {
  readonly nickname: string;
  readonly serviceAddress: string;
}

export type ProfileIssue = { readonly field: 'nickname' | 'serviceAddress'; readonly message: string };

export type ProfileValidation =
  | { readonly ok: true; readonly nickname: string; readonly serviceAddress: string }
  | { readonly ok: false; readonly issue: ProfileIssue };

/**
 * 本地校验：不合格的输入不应该发出任何网络请求。
 *
 * 地址策略（发布配置禁止明文）也在这里生效，因此用户永远看不到“先请求失败
 * 再告诉我要用 https”这种绕路。
 */
export function validateProfileInput(input: ProfileInput, policy: ServiceAddressPolicy): ProfileValidation {
  if (!isValidNickname(input.nickname)) {
    return {
      ok: false,
      issue: { field: 'nickname', message: `昵称需为 1-${NICKNAME_MAX_LENGTH} 个字符，且不能包含控制字符。` },
    };
  }
  const address = parseServiceAddress(input.serviceAddress, policy);
  if (!address.ok) {
    return { ok: false, issue: { field: 'serviceAddress', message: address.message } };
  }
  return {
    ok: true,
    nickname: normalizeNickname(input.nickname),
    serviceAddress: input.serviceAddress.trim(),
  };
}

export function formatFailureDetail(failure: ConnectionFailure): string {
  const parts = [failure.message];
  if (failure.supported !== undefined) {
    parts.push(`服务端支持协议版本 ${failure.supported.min}-${failure.supported.max}。`);
  }
  return parts.join(' ');
}
