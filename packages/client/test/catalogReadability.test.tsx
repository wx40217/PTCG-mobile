import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CardDetailScreen } from '../src/ui/CardDetailScreen.tsx';
import { createImageCache, createMemoryImageCacheStorage } from '../src/catalog/imageCache.ts';
import { catalogDocumentWithRuntime } from './catalogHelpers.ts';

function testImageCache() {
  return createImageCache(createMemoryImageCacheStorage(), {
    fetchImage: async () => {
      throw new Error('测试环境不应发起图片下载');
    },
  });
}

/**
 * 低分辨率 / 长文本 / 无图的静态可读性检查。
 *
 * jsdom 不做真实排版，因此这里检查两类可机检的不变量：
 *   - 样式表对完整文字使用换行与断词、不使用省略号或行数截断；
 *   - 详情在“无卡图”时仍把完整文字与关键数值放进 DOM，且不渲染误导性的图片。
 */

function stylesheet(): string {
  return readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
}

describe('完整文字样式不截断', () => {
  it('.fulltext 保留换行并允许任意位置断词', () => {
    const css = stylesheet();
    const block = css.slice(css.indexOf('.fulltext'));
    expect(block).toContain('white-space: pre-wrap');
    expect(block).toContain('overflow-wrap: anywhere');
  });

  it('目录与详情不使用省略号截断或行数裁剪', () => {
    const css = stylesheet();
    expect(css).not.toContain('text-overflow: ellipsis');
    expect(css).not.toContain('line-clamp');
  });

  it('窄屏下目录卡片标题允许换行', () => {
    const css = stylesheet();
    const block = css.slice(css.indexOf('.catalog-card__name'), css.indexOf('.catalog-card__number'));
    expect(block).toContain('overflow-wrap: anywhere');
  });
});

describe('无图详情仍可完整阅读', () => {
  it('渲染完整卡面文字、HP、弱点与身份，不出现卡图元素', () => {
    const { catalog } = catalogDocumentWithRuntime();
    const card = catalog.content.cards.find((entry) => entry.id === 'csv3c-043');
    expect(card).toBeDefined();
    const { container } = render(
      <CardDetailScreen
        card={card!}
        catalog={catalog}
        imageCache={testImageCache()}
        onBack={() => undefined}
        resolveAssetUrl={(path) => `https://service.test/${path}`}
        onOpenImage={() => undefined}
      />,
    );
    expect(screen.getByTestId('card-detail-fulltext').textContent).toBe(card!.fullTextZh);
    expect(screen.getByText('220')).toBeInTheDocument();
    expect(screen.getByText('钢×2')).toBeInTheDocument();
    expect(screen.getByText('print:CSV3C:043/130')).toBeInTheDocument();
    expect(screen.getByTestId('card-detail-no-image')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('窄视口下关键信息仍在文档中（jsdom 不排版，仅验证可访问性不依赖布局）', () => {
    const previous = window.innerWidth;
    window.innerWidth = 320;
    try {
      const { catalog } = catalogDocumentWithRuntime();
      const card = catalog.content.cards.find((entry) => entry.id === 'csve1-138');
      expect(card).toBeDefined();
      render(
        <CardDetailScreen
          card={card!}
          catalog={catalog}
          imageCache={testImageCache()}
          onBack={() => undefined}
          resolveAssetUrl={() => ''}
          onOpenImage={() => undefined}
        />,
      );
      expect(screen.getByTestId('card-detail-fulltext').textContent).toBe(card!.fullTextZh);
      expect(screen.getAllByText(/支援者/u).length).toBeGreaterThan(0);
    } finally {
      window.innerWidth = previous;
    }
  });
});
