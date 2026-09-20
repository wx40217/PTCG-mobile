import { useEffect, useState, type ReactElement } from 'react';
import { validateDeck, type DeckDocument, type ServiceCatalog } from '@ptcg/protocol';
import { copyTextToClipboard, type CopyText } from '../app/clipboard.ts';
import type { DeckDraft } from '../decks/draftStore.ts';
import { validationSummary } from '../decks/presentation.ts';
import type { RoomState } from '../rooms/roomController.ts';

export interface RoomScreenProps {
  readonly serviceAddress: string;
  /** 联机会话是否仍然存活；断线时禁用房间操作且不冒充可加入。 */
  readonly connected: boolean;
  readonly room: RoomState;
  readonly drafts: readonly DeckDraft[] | undefined;
  readonly catalog: ServiceCatalog | undefined;
  readonly onBack: () => void;
  readonly onCreate: () => void;
  readonly onJoin: (code: string) => void;
  readonly onSelectDeck: (deck: DeckDocument) => void;
  readonly onSetReady: (ready: boolean) => void;
  readonly onLeave: () => void;
  readonly onClearError: () => void;
  /** 覆盖剪贴板复制（测试注入假实现）；默认走平台适配层。 */
  readonly copyText?: CopyText | undefined;
}

/** 首页用的房间状态摘要；没有房间时为 undefined。 */
export function roomHomeSummary(room: RoomState): string | undefined {
  if (room.room === null) {
    return undefined;
  }
  if (room.room.status === 'started') {
    return `对局已建立（房间 ${room.room.code}）`;
  }
  if (room.room.status === 'finished') {
    return `对局已结束，可重新准备（房间 ${room.room.code}）`;
  }
  return `等待朋友加入 · 房间码 ${room.room.code}`;
}

/**
 * 朋友房间页（T06）。
 *
 * 服务地址在连接设置里确定；房间码是独立的 6 位数字输入，两者不混在同一个
 * 输入框里，避免“地址错了但看起来房间可用”。房间视图只显示对手的座位与准备
 * 状态，绝不渲染对手卡表（协议解析器也不会接受携带对手卡表的载荷）。
 */
export function RoomScreen(props: RoomScreenProps): ReactElement {
  const [codeInput, setCodeInput] = useState('');
  const [copyNotice, setCopyNotice] = useState<string | undefined>(undefined);
  const [selectedDraftId, setSelectedDraftId] = useState<string | undefined>(undefined);
  const { room } = props.room;
  const pending = props.room.pending;
  const disabled = !props.connected || pending;

  // 进入新房间或换房（含房间码复用后的新实例）时清掉上一间的局部选择，
  // 避免把旧选中显示成新房间的状态。
  useEffect(() => {
    setSelectedDraftId(undefined);
    setCopyNotice(undefined);
  }, [room?.roomId]);

  // 服务端拒绝过期/错目标命令后，本地高亮不得继续冒充已确认的选择。
  useEffect(() => {
    const code = props.room.error?.code;
    if (code === 'version-conflict' || code === 'stale-room' || code === 'catalog-changed') {
      setSelectedDraftId(undefined);
    }
  }, [props.room.error]);

  const copyCode = (): void => {
    if (room === null) {
      return;
    }
    void (async () => {
      try {
        await (props.copyText ?? copyTextToClipboard)(room.code);
        setCopyNotice('已复制房间码');
      } catch {
        setCopyNotice(`复制失败，请手动抄写：${room.code}`);
      }
    })();
  };

  return (
    <>
      <section className="card" aria-label="朋友房间">
        <h2 className="catalog__title">朋友房间</h2>
        <p className="catalog__note" data-testid="room-service-address">
          当前服务：{props.serviceAddress.length === 0 ? '（未设置）' : props.serviceAddress}
        </p>
        <p className="field__hint">房间码在服务端生成；请确认朋友连接的是同一个服务地址。房间码与服务地址分开填写。</p>
        {props.connected ? null : (
          <p className="notice" role="status" data-testid="room-disconnected">
            与服务端的连接已断开；房间操作已暂停，请返回设置重新连接。已经建立的房间与座位仍保留在服务端。
          </p>
        )}

        {props.room.error === null ? null : (
          <div className="field" data-testid="room-error">
            <span className="field__error" role="alert">
              {props.room.error.message}
              {props.room.error.retryAfterMs === undefined
                ? ''
                : `（请在 ${Math.ceil(props.room.error.retryAfterMs / 1000)} 秒后重试）`}
            </span>
            {props.room.error.validation === undefined ? null : (
              <ul className="catalog__list" data-testid="room-error-problems">
                {props.room.error.validation.problems.map((problem) => (
                  <li key={`${problem.code}-${problem.message}`} className="field__hint">
                    {problem.message}
                  </li>
                ))}
              </ul>
            )}
            <button className="secondary" type="button" data-testid="room-error-dismiss" onClick={props.onClearError}>
              知道了
            </button>
          </div>
        )}

        {room === null ? (
          <>
            {props.room.phase === 'left' ? (
              <p className="notice" role="status" data-testid="room-left-notice">
                已离开房间{props.room.lastCode === null ? '' : ` ${props.room.lastCode}`}。
              </p>
            ) : null}
            {props.room.phase === 'closed' ? (
              <p className="notice" role="status" data-testid="room-closed-notice">
                房主已关闭房间{props.room.lastCode === null ? '' : ` ${props.room.lastCode}`}。
              </p>
            ) : null}
            <div className="row">
              <button className="primary" type="button" data-testid="room-create" disabled={disabled} onClick={props.onCreate}>
                创建房间
              </button>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="room-code-input">
                6 位房间码
              </label>
              <input
                id="room-code-input"
                name="roomCode"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={codeInput}
                onChange={(event) => setCodeInput(event.target.value.replace(/[^0-9]/gu, '').slice(0, 6))}
                placeholder="例如 042000"
                data-testid="room-code-input"
              />
              <button
                className="secondary"
                type="button"
                data-testid="room-join"
                disabled={disabled || codeInput.length === 0}
                onClick={() => props.onJoin(codeInput)}
              >
                加入房间
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <span className="value__label">房间码</span>
              <div className="row">
                <span className="identity" data-testid="room-code" style={{ fontSize: 28, letterSpacing: 8 }}>
                  {room.code}
                </span>
                <button className="secondary" type="button" data-testid="room-copy-code" onClick={copyCode}>
                  复制房间码
                </button>
              </div>
              {copyNotice === undefined ? null : (
                <span className="field__hint" data-testid="room-copy-notice">
                  {copyNotice}
                </span>
              )}
            </div>

            <div className="field" data-testid="room-self">
              <span className="value__label">你的座位</span>
              <span className="value">
                {room.you.nickname}
                {room.you.host ? '（房主）' : ''}
              </span>
              <span className="field__hint" data-testid="room-self-ready">
                {room.you.ready ? '已准备' : '未准备'}
              </span>
            </div>

            <div className="field" data-testid="room-opponent">
              <span className="value__label">对手座位</span>
              {room.opponent.occupied ? (
                <>
                  <span className="value" data-testid="room-opponent-name">
                    {room.opponent.nickname}
                  </span>
                  <span className="field__hint" data-testid="room-opponent-status">
                    {room.opponent.ready ? '已准备' : '未准备'}
                    {room.opponent.online ? '' : ' · 已返回 UI（未认输）'}
                  </span>
                </>
              ) : (
                <span className="field__hint" data-testid="room-opponent-status">
                  等待朋友加入…
                </span>
              )}
            </div>

            {room.status === 'started' ? (
              <>
                <div className="field" data-testid="room-match">
                  <span className="value__label">对局已建立</span>
                  <span className="value" data-testid="room-match-session">
                    会话 {room.match?.sessionId.slice(0, 8)}… · 初始版本 v{room.match?.version}
                  </span>
                  <span className="field__hint">双方卡组已由服务端校验并固定；对手的完整卡表不会出现在本机载荷里。</span>
                </div>
                <div className="row">
                  <button className="primary" type="button" data-testid="room-back-home" onClick={props.onBack}>
                    返回首页（不认输）
                  </button>
                </div>
              </>
            ) : (
              <>
                {room.status === 'finished' ? (
                  <p className="notice" role="status" data-testid="room-finished-notice">
                    上一局已经结束；双方重新准备后会以原房间与座位开始新的一局（卡组可重新选择）。
                  </p>
                ) : null}
                <div className="field">
                  <span className="value__label">选择卡组</span>
                  {props.drafts === undefined ? (
                    <span className="field__hint" data-testid="room-drafts-loading">
                      正在读取本机草稿…
                    </span>
                  ) : props.drafts.length === 0 ? (
                    <span className="field__hint" data-testid="room-no-drafts">
                      还没有卡组草稿。请先在「我的卡组」里复制或新建一副 60 张卡组。
                    </span>
                  ) : (
                    <ul className="catalog__list">
                      {props.drafts.map((draft) => {
                        const local =
                          props.catalog === undefined
                            ? undefined
                            : validateDeck(draft.document, {
                                content: props.catalog.content,
                                catalogVersion: props.catalog.catalogVersion,
                              });
                        const summary = local === undefined ? undefined : validationSummary(local);
                        const selected = draft.id === selectedDraftId;
                        return (
                          <li key={draft.id} className="catalog-card">
                            <div className="catalog-card__head">
                              <span className="catalog-card__name">{draft.name}</span>
                              <span className="catalog-card__number">{draft.document.cards.reduce((sum, entry) => sum + entry.count, 0)} 张</span>
                            </div>
                            {summary === undefined ? null : (
                              <span className={`badge badge--${summary.tone === 'ok' ? 'ok' : summary.tone === 'warn' ? 'warn' : 'danger'}`}>
                                {summary.label}
                              </span>
                            )}
                            <button
                              className={selected ? 'primary' : 'secondary'}
                              type="button"
                              data-testid={`room-select-deck-${draft.id}`}
                              disabled={disabled}
                              onClick={() => {
                                setSelectedDraftId(draft.id);
                                props.onSelectDeck(draft.document);
                              }}
                            >
                              {selected ? '已选择（以服务端校验为准）' : '选择这副卡组'}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {room.you.deck === null ? null : (
                  <div className="field" data-testid="room-deck-validation">
                    <span className="value__label">服务端校验</span>
                    <span className="field__hint" data-testid="room-deck-validation-summary">
                      共 {room.you.deck.totalCards} 张 · {room.you.deck.validation.ready ? '可以正式对战' : '尚不能正式对战'}
                    </span>
                    {room.you.deck.validation.problems.map((problem) => (
                      <span key={`${problem.code}-${problem.message}`} className="field__hint" data-testid={`room-problem-${problem.code}`}>
                        {problem.message}
                      </span>
                    ))}
                  </div>
                )}

                <div className="row">
                  {room.you.ready ? (
                    <button className="secondary" type="button" data-testid="room-unready" disabled={disabled} onClick={() => props.onSetReady(false)}>
                      取消准备
                    </button>
                  ) : (
                    <button className="primary" type="button" data-testid="room-ready" disabled={disabled} onClick={() => props.onSetReady(true)}>
                      准备
                    </button>
                  )}
                </div>
                <div className="row">
                  <button className="secondary" type="button" data-testid="room-leave" disabled={disabled} onClick={props.onLeave}>
                    {room.you.host ? '关闭房间并离开' : '离开房间'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </section>

      <div className="row">
        <button className="secondary" type="button" data-testid="room-back" onClick={props.onBack}>
          返回
        </button>
      </div>
    </>
  );
}
