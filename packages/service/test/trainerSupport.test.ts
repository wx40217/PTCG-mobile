import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_STADIUM_EFFECTS, PRODUCTION_TRAINER_EFFECTS } from '../src/trainerEffects.ts';
import { PRODUCTION_ABILITY_EFFECTS, PRODUCTION_ATTACK_EFFECTS, PRODUCTION_TOOL_EFFECTS } from '../src/pokemonEffects.ts';

/**
 * 目录“效果支持”与正式服务注册表必须一致：目录多标一张未实现的卡会把不该
 * 玩的卡显示为可用，注册表少登记一张已标支持的卡会让本来可玩的卡被拒绝。
 *
 * 招式与特性注册键是 `效果身份#名称`；目录按效果身份标记整张卡。这里把
 * 招式/特性键还原成效果身份后与目录比较，仍要求“整张卡全部实现”。
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

function productionEffectIdentities(): Set<string> {
  const identities = new Set<string>([
    ...PRODUCTION_TRAINER_EFFECTS.keys(),
    ...PRODUCTION_STADIUM_EFFECTS.keys(),
    ...PRODUCTION_TOOL_EFFECTS.keys(),
  ]);
  for (const key of [...PRODUCTION_ATTACK_EFFECTS.keys(), ...PRODUCTION_ABILITY_EFFECTS.keys()]) {
    identities.add(key.split('#')[0] as string);
  }
  return identities;
}

describe('发行目录效果支持与效果注册表一致（T10 / #11 + T11 / #12）', () => {
  it('目录中已支持的效果身份恰好等于发行注册表', () => {
    const supported = catalog.cards.filter((card) => card.flags.effectSupported);
    expect(supported).toHaveLength(11);
    const supportedIdentities = new Set(supported.map((card) => card.identities.effectIdentity));
    expect([...supportedIdentities].sort()).toEqual([...productionEffectIdentities()].sort());
  });

  it('已支持卡牌的类别与注册表归属一致', () => {
    const supported = catalog.cards.filter((card) => card.flags.effectSupported);
    for (const card of supported) {
      const effectIdentity = card.identities.effectIdentity;
      if (card.cardClass === 'pokemon') {
        expect(effectIdentity).toMatch(/^fx:pokemon:/u);
        const abilityOrAttack = [...PRODUCTION_ATTACK_EFFECTS.keys(), ...PRODUCTION_ABILITY_EFFECTS.keys()].some((key) =>
          key.startsWith(`${effectIdentity}#`),
        );
        expect(abilityOrAttack).toBe(true);
        continue;
      }
      expect(card.cardClass).toBe('trainer');
      if (card.effectiveCategory === '宝可梦道具') {
        expect(PRODUCTION_TOOL_EFFECTS.has(effectIdentity)).toBe(true);
        continue;
      }
      expect(['物品', '支援者', '竞技场']).toContain(card.effectiveCategory);
      expect(
        PRODUCTION_TRAINER_EFFECTS.has(effectIdentity) || PRODUCTION_STADIUM_EFFECTS.has(effectIdentity),
      ).toBe(true);
    }
  });

  it('未注册的效果身份在目录中继续标为未接入', () => {
    const registered = productionEffectIdentities();
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
