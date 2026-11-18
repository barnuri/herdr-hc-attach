'use strict';

// Action: start a kept shell in hc, labelled with the app space and tab mapped to this
// TUI workspace and tab (new ids when none), and attach a split of this pane to it.
// The herdr app adopts the terminal into that space and tab.

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { hcBinary } = require('../lib/hc-cli');
const { runHerdr, findPaneId } = require('../lib/herdr');
const { appPlaceFor, syncedRunArgv } = require('../lib/sync');
const { attachCommand, withState } = require('../lib/sync-run');

const ADDRESS_RE = /\b(t[0-9a-z]+)\b/;

function newId(prefix) {
  return prefix + crypto.randomBytes(16).toString('hex');
}

function startTerminal(argv) {
  const stdout = execFileSync(hcBinary(), argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const data = JSON.parse(stdout);
    if (typeof data.address === 'string') return data.address;
  } catch {
    // text output: fall through
  }
  const match = stdout.match(ADDRESS_RE);
  if (!match) throw new Error(`hc run printed no address: ${stdout.trim()}`);
  return match[1];
}

function main() {
  const origin = process.env.HERDR_PANE_ID;
  if (!origin) throw new Error('HERDR_PANE_ID is unset; run this action from a herdr pane');
  const pane = runHerdr(['pane', 'get', origin]).pane || {};
  if (!pane.workspace_id || !pane.tab_id) throw new Error(`herdr pane get ${origin} returned no workspace or tab`);

  withState((state) => {
    const place = appPlaceFor(state, { workspaceId: pane.workspace_id, tuiTabId: pane.tab_id });
    const spaceId = place.spaceId || newId('sp');
    const tabId = place.tabId || newId('tb');
    const cwd = pane.foreground_cwd || pane.cwd || '';
    const address = startTerminal(syncedRunArgv({ spaceId, tabId, cwd, shell: process.env.SHELL }));

    const split = runHerdr(['pane', 'split', origin, '--direction', 'right', ...(cwd ? ['--cwd', cwd] : [])]);
    const paneId = findPaneId(split);
    if (!paneId) throw new Error('herdr pane split returned no pane id');
    runHerdr(['pane', 'run', paneId, attachCommand(address)]);
    runHerdr(['pane', 'rename', paneId, `${address} (synced)`]);

    state.spaces[spaceId] = pane.workspace_id;
    state.tabs[tabId] = { tuiTabId: pane.tab_id, spaceId };
    state.panes[address] = { paneId, tabId };
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`hc new synced terminal: ${error.message}\n`);
  process.exit(1);
}
