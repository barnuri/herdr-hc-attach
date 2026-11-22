'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { appPlaceFor, holdPane, isAutoTabLabel, nameDirection, paneAgents, placeForPane, normalizeState, parseAppLs, parseTui, planSync, stripNumber, syncedRunArgv } = require('../lib/sync');

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
// Tests about panes ignore the first-pass name bookkeeping.
const paneOps = (ops) => ops.filter((op) => op.type !== 'recordName');

test('parseAppLs keeps local spaces, tabs and valid addresses', () => {
  const spaces = parseAppLs(appJson([
    space('spA', 'repo', [tab('tb1', '1', ['t1', 'bad address']), tab('tb2', 'fix', [])]),
    space('spR', 'remote', [tab('tb9', '1', ['t9'])], 'vps'),
  ]));
  assert.deepEqual(spaces, [{ spaceId: 'spA', name: 'repo', folder: '/tmp', tabs: [
    { tabId: 'tb1', name: '1', terminals: ['t1'], agents: {} },
    { tabId: 'tb2', name: 'fix', terminals: [], agents: {} },
  ] }]);
});

test('paneAgents maps the app agent of each terminal, unknown when the status is not a herdr state', () => {
  const withAgents = (agents) => ({ id: 'tb1', name: '1', terminals: Object.keys(agents).map((t) => ({ terminal: t, pane: `p-${t}`, ...agents[t] })) });
  const spaces = parseAppLs(appJson([space('spA', 'repo', [
    withAgents({ t1: { app: 'opencode', status: 'working' }, t2: { app: 'claude', status: null }, t3: { app: null, status: null } }),
  ])]));
  const agents = paneAgents(spaces);
  assert.deepEqual(agents.get('t1'), { agent: 'opencode', state: 'working' });
  assert.deepEqual(agents.get('t2'), { agent: 'claude', state: 'unknown' });
  assert.equal(agents.has('t3'), false);
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
  assert.deepEqual(view.panes.get('w1:p1'), { tabId: 'w1:t1', workspaceId: 'w1', title: '' });
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
  // First pass records the names both sides agree on, then nothing is left to do.
  const ops = planSync(spaces, tui, state);
  assert.deepEqual(ops, [{ type: 'recordName', key: 'space:spA', name: 'repo' }, { type: 'recordName', key: 'tab:tb1', name: '' }]);
  state.names = { 'space:spA': 'repo', 'tab:tb1': '' };
  assert.deepEqual(planSync(spaces, tui, state), []);
});

test('nameDirection: app renames win, TUI renames go to the app, TUI-born names go first', () => {
  assert.equal(nameDirection('a', 'a', 'a'), null);
  assert.equal(nameDirection(undefined, 'a', 'a'), 'record');
  assert.equal(nameDirection('a', 'b', 'a'), 'toTui');
  assert.equal(nameDirection('a', 'a', 'b'), 'toApp');
  assert.equal(nameDirection('a', 'b', 'c'), 'toTui');
  assert.equal(nameDirection(undefined, 'b', 'c'), 'toTui');
  assert.equal(nameDirection(null, 'derived', 'repo'), 'toApp');
  assert.equal(nameDirection(null, 'x', ''), null);
  // An unnamed app tab takes a TUI rename; a label already recorded is not sent again.
  assert.equal(nameDirection('', '', 'build'), 'toApp');
  assert.equal(nameDirection('node', '', 'node'), null);
  assert.equal(nameDirection('node', 'x', 'node'), 'toTui');
  assert.equal(nameDirection('a', 'a', ''), 'toTui');
});

test('isAutoTabLabel spots labels herdr made from the running program', () => {
  assert.equal(isAutoTabLabel('hc', {}), true);
  assert.equal(isAutoTabLabel('opencode', { processNames: ['/usr/bin/opencode'] }), true);
  assert.equal(isAutoTabLabel('OC | plan', { titles: ['OC | plan'] }), true);
  assert.equal(isAutoTabLabel('build', { processNames: ['-zsh'], titles: ['~/repo'] }), false);
});

test('planSync treats a numbered app tab as unnamed and an auto TUI label as no name: no rename either way', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '2', ['t1', 't2'])])]));
  const state = {
    spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } },
    panes: { t1: { paneId: 'w1:p1', tabId: 'tb1' } }, names: { 'space:spA': 'repo', 'tab:tb1': '' },
  };
  const tui = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: 'node', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1' } } });
  // 'node' is an automatic label (isAutoTabLabel): no rename in either direction.
  assert.deepEqual(types(planSync(spaces, tui, state)), ['openPane']);
  const fresh = planSync(spaces, tuiView({ workspaces: { w1: 'repo' } }), { spaces: { spA: 'w1' }, names: { 'space:spA': 'repo' } });
  assert.equal(fresh.find((op) => op.type === 'createTab').name, '');
  const numbered = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: '1', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1' } } });
  assert.deepEqual(types(planSync(spaces, numbered, state)), ['openPane']);
});

test('planSync names a TUI-born space and tab in the app after the TUI', () => {
  const spaces = parseAppLs(appJson([space('spN', '~', [tab('tbN', '', ['t5'])])]));
  const state = {
    spaces: { spN: 'w1' }, tabs: { tbN: { tuiTabId: 'w1:t1', spaceId: 'spN' } },
    panes: { t5: { paneId: 'w1:p1', tabId: 'tbN' } }, names: { 'space:spN': null, 'tab:tbN': null },
  };
  const tui = tuiView({ workspaces: { w1: 'skills' }, tabs: { 'w1:t1': { label: 'build', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1' } } });
  assert.deepEqual(planSync(spaces, tui, state), [
    { type: 'renameAppSpace', spaceId: 'spN', workspaceId: 'w1', name: 'skills' },
    { type: 'renameAppTab', tabId: 'tbN', tuiTabId: 'w1:t1', name: 'build' },
  ]);
});

test('placeForPane reuses the mapping, else makes ids the TUI names first', () => {
  const state = normalizeState({ spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } } });
  const mapped = placeForPane(state, { workspaceId: 'w1', tuiTabId: 'w1:t1', cwd: '/r', shell: '/bin/zsh' });
  assert.deepEqual([mapped.spaceId, mapped.tabId], ['spA', 'tb1']);
  assert.deepEqual(state.names, {});
  const newId = (prefix) => `${prefix}New`;
  const newTab = placeForPane(state, { workspaceId: 'w1', tuiTabId: 'w1:t2', cwd: '/r', newId });
  assert.deepEqual([newTab.spaceId, newTab.tabId], ['spA', 'tbNew']);
  assert.deepEqual(state.tabs.tbNew, { tuiTabId: 'w1:t2', spaceId: 'spA' });
  assert.deepEqual(state.names, { 'tab:tbNew': null });
  const newSpace = placeForPane(state, { workspaceId: 'w2', tuiTabId: 'w2:t1', cwd: '/r', newId: (p) => `${p}Two` });
  assert.deepEqual([newSpace.spaceId, newSpace.tabId], ['spTwo', 'tbTwo']);
  assert.equal(state.spaces.spTwo, 'w2');
  assert.equal(state.names['space:spTwo'], null);
  assert.ok(newSpace.argv.includes('herdr.space=spTwo'));
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
  const ops = paneOps(planSync(spaces, tui, state));
  assert.deepEqual(ops, [{ type: 'closePane', terminal: 't1', paneId: 'w1:p1' }, { type: 'forget', terminal: 't2' }]);
});

test('planSync reopens a closed synced pane while its terminal runs, without asking', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '1', ['t1', 't2'])])]));
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } }, panes: {
    t1: { paneId: 'w1:p1', tabId: 'tb1' },
    t2: { paneId: 'w1:p2', tabId: 'tb1' },
  } };
  const tui = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: '1', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1' } } });
  const ops = paneOps(planSync(spaces, tui, state));
  assert.ok(ops.some((op) => op.type === 'reopen' && op.terminal === 't2'));
  assert.ok(!ops.some((op) => op.type === 'ask'));
});

test('planSync leaves tab names alone when either side is an auto label', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', 'skills', ['t1'])])]));
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } }, panes: { t1: { paneId: 'w1:p1', tabId: 'tb1' } } };
  const tui = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: 'hc', workspaceId: 'w1' } }, panes: { 'w1:p1': { tabId: 'w1:t1', title: 'OC | model' } } });
  assert.deepEqual(paneOps(planSync(spaces, tui, state)).filter((op) => op.type.startsWith('rename')), []);
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
  const ops = paneOps(planSync(spaces, tuiView({ workspaces: { w1: 'repo' } }), { spaces: { spA: 'w1' } }));
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
  assert.deepEqual(normalizeState({ panes: [], spaces: { a: 'w' } }), { spaces: { a: 'w' }, tabs: {}, panes: {}, detached: {}, asked: {}, names: {} });
});

test('holdPane keeps a pane whose terminal hc still lists as live', () => {
  assert.equal(holdPane('t1', { paneId: 'w1:p1' }, { liveTerminals: new Set(['t1']) }), true);
  assert.equal(holdPane('t1', { paneId: 'w1:p1' }, { liveTerminals: new Set(['t2']) }), false);
});

test('holdPane keeps a pane recorded at or after the app snapshot', () => {
  assert.equal(holdPane('t1', { paneId: 'w1:p1', recordedAt: 200 }, { snapshotAt: 100 }), true);
  assert.equal(holdPane('t1', { paneId: 'w1:p1', recordedAt: 100 }, { snapshotAt: 100 }), true);
  assert.equal(holdPane('t1', { paneId: 'w1:p1', recordedAt: 50 }, { snapshotAt: 100 }), false);
  assert.equal(holdPane('t1', { paneId: 'w1:p1' }, { snapshotAt: 100 }), false);
  assert.equal(holdPane('t1', { paneId: 'w1:p1', recordedAt: 200 }, {}), false);
});

test('planSync does not close the pane of a terminal the stale app snapshot misses', () => {
  const spaces = parseAppLs(appJson([space('spA', 'repo', [tab('tb1', '1', [])])]));
  const state = { spaces: { spA: 'w1' }, tabs: { tb1: { tuiTabId: 'w1:t1', spaceId: 'spA' } }, panes: {
    t1: { paneId: 'w1:p1', tabId: 'tb1', recordedAt: 200 },
    t2: { paneId: 'w1:p2', tabId: 'tb1' },
    t3: { paneId: 'w1:p3', tabId: 'tb1', recordedAt: 10 },
  } };
  const tui = tuiView({ workspaces: { w1: 'repo' }, tabs: { 'w1:t1': { label: '1', workspaceId: 'w1' } }, panes: {
    'w1:p1': { tabId: 'w1:t1' }, 'w1:p2': { tabId: 'w1:t1' }, 'w1:p3': { tabId: 'w1:t1' },
  } });
  const ops = paneOps(planSync(spaces, tui, state, { snapshotAt: 100, liveTerminals: new Set(['t2']) }));
  assert.deepEqual(ops, [{ type: 'closePane', terminal: 't3', paneId: 'w1:p3' }]);
});
