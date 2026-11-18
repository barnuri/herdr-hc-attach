'use strict';

// Action "hc: convert panes to synced". Without HC_CONVERT_POPUP it opens itself as a
// popup. The popup lists the plain TUI panes and, on a key, swaps each for an
// `hc attach` pane on a new hc terminal in the same folder, labelled for the app
// space and tab mapped to its TUI workspace and tab, so the herdr app shows it.
//   idle shell      the shell is replaced in place (`exec hc attach <t>`)
//   busy (program)  only with `a` then `A`: a new pane takes its place, the old one
//                   closes and its program ends
//   plugin panes and panes already synced are never touched

const { PLUGIN_ID, runHerdr, findPaneId } = require('../lib/herdr');
const { classifyPane, paneCommand } = require('../lib/convert');
const { placeForPane } = require('../lib/sync');
const { PLAIN_ENV, attachCommand, loadState, readTui, startTerminal, withState } = require('../lib/sync-run');

function openPopup() {
  runHerdr([
    'plugin', 'pane', 'open',
    '--plugin', PLUGIN_ID,
    '--entrypoint', 'convert',
    '--placement', 'popup',
    '--env', 'HC_CONVERT_POPUP=1',
    '--focus',
  ]);
}

function listCandidates() {
  const tui = readTui();
  const panes = runHerdr(['pane', 'list']).panes || [];
  const synced = new Set(Object.values(loadState().panes).map((entry) => entry.paneId));
  const self = process.env.HERDR_PANE_ID;
  const result = { idle: [], busy: [], skipped: 0 };
  for (const pane of panes) {
    if (pane.pane_id === self) continue;
    let info;
    try {
      info = runHerdr(['pane', 'process-info', '--pane', pane.pane_id]).process_info || {};
    } catch {
      result.skipped += 1;
      continue;
    }
    const kind = classifyPane({ ...info, pane_id: pane.pane_id }, synced);
    if (kind !== 'idle' && kind !== 'busy') {
      result.skipped += 1;
      continue;
    }
    result[kind].push({
      paneId: pane.pane_id,
      workspaceId: pane.workspace_id,
      tuiTabId: pane.tab_id,
      cwd: pane.foreground_cwd || pane.cwd || '',
      where: `${tui.workspaces.get(pane.workspace_id) || pane.workspace_id} / ${tui.tabs.get(pane.tab_id)?.label || pane.tab_id}`,
      command: kind === 'busy' ? paneCommand(info) : '',
    });
  }
  return result;
}

function convertPane(pane, busy) {
  withState((state) => {
    const { tabId, argv } = placeForPane(state, { workspaceId: pane.workspaceId, tuiTabId: pane.tuiTabId, cwd: pane.cwd, shell: process.env.SHELL });
    const address = startTerminal(argv, { timeout: 10_000 });
    let paneId = pane.paneId;
    if (busy) {
      paneId = findPaneId(runHerdr(['pane', 'split', pane.paneId, '--direction', 'right', ...(pane.cwd ? ['--cwd', pane.cwd] : []), ...PLAIN_ENV]));
      if (!paneId) throw new Error('herdr pane split returned no pane id');
      runHerdr(['pane', 'run', paneId, attachCommand(address)]);
    } else {
      runHerdr(['pane', 'run', paneId, `exec ${attachCommand(address)}`]);
    }
    runHerdr(['pane', 'rename', paneId, `${address} (synced)`]);
    state.panes[address] = { paneId, tabId, recordedAt: Date.now() };
  });
  if (busy) runHerdr(['pane', 'close', pane.paneId]);
}

function render(list, extra = '') {
  const out = ['\x1b[2J\x1b[H\x1b[1mConvert TUI panes to synced hc terminals\x1b[0m', ''];
  out.push('The herdr app shows synced panes. A converted pane starts a new shell in the same folder.', '');
  out.push(`Idle shells (y or a converts them): ${list.idle.length}`);
  for (const pane of list.idle) out.push(`  ${pane.paneId}  ${pane.where}  ${pane.cwd}`);
  out.push('', `Running a program (only a converts them, and the program ENDS): ${list.busy.length}`);
  for (const pane of list.busy) out.push(`  ${pane.paneId}  ${pane.where}  ${pane.command}`);
  out.push('', `Skipped (plugin panes, already synced): ${list.skipped}`, '');
  out.push('  y    convert the idle shells', '  a    convert all of the above', '  Esc  cancel');
  if (extra) out.push('', extra);
  process.stdout.write(out.join('\n') + '\n');
}

function finish(code) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

function runConversion(list, panes) {
  const failed = [];
  for (const pane of panes) {
    try {
      convertPane(pane, list.busy.includes(pane));
    } catch (error) {
      failed.push(`${pane.paneId}: ${error.message}`);
    }
  }
  if (failed.length === 0) finish(0);
  render(list, `Failed:\n  ${failed.join('\n  ')}\nPress any key.`);
  process.stdin.removeAllListeners('data');
  process.stdin.once('data', () => finish(1));
}

function popup() {
  const list = listCandidates();
  let confirmAll = false;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === '\x1b' || key === '\x03' || key === 'q') finish(0);
    if (key === 'y' && list.idle.length > 0) runConversion(list, list.idle);
    else if (key === 'a' && list.busy.length > 0) {
      confirmAll = true;
      render(list, `Press A (shift+a) to end ${list.busy.length} running program(s) and convert all. Any other key cancels.`);
    } else if (key === 'a') runConversion(list, list.idle);
    else if (key === 'A' && confirmAll) runConversion(list, [...list.idle, ...list.busy]);
    else if (confirmAll) finish(0);
  });
  render(list);
}

if (require.main === module) {
  try {
    if (process.env.HC_CONVERT_POPUP) popup();
    else openPopup();
  } catch (error) {
    process.stderr.write(`hc convert: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { listCandidates, convertPane };
