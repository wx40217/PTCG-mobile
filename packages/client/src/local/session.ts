import { computeCatalogVersion, parseCatalogContent, presetDeckDocument, type CatalogContent } from '@ptcg/protocol';
import bundledCatalog from '../../../../data/catalog/zh-cn-standard-2025-06-05-catalog.json';
import { createLocalMatchHost, type LocalPlayerPort } from '../../../service/src/localMatch.ts';

export type { LocalPlayerPort } from '../../../service/src/localMatch.ts';
export type { MatchSubmitResult } from '../../../service/src/match.ts';

const catalog = parseCatalogContent(bundledCatalog);
if (catalog === null) throw new Error('随包离线目录无效。');
const frozenCatalog: CatalogContent = catalog;
let version: Promise<string> | undefined;

/** Complete text, frozen environment and recipes; no network/cache warm-up. */
export function localCatalog(): CatalogContent {
  return structuredClone(frozenCatalog);
}

export interface LocalMatch {
  readonly players: readonly [LocalPlayerPort, LocalPlayerPort];
  dispose(): void;
}

/**
 * Runtime foundation only: the solo roster/entry chooses the allowed three presets.
 * Existing A/B/C/D recipes remain in the bundle for friend-mode compatibility.
 * No caller-supplied catalog, effects, random source, seed, or ordered deck.
 */
export async function createLocalMatch(options: {
  readonly presetIds: readonly [string, string];
  readonly nicknames: readonly [string, string];
}): Promise<LocalMatch> {
  const decks = options.presetIds.map((id) => {
    const preset = frozenCatalog.decks.find((item) => item.code === id);
    if (!preset) throw new Error(`未知预设：${id}`);
    const deck = presetDeckDocument(preset, frozenCatalog);
    if (!deck) throw new Error(`预设资料不完整：${id}`);
    return deck;
  });
  const nicknames = [...options.nicknames] as [string, string];
  if (decks.length !== 2 || nicknames.length !== 2 || nicknames.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error('本地对局需要两个预设与两个昵称。');
  }
  version ??= computeCatalogVersion(frozenCatalog);
  const host = createLocalMatchHost({
    catalog: frozenCatalog, catalogVersion: await version,
    decks: [decks[0]!, decks[1]!], nicknames,
  });
  return Object.freeze({ players: host.players, dispose: host.dispose });
}
