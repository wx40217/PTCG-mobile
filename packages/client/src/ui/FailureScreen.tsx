import type { ReactElement } from 'react';
import type { ConnectionFailure } from '@ptcg/protocol';
import { failureHint, failureTitle, formatFailureDetail } from '../app/controller.ts';

export interface FailureScreenProps {
  failure: ConnectionFailure;
  onRetry: () => void;
  onBackToSettings: () => void;
}

/**
 * 失败页：按类别给出不同说明，并始终提供“重试”与“返回设置”两条出路，
 * 保证任何失败都不会把用户困在空白页。
 */
export function FailureScreen({ failure, onRetry, onBackToSettings }: FailureScreenProps): ReactElement {
  return (
    <>
      <section className="card failure" aria-label="连接失败" role="alert">
        <h2>{failureTitle(failure.kind)}</h2>
        <p data-testid="failure-detail">{formatFailureDetail(failure)}</p>
        <p className="field__hint" style={{ color: 'var(--muted)' }}>
          {failureHint(failure.kind)}
        </p>
      </section>
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
