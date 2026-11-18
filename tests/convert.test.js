'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPane, paneCommand } = require('../lib/convert');

const proc = (pid, argv) => ({ pid, argv, cmdline: argv.join(' '), name: argv[0].split('/').pop() });
const info = (shellPid, procs, extra = {}) => ({ pane_id: 'w1:p1', shell_pid: shellPid, foreground_processes: procs, ...extra });

test('classifyPane: an idle login shell is idle', () => {
  assert.equal(classifyPane(info(10, [proc(10, ['-zsh'])]), new Set()), 'idle');
});

test('classifyPane: a shell running an agent is busy', () => {
  assert.equal(classifyPane(info(10, [proc(20, ['opencode', '--standalone'])]), new Set()), 'busy');
});

test('classifyPane: a plugin pane runs its program with no shell', () => {
  assert.equal(classifyPane(info(30, [proc(30, ['node', 'bin/slot.js'])]), new Set()), 'program');
  assert.equal(classifyPane(info(30, []), new Set()), 'program');
});

test('classifyPane: hc attach panes and recorded panes are synced', () => {
  assert.equal(classifyPane(info(10, [proc(11, ['/Users/x/.local/bin/hc', 'attach', 't5'])]), new Set()), 'synced');
  assert.equal(classifyPane(info(10, [proc(10, ['-zsh'])]), new Set(['w1:p1'])), 'synced');
});

test('paneCommand names the foreground program', () => {
  const pane = info(10, [proc(31, ['git', 'status']), proc(20, ['opencode', '--standalone'])], { foreground_process_group_id: 20 });
  assert.equal(paneCommand(pane), 'opencode --standalone');
  assert.equal(paneCommand(info(10, [])), '');
});
