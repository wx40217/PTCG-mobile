import type { ReactElement } from 'react';
import type { ConnectedSession } from '@ptcg/protocol';

export interface HomeScreenProps {
  session: ConnectedSession;
  /** 连接是否仍然存活；目录浏览期间断线时首页会显著提示。 */
  connected: boolean;
  onBackToSettings: () => void;
  /** 进入冻结卡牌目录（T04）。 */
  onOpenCatalog: () => void;
}

/** 已连接首页：进入卡牌目录或返回设置；对战入口尚未实现。 */
export function HomeScreen({ session, connected, onBackToSettings, onOpenCatalog }: HomeScreenProps): ReactElement {
  return (
    <>
      <section className="card" aria-label="连接状态">
        <div className="status">
          <span className={`status__dot ${connected ? 'status__dot--ok' : 'status__dot--error'}`} aria-hidden="true" />
          <span>{connected ? '已连接' : '连接已断开'}</span>
        </div>
        {connected ? null : (
          <p className="notice" role="status" data-testid="home-disconnected">
            与服务端的连接已断开；卡牌目录缓存仍可离线阅读。返回设置可重新连接。
          </p>
        )}
        <div>
          <div className="value__label">昵称</div>
          <div className="value" data-testid="home-nickname">
            {session.nickname}
          </div>
        </div>
        <div>
          <div className="value__label">服务版本</div>
          <div className="value" data-testid="home-server-version">
            {session.serverVersion}（协议 v{session.protocolVersion}）
          </div>
        </div>
        <div>
          <div className="value__label">设备标识</div>
          <div className="identity" data-testid="home-device-id">
            {session.deviceId}
          </div>
        </div>
      </section>
      <div className="row">
        <button className="primary" type="button" onClick={onOpenCatalog} data-testid="open-catalog">
          浏览卡牌目录
        </button>
      </div>
      <div className="row">
        <button className="secondary" type="button" onClick={onBackToSettings}>
          返回设置
        </button>
      </div>
    </>
  );
}
