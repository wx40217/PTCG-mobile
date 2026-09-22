import { parseMatchClientMessage, type ServerMessage } from '@ptcg/protocol';
import type { LocalPlayerPort } from '../local/session.ts';
import { createMatchController, type MatchState } from '../rooms/matchController.ts';

/** Reuse the exact board command builder; only replace its transport with one seat. */
export function createSoloMatchAdapter(port: LocalPlayerPort, changed: (state: MatchState) => void) {
  const listeners = new Set<(message: ServerMessage) => void>();
  let disposed = false;
  let enabled = true;
  let flight: Promise<void> = Promise.resolve();
  const emit = (message: ServerMessage) => { if (!disposed) for (const listener of listeners) listener(message); };
  const controller = createMatchController({
    get closed() { return disposed || !enabled; },
    send(message) {
      const parsed = parseMatchClientMessage(message);
      if (!parsed?.ok || disposed || !enabled) throw new Error('本地操作已暂停。');
      flight = Promise.resolve().then(async () => {
        const result = await port.submit(parsed.message);
        emit(result.ok
          ? { type: 'match', commandId: parsed.message.commandId, view: result.view }
          : { type: 'match-error', commandId: parsed.message.commandId, code: result.code, message: result.message, ...(result.view ? { view: result.view } : {}) });
      }).catch(error => emit({ type: 'match-error', commandId: parsed.message.commandId, code: 'action-not-allowed', message: error instanceof Error ? error.message : '本地操作失败。' }));
    },
    onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onClosed() { return () => undefined; },
  }, changed);
  const refresh = () => emit({ type: 'match', view: port.view() });
  const unsubscribe = port.subscribe(refresh);
  refresh();
  return {
    controller,
    setEnabled(value: boolean) { enabled = value; },
    settled: () => flight,
    dispose() { disposed = true; unsubscribe(); controller.dispose(); listeners.clear(); },
  };
}
