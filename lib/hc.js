'use strict';

// Pure logic for the hc attach plugin: parse `hc ls --json`, filter the list,
// build the argv for `hc attach`, and check the attach-all threshold.
// No I/O here, so every function is testable with node:test.

const CONFIRM_ABOVE = 6;
// `t7`, `t1b`, or `machine/t7`. hc also accepts names, but this plugin only lists addresses.
const ADDRESS_RE = /^(?:[A-Za-z0-9._-]+\/)?t[0-9a-z]+$/;

class HcParseError extends Error {}

// Returns { terminals, hiddenFinished } from the text of `hc ls --json`.
// Each terminal keeps address, agent, cwd, state and where. Entries without a valid address are dropped.
function parseLs(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new HcParseError(`hc ls did not return JSON: ${error.message}`);
  }
  if (!data || !Array.isArray(data.terminals)) {
    throw new HcParseError('hc ls JSON has no terminals array');
  }
  const terminals = [];
  for (const raw of data.terminals) {
    if (!raw || typeof raw.address !== 'string' || !ADDRESS_RE.test(raw.address)) {
      continue;
    }
    terminals.push({
      address: raw.address,
      agent: typeof raw.agent === 'string' ? raw.agent : '',
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      state: typeof raw.state === 'string' ? raw.state : '',
      where: typeof raw.where === 'string' ? raw.where : '',
    });
  }
  return {
    terminals,
    hiddenFinished: Number.isInteger(data.hidden_finished) ? data.hidden_finished : 0,
  };
}

function liveTerminals(terminals) {
  return terminals.filter((terminal) => terminal.state === 'live');
}

// Case-insensitive substring match on address, agent and cwd. An empty query keeps all.
function filterTerminals(terminals, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) {
    return terminals.slice();
  }
  return terminals.filter((terminal) =>
    [terminal.address, terminal.agent, terminal.cwd].some((field) => field.toLowerCase().includes(needle)),
  );
}

// Returns the argv for `hc attach`. Observe mode never types or resizes.
function attachArgv(address, { observe = false } = {}) {
  if (!isValidAddress(address)) {
    throw new HcParseError(`not a terminal address: ${address}`);
  }
  const argv = ['attach'];
  if (observe) {
    argv.push('--observe');
  }
  argv.push(address);
  return argv;
}

function isValidAddress(address) {
  return typeof address === 'string' && ADDRESS_RE.test(address);
}

// The pane title: the address and the agent, for example "t29 sh" or "t29 sh (watch)".
function paneTitle(terminal, { observe = false } = {}) {
  const parts = [terminal.address];
  if (terminal.agent) {
    parts.push(terminal.agent);
  }
  const title = parts.join(' ');
  return observe ? `${title} (watch)` : title;
}

// True when attach-all must ask before it opens every terminal.
function needsConfirm(count) {
  return count > CONFIRM_ABOVE;
}

module.exports = {
  CONFIRM_ABOVE,
  HcParseError,
  parseLs,
  liveTerminals,
  filterTerminals,
  attachArgv,
  isValidAddress,
  paneTitle,
  needsConfirm,
};
