import type { ReactElement } from 'react';

export interface RecoveryScreenProps {
  /** 服务中断的明确原因（实例变化、原房间不存在等），面向玩家说明。 */
  readonly message: string;
  /** 重新开局：进入房间页，由玩家重新建房或加入朋友。 */
  readonly onRematch: () => void;
  readonly onBackToSettings: () => void;
}

/**
 * 服务中断页（#15）。
 *
 * 服务进程重启后，未结束对局的内存状态已不存在。这里给出明确的“无胜负”
 * 说明与可重新开局入口，不伪造恢复；本机卡组、设备身份与资源不受影响。
 */
export function RecoveryScreen({ message, onRematch, onBackToSettings }: RecoveryScreenProps): ReactElement {
  return (
    <>
      <section className="card" aria-label="服务中断" data-testid="recovery-screen" role="status">
        <h2>服务中断，上一局无胜负</h2>
        <p data-testid="recovery-message">{message}</p>
        <p className="field__hint">
          服务重启后无法还原已经丢失的对局内存，因此不会伪造玩家认输或胜负。本机卡组、设备身份、昵称、服务
          地址与已缓存资源都已保留。
        </p>
      </section>
      <div className="row">
        <button className="primary" type="button" data-testid="recovery-rematch" onClick={onRematch}>
          重新开局
        </button>
        <button className="secondary" type="button" onClick={onBackToSettings}>
          返回设置
        </button>
      </div>
    </>
  );
}
