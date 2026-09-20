import type { ReactElement } from 'react';

export function ConnectingScreen(): ReactElement {
  return (
    <section className="card" aria-label="正在连接" aria-busy="true">
      <div className="status">
        <span className="spinner" aria-hidden="true" />
        <span>正在检查服务并验证身份…</span>
      </div>
      <span className="field__hint">若长时间无响应，可返回设置检查地址。</span>
    </section>
  );
}
