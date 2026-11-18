'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPane, paneCommand, resumeCommand, shellArgv, planPane } = require('../lib/convert');
const { placeForPane, emptyState } = require('../lib/sync');

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

const agentPane = (agent, value, status = 'idle') => ({ agent, agent_status: status, agent_session: { agent, kind: 'id', value } });

test('resumeCommand maps opencode, claude and codex sessions', () => {
  assert.equal(resumeCommand(agentPane('opencode', 'ses_abc123')), 'opencode -s ses_abc123');
  assert.equal(resumeCommand(agentPane('claude', '0f1e2d3c-aaaa-bbbb-cccc-1234567890ab')), 'claude --resume 0f1e2d3c-aaaa-bbbb-cccc-1234567890ab');
  assert.equal(resumeCommand(agentPane('codex', '019a-xyz')), 'codex resume 019a-xyz');
});

test('resumeCommand returns null for other agents, no session, or unsafe ids', () => {
  assert.equal(resumeCommand(agentPane('pi', 'ses_1')), null);
  assert.equal(resumeCommand({ agent: 'opencode', agent_status: 'idle' }), null);
  assert.equal(resumeCommand({ agent: 'opencode', agent_session: { agent: 'opencode', kind: 'path', value: '/x' } }), null);
  assert.equal(resumeCommand(agentPane('opencode', 'ses_1; rm -rf ~')), null);
  assert.equal(resumeCommand(agentPane('opencode', '')), null);
  assert.equal(resumeCommand({}), null);
});

test('shellArgv runs the resume command, then keeps a shell', () => {
  assert.deepEqual(shellArgv('/bin/zsh', 'opencode -s ses_1'), ['/bin/zsh', '-ic', "opencode -s ses_1; exec '/bin/zsh'"]);
  assert.deepEqual(shellArgv('/bin/zsh', null), ['/bin/zsh']);
  assert.deepEqual(shellArgv(undefined, null), ['/bin/sh']);
});

test('planPane marks working and blocked agents as active', () => {
  assert.deepEqual(planPane(agentPane('opencode', 'ses_1')), { agent: 'opencode', sessionId: 'ses_1', resume: 'opencode -s ses_1', active: false });
  assert.equal(planPane(agentPane('claude', 'abc', 'working')).active, true);
  assert.equal(planPane(agentPane('codex', 'abc', 'blocked')).active, true);
  assert.deepEqual(planPane({ agent: 'pi', agent_status: 'idle' }), { agent: 'pi', sessionId: '', resume: null, active: false });
  assert.deepEqual(planPane({ agent_status: 'unknown' }), { agent: '', sessionId: '', resume: null, active: false });
});

test('placeForPane puts the resume shell after --, with cwd and labels', () => {
  let n = 0;
  const { argv } = placeForPane(emptyState(), {
    workspaceId: 'w1', tuiTabId: 'w1:t1', cwd: '/tmp/x', shell: '/bin/zsh',
    shellArgs: shellArgv('/bin/zsh', 'opencode -s ses_1'), newId: (p) => `${p}_${String(++n).padStart(8, '0')}`,
  });
  const tail = argv.slice(argv.indexOf('--'));
  assert.deepEqual(tail, ['--', '/bin/zsh', '-ic', "opencode -s ses_1; exec '/bin/zsh'"]);
  assert.ok(argv.includes('/tmp/x'));
  assert.ok(argv.some((a) => a.startsWith('herdr.space=')) && argv.some((a) => a.startsWith('herdr.tab=')));
});
