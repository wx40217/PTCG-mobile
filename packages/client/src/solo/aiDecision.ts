import {
  SOLO_OPPONENTS, type SoloOpponentId, type SoloOpponent, type CatalogContent,
  type MatchView, type MatchCardView, type MatchPokemonView, type MatchPokemonRef,
  type MatchAttackView, type MatchClientMessage, type MatchChoiceCandidateView,
} from '@ptcg/protocol';

/** Bump when ordering/payload rules change: persisted games pin this version. */
export const SOLO_AI_VERSION = 'solo-ai-v1';
type Intent = MatchClientMessage extends infer C ? C extends MatchClientMessage ? Omit<C, 'commandId' | 'sessionId' | 'expectedVersion'> : never : never;
export interface AiDecision { readonly command: MatchClientMessage; readonly reason: string }
interface Ranked { intent: Intent; score: number; reason: string }
const V = 'csve1-062', VMAX = 'csve1-063', MEW = 'csve1-056', WORM = 'csv3c-095';
const CHEIN = 'csv3c-043', WO = 'csv3c-015';
const hp = (p: MatchPokemonView) => p.maxHp - p.damageCounters * 10;
const field = (v: MatchView): { pokemon: MatchPokemonView; ref: MatchPokemonRef }[] => [
  ...(v.you.active ? [{ pokemon: v.you.active, ref: { slot: 'active' as const } }] : []),
  ...v.you.bench.map((pokemon, index) => ({ pokemon, ref: { slot: 'bench' as const, index } })),
];
const sorted = <T>(items: readonly T[], score: (item: T) => number) => items.map((item, index) => ({ item, index, score: score(item) })).sort((a, b) => b.score - a.score || a.index - b.index).map(x => x.item);

/** Heuristics estimate only public combat information; the shared session remains the rules authority. */
export function estimateDamage(base: number, type: string | null, target: MatchPokemonView): number {
  const weak = target.weakness?.match(/^(.+?)\s*[×x]\s*(\d+)$/u);
  const resist = target.resistance?.match(/^(.+?)\s*[-−]\s*(\d+)$/u);
  return Math.max(0, base * (weak?.[1] === type ? Number(weak[2]) : 1) - (resist?.[1] === type ? Number(resist[2]) : 0));
}
function affordable(p: MatchPokemonView, cost: readonly string[]): boolean {
  const types = p.energies.map(e => e.card.type);
  for (const type of cost.filter(t => t !== '无')) {
    const i = types.indexOf(type); if (i < 0) return false; types.splice(i, 1);
  }
  return types.length >= cost.filter(t => t === '无').length;
}
function prizes(p: MatchPokemonView): number {
  return p.card.classLabelZh.includes('VMAX') || p.card.nameZh.includes('VMAX') ? 3 : /ex$|V$/u.test(p.card.nameZh) ? 2 : 1;
}
function knockoutScore(v: MatchView, target: MatchPokemonView, damage: number, bench = false): number {
  if (damage <= 0) return 0;
  if (damage >= hp(target)) {
    if (prizes(target) >= v.you.prizeCount || (!bench && v.opponent.bench.length === 0)) return 10000;
    return 800 + prizes(target) * 150 + target.energies.length * 20;
  }
  return Math.min(damage, hp(target)) + damage / Math.max(1, hp(target)) * 40;
}
function mainId(o: SoloOpponent): string { return o.strategyId === 'harmony-evolution' ? V : o.strategyId === 'hail-resource' ? CHEIN : WO; }
function cardValue(card: MatchCardView, v: MatchView, o: SoloOpponent): number {
  const own = field(v).map(x => x.pokemon.card);
  const count = own.filter(c => c.cardId === card.cardId).length;
  if (card.cardId === VMAX && o.strategyId === 'harmony-evolution') return own.some(c => c.cardId === V) && !v.you.hand.some(c => c.cardId === VMAX) ? 150 : 65;
  if (card.cardId === mainId(o)) return count === 0 ? 140 : count === 1 ? 60 : 5;
  if (card.cardId === WORM && o.strategyId === 'harmony-evolution') return own.some(c => c.type === '钢') ? 0 : 100;
  if (card.cardId === MEW) return count === 0 ? 75 : 5;
  if (card.kind === 'pokemon') return count === 0 ? 30 : 0;
  if (card.kind === 'energy') return v.you.hand.filter(c => c.kind === 'energy').length < 2 ? 110 : 25;
  if (card.nameZh === '高级球') return 55;
  if (card.nameZh === '超级球' || card.nameZh === '精灵球') return 60;
  if (card.nameZh === '珠贝' || card.nameZh === '莎莉娜') return 50;
  return 20;
}
function keepValue(card: MatchCardView, v: MatchView, o: SoloOpponent): number {
  const copies = v.you.hand.filter(c => c.cardId === card.cardId).length;
  if (card.cardId === VMAX && o.strategyId === 'harmony-evolution' && copies === 1) return 1000;
  if (card.kind === 'energy' && v.you.hand.filter(c => c.kind === 'energy').length === 1) return 900;
  return cardValue(card, v, o) - (copies > 1 ? 30 : 0);
}
function fighterValue(p: MatchPokemonView, o: SoloOpponent): number {
  return (p.card.cardId === mainId(o) || p.card.cardId === VMAX ? 100 : p.card.cardId === MEW ? 35 : 0) + p.energies.length * 30 + hp(p) / 20;
}
function hailCount(v: MatchView): number {
  const active = v.you.active, target = v.opponent.active;
  const total = field(v).flatMap(x => x.pokemon.energies).filter(e => e.card.type === '水').length;
  if (!active || !target) return 0;
  for (let count = 1; count <= total; count++) if (estimateDamage(count * 60, active.card.type, target) >= hp(target)) return count;
  // Avoid spending the entire reserve on a non-KO unless it puts meaningful damage on the board.
  return Math.max(0, total - 1);
}
function attackValue(v: MatchView, p: MatchPokemonView, attack: MatchAttackView, o: SoloOpponent, copied = false): number {
  const target = v.opponent.active; if (!target || !attack.supported) return 0;
  let base = Number.parseInt(attack.damageText ?? '0', 10) || 0;
  switch (attack.name) {
    case '珍贵一触': return v.you.hand.some(c => c.kind === 'energy') ? Math.max(0, ...v.you.bench.map(b => b.damageCounters >= 5 ? 70 + Math.min(120, b.damageCounters * 10) : 0)) : 0;
    case '极巨和弦': base = 70 + new Set(v.you.bench.map(b => b.card.type)).size * 30; break;
    case '冰雹利刃': base = hailCount(v) * 60; break;
    case '月亮强念': base = 30 + p.energies.filter(e => e.card.type === '超').length * 30; break;
    case '贪欲藤蔓': return Math.max(0, ...v.opponent.bench.map(b => knockoutScore(v, b, (6 - v.opponent.prizeCount) * 60, true) + ((6 - v.opponent.prizeCount) > 0 ? 15 : 0)));
    case '基因侵入': return copied ? 0 : Math.max(0, ...target.attacks.map(a => attackValue(v, p, a, o, true)));
    case '巨人破坏': base = target.card.nameZh.includes('VMAX') ? 300 : 150; break;
    case '循环抽取': return v.you.deckCount > 5 && v.you.hand.length < 4 ? 35 : 0;
    case '妒火中烧': return v.opponent.deckCount <= 2 ? 10000 : 25;
  }
  return knockoutScore(v, target, estimateDamage(base, p.card.type, target));
}
function canAttack(v: MatchView, p: MatchPokemonView, attack: MatchAttackView): boolean {
  return !(v.turn === 1 && v.firstSeat === v.you.seat) && !p.statuses.some(s => s === '睡眠' || s === '麻痹') && affordable(p, attack.cost);
}

// The swap's first selection remains in discard until the second selection resolves.
// Recompute the same safe pair from public zones so restoring mid-choice needs no strategy memory.
function swapPair(v: MatchView, o: SoloOpponent): { card: MatchCardView; ref: MatchPokemonRef; score: number } | null {
  const pairs = v.you.discard.filter(c => c.isBasicPokemon).flatMap(card => field(v).filter(x => x.pokemon.card.isBasicPokemon).map(({ pokemon, ref }) => ({ card, ref,
    score: (card.hp ?? 0) <= pokemon.damageCounters * 10 ? -1000 :
      (card.cardId === mainId(o) ? 120 : card.cardId === MEW ? 20 : 0) - (pokemon.card.cardId === mainId(o) ? 120 : pokemon.card.cardId === MEW ? 20 : 0) + pokemon.energies.length * 3,
  })));
  return sorted(pairs, p => p.score)[0] ?? null;
}

function choices(v: MatchView, o: SoloOpponent): Ranked[] {
  const p = v.pendingChoice!;
  const base = { choiceId: p.choiceId };
  const one = (intent: Intent, reason: string): Ranked[] => [{ intent, score: 1, reason }];
  const candidates = p.cardCandidates.filter(c => c.selectable !== false);
  const chooseCards = (rank: (c: MatchChoiceCandidateView) => number, optionalUseful = true) => {
    const order = sorted(candidates, rank);
    const selected = order.filter((c, i) => i < p.min || !optionalUseful || rank(c) > 0).slice(0, p.max);
    return selected.map(c => c.candidateId);
  };
  switch (p.kind) {
    case 'turn-order': return one({ ...base, type: 'choose-turn-order', goFirst: true }, '先攻积累附能与进化时机');
    case 'place-setup': {
      const order = sorted(p.candidates, i => cardValue(v.you.hand[i]!, v, o));
      const active = order[0]; if (active === undefined) return [];
      const seen = new Set<string>([v.you.hand[active]!.cardId]);
      const bench = order.slice(1).filter(i => { const c = v.you.hand[i]!; const use = !seen.has(c.cardId) || c.cardId === mainId(o); seen.add(c.cardId); return use; }).slice(0, Math.min(3, p.benchMax));
      return one({ ...base, type: 'place-setup', active, bench }, '主攻站场并保留后备');
    }
    case 'place-bench': return one({ ...base, type: 'place-bench', bench: sorted(p.candidates, i => cardValue(v.you.hand[i]!, v, o)).filter(i => cardValue(v.you.hand[i]!, v, o) > 20).slice(0, Math.min(p.benchMax, Math.max(0, 3 - v.you.bench.length))) }, '补足展开');
    case 'compensation-draw': return one({ ...base, type: 'resolve-compensation', draw: Math.min(p.max, Math.max(p.min, v.you.deckCount - 10)) }, '补充可用资源并保留牌库');
    case 'take-prizes': return one({ ...base, type: 'take-prizes', prizes: p.candidates.slice(0, p.min) }, '奖赏身份未知，按位置取牌');
    case 'choose-replacement': return one({ ...base, type: 'choose-replacement', benchIndex: sorted(p.candidates, i => fighterValue(v.you.bench[i]!, o) + Math.max(0, ...v.you.bench[i]!.attacks.filter(a => affordable(v.you.bench[i]!, a.cost)).map(a => attackValue(v, v.you.bench[i]!, a, o))))[0]! }, '升前可进攻的主攻');
    case 'discard-hand': return one({ ...base, type: 'discard-hand', handIndices: sorted(p.candidates, i => -keepValue(v.you.hand[i]!, v, o)).slice(0, p.min) }, '依法支付成本，保留唯一进化件和能量');
    case 'search-deck': {
      const benchSearch = p.descriptionZh.includes('放于备战');
      const seen = new Set<string>();
      const order = sorted(candidates, c => cardValue(c.card, v, o));
      const selected = order.filter(c => { const use = !benchSearch || !seen.has(c.card.cardId); seen.add(c.card.cardId); return use; }).filter(c => cardValue(c.card, v, o) > (benchSearch ? 20 : 0)).slice(0, p.max);
      for (const c of order) if (selected.length < p.min && !selected.includes(c)) selected.push(c);
      return one({ ...base, type: 'search-deck', candidateIds: selected.map(c => c.candidateId) }, '检索当前缺失的战术资源');
    }
    case 'choose-mode': {
      const bestSwitch = Math.max(0, ...v.opponent.bench.map(b => {
        const active = v.you.active; if (!active) return 0;
        return Math.max(0, ...active.attacks.filter(a => canAttack(v, active, a)).map(a => attackValue({ ...v, opponent: { ...v.opponent, active: b } }, active, a, o)));
      }));
      const order = sorted(p.modes.filter(m => m.available), m => {
        const copied = /^attack-(\d+)$/u.exec(m.modeId);
        if (copied) {
          const attack = v.opponent.active?.attacks.find(a => a.index === Number(copied[1]));
          return attack && v.you.active ? attackValue(v, v.you.active, attack, o, true) : 0;
        }
        return m.modeId === 'switch-opponent-v' ? bestSwitch >= 800 ? bestSwitch : 0 : m.modeId === 'discard-draw-five' ? 100 : 10;
      });
      return order.map(m => ({ intent: { ...base, type: 'choose-mode', modeId: m.modeId }, score: 1, reason: '选择有效资源或击倒路线' }));
    }
    case 'switch-opponent': return one({ ...base, type: 'switch-opponent', benchIndex: sorted(p.candidates, i => {
      const target = v.opponent.bench[i]!, active = v.you.active;
      return active ? Math.max(0, ...active.attacks.filter(a => canAttack(v, active, a)).map(a => attackValue({ ...v, opponent: { ...v.opponent, active: target } }, active, a, o))) - hp(target) / 100 : -hp(target);
    })[0]! }, '选择可击倒的公开目标');
    case 'choose-own-bench': return one({ ...base, type: 'choose-own-bench', benchIndex: sorted(p.candidates, i => v.you.bench[i]!.damageCounters * 10 + fighterValue(v.you.bench[i]!, o))[0]! }, '附能并回复有价值的后备');
    case 'attach-hand-energy': return one({ ...base, type: 'attach-hand-energy', candidateId: candidates[0]!.candidateId }, '完成已宣告的附能');
    case 'discard-energy': return one({ ...base, type: 'discard-energy', candidateIds: sorted(candidates, c => c.candidateId.startsWith('active:') ? 10 : 0).slice(0, Math.max(p.min, Math.min(p.max, hailCount(v)))).map(c => c.candidateId) }, '只弃足够击倒的水能量，保留后备能源');
    case 'copy-attack': return sorted(v.opponent.active?.attacks.filter(a => p.candidates.includes(a.index)) ?? [], a => attackValue(v, v.you.active!, a, o, true)).map(a => ({ intent: { ...base, type: 'copy-attack', attackIndex: a.index }, score: 1, reason: '复制能产生实际收益的招式' }));
    case 'select-card': {
      const pair = p.descriptionZh.startsWith('捩木') ? swapPair(v, o) : null;
      return one({ ...base, type: 'select-card', candidateIds: chooseCards(c => pair ? c.card.cardId === pair.card.cardId ? 100 : 0 : p.source === 'opponent-hand' ? 500 - (c.card.hp ?? 500) : cardValue(c.card, v, o)) }, '处理依法可见的效果候选');
    }
    case 'select-target': {
      const pair = p.descriptionZh.startsWith('捩木') ? swapPair(v, o) : null;
      const pairId = pair?.ref.slot === 'active' ? 'active' : pair?.ref.slot === 'bench' ? `bench-${pair.ref.index}` : '';
      return one({ ...base, type: 'select-target', candidateIds: chooseCards(c => {
        if (pair) return c.candidateId === pairId ? 100 : 0;
        const match = /^opponent-bench-(\d+)$/u.exec(c.candidateId);
        if (match) { const target = v.opponent.bench[Number(match[1])]!; const damage = p.descriptionZh.startsWith('贪欲藤蔓') ? (6 - v.opponent.prizeCount) * 60 : 30; return knockoutScore(v, target, damage, true) + target.energies.length; }
        return cardValue(c.card, v, o);
      }) }, '按公开HP与奖赏收益选择目标');
    }
  }
}

/** No session, RNG, checkpoint, opposite seat or deck order is accepted here. */
export function decideSoloAi(view: MatchView, opponentId: SoloOpponentId, catalog: CatalogContent): readonly AiDecision[] {
  const o = SOLO_OPPONENTS.find(x => x.id === opponentId);
  if (!o) throw new Error('未知 AI 对手。');
  const v = view;
  if (v.result || v.waitingForOpponentChoice) return [];
  let ranked: Ranked[] = [];
  if (v.pendingChoice) ranked = choices(v, o);
  else if (v.phase === 'playing' && v.activeSeat === v.you.seat) {
    const add = (intent: Intent, score: number, reason: string) => { if (score > 0) ranked.push({ intent, score, reason }); };
    const active = v.you.active;
    const all = field(v);
    const bestAttack = active ? Math.max(0, ...active.attacks.filter(a => canAttack(v, active, a)).map(a => attackValue(v, active, a, o))) : 0;
    if (active) for (const attack of active.attacks) if (canAttack(v, active, attack)) add({ type: 'attack', attackIndex: attack.index, target: { slot: 'active' } }, attackValue(v, active, attack, o), '执行有效招式');
    for (const [handIndex, card] of v.you.hand.entries()) {
      const definition = catalog.cards.find(c => c.id === card.cardId);
      if (card.isBasicPokemon && v.you.bench.length < 5) {
        const value = cardValue(card, v, o);
        if (value > 20 || v.you.bench.length === 0) add({ type: 'play-basic', handIndex }, 450 + value, '展开主攻、后备或缺失属性');
      }
      for (const { pokemon, ref } of all) {
        if (card.evolvesFrom === pokemon.card.nameZh && pokemon.canEvolve) add({ type: 'evolve', handIndex, target: ref }, 720, '合法进化建立主攻');
        if (card.kind === 'energy' && !v.you.energyAttachedThisTurn) {
          const desired = pokemon.card.cardId === V || pokemon.card.cardId === VMAX ? 3 : pokemon.card.cardId === CHEIN ? 3 : pokemon.card.cardId === WO ? 4 : 3;
          const retreatFunding = ref.slot === 'active' && ![mainId(o), VMAX].includes(pokemon.card.cardId) && v.you.bench.some(b => b.card.cardId === mainId(o) || b.card.cardId === VMAX) && pokemon.energies.length < pokemon.retreatCost;
          const matching = pokemon.attacks.some(a => a.cost.includes(card.type ?? '') || a.cost.every(t => t === '无')) || pokemon.card.cardId === VMAX || pokemon.card.cardId === V;
          if (matching || retreatFunding) add({ type: 'attach-energy', handIndex, target: ref }, retreatFunding ? 850 : 550 + fighterValue(pokemon, o) - Math.max(0, pokemon.energies.length - desired + 1) * 150, '积累主攻费用或支付撤退，再培养后备');
        }
        if (definition?.effectiveCategory === '宝可梦道具' && pokemon.tools.length === 0 && pokemon.card.isBasicPokemon) add({ type: 'attach-tool', handIndex, target: ref }, 480 + fighterValue(pokemon, o), '保护主攻');
      }
      if (card.kind === 'trainer' && definition?.effectiveCategory !== '宝可梦道具') {
        if (definition?.effectiveCategory === '支援者' && (v.you.supporterUsedThisTurn || v.turn === 1 && v.firstSeat === v.you.seat)) continue;
        let score = 320;
        if (card.nameZh === '捩木') score = (swapPair(v, o)?.score ?? 0) > 50 ? 500 : 0;
        if (card.nameZh === '藤树') score = v.you.bench.length < 3 ? 410 : 0;
        if (card.nameZh === '珠贝') score = 430;
        if (card.nameZh === '莉佳的邀请') score = bestAttack > 0 && bestAttack < 800 && v.opponent.handCount > 0 && v.opponent.bench.length < 5 ? 100 : 0;
        if (card.nameZh === '莎莉娜') score = v.you.hand.length <= 5 && v.you.deckCount > 5 ? 330 : 50;
        if (card.nameZh === '高级球') {
          const disposable = v.you.hand.filter((c, i) => i !== handIndex && keepValue(c, v, o) < 800).length;
          score = disposable >= 2 && (v.you.bench.length < 3 || all.some(x => x.pokemon.card.cardId === V) && !v.you.hand.some(c => c.cardId === VMAX)) ? 340 : 0;
        }
        if (card.nameZh === '鼓励信') score = !v.you.koDuringLastOpponentTurn || v.you.hand.filter(c => c.kind === 'energy').length >= 3 ? 0 : 410;
        if (definition?.effectiveCategory === '竞技场' && (v.you.stadiumPlayedThisTurn || v.stadium?.nameZh === card.nameZh)) score = 0;
        if (v.you.deckCount <= 3 && !['捩木', '莉佳的邀请'].includes(card.nameZh)) score = 0;
        add({ type: 'play-trainer', handIndex }, score, '用训练家补足当前资源');
      }
    }
    for (const { pokemon, ref } of all) for (const ability of pokemon.abilities) if (ability.usable) {
      if (ability.name === '海之伴奏' && !v.you.hand.some(c => c.kind === 'energy' && c.type === '水')) continue;
      const score = ability.name === '梦中赠礼' ? bestAttack > 0 ? 0 : 10 : ability.name === '战栗冷气' ? v.you.hand.filter(c => c.kind === 'energy').length < 3 ? 600 : 0 : 420;
      add({ type: 'use-ability', target: ref, abilityIndex: ability.index }, score, '使用可用特性补充资源');
    }
    if (v.stadium && !v.you.stadiumUsedThisTurn && v.you.bench.length < 4 && v.you.deckCount > 3) add({ type: 'use-stadium' }, 380, '竞技场补足后备');
    if (active && !v.you.retreatedThisTurn && !active.statuses.some(s => s === '睡眠' || s === '麻痹') && active.energies.length >= active.retreatCost) {
      for (const [benchIndex, pokemon] of v.you.bench.entries()) {
        const attack = Math.max(0, ...pokemon.attacks.filter(a => canAttack(v, pokemon, a)).map(a => attackValue(v, pokemon, a, o)));
        if (attack > bestAttack + 100 || ![mainId(o), VMAX].includes(active.card.cardId) && pokemon.card.cardId === mainId(o) && active.retreatCost === 0) add({ type: 'retreat', benchIndex, energyIndices: active.energies.slice(0, active.retreatCost).map(e => e.energyIndex) }, attack + 200, '让可进攻的主攻升前');
      }
    }
    add({ type: 'end-turn' }, 0.1, '无有效行动时正常结束回合');
  }
  return sorted(ranked, r => r.score).slice(0, 160).map(({ intent, reason }, index) => ({ reason, command: {
    ...intent, sessionId: v.sessionId, expectedVersion: v.version,
    commandId: `${SOLO_AI_VERSION}:${v.sessionId}:${v.you.seat}:${v.version}:${index}`,
  } as MatchClientMessage }));
}
