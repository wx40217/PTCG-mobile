import { describe, expect, it } from 'vitest';
import { presetDeckDocument, type MatchClientMessage } from '@ptcg/protocol';
import { createLocalMatchHost } from '../src/localMatch.ts';
import { exportLocalCheckpoint, restoreLocalCheckpoint } from '../src/localCheckpoint.ts';
import { decodeCheckpointGraph, encodeCheckpointGraph } from '../src/checkpointGraph.ts';
import { releaseCatalogContent } from './support/matchTestKit.ts';

const catalog = releaseCatalogContent();
const deck = presetDeckDocument(catalog.decks[0]!, catalog)!;
const config = { catalog, catalogVersion: 'test-version', decks: [deck, deck] as const, nicknames: ['a', 'b'] as const };
describe('private local checkpoints', () => {
  it('restores saved entropy without drawing, reinitializing, or exposing it to players', async () => {
    const host = createLocalMatchHost(config);
    const saved = JSON.parse(JSON.stringify(exportLocalCheckpoint(host)));
    const restored = restoreLocalCheckpoint(saved, config);
    expect(restored.random.snapshot()).toEqual(host.random.snapshot());
    expect(restored.players.map(port => port.view())).toEqual(host.players.map(port => port.view()));
    // This comparison is deliberately within already sampled entropy, not new entropy after refill.
    for (let i = 0; i < 80; i++) expect(restored.random.nextInt(60)).toBe(host.random.nextInt(60));
    expect(Object.keys(restored.players[0])).toEqual(['view', 'submit', 'subscribe']);
    expect(JSON.stringify(restored.players[0].view())).not.toContain('webcrypto-pool');
  });
  it('restores exact original command results and rejects same ID with different body/other seat', async () => {
    const host = createLocalMatchHost(config);
    const view = host.players[0].view();
    const command: MatchClientMessage = { type: 'concede', commandId: 'once', expectedVersion: view.version, sessionId: view.sessionId };
    const result = await host.players[0].submit(command);
    const restored = restoreLocalCheckpoint(JSON.parse(JSON.stringify(exportLocalCheckpoint(host))), config);
    expect(await restored.players[0].submit(command)).toEqual({ ...result, duplicate: true });
    expect(await restored.players[0].submit({ ...command, expectedVersion: 2 })).toMatchObject({ ok: false, code: 'command-id-reused' });
    expect(await restored.players[1].submit(command)).toMatchObject({ ok: false });
  });
  it('refuses invalid inventories and incompatible rules before granting a port', () => {
    const saved = exportLocalCheckpoint(createLocalMatchHost(config));
    expect(() => restoreLocalCheckpoint({ ...saved, rulesVersion: 'old-rules' }, config)).toThrow('不兼容');
    const data = decodeCheckpointGraph(saved.session) as any;
    data.state.players[0].deck.pop();
    expect(() => restoreLocalCheckpoint({ ...saved, session: encodeCheckpointGraph(data) }, config)).toThrow('损坏');
  });
});
