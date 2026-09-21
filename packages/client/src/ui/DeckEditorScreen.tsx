import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  DECK_FORMAT_VERSION,
  DECK_TEXT_HEADER,
  deckCardTotal,
  exportDeckText,
  importDeckText,
  validateDeck,
  type CatalogCard,
  type DeckCardEntry,
  type DeckDocument,
  type DeckValidationResponse,
  type ServiceCatalog,
} from '@ptcg/protocol';
import { DRAFT_NAME_MAX_LENGTH, type DeckDraft } from '../decks/draftStore.ts';
import { lockScreenOrientation } from '../app/orientation.ts';
import { catalogRevisionLabel, shortRevision, validationSummary } from '../decks/presentation.ts';
import type { DeckValidatorSource } from '../decks/validatorSource.ts';

export interface DeckEditorScreenProps {
  readonly draft: DeckDraft;
  readonly catalog: ServiceCatalog | undefined;
  /** 服务地址可用时的服务端校验数据源；无效地址时为 undefined。 */
  readonly validator: DeckValidatorSource | undefined;
  readonly saveError: string | undefined;
  readonly onPersist: (document: DeckDocument, name: string) => void;
  readonly onBack: () => void;
}

type ServerValidationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'done'; readonly response: DeckValidationResponse; readonly staleCatalog: boolean }
  | { readonly phase: 'error'; readonly message: string };

const EMPTY_SERVER_STATE: ServerValidationState = { phase: 'idle' };

/**
 * 草稿编辑：增减数量、从缓存卡池加卡、重命名、导入导出与两级校验。
 *
 * 编辑始终是可持久化的：每次变更立即写入本机草稿存储，因此离线重启后
 * 可以恢复；导入只有在整篇文本解析成功后才会替换卡组，失败不会覆盖原样。
 */
export function DeckEditorScreen(props: DeckEditorScreenProps): ReactElement {
  const { draft, catalog, validator, onPersist, onBack, saveError } = props;
  // 组卡固定竖屏：从对战返回后切回竖屏编辑。
  useEffect(() => {
    void lockScreenOrientation('portrait');
  }, []);
  const [name, setName] = useState(draft.name);
  const [environmentId, setEnvironmentId] = useState(draft.document.environmentId);
  const [cards, setCards] = useState<readonly DeckCardEntry[]>(draft.document.cards);
  const [nameError, setNameError] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [importText, setImportText] = useState('');
  const [importIssues, setImportIssues] = useState<readonly string[]>([]);
  const [exportText, setExportText] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [server, setServer] = useState<ServerValidationState>(EMPTY_SERVER_STATE);
  const validationToken = useRef(0);

  useEffect(() => {
    setName(draft.name);
    setEnvironmentId(draft.document.environmentId);
    setCards(draft.document.cards);
    setNameError(undefined);
    setSearch('');
    setImportText('');
    setImportIssues([]);
    setExportText(undefined);
    setNotice(undefined);
    setServer(EMPTY_SERVER_STATE);
    validationToken.current += 1;
    // 只在切换到另一份草稿时同步本地编辑状态；自动保存回来的新对象不重置输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  const document = useMemo<DeckDocument>(
    () => ({
      formatVersion: DECK_FORMAT_VERSION,
      environmentId,
      cards,
    }),
    [cards, environmentId],
  );

  const commit = useCallback(
    (nextCards: readonly DeckCardEntry[], nextName: string, nextEnvironmentId: string = environmentId) => {
      setCards(nextCards);
      setName(nextName);
      setEnvironmentId(nextEnvironmentId);
      // 修改后旧的服务器校验结果立即失效。
      validationToken.current += 1;
      setServer(EMPTY_SERVER_STATE);
      onPersist(
        { formatVersion: DECK_FORMAT_VERSION, environmentId: nextEnvironmentId, cards: nextCards },
        nextName,
      );
    },
    [environmentId, onPersist],
  );

  const offlineValidation = useMemo(
    () =>
      catalog === undefined
        ? undefined
        : validateDeck(document, { content: catalog.content, catalogVersion: catalog.catalogVersion }),
    [catalog, document],
  );

  const searchResults = useMemo(() => {
    if (catalog === undefined || search.trim().length === 0) {
      return [];
    }
    const query = search.trim().toLowerCase();
    return catalog.content.cards
      .filter(
        (card) =>
          card.nameZh.toLowerCase().includes(query) ||
          card.id.toLowerCase().includes(query) ||
          card.print.displayNumber.toLowerCase().includes(query) ||
          card.print.number.toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [catalog, search]);

  const countOf = (cardId: string): number => cards.find((entry) => entry.cardId === cardId)?.count ?? 0;

  const addCard = (card: CatalogCard): void => {
    const existing = cards.find((entry) => entry.cardId === card.id);
    const next = existing
      ? cards.map((entry) => (entry === existing ? { ...entry, count: Math.min(99, entry.count + 1) } : entry))
      : [
          ...cards,
          {
            cardId: card.id,
            printIdentity: card.identities.printIdentity,
            effectIdentity: card.identities.effectIdentity,
            count: 1,
          },
        ];
    commit(next, name.trim().length > 0 ? name.trim() : draft.name);
    setNotice(`已加入「${card.nameZh}」。`);
  };

  const changeCount = (cardId: string, delta: number): void => {
    const next = cards
      .map((entry) => (entry.cardId === cardId ? { ...entry, count: entry.count + delta } : entry))
      .filter((entry) => entry.count > 0)
      .map((entry) => ({ ...entry, count: Math.min(99, entry.count) }));
    commit(next, name.trim().length > 0 ? name.trim() : draft.name);
  };

  const removeCard = (cardId: string): void => {
    commit(
      cards.filter((entry) => entry.cardId !== cardId),
      name.trim().length > 0 ? name.trim() : draft.name,
    );
  };

  const handleNameChange = (value: string): void => {
    setName(value);
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setNameError('卡组名称不能为空。');
      validationToken.current += 1;
      setServer(EMPTY_SERVER_STATE);
      return;
    }
    if (trimmed.length > DRAFT_NAME_MAX_LENGTH) {
      setNameError(`卡组名称最多 ${DRAFT_NAME_MAX_LENGTH} 个字符。`);
      return;
    }
    setNameError(undefined);
    commit(cards, trimmed);
  };

  const handleSave = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError('卡组名称不能为空。');
      return;
    }
    commit(cards, trimmed);
    setNotice('草稿已保存到本机。');
  };

  const handleImport = (): void => {
    if (catalog === undefined) {
      setImportIssues(['卡牌目录未加载，无法解析导入文本。']);
      return;
    }
    const result = importDeckText(importText, {
      content: catalog.content,
      catalogVersion: catalog.catalogVersion,
    });
    if (!result.ok) {
      // 失败时保持当前卡组不变，只显示错误。
      setImportIssues(result.issues.map((issue) => issue.message));
      setNotice(undefined);
      return;
    }
    commit(result.deck.cards, name.trim().length > 0 ? name.trim() : draft.name, result.deck.environmentId);
    setImportIssues([]);
    setImportText('');
    setExportText(undefined);
    setNotice(`已导入 ${result.deck.cards.length} 种卡牌，并替换当前草稿内容。`);
  };

  const handleExport = (): void => {
    if (catalog === undefined) {
      setImportIssues(['卡牌目录未加载，无法生成导入导出文本。']);
      return;
    }
    setExportText(exportDeckText(document, catalog));
    setImportIssues([]);
    setNotice(undefined);
  };

  const handleCopyExport = (): void => {
    if (exportText === undefined) {
      return;
    }
    void (async () => {
      try {
        if (navigator.clipboard?.writeText === undefined) {
          throw new Error('clipboard unavailable');
        }
        await navigator.clipboard.writeText(exportText);
        setNotice('导出文本已复制到剪贴板。');
      } catch {
        setNotice('无法自动复制；请长按或手动选择文本复制。');
      }
    })();
  };

  const handleServerValidate = (): void => {
    if (validator === undefined) {
      return;
    }
    const token = (validationToken.current += 1);
    setServer({ phase: 'checking' });
    void (async () => {
      const result = await validator.validate(document);
      if (token !== validationToken.current) {
        return;
      }
      if (!result.ok) {
        setServer({ phase: 'error', message: result.message });
        return;
      }
      setServer({
        phase: 'done',
        response: result.response,
        staleCatalog: catalog !== undefined && catalog.catalogVersion !== result.response.catalogVersion,
      });
    })();
  };

  const total = deckCardTotal(document);
  const offlineSummary = offlineValidation === undefined ? undefined : validationSummary(offlineValidation);

  return (
    <>
      <section className="card" aria-label="草稿概览">
        <div className="field">
          <label className="field__label" htmlFor="deck-name">
            卡组名称
          </label>
          <input
            id="deck-name"
            data-testid="deck-name"
            name="deckName"
            type="text"
            autoComplete="off"
            maxLength={DRAFT_NAME_MAX_LENGTH}
            value={name}
            onChange={(event) => handleNameChange(event.target.value)}
          />
          {nameError === undefined ? null : (
            <span className="field__error" role="alert" data-testid="deck-name-error">
              {nameError}
            </span>
          )}
        </div>
        <span className="catalog__version" data-testid="deck-total">
          共 {total} 张 · 环境 {document.environmentId}
        </span>
        {catalog === undefined ? null : (
          <span className="catalog__version" data-testid="deck-revision">
            {catalogRevisionLabel(catalog)}
          </span>
        )}
        {saveError === undefined ? null : (
          <span className="field__error" role="alert" data-testid="deck-save-error">
            {saveError}
          </span>
        )}
        {notice === undefined ? null : (
          <span className="field__hint" role="status" data-testid="deck-notice">
            {notice}
          </span>
        )}
        <div className="row">
          <button className="primary" type="button" data-testid="deck-save" onClick={handleSave}>
            保存草稿
          </button>
          <button className="secondary" type="button" data-testid="deck-back" onClick={onBack}>
            返回卡组列表
          </button>
        </div>
      </section>

      <section className="card" aria-label="本机缓存校验">
        <h3 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
          本机缓存校验
        </h3>
        {offlineValidation === undefined || offlineSummary === undefined ? (
          <span className="field__hint" data-testid="deck-catalog-missing">
            卡牌目录尚未加载，离线校验不可用；草稿仍保存在本机。
          </span>
        ) : (
          <>
            <span
              className={`badge badge--${offlineSummary.tone === 'ok' ? 'ok' : offlineSummary.tone === 'warn' ? 'warn' : 'danger'}`}
              data-testid="deck-offline-summary"
            >
              {offlineSummary.label}
            </span>
            <span className="catalog__version" data-testid="deck-offline-revision">
              依据本机缓存：环境 {offlineValidation.environmentId} · 目录版本{' '}
              {shortRevision(offlineValidation.catalogVersion)} · 资料修订 {shortRevision(offlineValidation.dataRevision)}
            </span>
            {offlineValidation.problems.length === 0 ? null : (
              <ul className="deck-problems" data-testid="deck-offline-problems">
                {offlineValidation.problems.map((problem, index) => (
                  <li
                    key={`${problem.code}-${index}`}
                    className={`deck-problem deck-problem--${problem.kind}`}
                    data-testid={`deck-offline-problem-${index}`}
                  >
                    {problem.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="card" aria-label="服务端校验">
        <h3 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
          服务端当前目录校验
        </h3>
        {validator === undefined ? (
          <span className="field__hint" data-testid="deck-server-unavailable">
            设置有效的服务地址后才能请求服务端校验；正式开局始终以服务端结果为准。
          </span>
        ) : (
          <>
            <span className="field__hint">服务端会独立重算合法性与效果就绪状态，不读取客户端声明。</span>
            <button
              className="secondary"
              type="button"
              data-testid="deck-server-validate"
              onClick={handleServerValidate}
              disabled={server.phase === 'checking'}
            >
              {server.phase === 'checking' ? '正在请求服务端…' : '用服务端当前目录校验'}
            </button>
            {server.phase === 'error' ? (
              <span className="field__error" role="alert" data-testid="deck-server-error">
                {server.message}
              </span>
            ) : null}
            {server.phase === 'done' ? (
              <>
                <span
                  className={`badge badge--${
                    server.response.ready ? 'ok' : server.response.legal ? 'warn' : 'danger'
                  }`}
                  data-testid="deck-server-summary"
                >
                  {validationSummary(server.response).label}
                </span>
                <span className="catalog__version" data-testid="deck-server-revision">
                  服务端：环境 {server.response.environmentId} · 目录版本 {shortRevision(server.response.catalogVersion)} · 资料修订{' '}
                  {shortRevision(server.response.dataRevision)}
                </span>
                {server.staleCatalog ? (
                  <span className="notice" data-testid="deck-server-stale">
                    服务端目录版本与本机缓存不同，本次结果以服务端为准；本机缓存会在下次在线刷新后更新。
                  </span>
                ) : null}
                {server.response.problems.length === 0 ? null : (
                  <ul className="deck-problems" data-testid="deck-server-problems">
                    {server.response.problems.map((problem, index) => (
                      <li
                        key={`${problem.code}-${index}`}
                        className={`deck-problem deck-problem--${problem.kind}`}
                        data-testid={`deck-server-problem-${index}`}
                      >
                        {problem.message}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </>
        )}
      </section>

      <section className="card" aria-label="卡组内容">
        <h3 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
          卡组内容
        </h3>
        {cards.length === 0 ? (
          <span className="field__hint" data-testid="deck-empty">
            卡组里还没有卡牌。用下面的搜索从缓存卡池加入。
          </span>
        ) : (
          <ul className="catalog__list">
            {cards.map((entry) => {
              const card = catalog?.content.cards.find((candidate) => candidate.id === entry.cardId);
              return (
                <li key={entry.cardId} className="deck-row" data-testid={`deck-entry-${entry.cardId}`}>
                  <div className="deck-row__main">
                    <span className="catalog-card__name">{card?.nameZh ?? `未知卡牌 ${entry.cardId}`}</span>
                    <span className="catalog-card__number">
                      {card === undefined ? entry.cardId : card.print.displayNumber}
                      {card === undefined ? '' : ` · ${card.categoryLabelZh}`}
                    </span>
                  </div>
                  <div className="deck-row__side">
                    <button
                      className="deck-count-button"
                      type="button"
                      aria-label={`减少 ${card?.nameZh ?? entry.cardId}`}
                      data-testid={`deck-entry-dec-${entry.cardId}`}
                      onClick={() => changeCount(entry.cardId, -1)}
                    >
                      −
                    </button>
                    <span className="deck-count" data-testid={`deck-entry-count-${entry.cardId}`}>
                      {entry.count}
                    </span>
                    <button
                      className="deck-count-button"
                      type="button"
                      aria-label={`增加 ${card?.nameZh ?? entry.cardId}`}
                      data-testid={`deck-entry-inc-${entry.cardId}`}
                      onClick={() => changeCount(entry.cardId, 1)}
                    >
                      +
                    </button>
                    <button
                      className="deck-remove"
                      type="button"
                      aria-label={`移除 ${card?.nameZh ?? entry.cardId}`}
                      data-testid={`deck-entry-remove-${entry.cardId}`}
                      onClick={() => removeCard(entry.cardId)}
                    >
                      移除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" aria-label="从缓存卡池加入">
        <h3 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
          从缓存卡池加入卡牌
        </h3>
        <div className="field">
          <label className="field__label" htmlFor="deck-card-search">
            搜索简中名称、商品/卡牌编号或类别
          </label>
          <input
            id="deck-card-search"
            data-testid="deck-card-search"
            name="deckCardSearch"
            type="text"
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="例如 古剑豹 / CSVE1C / 物品"
            disabled={catalog === undefined}
          />
          <span className="field__hint">离线时使用本机缓存卡池；同名不同效果的卡牌各自独立列出。</span>
        </div>
        {searchResults.length === 0 ? null : (
          <ul className="catalog__list">
            {searchResults.map((card) => (
              <li key={card.id} className="deck-row" data-testid={`deck-search-result-${card.id}`}>
                <div className="deck-row__main">
                  <span className="catalog-card__name">{card.nameZh}</span>
                  <span className="catalog-card__number">
                    {card.print.displayNumber} · {card.categoryLabelZh} ·{' '}
                    {card.flags.effectSupported ? '效果已支持' : '效果未接入'}
                  </span>
                </div>
                <div className="deck-row__side">
                  <span className="deck-count">已加 {countOf(card.id)}</span>
                  <button
                    className="secondary"
                    type="button"
                    data-testid={`deck-add-${card.id}`}
                    onClick={() => addCard(card)}
                  >
                    加入
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-label="导入导出">
        <h3 className="value__label" style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>
          文本导入 / 导出
        </h3>
        <div className="field">
          <label className="field__label" htmlFor="deck-import-text">
            卡组分享文本
          </label>
          <textarea
            id="deck-import-text"
            data-testid="deck-import-text"
            className="deck-textarea"
            rows={6}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={`${DECK_TEXT_HEADER}/1\nENV ${catalog?.content.environment.id ?? '环境标识'}\n4 卡牌编号 print:... fx:...`}
            disabled={catalog === undefined}
          />
          {importIssues.length === 0 ? null : (
            <ul className="deck-problems" data-testid="deck-import-errors">
              {importIssues.map((issue, index) => (
                <li key={index} className="deck-problem deck-problem--legality">
                  {issue}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="row">
          <button className="secondary" type="button" data-testid="deck-import" onClick={handleImport} disabled={catalog === undefined}>
            导入并替换
          </button>
          <button className="secondary" type="button" data-testid="deck-export" onClick={handleExport} disabled={catalog === undefined}>
            生成导出文本
          </button>
        </div>
        {exportText === undefined ? null : (
          <div className="field">
            <label className="field__label" htmlFor="deck-export-text">
              导出文本（可复制分享）
            </label>
            <textarea
              id="deck-export-text"
              data-testid="deck-export-text"
              className="deck-textarea"
              rows={8}
              readOnly
              value={exportText}
            />
            <button className="secondary" type="button" data-testid="deck-copy-export" onClick={handleCopyExport}>
              复制导出文本
            </button>
          </div>
        )}
        <p className="field__hint">
          导入失败时不会改动当前草稿；文本带格式版本、环境标识、印刷身份与效果身份，重印和异画不会被按名称猜测。
        </p>
      </section>
    </>
  );
}
