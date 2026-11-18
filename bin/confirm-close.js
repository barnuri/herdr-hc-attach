'use strict';

// Popup the watcher opens when the user closed synced TUI panes while their terminals
// still run. HC_ORPHANS is a comma list of addresses.
// Keys: k ends the terminals (the app closes their panes too), r opens the TUI panes
// again, d or Esc keeps them running in the app only.

const { execFileSync } = require('node:child_process');

const { isValidAddress } = require('../lib/hc');
const { hcBinary } = require('../lib/hc-cli');
const { withState } = require('../lib/sync-run');

const terminals = (process.env.HC_ORPHANS || '').split(',').filter(isValidAddress);

function render(extra = '') {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(`\x1b[1mSynced TUI panes closed: ${terminals.join(', ')}\x1b[0m\n\n`);
  process.stdout.write('These terminals still run, and the herdr app still shows them.\n\n');
  process.stdout.write('  k  end the terminals (the app closes their panes)\n');
  process.stdout.write('  r  open the TUI panes again\n');
  process.stdout.write('  d  keep them in the app only (Esc does the same)\n');
  if (extra) process.stdout.write(`\n${extra}\n`);
}

function decide(choice) {
  const failed = [];
  withState((state) => {
    for (const terminal of terminals) {
      if (choice === 'kill') {
        try {
          execFileSync(hcBinary(), ['kill', terminal], { stdio: 'ignore' });
        } catch {
          failed.push(terminal);
          delete state.asked[terminal];
        }
        continue;
      }
      delete state.panes[terminal];
      delete state.asked[terminal];
      if (choice === 'detach') state.detached[terminal] = true;
    }
  });
  return failed;
}

function finish(code) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

function onKey(key) {
  const choice = { k: 'kill', K: 'kill', r: 'reopen', R: 'reopen', d: 'detach', D: 'detach', '\x1b': 'detach', '\x03': 'detach' }[key];
  if (!choice) return;
  try {
    const failed = decide(choice);
    if (failed.length > 0) {
      render(`hc kill failed for ${failed.join(', ')}. Press any key.`);
      process.stdin.once('data', () => finish(1));
      process.stdin.removeListener('data', onKey);
      return;
    }
  } catch (error) {
    render(`Failed: ${error.message}`);
    return;
  }
  finish(0);
}

if (terminals.length === 0) process.exit(0);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', onKey);
render();
