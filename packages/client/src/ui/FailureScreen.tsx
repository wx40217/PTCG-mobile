import type { ReactElement } from 'react';
import type { ConnectionFailure } from '@ptcg/protocol';
import { failureHint, failureTitle, formatFailureDetail, type OfflineCatalogEntryState } from '../app/controller.ts';

export interface FailureScreenProps {
  failure: ConnectionFailure;
  /** 本机完整目录缓存的检查状态；有缓存时允许不连接服务直接浏览。 */
  offlineCatalog: OfflineCatalogEntryState;
  onRetry: () => void;
  onBackToSettings: () => void;
  onOpenOfflineCatalog: () => void;
}

/**
 * 失败页：按类别给出不同说明，并始终提供“重试”与“返回设置”两条出路，
 * 保证任何失败都不会把用户困在空白页。本机已有完整缓存时额外提供离线
 * 目录入口，避免没有成功握手就无法阅读已缓存卡牌。
 */
export function FailureScreen({
  failure,
  offlineCatalog,
  onRetry,
  onBackToSettings,
  onOpenOfflineCatalog,
}: FailureScreenProps): ReactElement {
  return (
    <>
      <section className="card failure" aria-label="连接失败" role="alert">
        <h2>{failureTitle(failure.kind)}</h2>
        <p data-testid="failure-detail">{formatFailureDetail(failure)}</p>
        <p className="field__hint" style={{ color: 'var(--muted)' }}>
          {failureHint(failure.kind)}
        </p>
      </section>
      {offlineCatalog === 'checking' ? (
        <p className="field__hint" data-testid="offline-catalog-checking">
          正在检查本机目录缓存…
        </p>
      ) : null}
      {offlineCatalog === 'available' ? (
        <section className="card" aria-label="离线目录">
          <span className="value__label">离线浏览卡牌目录</span>
          <span className="field__hint">使用本机完整缓存阅读已核实卡牌，文字资料与版本仍然完整。</span>
          <button
            className="secondary"
            type="button"
            onClick={onOpenOfflineCatalog}
            data-testid="open-offline-catalog"
          >
            离线浏览卡牌目录
          </button>
        </section>
      ) : null}
      <div className="row">
        <button className="primary" type="button" onClick={onRetry}>
          重试
        </button>
        <button className="secondary" type="button" onClick={onBackToSettings}>
          返回设置
        </button>
      </div>
    </>
  );
}
