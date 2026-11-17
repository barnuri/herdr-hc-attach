'use strict';

const { execFileSync } = require('node:child_process');

const { parseLs, liveTerminals } = require('./hc');

class HcMissingError extends Error {}

function hcBinary() {
  return process.env.HC_BIN_PATH || 'hc';
}

// Lists the terminals through `hc ls --json`. Throws HcMissingError when hc is not installed.
function listTerminals() {
  let stdout;
  try {
    stdout = execFileSync(hcBinary(), ['ls', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HcMissingError(`hc not found on PATH (looked for "${hcBinary()}"). Install herdr-core, then reopen.`);
    }
    const detail = (error.stderr || error.message || '').toString().trim();
    throw new Error(`hc ls failed: ${detail}`);
  }
  return parseLs(stdout);
}

module.exports = { HcMissingError, listTerminals, liveTerminals };
