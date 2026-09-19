import type { ReactElement } from 'react';
import { NICKNAME_MAX_LENGTH, type DeviceIdentity } from '@ptcg/protocol';

export interface SettingsScreenProps {
  nickname: string;
  serviceAddress: string;
  addressHint: string;
  identity: DeviceIdentity | undefined;
  fieldError: { field: 'nickname' | 'serviceAddress'; message: string } | undefined;
  busy: boolean;
  onNicknameChange: (value: string) => void;
  onAddressChange: (value: string) => void;
  onConnect: () => void;
  onResetIdentity: () => void;
}

/** 设置页：昵称（只用于显示）、服务地址与设备身份入口。服务未启动时也能到达。 */
export function SettingsScreen(props: SettingsScreenProps): ReactElement {
  const { fieldError } = props;
  return (
    <>
      <section className="card" aria-label="连接设置">
        <h2 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
          连接设置
        </h2>
        <div className="field">
          <label className="field__label" htmlFor="nickname">
            昵称（仅用于显示）
          </label>
          <input
            id="nickname"
            name="nickname"
            type="text"
            inputMode="text"
            autoComplete="off"
            enterKeyHint="next"
            maxLength={NICKNAME_MAX_LENGTH}
            value={props.nickname}
            onChange={(event) => props.onNicknameChange(event.target.value)}
          />
          {fieldError?.field === 'nickname' ? <span className="field__error">{fieldError.message}</span> : null}
          <span className="field__hint">昵称不影响身份，也不会用于登录。</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="service-address">
            服务地址
          </label>
          <input
            id="service-address"
            name="serviceAddress"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            value={props.serviceAddress}
            onChange={(event) => props.onAddressChange(event.target.value)}
            placeholder="例如 https://ptcg.example.com:8443"
          />
          {fieldError?.field === 'serviceAddress' ? <span className="field__error">{fieldError.message}</span> : null}
          <span className="field__hint">{props.addressHint}</span>
        </div>

        <button className="primary" type="button" onClick={props.onConnect} disabled={props.busy}>
          保存并连接
        </button>
      </section>

      <section className="card" aria-label="设备身份">
        <span className="value__label">设备恢复身份</span>
        {props.identity === undefined ? (
          <span className="field__hint">正在生成…</span>
        ) : (
          <>
            <span className="identity" data-testid="device-id">
              {props.identity.deviceId}
            </span>
            <span className="field__hint">
              私钥只保存在本机，服务只保存公钥；恢复身份不会被写入日志。
            </span>
          </>
        )}
        <button className="secondary" type="button" onClick={props.onResetIdentity}>
          重置本机身份
        </button>
      </section>
    </>
  );
}
