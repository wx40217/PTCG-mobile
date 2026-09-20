import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from '../src/trainerEffects.ts';

/**
 * 目录“效果支持”与正式服务注册表必须一致：目录多标一张未实现的卡会把不该
 * 玩的卡显示为可用，注册表少登记一张已标支持的卡会让本来可玩的卡被拒绝。
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const catalog = JSON.parse(readFileSync(`${root}data/catalog/zh-cn-standard-2025-06-05-catalog.json`, 'utf8')) as {
  readonly cards: readonly {
    readonly id: string;
    readonly nameZh: string;
    readonly cardClass: string;
    readonly effectiveCategory: string | null;
    readonly flags: { readonly effectSupported: boolean };
    readonly identities: { readonly effectIdentity: string };
  }[];
};

describe('发行目录效果支持与训练家效果注册表一致（T10 / #11）', () => {
  it('目录中已支持的训练家卡效果身份恰好等于发行注册表', () => {
    const supported = catalog.cards.filter((card) => card.flags.effectSupported);
    expect(supported).toHaveLength(7);
    const supportedIdentities = new Set(supported.map((card) => card.identities.effectIdentity));
    const registered = new Set([...PRODUCTION_TRAINER_EFFECTS.keys(), ...PRODUCTION_STADIUM_EFFECTS.keys()]);
    expect([...supportedIdentities].sort()).toEqual([...registered].sort());
    for (const card of supported) {
      expect(card.cardClass).toBe('trainer');
      expect(['物品', '支援者', '竞技场']).toContain(card.effectiveCategory);
      expect(PRODUCTION_TRAINER_EFFECTS.has(card.identities.effectIdentity)).toBe(true);
    }
  });

  it('未注册的效果身份在目录中继续标为未接入', () => {
    const registered = new Set([...PRODUCTION_TRAINER_EFFECTS.keys(), ...PRODUCTION_STADIUM_EFFECTS.keys()]);
    for (const card of catalog.cards) {
      if (card.flags.effectSupported) {
        continue;
      }
      // 未接入的效果身份绝不能被注册表实现半边（否则目录与行为会互相矛盾）。
      if (registered.has(card.identities.effectIdentity)) {
        throw new Error(`${card.id}（${card.nameZh}）已注册效果但仍标为未接入`);
      }
    }
    expect(catalog.supportPolicy.engineIntegration).toBe('integrated');
    expect(catalog.supportPolicy.playable).toBe(false);
  });
});
