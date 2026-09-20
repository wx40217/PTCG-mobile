import { isCardImageAvailable, type CatalogCard, type ServiceCatalog } from '@ptcg/protocol';
import { identityRelation, identityRelationLabel } from '../catalog/search.ts';
import { shortVersion } from '../catalog/format.ts';
import type { ReactElement, ReactNode } from 'react';
import type { CatalogImageRequest } from './CatalogScreen.tsx';

export interface CardDetailScreenProps {
  readonly card: CatalogCard;
  readonly catalog: ServiceCatalog;
  readonly onBack: () => void;
  readonly resolveAssetUrl: (path: string) => string;
  readonly onOpenImage: (image: CatalogImageRequest) => void;
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="detail__row">
      <span className="detail__label">{label}</span>
      <span className="detail__value">{children}</span>
    </div>
  );
}

function CostChips({ cost }: { readonly cost: readonly string[] }): ReactElement {
  return (
    <span className="costs">
      {cost.map((entry, index) => (
        <span className="cost" key={`${entry}-${index}`}>
          {entry}
        </span>
      ))}
    </span>
  );
}

export function CardDetailScreen(props: CardDetailScreenProps): ReactElement {
  const { card, catalog } = props;
  const relation = identityRelation(card, catalog.content.cards);
  const imageStatus = catalog.runtime.cardImages[card.id];
  const imagePath = imageStatus?.path ?? null;
  const imageAvailable =
    card.imageSource !== null && isCardImageAvailable(catalog, card.id) && imageStatus !== undefined && imagePath !== null;
  const imageUrl = imageAvailable && imagePath !== null ? props.resolveAssetUrl(imagePath) : '';

  return (
    <>
      <div className="row">
        <button className="secondary" type="button" onClick={props.onBack} data-testid="card-detail-back">
          返回目录
        </button>
      </div>

      <section className="card" aria-label="卡牌详情">
        <h2 className="catalog__title" data-testid="card-detail-name">
          {card.nameZh}
        </h2>
        <div className="value__label">
          {card.classLabelZh} · {card.categoryLabelZh} · {card.print.displayNumber} · {card.productNameZh}
        </div>
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
        {relation === 'unique' ? null : (
          <p className="notice" data-testid="card-detail-relation">
            {identityRelationLabel(relation)}
          </p>
        )}

        <div className="detail__group" aria-label="三项独立状态">
          <Row label="环境合法">{card.flags.legalityNoteZh}</Row>
          <Row label="效果支持">{card.flags.effectNoteZh}</Row>
          <Row label="卡图状态">
            {imageAvailable
              ? `${imageStatus?.labelZh ?? '卡图'}（来自本机配置；T01 已核实哈希）`
              : '无可用卡图：以完整文字卡面兜底。'}
          </Row>
        </div>

        <div className="detail__group" aria-label="身份">
          <Row label="印刷身份">{card.identities.printIdentity}</Row>
          <Row label="效果身份">{card.identities.effectIdentity}</Row>
          <Row label="同名组">{card.identities.nameGroupKey}</Row>
          {card.decks.length === 0 ? null : <Row label="预设卡组">{card.decks.join('、')}</Row>}
        </div>

        <div className="detail__group" aria-label="卡牌数值">
          {card.type === null ? null : <Row label="属性">{card.type}</Row>}
          {card.hp === null ? null : <Row label="HP">{card.hp}</Row>}
          {card.weakness === null ? null : <Row label="弱点">{card.weakness}</Row>}
          {card.resistance === null ? null : <Row label="抵抗">{card.resistance}</Row>}
          {card.retreat === null ? null : <Row label="撤退">{card.retreat}</Row>}
          {card.evolvesFrom === null ? null : <Row label="进化自">{card.evolvesFrom}</Row>}
          {card.pokedexText === null ? null : <Row label="图鉴">{card.pokedexText}</Row>}
          <Row label="印刷编号">{card.print.displayNumber}</Row>
          <Row label="赛制标记">{card.print.regulationMark ?? '基本能量（无标记要求）'}</Row>
          {card.print.illustrator === null ? null : <Row label="画师">{card.print.illustrator}</Row>}
        </div>
      </section>

      <section className="card" aria-label="效果">
        {card.abilities.length === 0 && card.attacks.length === 0 ? null : <h3 className="detail__heading">特性与招式</h3>}
        {card.abilities.map((ability) => (
          <div className="move" key={`ability-${ability.name}`}>
            <div className="move__name">
              【{ability.label}】{ability.name}
            </div>
            <p className="move__text">{ability.text}</p>
          </div>
        ))}
        {card.attacks.map((attack) => (
          <div className="move" key={`attack-${attack.name}`}>
            <div className="move__name">
              <CostChips cost={attack.cost} /> {attack.name}
              {attack.damage === null ? '' : ` ${attack.damage}`}
            </div>
            {attack.attackKind === null ? null : <span className="badge badge--note">{attack.attackKind}</span>}
            {attack.text === null ? null : <p className="move__text">{attack.text}</p>}
          </div>
        ))}
        {card.specialRuleTextZh === null ? null : <p className="move__text">{card.specialRuleTextZh}</p>}
        {card.toolBannerTextZh === null ? null : <p className="move__text">{card.toolBannerTextZh}</p>}
        <h3 className="detail__heading">完整卡面文字</h3>
        <pre className="fulltext" data-testid="card-detail-fulltext">
          {card.fullTextZh}
        </pre>
        <p className="field__hint" data-testid="card-detail-text-fallback">
          以上文字是 T01 逐图核实的简中资料；卡图不可用或加载失败时，效果与数值仍可完整阅读。
        </p>
      </section>

      <section className="card" aria-label="卡图">
        {imageAvailable && imageUrl.length > 0 ? (
          <>
            <img className="detail__thumb" src={imageUrl} alt={`${card.nameZh} 官方商品图`} />
            <button
              className="secondary"
              type="button"
              onClick={() =>
                props.onOpenImage({
                  src: imageUrl,
                  labelZh: `${card.nameZh} ${card.print.displayNumber}`,
                  provenanceZh: imageStatus?.provenanceZh ?? '',
                })
              }
            >
              放大查看卡图
            </button>
            <p className="field__hint">{imageStatus?.provenanceZh}</p>
          </>
        ) : (
          <p className="field__hint" data-testid="card-detail-no-image">
            无可用卡图：不依赖图片也能阅读完整效果、类型与数值。图片字节由本机配置提供，仓库不分发。
          </p>
        )}
      </section>

      <div className="value__label" data-testid="card-detail-version">
        使用目录 {shortVersion(catalog.catalogVersion)} · 资料修订 {shortVersion(catalog.content.dataRevision.sourceDigest)}
      </div>
    </>
  );
}
