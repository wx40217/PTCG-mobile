import { describe, expect, it } from 'vitest';
import { lockScreenOrientation } from '../src/app/orientation.ts';

/**
 * 运行时方向切换：对战横屏、组卡竖屏。
 *
 * 原生平台通过 @capacitor/screen-orientation 锁定；浏览器/测试环境（jsdom）保持
 * 系统方向并返回 false，不抛错、不阻塞界面，也不改变规则。
 */
describe('运行时方向切换（#17）', () => {
  it('非原生环境不锁定方向，也不抛错', async () => {
    await expect(lockScreenOrientation('landscape')).resolves.toBe(false);
    await expect(lockScreenOrientation('portrait')).resolves.toBe(false);
  });
});
