import type { ReactElement } from 'react';
import { NICKNAME_MAX_LENGTH, type DeviceIdentity } from '@ptcg/protocol';
import type { OfflineCatalogEntryState } from '../app/controller.ts';
import { formatBytes } from '../catalog/format.ts';
import type { ImageCacheUsage } from '../catalog/imageCache.ts';

export interface SettingsScreenProps {
  nickname: string;
  serviceAddress: string;
  addressHint: string;
  identity: DeviceIdentity | undefined;
  /** 本机资料（含身份）读取/生成/保存失败时的说明；错误对用户始终可见。 */
  identityError: string | undefined;
  fieldError: { field: 'nickname' | 'serviceAddress'; message: string } | undefined;
  /** 本机完整目录缓存的检查状态；有缓存时允许不连接服务直接浏览。 */
  offlineCatalog: OfflineCatalogEntryState;
  /** 图片缓存的占用；undefined 表示仍在统计。 */
  imageCacheUsage: ImageCacheUsage | undefined;
  imageCacheBusy: boolean;
  imageCacheError: string | undefined;
  imageCacheNote: string | undefined;
  onNicknameChange: (value: string) => void;
  onAddressChange: (value: string) => void;
  onConnect: () => void;
  onOpenOfflineCatalog: () => void;
  onResetIdentity: () => void;
  onRefreshImageCacheUsage: () => void;
  onClearImageCache: () => void;
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

        <button className="primary" type="button" onClick={props.onConnect} disabled={props.identity === undefined}>
          保存并连接
        </button>
      </section>

      <section className="card" aria-label="设备身份">
        <span className="value__label">设备恢复身份</span>
        {props.identity === undefined && props.identityError === undefined ? (
          <span className="field__hint">正在生成…</span>
        ) : null}
        {props.identity === undefined ? null : (
          <>
            <span className="identity" data-testid="device-id">
              {props.identity.deviceId}
            </span>
            <span className="field__hint">
              私钥只保存在本机，服务只保存公钥；恢复身份不会被写入日志。
            </span>
          </>
        )}
        {props.identityError === undefined ? null : (
          <span className="field__error" role="alert">
            {props.identityError}
          </span>
        )}
        <button className="secondary" type="button" onClick={props.onResetIdentity}>
          重置本机身份
        </button>
      </section>

      <section className="card" aria-label="离线目录">
        <span className="value__label">离线浏览卡牌目录</span>
        {props.offlineCatalog === 'checking' ? (
          <span className="field__hint" data-testid="offline-catalog-checking">
            正在检查本机目录缓存…
          </span>
        ) : null}
        {props.offlineCatalog === 'available' ? (
          <>
            <span className="field__hint">
              使用本机完整缓存阅读已核实卡牌，不连接服务；文字资料与版本仍然完整。
            </span>
            <button
              className="secondary"
              type="button"
              onClick={props.onOpenOfflineCatalog}
              data-testid="open-offline-catalog"
            >
              离线浏览卡牌目录
            </button>
          </>
        ) : null}
        {props.offlineCatalog === 'none' ? (
          <span className="field__hint" data-testid="offline-catalog-none">
            本机还没有通过校验的完整目录缓存；连接服务成功加载一次后即可离线阅读。
          </span>
        ) : null}
      </section>
      <section className="card" aria-label="图片缓存">
        <span className="value__label">卡图缓存</span>
        {props.imageCacheUsage === undefined && props.imageCacheError === undefined ? (
          <span className="field__hint" data-testid="image-cache-loading">
            正在统计本机图片缓存…
          </span>
        ) : null}
        {props.imageCacheUsage === undefined ? null : (
          <span className="field__hint" data-testid="image-cache-usage">
            已缓存 {props.imageCacheUsage.count} 张图片，占用 {formatBytes(props.imageCacheUsage.bytes)}。
          </span>
        )}
        <span className="field__hint">
          清除只删除图片缓存文件，不删除设备身份、昵称、服务地址与卡组；离线时已缓存卡图仍可查看，无图时文字卡面完整可读。
        </span>
        {props.imageCacheError === undefined ? null : (
          <span className="field__error" role="alert" data-testid="image-cache-error">
            {props.imageCacheError}
          </span>
        )}
        {props.imageCacheNote === undefined ? null : (
          <span className="field__hint" role="status" data-testid="image-cache-note">
            {props.imageCacheNote}
          </span>
        )}
        <div className="row">
          <button className="secondary" type="button" onClick={props.onRefreshImageCacheUsage} disabled={props.imageCacheBusy}>
            刷新占用
          </button>
          <button
            className="secondary"
            type="button"
            onClick={props.onClearImageCache}
            disabled={props.imageCacheBusy}
            data-testid="image-cache-clear"
          >
            清除图片缓存
          </button>
        </div>
      </section>
    </>
  );
}
