'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIRM_ABOVE,
  HcParseError,
  parseLs,
  liveTerminals,
  filterTerminals,
  attachArgv,
  paneTitle,
  needsConfirm,
} = require('../lib/hc');

const SAMPLE = JSON.stringify({
  hidden_finished: 15,
  terminals: [
    { address: 't29', agent: 'sh', cwd: '/work/skills', state: 'live', turn: 0 },
    { address: 't1t', agent: 'zsh', cwd: '/Users/me', state: 'live', turn: 0, where: '~ / 1' },
    { address: 'box/t7', agent: 'claude', cwd: '/srv/app', state: 'live', turn: 2 },
    { address: 't3', agent: 'sh', cwd: '/tmp/old', state: 'finished', turn: 9 },
    { address: 'bad address', agent: 'x', cwd: '/', state: 'live' },
    null,
  ],
});

test('parseLs keeps valid addresses and the hidden finished count', () => {
  const { terminals, hiddenFinished } = parseLs(SAMPLE);
  assert.deepEqual(terminals.map((t) => t.address), ['t29', 't1t', 'box/t7', 't3']);
  assert.equal(hiddenFinished, 15);
  assert.equal(terminals[1].where, '~ / 1');
  assert.equal(terminals[0].where, '');
});

test('parseLs rejects non-JSON and a missing terminals array', () => {
  assert.throws(() => parseLs('not json'), HcParseError);
  assert.throws(() => parseLs('{"x":1}'), HcParseError);
});

test('parseLs accepts an empty list', () => {
  assert.deepEqual(parseLs('{"terminals":[]}'), { terminals: [], hiddenFinished: 0 });
});

test('liveTerminals drops finished terminals', () => {
  const { terminals } = parseLs(SAMPLE);
  assert.deepEqual(liveTerminals(terminals).map((t) => t.address), ['t29', 't1t', 'box/t7']);
});

test('filterTerminals matches address, agent and cwd case-insensitively', () => {
  const { terminals } = parseLs(SAMPLE);
  assert.deepEqual(filterTerminals(terminals, '').length, 4);
  assert.deepEqual(filterTerminals(terminals, 'CLAUDE').map((t) => t.address), ['box/t7']);
  assert.deepEqual(filterTerminals(terminals, '/work').map((t) => t.address), ['t29']);
  assert.deepEqual(filterTerminals(terminals, 't1').map((t) => t.address), ['t1t']);
  assert.deepEqual(filterTerminals(terminals, 'nothing-here'), []);
});

test('attachArgv builds attach and observe argv', () => {
  assert.deepEqual(attachArgv('t29'), ['attach', 't29']);
  assert.deepEqual(attachArgv('box/t7', { observe: true }), ['attach', '--observe', 'box/t7']);
});

test('attachArgv rejects an address that could inject options', () => {
  assert.throws(() => attachArgv('--kill'), HcParseError);
  assert.throws(() => attachArgv('t1; rm -rf ~'), HcParseError);
});

test('paneTitle shows the address and agent, and marks observe mode', () => {
  assert.equal(paneTitle({ address: 't29', agent: 'sh' }), 't29 sh');
  assert.equal(paneTitle({ address: 't29', agent: '' }), 't29');
  assert.equal(paneTitle({ address: 't29', agent: 'sh' }, { observe: true }), 't29 sh (watch)');
});

test('needsConfirm asks above six terminals only', () => {
  assert.equal(CONFIRM_ABOVE, 6);
  assert.equal(needsConfirm(6), false);
  assert.equal(needsConfirm(7), true);
});
