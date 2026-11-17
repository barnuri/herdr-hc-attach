'use strict';

// Popup picker. HC_MODE is attach, watch or all. HC_ORIGIN_PANE is the herdr pane to split.
// Keys: type to filter, up/down to move, Enter to open, Esc or Ctrl+C to close.

const { attachArgv, filterTerminals, liveTerminals, needsConfirm, paneTitle } = require('../lib/hc');
const { listTerminals } = require('../lib/hc-cli');
const { runHerdr, findPaneId } = require('../lib/herdr');

const mode = process.env.HC_MODE || 'attach';
const originPane = process.env.HC_ORIGIN_PANE || '';

const state = {
  all: [],
  filter: '',
  index: 0,
  view: 'list', // list | confirm | message
  message: '',
};

const CLEAR = '\x1b[2J\x1b[H';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const REVERSE = '\x1b[7m';
const RESET = '\x1b[0m';

function title() {
  if (mode === 'watch') return 'hc: watch a terminal (view only)';
  if (mode === 'all') return 'hc: attach all live terminals';
  return 'hc: attach a terminal';
}

function visible() {
  return filterTerminals(liveTerminals(state.all), state.filter);
}

function render() {
  const out = [CLEAR, `${BOLD}${title()}${RESET}`, ''];
  if (state.view === 'message') {
    out.push(state.message, '', `${DIM}Press any key to close.${RESET}`);
  } else if (state.view === 'confirm') {
    out.push(`${liveTerminals(state.all).length} terminals will open in a new tab, each as an attached pane.`);
    out.push('Each attach resizes its terminal to the pane. Continue? (y/N)');
  } else {
    out.push(`filter: ${state.filter}_`, '');
    const rows = visible();
    if (rows.length === 0) {
      out.push(`${DIM}No live terminals match.${RESET}`);
    }
    rows.forEach((t, i) => {
      const line = `${t.address.padEnd(10)} ${(t.agent || '-').padEnd(12)} ${t.cwd}`;
      out.push(i === state.index ? `${REVERSE}> ${line}${RESET}` : `  ${line}`);
    });
    out.push('', `${DIM}up/down move   Enter open   type to filter   Esc close${RESET}`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

function showMessage(text) {
  state.view = 'message';
  state.message = text;
  render();
}

// Splits origin pane right, runs `hc attach`, and names the new pane.
function openSplit(terminal, { observe }) {
  const argv = attachArgv(terminal.address, { observe });
  const split = runHerdr(['pane', 'split', originPane, '--direction', 'right', ...(terminal.cwd ? ['--cwd', terminal.cwd] : [])]);
  const paneId = findPaneId(split);
  if (!paneId) {
    throw new Error('herdr pane split returned no pane id');
  }
  runHerdr(['pane', 'run', paneId, ['hc', ...argv].join(' ')]);
  runHerdr(['pane', 'rename', paneId, paneTitle(terminal, { observe })]);
  return paneId;
}

// Opens every live terminal in one new tab. Each new pane splits the previous one, alternating right and down.
function openAll(terminals) {
  const tab = runHerdr(['tab', 'create', '--label', 'hc attach', '--focus']);
  let previous = findPaneId(tab);
  if (!previous) {
    throw new Error('herdr tab create returned no pane id');
  }
  terminals.forEach((terminal, i) => {
    const argv = attachArgv(terminal.address);
    let paneId = previous;
    if (i > 0) {
      const direction = i % 2 ? 'right' : 'down';
      const split = runHerdr(['pane', 'split', previous, '--direction', direction, ...(terminal.cwd ? ['--cwd', terminal.cwd] : [])]);
      paneId = findPaneId(split);
      if (!paneId) {
        throw new Error('herdr pane split returned no pane id');
      }
      previous = paneId;
    }
    runHerdr(['pane', 'run', paneId, ['hc', ...argv].join(' ')]);
    runHerdr(['pane', 'rename', paneId, paneTitle(terminal)]);
  });
}

function finish(code) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(RESET);
  process.exit(code);
}

function openFromList() {
  const rows = visible();
  const chosen = rows[state.index];
  if (!chosen) return;
  if (!originPane) {
    showMessage('No origin pane (HC_ORIGIN_PANE is unset). Run the action from a herdr pane.');
    return;
  }
  try {
    openSplit(chosen, { observe: mode === 'watch' });
    finish(0);
  } catch (error) {
    showMessage(`Could not open ${chosen.address}: ${error.message}`);
  }
}

function openAllNow() {
  const live = liveTerminals(state.all);
  if (live.length === 0) {
    showMessage('No live terminals. Start one with: hc run --bg sh');
    return;
  }
  try {
    openAll(live);
    finish(0);
  } catch (error) {
    showMessage(`Could not open all terminals: ${error.message}`);
  }
}

function onKey(key) {
  if (key === '\x03') return finish(0);

  if (state.view === 'message') {
    return finish(1);
  }

  if (state.view === 'confirm') {
    if (key === 'y' || key === 'Y') return openAllNow();
    return finish(0);
  }

  if (key === '\x1b') return finish(0);
  if (key === '\x1b[A') {
    state.index = Math.max(0, state.index - 1);
  } else if (key === '\x1b[B') {
    state.index = Math.min(Math.max(0, visible().length - 1), state.index + 1);
  } else if (key === '\r' || key === '\n') {
    if (mode === 'all') {
      const count = liveTerminals(state.all).length;
      if (count === 0) return showMessage('No live terminals. Start one with: hc run --bg sh');
      if (needsConfirm(count)) {
        state.view = 'confirm';
        return render();
      }
      return openAllNow();
    }
    return openFromList();
  } else if (key === '\x7f') {
    state.filter = state.filter.slice(0, -1);
    state.index = 0;
  } else if (key.length === 1 && key >= ' ' && key !== '\x7f') {
    state.filter += key;
    state.index = 0;
  } else {
    return;
  }
  render();
}

function main() {
  let parsed;
  try {
    parsed = listTerminals();
  } catch (error) {
    // HcMissingError and a failed `hc ls` both show their message and wait for a key.
    showMessage(error.message);
    return start();
  }
  state.all = parsed.terminals;

  if (liveTerminals(state.all).length === 0) {
    const hidden = parsed.hiddenFinished ? ` (${parsed.hiddenFinished} finished hidden)` : '';
    state.view = 'message';
    state.message = `No live terminals${hidden}. Start one with: hc run --bg sh`;
  }
  if (mode === 'all') {
    // all mode asks in confirm view or opens at once; the list view is not shown.
    if (state.view !== 'message') {
      const count = liveTerminals(state.all).length;
      if (needsConfirm(count)) {
        state.view = 'confirm';
      } else {
        return openAllNow();
      }
    }
  }
  start();
}

function start() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', onKey);
  render();
}

main();
