import type { ReactElement, ReactNode } from 'react';
import type { MatchCardView } from '@ptcg/protocol';
import type { ImageCache } from '../catalog/imageCache.ts';
import { useCardImage } from '../catalog/useCardImage.ts';

/**
 * 牌桌上的卡面：文字卡面始终渲染，卡图可用时叠加在文字之上。
 *
 * 缺图、下载失败或服务端未提供卡图时，文字卡面（名称、类别、HP、印刷编号）
 * 仍然完整可读，保证「缺图仍可玩」。点击目标不小于 48 dp（由 CSS 保证），
 * 牌桌高亮（可选中目标）与选中态都用属性暴露给测试与辅助技术。
 */

export interface CardFaceImageSource {
  readonly cache: ImageCache;
  /** 已解析的可下载地址；目录未提供卡图时为空串。 */
  readonly url: string;
  /** 目录声明的期望 SHA-256；null 表示没有可分发卡图。 */
  readonly sha256: string | null;
}

export interface CardFaceProps {
  readonly card: MatchCardView;
  readonly testId: string;
  readonly variant?: 'board' | 'hand' | 'pile';
  /** 玩家可读的完整描述，供辅助技术朗读；不得包含对手隐藏信息。 */
  readonly descriptionZh: string;
  readonly selected?: boolean;
  /** 当前动作下该卡面是合法目标：牌桌上高亮且可点选。 */
  readonly targetable?: boolean;
  readonly disabled?: boolean;
  readonly image?: CardFaceImageSource | undefined;
  readonly onPress?: (() => void) | undefined;
  /** 叠加在卡面上的公开状态徽标（HP、伤害、特殊状态、附着卡）。 */
  readonly children?: ReactNode;
}

function CardFaceImage(props: { readonly source: CardFaceImageSource; readonly card: MatchCardView }): ReactElement | null {
  const image = useCardImage(props.source.cache, {
    cacheKey: `card:${props.card.cardId}`,
    expectedSha256: props.source.sha256,
    url: props.source.url,
    enabled: props.source.url.length > 0,
  });
  if (image.src.length === 0) {
    return null;
  }
  // 有图时文字卡面仍然保留：图片解码失败或被系统字体缩放遮挡时依然可辨认。
  return <img className="cardface__image" src={image.src} alt="" aria-hidden="true" />;
}

export function CardFace(props: CardFaceProps): ReactElement {
  const { card } = props;
  const className = [
    'cardface',
    `cardface--${props.variant ?? 'board'}`,
    props.selected === true ? 'is-selected' : '',
    props.targetable === true ? 'is-target' : '',
  ]
    .filter((entry) => entry.length > 0)
    .join(' ');
  const body = (
    <>
      {props.image === undefined || props.image.url.length === 0 ? null : <CardFaceImage source={props.image} card={card} />}
      <span className="cardface__text">
        <span className="cardface__name">{card.nameZh}</span>
        <span className="cardface__meta">
          {card.classLabelZh}
          {card.hp === null ? '' : ` · HP${card.hp}`}
        </span>
        {card.evolvesFrom === null ? null : <span className="cardface__meta">进化自 {card.evolvesFrom}</span>}
        <span className="cardface__number">{card.printDisplayNumber}</span>
      </span>
      {props.children}
    </>
  );
  if (props.onPress === undefined) {
    return (
      <span className={className} data-testid={props.testId} aria-label={props.descriptionZh} data-targetable={props.targetable === true ? 'true' : 'false'}>
        {body}
      </span>
    );
  }
  return (
    <button
      className={className}
      type="button"
      data-testid={props.testId}
      aria-label={props.descriptionZh}
      aria-pressed={props.selected === true}
      data-targetable={props.targetable === true ? 'true' : 'false'}
      disabled={props.disabled === true}
      onClick={props.onPress}
    >
      {body}
    </button>
  );
}
