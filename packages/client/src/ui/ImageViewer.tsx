import { useEffect, useState, type ReactElement } from 'react';

/** 可缩放的图片查看器：资源样本与卡图共用，文字卡面始终在原页面保留。 */
export interface ImageViewerProps {
  readonly src: string;
  readonly labelZh: string;
  readonly provenanceZh: string;
  readonly onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10));
}

export function ImageViewer({ src, labelZh, provenanceZh, onClose }: ImageViewerProps): ReactElement {
  const [zoom, setZoom] = useState(MIN_ZOOM);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`${labelZh}（可放大查看）`}>
      <div className="viewer__bar">
        <button className="secondary" type="button" aria-label="缩小" onClick={() => setZoom((value) => clampZoom(value - 0.5))}>
          －
        </button>
        <span className="viewer__zoom" data-testid="viewer-zoom">
          {Math.round(zoom * 100)}%
        </span>
        <button className="secondary" type="button" aria-label="放大" onClick={() => setZoom((value) => clampZoom(value + 0.5))}>
          ＋
        </button>
        <button className="secondary" type="button" onClick={() => setZoom(MIN_ZOOM)}>
          适应屏幕
        </button>
        <button className="primary" type="button" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="viewer__stage">
        <img
          className="viewer__image"
          src={src}
          alt={labelZh}
          style={{ width: `${zoom * 100}%` }}
          data-testid="viewer-image"
        />
      </div>
      <p className="viewer__provenance">{provenanceZh}</p>
    </div>
  );
}
