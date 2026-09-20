import { useMemo, useState, type ReactElement } from 'react';
import { isCardImageAvailable, type CatalogCard } from '@ptcg/protocol';
import {
  ALL_TAG_ID,
  availableTags,
  identityRelation,
  identityRelationLabel,
  searchCards,
} from '../catalog/search.ts';
import { shortVersion } from '../catalog/format.ts';
import type { CatalogState } from '../catalog/useCatalog.ts';

export interface CatalogImageRequest {
  readonly src: string;
  readonly labelZh: string;
  readonly provenanceZh: string;
}

export interface CatalogScreenProps {
  readonly state: CatalogState;
  /** 浏览期间连接断开：显示离线状态，但保留缓存内容。 */
  readonly connectionLost: boolean;
  /** 未建立联机会话的离线入口：目录可能来自缓存或一次匿名读取，不能显示为已连接。 */
  readonly offlineMode: boolean;
  readonly onRetry: () => void;
  readonly onBackToHome: () => void;
  readonly onSelectCard: (card: CatalogCard) => void;
  readonly resolveAssetUrl: (path: string) => string;
  readonly onOpenImage: (image: CatalogImageRequest) => void;
}

function StatusBadges({ card, imageAvailable }: { readonly card: CatalogCard; readonly imageAvailable: boolean }): ReactElement {
  return (
    <span className="badges">
      <span className={`badge ${card.flags.environmentLegal ? 'badge--ok' : 'badge--danger'}`}>
        {card.flags.environmentLegal ? '环境合法' : '环境不合法'}
      </span>
      <span className={`badge ${card.flags.effectSupported ? 'badge--ok' : 'badge--warn'}`}>
        {card.flags.effectSupported ? '效果已支持' : '效果未接入'}
      </span>
      <span className={`badge ${imageAvailable ? 'badge--info' : 'badge--muted'}`}>
        {imageAvailable ? '卡图可用' : '文字卡面'}
      </span>
    </span>
  );
}

export function CatalogScreen(props: CatalogScreenProps): ReactElement {
  const { state, resolveAssetUrl, onOpenImage } = props;
  const [text, setText] = useState('');
  const [tagId, setTagId] = useState(ALL_TAG_ID);
  const [presetOnly, setPresetOnly] = useState(false);
  const catalog = state.catalog;

  const tags = useMemo(() => (catalog === undefined ? [] : availableTags(catalog.content.cards)), [catalog]);
  const results = useMemo(
    () => (catalog === undefined ? [] : searchCards(catalog.content.cards, { text, tagId, presetOnly })),
    [catalog, presetOnly, tagId, text],
  );

  if (catalog === undefined) {
    return (
      <>
        {state.phase === 'error' ? (
          <section className="card failure" aria-label="目录加载失败">
            <h2>卡牌目录加载失败</h2>
            <p role="alert" data-testid="catalog-error">
              {state.errorMessage ?? '未知错误'}
            </p>
            <p>没有可用的本机缓存；请确认服务在线后重试。</p>
            <div className="row">
              <button className="primary" type="button" onClick={props.onRetry}>
                重试
              </button>
              <button className="secondary" type="button" onClick={props.onBackToHome}>
                {props.offlineMode ? '返回设置' : '返回首页'}
              </button>
            </div>
          </section>
        ) : (
          <section className="card" aria-label="目录加载中">
            <span className="value__label">正在加载卡牌目录…</span>
            <div className="spinner" aria-hidden="true" />
          </section>
        )}
      </>
    );
  }

  const { content, runtime } = catalog;
  const statusText = props.offlineMode
    ? state.fromCache
      ? '离线 · 未连接服务，显示本机缓存'
      : '离线 · 未连接服务，目录来自服务'
    : props.connectionLost
      ? '离线 · 连接已断开，显示本机缓存'
      : '已连接 · 卡牌目录';

  return (
    <>
      <section className="card" aria-label="环境与冻结范围">
        <div className="status">
          <span
            className={`status__dot ${props.offlineMode || props.connectionLost ? 'status__dot--error' : 'status__dot--ok'}`}
            aria-hidden="true"
          />
          <span>{statusText}</span>
        </div>
        <h2 className="catalog__title" data-testid="catalog-environment">
          {content.environment.nameZh}
        </h2>
        <div className="value__label">
          格式：{content.environment.formatZh} · 冻结日：{content.environment.frozenAt} · 规则手册：
          {content.environment.ruleManual.title} {content.environment.ruleManual.version}（{content.environment.ruleManual.date}）
        </div>
        <p className="catalog__note" data-testid="catalog-scope">
          {content.environment.scopeZh}
        </p>
        <p className="catalog__note">{content.environment.supportedSubsetZh}</p>
        <div className="catalog__version" data-testid="catalog-version">
          目录版本 {shortVersion(catalog.catalogVersion)} · 资料修订 {shortVersion(content.dataRevision.sourceDigest)} ·{' '}
          {state.fromCache ? '来自本机缓存（断网可读）' : '来自服务'}
        </div>
        {state.staleReason === undefined ? null : (
          <p className="notice" role="status" data-testid="catalog-stale">
            在线更新失败：{state.staleReason} 正在显示本机缓存版本，文字资料仍完整。
          </p>
        )}
        {state.cacheWriteFailed ? (
          <p className="notice" role="status" data-testid="catalog-cache-warning">
            本次在线目录未能写入本机缓存；已保留上一份完整缓存。
          </p>
        ) : null}
        <p className="catalog__note" data-testid="catalog-flags-note">
          环境合法、效果支持、卡图可用分别判断。当前效果支持为「未接入」的卡牌只能浏览资料，客户端不会把它标为可对战。
        </p>
      </section>

      <section className="card" aria-label="资源样本">
        <span className="value__label">T01 资源服务样本</span>
        {content.resources.length === 0 ? <p className="catalog__note">目录未声明资源样本。</p> : null}
        {content.resources.map((resource) => {
          const status = runtime.resources[resource.resourceId];
          const path = status?.path ?? null;
          const url = status?.available === true && path !== null ? resolveAssetUrl(path) : '';
          return (
            <div className="resource" key={resource.resourceId} data-testid={`resource-${resource.resourceId}`}>
              <div className="value">{resource.labelZh}</div>
              <div className="catalog__note">{resource.provenanceZh}</div>
              <div className="catalog__note">{resource.caveatZh}</div>
              {status?.available === true && url.length > 0 ? (
                <button
                  className="secondary"
                  type="button"
                  onClick={() =>
                    onOpenImage({ src: url, labelZh: resource.labelZh, provenanceZh: resource.provenanceZh })
                  }
                >
                  查看资源样本（可放大）
                </button>
              ) : (
                <p className="field__hint" data-testid={`resource-unavailable-${resource.resourceId}`}>
                  未配置本机资源样本：图片字节不入库，服务启动时以 --resource-dir 指定导出目录。
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section className="card" aria-label="搜索与筛选">
        <div className="field">
          <label className="field__label" htmlFor="catalog-search">
            搜索简中名称、商品/卡牌编号或类别
          </label>
          <input
            id="catalog-search"
            name="catalogSearch"
            type="search"
            inputMode="search"
            autoComplete="off"
            enterKeyHint="search"
            placeholder="例如：古剑豹 / CSVE1C 143 / 支援者"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div className="chips" role="group" aria-label="类别筛选">
          <button
            type="button"
            className={`chip ${tagId === ALL_TAG_ID ? 'chip--active' : ''}`}
            aria-pressed={tagId === ALL_TAG_ID}
            onClick={() => setTagId(ALL_TAG_ID)}
          >
            全部
          </button>
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={`chip ${tagId === tag.id ? 'chip--active' : ''}`}
              aria-pressed={tagId === tag.id}
              onClick={() => setTagId(tag.id)}
            >
              {tag.labelZh}
            </button>
          ))}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={presetOnly} onChange={(event) => setPresetOnly(event.target.checked)} />
          只看四套预设卡组使用的卡牌
        </label>
        <div className="catalog__count" data-testid="catalog-count">
          共 {results.length} 条
        </div>
      </section>

      {results.length === 0 ? (
        <section className="card" aria-label="空结果">
          <p role="status" data-testid="catalog-empty">
            没有找到匹配的卡牌。
          </p>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setText('');
              setTagId(ALL_TAG_ID);
              setPresetOnly(false);
            }}
          >
            清除筛选
          </button>
        </section>
      ) : (
        <ul className="catalog__list">
          {results.map((card) => {
            const imageAvailable = card.imageSource !== null && isCardImageAvailable(catalog, card.id);
            const relation = identityRelation(card, content.cards);
            return (
              <li key={card.id}>
                <button
                  type="button"
                  className="catalog-card"
                  data-testid={`catalog-card-${card.id}`}
                  onClick={() => props.onSelectCard(card)}
                >
                  <span className="catalog-card__head">
                    <span className="catalog-card__name">{card.nameZh}</span>
                    <span className="catalog-card__number">{card.print.displayNumber}</span>
                  </span>
                  <span className="catalog-card__meta">
                    {card.categoryLabelZh}
                    {card.type === null ? '' : ` · ${card.type}`} · {card.productNameZh}
                  </span>
                  <StatusBadges card={card} imageAvailable={imageAvailable} />
                  {relation === 'unique' ? null : (
                    <span className="badge badge--note" data-testid={`identity-relation-${card.id}`}>
                      {identityRelationLabel(relation)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="row">
        <button className="secondary" type="button" onClick={props.onBackToHome}>
          {props.offlineMode ? '返回设置' : '返回首页'}
        </button>
        <button className="secondary" type="button" onClick={props.onRetry}>
          刷新目录
        </button>
      </div>
    </>
  );
}
