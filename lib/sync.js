'use strict';

// Pure logic for the app <-> TUI sync: parse `herdr-app ls` (JSON) and the herdr
// TUI lists, then diff the desired layout against the recorded mapping and the
// live TUI panes into a list of ops. No I/O here.

const { isValidAddress } = require('./hc');

const LABEL_NUMBER_RE = /^\[\d+\]\s*/;
const APP_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

class SyncParseError extends Error {}

function emptyState() {
  return { spaces: {}, tabs: {}, panes: {}, detached: {}, asked: {} };
}

// Fills missing keys so an old or hand-edited state file still works.
function normalizeState(raw) {
  const state = emptyState();
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(state)) {
      if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
        state[key] = { ...raw[key] };
      }
    }
  }
  return state;
}

// Returns the local spaces from `herdr-app ls` (JSON):
// [{ spaceId, name, folder, tabs: [{ tabId, name, terminals: [address] }] }].
// Spaces on other machines are skipped: their labels live on that machine's core.
function parseAppLs(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SyncParseError(`herdr-app ls did not return JSON: ${error.message}`);
  }
  if (!data || !Array.isArray(data.spaces)) {
    throw new SyncParseError('herdr-app ls JSON has no spaces array');
  }
  const spaces = [];
  for (const space of data.spaces) {
    if (!space || !isAppId(space.id) || space.machine) {
      continue;
    }
    const tabs = [];
    for (const tab of Array.isArray(space.tabs) ? space.tabs : []) {
      if (!tab || !isAppId(tab.id)) {
        continue;
      }
      const terminals = (Array.isArray(tab.terminals) ? tab.terminals : [])
        .map((entry) => entry && entry.terminal)
        .filter(isValidAddress);
      tabs.push({ tabId: tab.id, name: stringOr(tab.name, ''), terminals });
    }
    spaces.push({ spaceId: space.id, name: stringOr(space.name, ''), folder: stringOr(space.folder, ''), tabs });
  }
  return spaces;
}

// Builds the TUI view from the `result` of `herdr workspace list`, `tab list` and `pane list`.
function parseTui({ workspaces, tabs, panes }) {
  const view = { workspaces: new Map(), tabs: new Map(), panes: new Map() };
  for (const ws of workspaces?.workspaces || []) {
    view.workspaces.set(ws.workspace_id, stripNumber(ws.label));
  }
  for (const tab of tabs?.tabs || []) {
    view.tabs.set(tab.tab_id, { label: stripNumber(tab.label), workspaceId: tab.workspace_id });
  }
  for (const pane of panes?.panes || []) {
    view.panes.set(pane.pane_id, { tabId: pane.tab_id, workspaceId: pane.workspace_id });
  }
  return view;
}

// The herdr TUI prefixes list labels with their number, for example "[3] skills".
function stripNumber(label) {
  return stringOr(label, '').replace(LABEL_NUMBER_RE, '');
}

// Diffs the app layout against the mapping and the live TUI into ordered ops:
//   forget       { terminal }                        terminal ended, pane already gone
//   closePane    { terminal, paneId }                terminal ended, close its pane
//   unmapSpace   { spaceId } / unmapTab { tabId }    the TUI workspace or tab is gone
//   reopen       { terminal }                        every synced pane vanished (TUI restart): open again, no question
//   ask          { terminals }                       the user closed synced panes: ask kill / keep / reopen
//   createWorkspace { spaceId, name, folder }
//   renameWorkspace { spaceId, workspaceId, name }
//   createTab    { spaceId, tabId, name, folder }
//   renameTab    { tabId, tuiTabId, name }
//   openPane     { spaceId, tabId, terminal }
// The executor runs them in order; create ops record their ids so later ops can find them.
function planSync(spaces, tui, rawState) {
  const state = normalizeState(rawState);
  const ops = [];
  const desired = new Map();
  for (const space of spaces) {
    for (const tab of space.tabs) {
      for (const terminal of tab.terminals) {
        desired.set(terminal, { spaceId: space.spaceId, tabId: tab.tabId });
      }
    }
  }

  const missing = [];
  for (const [terminal, entry] of Object.entries(state.panes)) {
    const paneLive = tui.panes.has(entry.paneId);
    if (!desired.has(terminal)) {
      ops.push(paneLive ? { type: 'closePane', terminal, paneId: entry.paneId } : { type: 'forget', terminal });
    } else if (!paneLive && !state.asked[terminal]) {
      missing.push(terminal);
    }
  }
  for (const terminal of new Set([...Object.keys(state.detached), ...Object.keys(state.asked)])) {
    if (!desired.has(terminal) && !state.panes[terminal]) {
      ops.push({ type: 'forget', terminal });
    }
  }

  const livePanes = Object.values(state.panes).filter((entry) => tui.panes.has(entry.paneId)).length;
  const reopened = new Set();
  if (missing.length > 0 && livePanes === 0) {
    // No synced pane is left at all: the TUI server restarted, nobody closed them.
    for (const terminal of missing) {
      ops.push({ type: 'reopen', terminal });
      reopened.add(terminal);
    }
  } else if (missing.length > 0) {
    ops.push({ type: 'ask', terminals: missing });
  }

  const spaceLive = new Map();
  for (const [spaceId, workspaceId] of Object.entries(state.spaces)) {
    const live = tui.workspaces.has(workspaceId);
    spaceLive.set(spaceId, live);
    if (!live) ops.push({ type: 'unmapSpace', spaceId });
  }
  const tabLive = new Map();
  for (const [tabId, entry] of Object.entries(state.tabs)) {
    const live = tui.tabs.has(entry.tuiTabId) && spaceLive.get(entry.spaceId) !== false;
    tabLive.set(tabId, live);
    if (!live) ops.push({ type: 'unmapTab', tabId });
  }

  const needsPane = (terminal) =>
    reopened.has(terminal) || (!state.panes[terminal] && !state.detached[terminal] && !state.asked[terminal]);

  for (const space of spaces) {
    const workspaceId = spaceLive.get(space.spaceId) ? state.spaces[space.spaceId] : null;
    const openTabs = space.tabs.filter((tab) => tab.terminals.some(needsPane));
    if (workspaceId) {
      if (space.name && tui.workspaces.get(workspaceId) !== space.name) {
        ops.push({ type: 'renameWorkspace', spaceId: space.spaceId, workspaceId, name: space.name });
      }
    } else if (openTabs.length > 0) {
      ops.push({ type: 'createWorkspace', spaceId: space.spaceId, name: space.name, folder: space.folder });
    }
    for (const tab of space.tabs) {
      const tuiTabId = tabLive.get(tab.tabId) ? state.tabs[tab.tabId].tuiTabId : null;
      const toOpen = tab.terminals.filter(needsPane);
      if (tuiTabId) {
        if (tab.name && tui.tabs.get(tuiTabId)?.label !== tab.name) {
          ops.push({ type: 'renameTab', tabId: tab.tabId, tuiTabId, name: tab.name });
        }
      } else if (toOpen.length > 0) {
        ops.push({ type: 'createTab', spaceId: space.spaceId, tabId: tab.tabId, name: tab.name, folder: space.folder });
      }
      for (const terminal of toOpen) {
        ops.push({ type: 'openPane', spaceId: space.spaceId, tabId: tab.tabId, terminal });
      }
    }
  }
  return ops;
}

// Finds the app space and tab a TUI pane belongs to, from the mapping. Either can be null.
function appPlaceFor(state, { workspaceId, tuiTabId }) {
  const normalized = normalizeState(state);
  const spaceId = Object.keys(normalized.spaces).find((id) => normalized.spaces[id] === workspaceId) || null;
  const tabId = Object.keys(normalized.tabs).find((id) => normalized.tabs[id].tuiTabId === tuiTabId) || null;
  return { spaceId: tabId ? normalized.tabs[tabId].spaceId : spaceId, tabId };
}

// argv for `hc run` that starts a kept shell the app adopts into that space and tab.
function syncedRunArgv({ spaceId, tabId, cwd, shell }) {
  if (!isAppId(spaceId) || !isAppId(tabId)) {
    throw new SyncParseError(`bad app ids: space ${spaceId}, tab ${tabId}`);
  }
  const argv = ['run', '--bg', '--keep', '--json', '--no-parent', '--label', `herdr.space=${spaceId}`, '--label', `herdr.tab=${tabId}`];
  if (cwd) argv.push('--cwd', cwd);
  argv.push('--', shell || '/bin/sh');
  return argv;
}

function isAppId(value) {
  return typeof value === 'string' && APP_ID_RE.test(value);
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

module.exports = {
  SyncParseError,
  emptyState,
  normalizeState,
  parseAppLs,
  parseTui,
  stripNumber,
  planSync,
  appPlaceFor,
  syncedRunArgv,
  isAppId,
};
