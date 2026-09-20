import { useMemo, type ReactElement } from 'react';
import {
  deckCardTotal,
  presetDeckDocument,
  validateDeck,
  type CatalogDeck,
  type DeckDocument,
  type DeckValidationResponse,
  type ServiceCatalog,
} from '@ptcg/protocol';
import type { DeckDraft } from '../decks/draftStore.ts';
import { catalogRevisionLabel, validationSummary } from '../decks/presentation.ts';

export interface DecksScreenProps {
  /** undefined 表示正在读取本机草稿。 */
  readonly drafts: readonly DeckDraft[] | undefined;
  readonly catalog: ServiceCatalog | undefined;
  /** 没有联机会话时进入的离线模式（草稿与缓存目录仍可编辑）。 */
  readonly offlineMode: boolean;
  readonly connectionLost: boolean;
  readonly onBack: () => void;
  readonly onCreateBlank: () => void;
  readonly onOpenPreset: (code: string) => void;
  readonly onCopyPreset: (code: string) => void;
  readonly onOpenDraft: (id: string) => void;
}

interface PresetEntry {
  readonly preset: CatalogDeck;
  readonly document: DeckDocument;
  readonly validation: DeckValidationResponse;
}

function presetEntries(catalog: ServiceCatalog): PresetEntry[] {
  const entries: PresetEntry[] = [];
  for (const preset of catalog.content.decks) {
    const document = presetDeckDocument(preset, catalog.content);
    if (document === null) {
      continue;
    }
    entries.push({
      preset,
      document,
      validation: validateDeck(document, { content: catalog.content, catalogVersion: catalog.catalogVersion }),
    });
  }
  return entries;
}

/**
 * 卡组列表：冻结预设（预览 / 复制）与本机草稿。
 *
 * 预设与草稿都走同一个 `validateDeck`，预设身份不会绕过效果支持检查。
 */
export function DecksScreen(props: DecksScreenProps): ReactElement {
  const { catalog, drafts } = props;
  const presets = useMemo(() => (catalog === undefined ? [] : presetEntries(catalog)), [catalog]);

  return (
    <>
      <section className="card" aria-label="卡组列表">
        <h2 className="catalog__title">我的卡组</h2>
        <p className="catalog__note">
          {props.offlineMode
            ? '离线模式：草稿保存在本机，重启后仍可恢复；编辑与规则校验使用本机缓存的卡牌目录。'
            : '草稿保存在本机；正式开局以服务端当前目录的校验结果为准。'}
        </p>
        {props.connectionLost ? (
          <p className="notice" role="status" data-testid="decks-connection-lost">
            与服务端的连接已断开；草稿仍可离线编辑，联网后可重新做服务端校验。
          </p>
        ) : null}
        {catalog === undefined ? (
          <p className="field__hint" data-testid="decks-catalog-missing">
            卡牌目录尚未加载：可以查看已保存草稿，但无法预览预设、校验或添加卡牌。连接服务或先在线浏览一次目录即可离线使用。
          </p>
        ) : (
          <span className="catalog__version" data-testid="decks-revision">
            {catalogRevisionLabel(catalog)}
          </span>
        )}
      </section>

      {catalog === undefined ? null : (
        <section className="card" aria-label="冻结预设卡组">
          <h3 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
            冻结预设（2025-06-05）
          </h3>
          <p className="catalog__note">
            四套预设是资料核实的 60 张构筑，可直接预览或复制为草稿。效果未接入前，它们都不会被标成可正式对战。
          </p>
          <ul className="catalog__list">
            {presets.map((entry) => {
              const summary = validationSummary(entry.validation);
              return (
                <li key={entry.preset.code} className="catalog-card" data-testid={`preset-card-${entry.preset.code}`}>
                  <div className="catalog-card__head">
                    <span className="catalog-card__name">
                      {entry.preset.code} · {entry.preset.nameZh}
                    </span>
                    <span className="catalog-card__number">共 {deckCardTotal(entry.document)} 张</span>
                  </div>
                  <span className="catalog-card__meta">{entry.preset.playstyleZh}</span>
                  <span
                    className={`badge badge--${summary.tone === 'ok' ? 'ok' : summary.tone === 'warn' ? 'warn' : 'danger'}`}
                    data-testid={`preset-readiness-${entry.preset.code}`}
                  >
                    {summary.label}
                  </span>
                  <div className="row">
                    <button
                      className="secondary"
                      type="button"
                      data-testid={`preset-preview-${entry.preset.code}`}
                      onClick={() => props.onOpenPreset(entry.preset.code)}
                    >
                      预览
                    </button>
                    <button
                      className="primary"
                      type="button"
                      data-testid={`preset-copy-${entry.preset.code}`}
                      onClick={() => props.onCopyPreset(entry.preset.code)}
                    >
                      复制为草稿
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card" aria-label="本机草稿">
        <h3 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
          本机草稿
        </h3>
        {drafts === undefined ? (
          <span className="field__hint" data-testid="decks-loading">
            正在读取本机草稿…
          </span>
        ) : null}
        {drafts !== undefined && drafts.length === 0 ? (
          <span className="field__hint" data-testid="decks-empty">
            还没有草稿。复制一套预设，或新建空白草稿开始编辑。
          </span>
        ) : null}
        {drafts !== undefined && drafts.length > 0 ? (
          <ul className="catalog__list">
            {drafts.map((draft) => {
              const validation =
                catalog === undefined
                  ? undefined
                  : validateDeck(draft.document, { content: catalog.content, catalogVersion: catalog.catalogVersion });
              const summary = validation === undefined ? undefined : validationSummary(validation);
              return (
                <li key={draft.id} className="catalog-card" data-testid={`draft-item-${draft.id}`}>
                  <div className="catalog-card__head">
                    <span className="catalog-card__name" data-testid={`draft-name-${draft.id}`}>
                      {draft.name}
                    </span>
                    <span className="catalog-card__number">共 {deckCardTotal(draft.document)} 张</span>
                  </div>
                  {summary === undefined ? (
                    <span className="badge badge--muted">目录未加载 · 暂不校验</span>
                  ) : (
                    <span
                      className={`badge badge--${summary.tone === 'ok' ? 'ok' : summary.tone === 'warn' ? 'warn' : 'danger'}`}
                      data-testid={`draft-readiness-${draft.id}`}
                    >
                      {summary.label}
                    </span>
                  )}
                  <button
                    className="secondary"
                    type="button"
                    data-testid={`draft-open-${draft.id}`}
                    onClick={() => props.onOpenDraft(draft.id)}
                  >
                    打开编辑
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {catalog === undefined ? null : (
          <button className="primary" type="button" data-testid="create-blank-draft" onClick={props.onCreateBlank}>
            新建空白草稿
          </button>
        )}
      </section>

      <div className="row">
        <button className="secondary" type="button" data-testid="decks-back" onClick={props.onBack}>
          返回
        </button>
      </div>
    </>
  );
}
