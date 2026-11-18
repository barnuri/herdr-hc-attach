'use strict';

// Called by bin/hc-shell when the herdr TUI opens a new pane. Starts a kept shell in
// hc, labelled with the app space and tab mapped to this TUI workspace and tab (new
// ones, named after the TUI, when none), records the pane, and prints the address.
// bin/hc-shell then runs `hc attach` on it. Any failure exits non-zero, and
// bin/hc-shell starts a plain shell instead.

const { listTerminals } = require('../lib/hc-cli');
const { runHerdr } = require('../lib/herdr');
const { placeForPane } = require('../lib/sync');
const { startTerminal, withState } = require('../lib/sync-run');

const HC_TIMEOUT_MS = 10_000;

function paneWhere(paneId) {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const tuiTabId = process.env.HERDR_TAB_ID;
  if (workspaceId && tuiTabId) return { workspaceId, tuiTabId };
  const pane = runHerdr(['pane', 'get', paneId]).pane || {};
  if (!pane.workspace_id || !pane.tab_id) throw new Error(`herdr pane get ${paneId} returned no workspace or tab`);
  return { workspaceId: pane.workspace_id, tuiTabId: pane.tab_id };
}

// A restored pane keeps its id: attach it to its old terminal instead of a new one.
function restoredTerminal(state, paneId) {
  const terminal = Object.keys(state.panes).find((address) => state.panes[address].paneId === paneId);
  if (!terminal) return null;
  const live = listTerminals().terminals.some((entry) => entry.address === terminal && entry.state === 'live');
  return live ? terminal : null;
}

function main() {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) throw new Error('HERDR_PANE_ID is unset');
  const where = paneWhere(paneId);
  const cwd = process.cwd();
  const address = withState((state) => {
    const restored = restoredTerminal(state, paneId);
    if (restored) return restored;
    const { tabId, argv } = placeForPane(state, { ...where, cwd, shell: process.env.HC_REAL_SHELL });
    const started = startTerminal(argv, { timeout: HC_TIMEOUT_MS });
    state.panes[started] = { paneId, tabId, recordedAt: Date.now() };
    return started;
  });
  try {
    runHerdr(['pane', 'rename', paneId, `${address} (synced)`]);
  } catch {
    // the title is cosmetic
  }
  process.stdout.write(`${address}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${new Date().toISOString()} hc-shell: ${error.message}\n`);
  process.exit(1);
}
