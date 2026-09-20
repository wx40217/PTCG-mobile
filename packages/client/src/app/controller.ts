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
export type AppView =
  | 'loading'
  | 'settings'
  | 'connecting'
  | 'failure'
  | 'home'
  | 'catalog'
  | 'card'
  | 'decks'
  | 'preset'
  | 'deck';

/**
 * 设置/失败页的离线目录入口状态。
 *
 * `checking` 表示正在读取本机完整缓存，界面必须显示这一加载状态；`available`
 * 表示缓存通过版本校验，可以脱离联机会话浏览；`none` 表示没有可用缓存。
 */
export type OfflineCatalogEntryState = 'checking' | 'available' | 'none';

export type BackAction = 'to-settings' | 'to-home' | 'to-catalog' | 'to-decks' | 'exit';

/**
 * Android 返回键行为。
 *
 * 逐级返回：卡牌详情 → 目录 → 已连接首页 → 设置 → 退出；卡组编辑 → 卡组
 * 列表；任何页面都能回到设置以修改地址或身份。
 */
export function resolveBackAction(view: AppView): BackAction {
  switch (view) {
    case 'loading':
    case 'settings':
      return 'exit';
    case 'home':
      return 'to-settings';
    case 'catalog':
    case 'decks':
      return 'to-home';
    case 'card':
      return 'to-catalog';
    case 'preset':
    case 'deck':
      return 'to-decks';
    default:
      return 'to-settings';
  }
}

const FAILURE_TEXT: Record<ConnectionFailureKind, { readonly title: string; readonly hint: string }> = {
  'invalid-address': {
    title: '地址无法使用',
    hint: '检查地址格式；正式版本只接受 https 或 wss。',
  },
  unreachable: {
    title: '无法连接服务',
    hint: '确认服务已启动、端口正确，且手机与服务在同一局域网。',
  },
  certificate: {
    title: '证书无法验证',
    hint: '服务证书不受信任。请更换受信任证书，或在开发配置下使用明文地址。',
  },
  incompatible: {
    title: '协议不兼容',
    hint: '客户端与服务端协议版本不一致，需要升级其中一端。',
  },
  'identity-rejected': {
    title: '设备身份被拒绝',
    hint: '本机恢复身份被服务拒绝；可在设置中重置本机身份后重新登记。',
  },
  'server-error': {
    title: '服务端错误',
    hint: '服务返回了错误，请稍后重试或查看服务日志。',
  },
  disconnected: {
    title: '连接已断开',
    hint: '与服务端的连接已经中断。请确认服务仍在运行，然后重试。',
  },
};

export function failureTitle(kind: ConnectionFailureKind): string {
  return FAILURE_TEXT[kind].title;
}

export function failureHint(kind: ConnectionFailureKind): string {
  return FAILURE_TEXT[kind].hint;
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
