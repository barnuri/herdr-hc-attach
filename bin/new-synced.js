'use strict';

// Action: start a kept shell in hc, labelled with the app space and tab mapped to this
// TUI workspace and tab (new ids when none), and attach a split of this pane to it.
// The herdr app adopts the terminal into that space and tab.

const { runHerdr, findPaneId } = require('../lib/herdr');
const { PLAIN_ENV, attachCommand, startTerminal, withState } = require('../lib/sync-run');
const { placeForPane } = require('../lib/sync');

function main() {
  const origin = process.env.HERDR_PANE_ID;
  if (!origin) throw new Error('HERDR_PANE_ID is unset; run this action from a herdr pane');
  const pane = runHerdr(['pane', 'get', origin]).pane || {};
  if (!pane.workspace_id || !pane.tab_id) throw new Error(`herdr pane get ${origin} returned no workspace or tab`);

  withState((state) => {
    const cwd = pane.foreground_cwd || pane.cwd || '';
    const { tabId, argv } = placeForPane(state, { workspaceId: pane.workspace_id, tuiTabId: pane.tab_id, cwd, shell: process.env.SHELL });
    const address = startTerminal(argv);

    const split = runHerdr(['pane', 'split', origin, '--direction', 'right', ...(cwd ? ['--cwd', cwd] : []), ...PLAIN_ENV]);
    const paneId = findPaneId(split);
    if (!paneId) throw new Error('herdr pane split returned no pane id');
    runHerdr(['pane', 'run', paneId, attachCommand(address)]);
    runHerdr(['pane', 'rename', paneId, `${address} (synced)`]);

    state.panes[address] = { paneId, tabId };
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`hc new synced terminal: ${error.message}\n`);
  process.exit(1);
}
