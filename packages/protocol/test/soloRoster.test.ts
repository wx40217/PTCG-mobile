import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseServiceCatalog, presetDeckDocument, exportDeckText, importDeckText, validateDeck, SOLO_PRESETS, SOLO_OPPONENTS, SOLO_MATCHUPS, SOLO_DATA_REVISION, soloDeckDocument, soloDialogue, validateSoloRoster } from '../src/index.ts';

function catalog() {
  const parsed = parseServiceCatalog(JSON.parse(readFileSync(new URL('../../../data/catalog/zh-cn-standard-2025-06-05-catalog.json', import.meta.url), 'utf8')));
  if (!parsed) throw new Error('Invalid release catalog');
  return parsed;
}

describe('frozen single-player roster', () => {
  it('binds current fully supported A/B/D, preserving all four friend presets', () => {
    const source = catalog();
    expect(validateSoloRoster(source)).toEqual([]);
    expect(source.content.dataRevision.sourceDigest).toBe(SOLO_DATA_REVISION);
    expect(source.content.decks.map(d => d.code)).toEqual(['A', 'B', 'C', 'D']);
    expect(SOLO_PRESETS.map(p => p.sourceCode)).toEqual(['A', 'B', 'D']);
    for (const preset of SOLO_PRESETS) {
      const original = source.content.decks.find(d => d.code === preset.sourceCode)!;
      expect(preset.deck).toEqual(presetDeckDocument(original, source.content));
      expect(validateDeck(preset.deck, source)).toMatchObject({ legal: true, ready: true, totalCards: 60, problems: [] });
      expect(importDeckText(exportDeckText(preset.deck, source), source)).toEqual({ ok: true, deck: preset.deck });
    }
  });

  it('rejects changed revision, identity, support flag and original preset', () => {
    const original = catalog();
    const revision = structuredClone(original);
    Object.assign(revision.content.dataRevision, { sourceDigest: 'changed' });
    expect(validateSoloRoster(revision)).toContain('单人预设目录修订不匹配。');
    for (const change of ['identity', 'support', 'count']) {
      const changed = structuredClone(original);
      const card = changed.content.cards.find(c => c.id === 'csve1-062')!;
      if (change === 'identity') Object.assign(card.identities, { effectIdentity: 'wrong-effect' });
      if (change === 'support') Object.assign(card.flags, { effectSupported: false });
      if (change === 'count') Object.assign(changed.content.decks[0]!.cards[0]!, { count: 3 });
      expect(validateSoloRoster(changed).length).toBeGreaterThan(0);
    }
  });

  it('returns independent session documents and rejects unknown/free-form selection', () => {
    const first = soloDeckDocument('solo-a-v1')!;
    Object.assign(first.cards[0]!, { count: 1 });
    expect(soloDeckDocument('solo-a-v1')!.cards[0]!.count).toBe(4);
    expect(soloDeckDocument('C')).toBeNull();
    expect(soloDeckDocument('custom')).toBeNull();
    expect(Object.isFrozen(SOLO_PRESETS[0]!.deck.cards[0])).toBe(true);
    expect(Object.isFrozen(SOLO_OPPONENTS[0]!.tactics)).toBe(true);
  });

  it('opens exactly nine directed matchups including all mirrors', () => {
    expect(SOLO_MATCHUPS).toHaveLength(9);
    expect(new Set(SOLO_MATCHUPS.map(m => `${m.presetId}/${m.opponentId}`)).size).toBe(9);
    for (const opponent of SOLO_OPPONENTS) {
      expect(opponent.available).toBe(true);
      expect(SOLO_PRESETS.some(p => p.id === opponent.presetId)).toBe(true);
      expect(SOLO_MATCHUPS.filter(m => m.opponentId === opponent.id)).toHaveLength(3);
      const deck = soloDeckDocument(opponent.presetId)!;
      for (const cardId of opponent.tactics.primaryCardIds) expect(deck.cards.some(c => c.cardId === cardId)).toBe(true);
    }
    expect(new Set(SOLO_OPPONENTS.map(o => o.strategyId)).size).toBe(3);
  });

  it('ships self-contained portraits and disables every event line without private state input', () => {
    for (const opponent of SOLO_OPPONENTS) {
      expect(opponent.portrait.svg).toContain('viewBox="0 0 128 128"');
      expect(opponent.portrait.svg).not.toMatch(/<script|<image|href=|<foreignObject/);
      expect(opponent.tactics.scenarios).toHaveLength(3);
      for (const event of ['start', 'win', 'loss'] as const) {
        expect(soloDialogue(opponent.id, event, false)).toBeNull();
        expect(soloDialogue(opponent.id, event, true)).toBe(opponent.dialogue[event]);
      }
    }
  });
});
