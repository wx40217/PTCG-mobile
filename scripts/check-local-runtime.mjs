// Run the actual emitted offline bundle in an isolated, network-free Chromium page.
// Usage: node scripts/check-local-runtime.mjs <Chromium executable>
// This is a browser runtime check, not Android or human gameplay acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = process.argv[2];
if (!browser) throw new Error('Pass an installed Chromium browser executable.');
const dist = resolve('packages/client/dist');
const entry = (await readdir(resolve(dist, 'assets'))).find((file) => /^local-.*\.js$/.test(file));
assert.ok(entry, 'Build must contain the offline runtime entry.');
const page = resolve(dist, '.local-runtime-check.html');
const profile = resolve('.local-validation/browser-profile');
await mkdir(profile, { recursive: true });
const html = `<!doctype html><meta charset="utf-8"><pre id="result">pending</pre>
<script type="module">
import { createLocalMatch, localCatalog } from './assets/${entry}';
try {
  globalThis.fetch = () => { throw new Error('Network forbidden'); };
  globalThis.WebSocket = class { constructor() { throw new Error('Network forbidden'); } };
  localStorage.clear();
  const game = await createLocalMatch({ presetIds: ['A', 'D'], nicknames: ['离线甲', '离线乙'] });
  let moves = 0;
  while (!game.players[0].view().result && moves < 250) {
    let seat = [0, 1].find(s => game.players[s].view().pendingChoice);
    seat ??= game.players[0].view().activeSeat;
    const port = game.players[seat], view = port.view(), choice = view.pendingChoice;
    let body;
    if (!choice) body = { type: 'end-turn' };
    else if (choice.kind === 'turn-order') body = { type: 'choose-turn-order', goFirst: true };
    else if (choice.kind === 'place-setup') body = { type: 'place-setup', active: view.you.hand.findIndex(c => c.isBasicPokemon), bench: [] };
    else if (choice.kind === 'compensation-draw') body = { type: 'resolve-compensation', draw: 0 };
    else if (choice.kind === 'place-bench') body = { type: 'place-bench', bench: [] };
    else throw new Error('Unexpected choice ' + choice.kind);
    const command = { sessionId: view.sessionId, expectedVersion: view.version, commandId: 'browser-' + (++moves), ...body };
    if (choice) command.choiceId = choice.choiceId;
    const result = await port.submit(command);
    if (!result.ok) throw new Error(JSON.stringify(result));
  }
  const result = game.players[0].view().result;
  if (!result || JSON.stringify(result) !== JSON.stringify(game.players[1].view().result)) throw new Error('No consistent terminal result');
  document.querySelector('#result').textContent = JSON.stringify({ ok: true, moves, cards: localCatalog().cards.length, result });
  game.dispose();
} catch (error) { document.querySelector('#result').textContent = JSON.stringify({ ok: false, error: String(error) }); }
</script>`;
await writeFile(page, html);
try {
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--allow-file-access-from-files', '--dump-dom', '--virtual-time-budget=10000',
    `--user-data-dir=${profile}`, pathToFileURL(page).href,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  // Drain browser diagnostics without leaking unrelated browser startup chatter.
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 30_000);
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  clearTimeout(timer);
  assert.equal(code, 0, 'Browser must exit successfully.');
  const result = output.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
  assert.ok(result && result !== 'pending', 'Browser must execute the bundled runtime.');
  const parsed = JSON.parse(result.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  console.log(JSON.stringify({ verification: 'offline browser bundle (not Android)', ...parsed }));
} finally { await unlink(page); }
