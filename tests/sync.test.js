'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { appPlaceFor, normalizeState, parseAppLs, parseTui, planSync, stripNumber, syncedRunArgv } = require('../lib/sync');

const appJson = (spaces) => JSON.stringify({ spaces, recent: [] });
const space = (id, name, tabs, machine = null) => ({ id, name, folder: '/tmp', machine, tabs });
const tab = (id, name, terminals) => ({ id, name, terminals: terminals.map((t) => ({ terminal: t, pane: `p-${t}` })) });

function tuiView({ workspaces = {}, tabs = {}, panes = {} } = {}) {
  return {
    workspaces: new Map(Object.entries(workspaces)),
    tabs: new Map(Object.entries(tabs)),
    panes: new Map(Object.entries(panes)),
  };
}

const types = (ops) => ops.map((op) => op.type);

test('parseAppLs keeps local spaces, tabs and valid addresses', () => {
  const spaces = parseAppLs(appJson([
    space('spA', 'repo', [tab('tb1', '1', ['t1', 'bad address']), tab('tb2', 'fix', [])]),
    space('spR', 'remote', [tab('tb9', '1', ['t9'])], 'vps'),
  ]));
  assert.deepEqual(spaces, [{ spaceId: 'spA', name: 'repo', folder: '/tmp', tabs: [
    { tabId: 'tb1', name: '1', terminals: ['t1'] },
    { tabId: 'tb2', name: 'fix', terminals: [] },
  ] }]);
});

test('parseAppLs rejects non-JSON and a missing spaces array', () => {
  assert.throws(() => parseAppLs('usage: herdr-app ls'), /did not return JSON/);
  assert.throws(() => parseAppLs('{}'), /no spaces array/);
});

test('parseTui strips the [n] prefix from labels', () => {
  const view = parseTui({
    workspaces: { workspaces: [{ workspace_id: 'w1', label: '[3] skills (private)' }] },
    tabs: { tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '[1] node' }] },
    panes: { panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }] },
  });
  assert.equal(view.workspaces.get('w1'), 'skills (private)');
  assert.deepEqual(view.tabs.get('w1:t1'), { label: 'node', workspaceId: 'w1' });
  assert.deepEqual(view.panes.get('w1:p1'), { tabId: 'w1:t1', workspaceId: 'w1' });
  assert.equal(stripNumber(undefined), '');
});

test('planSync opens a workspace, a tab and panes for a new space', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '1', ['t1', 't2']), tab('tb2', 'x', [])])]));
  const ops = planSync(spaces, tuiView(), null);
  assert.deepEqual(types(ops), ['createWorkspace', 'createTab', 'openPane', 'openPane']);
  assert.equal(ops[0].name, 'repo');
  assert.deepEqual(ops.slice(2).map((op) => op.terminal), ['t1', 't2']);
});

test('planSync is idempotent when the mapping matches the TUI', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '1', ['t1'])])]));
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } }, panes: { t1: { paneId: 'w1:p1', tabId: 'tb1' } } };
  const tui = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: '1', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1' } } });
  assert.deepEqual(planSync(spaces, tui, state), []);
});

test('planSync adds a pane for a new terminal in a mapped tab, and renames', () => {
  const spaces = parseAppLs(appJson([space('spA', 'renamed', [tab('tb1', 'fix login', ['t1', 't3'])])]));
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } }, panes: { t1: { paneId: 'w1:p1', tabId: 'tb1' } } };
  const tui = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: '1', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1' } } });
  const ops = planSync(spaces, tui, state);
  assert.deepEqual(types(ops), ['renameWorkspace', 'renameTab', 'openPane']);
  assert.equal(ops[0].name, 'renamed');
  assert.equal(ops[1].name, 'fix login');
  assert.equal(ops[2].terminal, 't3');
});

test('planSync closes the pane of an ended terminal and forgets one already gone', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '1', [])])]));
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } }, panes: {
    t1: { paneId: 'w1:p1', tabId: 'tb1' },
    t2: { paneId: 'w1:p2', tabId: 'tb1' },
  } };
  const tui = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: '1', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1' } } });
  const ops = planSync(spaces, tui, state);
  assert.deepEqual(ops, [{ type: 'closePane', terminal: 't1', paneId: 'w1:p1' }, { type: 'forget', terminal: 't2' }]);
});

test('planSync asks once when the user closed a synced pane while others stay', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '1', ['t1', 't2'])])]));
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } }, panes: {
    t1: { paneId: 'w1:p1', tabId: 'tb1' },
    t2: { paneId: 'w1:p2', tabId: 'tb1' },
  } };
  const tui = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: '1', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1' } } });
  assert.deepEqual(planSync(spaces, tui, state), [{ type: 'ask', terminals: ['t2'] }]);
  assert.deepEqual(planSync(spaces, tui, { ...state, asked: { t2: 1 } }), []);
});

test('planSync reopens without asking when every synced pane vanished (TUI restart)', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '1', ['t1'])])]));
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } }, panes: { t1: { paneId: 'w1:p1', tabId: 'tb1' } } };
  const ops = planSync(spaces, tuiView(), state);
  assert.deepEqual(types(ops), ['reopen', 'unmapSpace', 'unmapTab', 'createWorkspace', 'createTab', 'openPane']);
});

test('planSync leaves detached terminals alone and forgets them once they end', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '1', ['t1'])])]));
  assert.deepEqual(planSync(spaces, tuiView(), { detached: { t1: true } }), []);
  const none = parseAppLs(appJson([]));
  assert.deepEqual(planSync(none, tuiView(), { detached: { t1: true } }), [{ type: 'forget', terminal: 't1' }]);
});

test('planSync skips spaces and tabs without terminals', () => {
  const spaces = parseAppLs(appJson([space('spA', '~', [tab('tb1', '1', [])])]));
  assert.deepEqual(planSync(spaces, tuiView(), null), []);
});

test('planSync opens a new tab in a mapped workspace', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb2', '2', ['t5'])])]));
  const ops = planSync(spaces, tuiView({ workspaces: { w1: 'repo' } }), { spaces: { spA: 'w1' } });
  assert.deepEqual(types(ops), ['createTab', 'openPane']);
});

test('appPlaceFor maps a TUI pane back to its app space and tab', () => {
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } } };
  assert.deepEqual(appPlaceFor(state, { workspaceId: 'w1', tuiTabId: 'w1:t1' }), { spaceId: 'spA', tabId: 'tb1' });
  assert.deepEqual(appPlaceFor(state, { workspaceId: 'w1', tuiTabId: 'w1:t9' }), { spaceId: 'spA', tabId: null });
  assert.deepEqual(appPlaceFor(state, { workspaceId: 'w2', tuiTabId: 'w2:t1' }), { spaceId: null, tabId: null });
});

test('syncedRunArgv labels a kept shell for the app', () => {
  assert.deepEqual(syncedRunArgv({ spaceId: 'spA', tabId: 'tb1', cwd: '/x', shell: '/bin/zsh' }), [
    'run', '--bg', '--keep', '--json', '--no-parent', '--label', 'herdr.space=spA', '--label', 'herdr.tab=tb1', '--cwd', '/x', '--', '/bin/zsh',
  ]);
  assert.throws(() => syncedRunArgv({ spaceId: 'a b', tabId: 'tb1' }), /bad app ids/);
});

test('normalizeState fills missing keys and drops bad ones', () => {
  assert.deepEqual(normalizeState({ panes: [], spaces: { a: 'w' } }), { spaces: { a: 'w' }, tabs: {}, panes: {}, detached: {}, asked: {} });
});
