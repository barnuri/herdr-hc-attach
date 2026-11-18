'use strict';

// Background watcher (the [[startup]] hook): keeps one TUI workspace per app space,
// one TUI tab per app tab and one `hc attach` pane per app terminal.
//   node bin/sync.js            watch, one pass every HC_SYNC_MS (default 3000)
//   node bin/sync.js --once     one pass, then exit
//   node bin/sync.js --dry-run  print the ops one pass would run, change nothing

const fs = require('node:fs');
const path = require('node:path');

const { planSync } = require('../lib/sync');
const { stateDir, syncOnce } = require('../lib/sync-run');

const PID_FILE = 'sync.pid';
const DEFAULT_INTERVAL_MS = 3000;

function log(line) {
  process.stderr.write(`${new Date().toISOString()} hc-sync: ${line}\n`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One watcher per state dir. Returns false when another live watcher holds the pid file.
function takePidFile() {
  fs.mkdirSync(stateDir(), { recursive: true });
  const file = path.join(stateDir(), PID_FILE);
  const holder = Number.parseInt(fs.readFileSync(file, { encoding: 'utf8', flag: 'a+' }), 10);
  if (Number.isInteger(holder) && holder !== process.pid && isAlive(holder)) return false;
  fs.writeFileSync(file, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
    } catch {
      // gone already
    }
  };
  process.once('exit', release);
  return true;
}

function pass(dryRun) {
  const { ops, errors } = syncOnce({ dryRun, plan: planSync });
  for (const error of errors) log(error);
  return ops;
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--dry-run')) {
    process.stdout.write(JSON.stringify(pass(true), null, 2) + '\n');
    return;
  }
  if (args.has('--once')) {
    for (const op of pass(false)) log(JSON.stringify(op));
    return;
  }
  if (!takePidFile()) {
    log('another watcher is running; exiting');
    return;
  }
  const interval = Number.parseInt(process.env.HC_SYNC_MS, 10) || DEFAULT_INTERVAL_MS;
  const tick = () => {
    try {
      for (const op of pass(false)) log(JSON.stringify(op));
    } catch (error) {
      log(`pass failed: ${error.message}`);
    }
    setTimeout(tick, interval);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
  tick();
}

main();
