'use strict';

const { execFileSync } = require('node:child_process');

const PLUGIN_ID = 'barnuri.hc-attach';

function herdrBinary() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

// Runs a herdr command and returns its `result` field. herdr wraps every reply in { result }.
function runHerdr(args) {
  const stdout = execFileSync(herdrBinary(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // `pane run` and `pane rename` print nothing on success.
  if (stdout.trim() === '') {
    return {};
  }
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`herdr ${args.join(' ')} returned unparseable output: ${stdout.trim()}`);
  }
  return envelope.result;
}

// Pane id from a `pane split` or `tab create` reply. Both shapes have shipped.
function findPaneId(result) {
  if (result === null || typeof result !== 'object') {
    return null;
  }
  return result.pane_id || result.pane?.pane_id || result.root_pane?.pane_id || result.tab?.pane_id || result.panes?.[0]?.pane_id || null;
}

module.exports = { PLUGIN_ID, runHerdr, findPaneId };
