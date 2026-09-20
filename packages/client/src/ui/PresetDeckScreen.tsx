import { useMemo, type ReactElement } from 'react';
import { deckCardTotal, presetDeckDocument, validateDeck, type CatalogDeck, type ServiceCatalog } from '@ptcg/protocol';
import { catalogRevisionLabel, validationSummary } from '../decks/presentation.ts';

export interface PresetDeckScreenProps {
  readonly preset: CatalogDeck;
  readonly catalog: ServiceCatalog;
  /** 本机草稿尚未读取成功时禁止复制，避免覆盖设备上已有草稿。 */
  readonly copyDisabled: boolean;
  readonly onCopy: () => void;
  readonly onBack: () => void;
}

/** 预设卡组预览：逐张列出构筑与效果状态，复制按钮把精确身份带入草稿。 */
export function PresetDeckScreen(props: PresetDeckScreenProps): ReactElement {
  const { preset, catalog } = props;
  const state = useMemo(() => {
    const document = presetDeckDocument(preset, catalog.content);
    if (document === null) {
      return { document: undefined, validation: undefined };
    }
    return {
      document,
      validation: validateDeck(document, { content: catalog.content, catalogVersion: catalog.catalogVersion }),
    };
  }, [catalog, preset]);

  if (state.document === undefined || state.validation === undefined) {
    return (
      <>
        <section className="card">
          <h2 className="catalog__title">预设卡组无法预览</h2>
          <p className="notice" role="alert">
            该预设引用了目录中不存在的卡牌，不能作为可信构筑展示；这不会被静默忽略。
          </p>
        </section>
        <div className="row">
          <button className="secondary" type="button" onClick={props.onBack}>
            返回卡组列表
          </button>
        </div>
      </>
    );
  }

  const summary = validationSummary(state.validation);
  return (
    <>
      <section className="card" aria-label="预设卡组概览">
        <h2 className="catalog__title" data-testid="preset-title">
          {preset.code} · {preset.nameZh}
        </h2>
        <p className="catalog__note">{preset.playstyleZh}</p>
        <p className="catalog__note">进化策略：{preset.evolutionStrategyZh}</p>
        <span className="catalog__version" data-testid="preset-revision">
          {catalogRevisionLabel(catalog)}
        </span>
        <span
          className={`badge badge--${summary.tone === 'ok' ? 'ok' : summary.tone === 'warn' ? 'warn' : 'danger'}`}
          data-testid="preset-summary"
        >
          {summary.label}
        </span>
        <p className="catalog__note" data-testid="preset-total">
          共 {deckCardTotal(state.document)} 张
        </p>
      </section>

      <section className="card" aria-label="预设卡表">
        <h3 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
          卡表
        </h3>
        <ul className="catalog__list">
          {state.document.cards.map((entry) => {
            const card = catalog.content.cards.find((candidate) => candidate.id === entry.cardId);
            if (card === undefined) {
              return null;
            }
            return (
              <li key={entry.cardId} className="deck-row" data-testid={`preset-entry-${entry.cardId}`}>
                <div className="deck-row__main">
                  <span className="catalog-card__name">{card.nameZh}</span>
                  <span className="catalog-card__number">
                    {card.print.displayNumber} · {card.categoryLabelZh}
                  </span>
                </div>
                <div className="deck-row__side">
                  <span className="deck-count" data-testid={`preset-count-${entry.cardId}`}>
                    ×{entry.count}
                  </span>
                  <span className={`badge badge--${card.flags.effectSupported ? 'ok' : 'warn'}`}>
                    {card.flags.effectSupported ? '效果已支持' : '效果未接入'}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="row">
          <button
            className="primary"
            type="button"
            data-testid="preset-copy"
            disabled={props.copyDisabled}
            onClick={props.onCopy}
          >
            复制为草稿
          </button>
        </div>
        {props.copyDisabled ? (
          <p className="field__hint" data-testid="preset-copy-blocked">
            本机草稿读取完成前不能复制，避免覆盖已有草稿。
          </p>
        ) : null}
        <p className="field__hint">
          复制会逐张保留印刷与效果身份；复制后的草稿仍按同一套规则与效果支持校验，预设身份不能绕过。
        </p>
      </section>

      <div className="row">
        <button className="secondary" type="button" data-testid="preset-back" onClick={props.onBack}>
          返回卡组列表
        </button>
      </div>
    </>
  );
}
