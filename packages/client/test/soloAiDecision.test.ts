import { describe, expect, it } from 'vitest';
import { parseMatchClientMessage, type MatchCardView, type MatchPendingChoiceView, type MatchPokemonView, type MatchView } from '@ptcg/protocol';
import { localCatalog } from '../src/local/session.ts';
import { decideSoloAi, estimateDamage } from '../src/solo/aiDecision.ts';
import { matchView, matchSide, matchPokemon } from './matchHelpers.ts';

const catalog = localCatalog();
const V = 'csve1-062', VMAX = 'csve1-063', MEW = 'csve1-056', WORM = 'csv3c-095', CHEIN = 'csv3c-043', WO = 'csv3c-015';
function card(id: string): MatchCardView {
  const c = catalog.cards.find(c => c.id === id)!;
  return { cardId: id, nameZh: c.nameZh, kind: c.cardClass, classLabelZh: c.classLabelZh, isBasicPokemon: c.subtypes.includes('基础'), evolvesFrom: c.evolvesFrom, type: c.type, hp: c.hp, printDisplayNumber: c.print.displayNumber };
}
function pokemon(id: string, energy = 0, damageCounters = 0): MatchPokemonView {
  const c = catalog.cards.find(c => c.id === id)!;
  const energyId = id === WO ? 'cbb1c-1801' : id === CHEIN ? 'cbb1c-1803' : 'cbb2c-1102';
  return matchPokemon({ card: card(id), maxHp: c.hp!, damageCounters, weakness: c.weakness, resistance: c.resistance, retreatCost: c.retreat!,
    attacks: c.attacks.map((a, index) => ({ index, name: a.name, cost: a.cost, damageText: a.damage, effectTextZh: a.text, supported: true })),
    energies: Array.from({ length: energy }, (_, energyIndex) => ({ energyIndex, card: card(energyId) })),
  });
}
function view(active: MatchPokemonView, hand: MatchCardView[] = [], bench: MatchPokemonView[] = []): MatchView {
  return matchView({ phase: 'playing', turn: 3, activeSeat: 0, you: matchSide(0, { active, hand, handCount: hand.length, bench, prizeCount: 6 }), opponent: matchSide(1, { active: pokemon(CHEIN), bench: [pokemon(MEW)], prizeCount: 6 }) });
}
function pending(kind: MatchPendingChoiceView['kind'], extra: Partial<MatchPendingChoiceView> = {}): MatchPendingChoiceView {
  return { kind, choiceId: 'choice-1', seat: 0, min: 0, max: 1, benchMin: 0, benchMax: 5, candidates: [], cardCandidates: [], modes: [], source: 'none', descriptionZh: '', step: 1, stepCount: 1, ...extra };
}
describe('S02 observable tactical decisions', () => {
  it('林悦先铺钢属性再和弦，并在合法时进化', () => {
    const v = view(pokemon(VMAX, 3), [card(WORM)], [pokemon(MEW)]);
    expect(decideSoloAi(v, 'linyue', catalog)[0]!.command).toMatchObject({ type: 'play-basic', handIndex: 0 });
    expect(decideSoloAi(view(pokemon(V), [card(VMAX)]), 'linyue', catalog)[0]!.command.type).toBe('evolve');
    expect(decideSoloAi(view({ ...pokemon(V), canEvolve: false }, [card(VMAX)]), 'linyue', catalog).some(d => d.command.type === 'evolve')).toBe(false);
  });
  it('林悦有致胜攻击时不回复拖延，平时可用珍贵一触救后备', () => {
    const v = view(pokemon(VMAX, 3), [card('cbb2c-1102')], [pokemon(V, 1, 12)]);
    const finish = { ...v, you: { ...v.you, prizeCount: 2 }, opponent: { ...v.opponent, active: { ...pokemon(MEW), damageCounters: 10 } } };
    expect(decideSoloAi(finish, 'linyue', catalog)[0]!.command).toMatchObject({ type: 'attack', attackIndex: 1 });
    const healing = { ...v, you: { ...v.you, energyAttachedThisTurn: true } };
    expect(decideSoloAi(healing, 'linyue', catalog)[0]!.command).toMatchObject({ type: 'attack', attackIndex: 0 });
  });
  it('沧澜120HP只弃2水；最后奖赏允许全弃；不会重复手贴', () => {
    const v = view(pokemon(CHEIN, 4), [card('cbb1c-1803')]);
    const choice = pending('discard-energy', { max: 4, source: 'own-field-energy', cardCandidates: Array.from({ length: 4 }, (_, i) => ({ candidateId: `active:${i}`, card: card('cbb1c-1803') })) });
    const damage = { ...v, pendingChoice: choice, opponent: { ...v.opponent, active: { ...pokemon(MEW), damageCounters: 6 } } };
    expect(decideSoloAi(damage, 'canglan', catalog)[0]!.command).toMatchObject({ type: 'discard-energy', candidateIds: ['active:0', 'active:1'] });
    const finish = { ...v, pendingChoice: choice, you: { ...v.you, prizeCount: 2 } };
    expect(decideSoloAi(finish, 'canglan', catalog)[0]!.command).toMatchObject({ candidateIds: ['active:0', 'active:1', 'active:2', 'active:3'] });
    expect(decideSoloAi({ ...v, you: { ...v.you, energyAttachedThisTurn: true } }, 'canglan', catalog).some(d => d.command.type === 'attach-energy')).toBe(false);
  });
  it('岩森按公开奖赏狙击120HP后备，零奖赏改用森林，致胜优先', () => {
    const v = view(pokemon(WO, 4));
    const opponent = { ...v.opponent, prizeCount: 4, active: pokemon(CHEIN), bench: [{ ...pokemon(MEW), damageCounters: 6 }] };
    expect(decideSoloAi({ ...v, opponent }, 'yansen', catalog)[0]!.command).toMatchObject({ type: 'attack', attackIndex: 0 });
    expect(decideSoloAi(v, 'yansen', catalog)[0]!.command).toMatchObject({ type: 'attack', attackIndex: 1 });
    const finish = { ...v, you: { ...v.you, prizeCount: 2 }, opponent: { ...opponent, active: { ...pokemon(CHEIN), damageCounters: 2 }, bench: [pokemon(WORM)] } };
    expect(decideSoloAi(finish, 'yansen', catalog)[0]!.command).toMatchObject({ type: 'attack', attackIndex: 1 });
  });
  it('高级球保留唯一VMAX和下一张能量，检索实际缺失的进化件', () => {
    const v = view(pokemon(V), [card(VMAX), card('cbb2c-1102'), card('csv2c-118'), card('csv2c-118')]);
    expect(decideSoloAi({ ...v, pendingChoice: pending('discard-hand', { min: 2, max: 2, candidates: [0, 1, 2, 3] }) }, 'linyue', catalog)[0]!.command).toMatchObject({ handIndices: [2, 3] });
    const search = pending('search-deck', { cardCandidates: [{ candidateId: 'evolve', card: card(VMAX) }, { candidateId: 'spare', card: card(MEW) }] });
    expect(decideSoloAi({ ...view(pokemon(V)), pendingChoice: search }, 'linyue', catalog)[0]!.command).toMatchObject({ candidateIds: ['evolve'] });
  });
  it('捩木不把带伤目标换成会立即昏厥的低HP宝可梦', () => {
    const v = view(pokemon(WO, 4, 19), [card('csve1-157')]);
    const dangerous = { ...v, you: { ...v.you, discard: [card(MEW)] } };
    expect(decideSoloAi(dangerous, 'yansen', catalog).some(d => d.command.type === 'play-trainer')).toBe(false);
  });
  it('复制选择避开强制自引用，按实际可见招式选伤害', () => {
    const v = view(pokemon(MEW, 3));
    const target = { ...pokemon(MEW), attacks: [...pokemon(MEW).attacks, { ...pokemon(WO).attacks[1]!, index: 1 }] };
    expect(decideSoloAi({ ...v, opponent: { ...v.opponent, active: target }, pendingChoice: pending('copy-attack', { candidates: [0, 1] }) }, 'linyue', catalog)[0]!.command).toMatchObject({ type: 'copy-attack', attackIndex: 1 });
  });
  it('战术估算按弱点再抵抗，并拒绝在对手选择期间行动', () => {
    expect(estimateDamage(120, '草', { ...pokemon(MEW), weakness: '草×2', resistance: '草-30' })).toBe(210);
    expect(decideSoloAi({ ...view(pokemon(WO, 4)), waitingForOpponentChoice: true }, 'yansen', catalog)).toEqual([]);
    const v = view(pokemon(VMAX, 3), [card(WORM), card('cbb2c-1102')]);
    for (const decision of decideSoloAi(v, 'linyue', catalog)) expect(parseMatchClientMessage(decision.command)?.ok).toBe(true);
    expect(decideSoloAi(structuredClone(v), 'linyue', structuredClone(catalog))).toEqual(decideSoloAi(v, 'linyue', catalog));
  });
});
