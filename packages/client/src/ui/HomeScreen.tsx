import type { ReactElement } from 'react';
import type { ConnectedSession } from '@ptcg/protocol';

export interface HomeScreenProps {
  session: ConnectedSession;
  onBackToSettings: () => void;
  onDisconnect: () => void;
}

/** 已连接首页：本票只呈现“已连上服务”这一事实，不包含卡牌或对战入口。 */
export function HomeScreen({ session, onBackToSettings, onDisconnect }: HomeScreenProps): ReactElement {
  return (
    <>
      <section className="card" aria-label="连接状态">
        <div className="status">
          <span className="status__dot status__dot--ok" aria-hidden="true" />
          <span>已连接</span>
        </div>
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
        <button className="secondary" type="button" onClick={onBackToSettings}>
          返回设置
        </button>
        <button className="secondary" type="button" onClick={onDisconnect}>
          断开连接
        </button>
      </div>
    </>
  );
}
