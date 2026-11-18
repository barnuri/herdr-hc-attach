'use strict';

// I/O side of the sync: the state file and its lock, reading the app and the TUI,
// and running the ops from lib/sync.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { attachArgv } = require('./hc');
const { hcBinary } = require('./hc-cli');
const { PLUGIN_ID, runHerdr, findPaneId } = require('./herdr');
const { normalizeState, parseAppLs, parseTui } = require('./sync');

const STATE_FILE = 'sync-state.json';
const LOCK_NAME = 'sync.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function stateDir() {
  return process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.homedir(), '.config', 'herdr', 'plugins', 'state', PLUGIN_ID);
}

function loadState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(path.join(stateDir(), STATE_FILE), 'utf8')));
  } catch {
    return normalizeState(null);
  }
}

function saveState(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const file = path.join(stateDir(), STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Runs fn(state) under a directory lock, then saves the state. The watcher and the
// actions both write the mapping, so neither may lose the other's change.
function withState(fn) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const lock = path.join(stateDir(), LOCK_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.rmdirSync(lock, { recursive: false });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`state lock busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const state = loadState();
    const result = fn(state);
    saveState(state);
    return result;
  } finally {
    fs.rmdirSync(lock);
  }
}

function appBinary() {
  return process.env.HERDR_APP_BIN_PATH || 'herdr-app';
}

// The app's local spaces, or null when the app is not reachable (then nothing changes).
function readApp() {
  try {
    const stdout = execFileSync(appBinary(), ['ls'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    return parseAppLs(stdout);
  } catch {
    return null;
  }
}

function readTui() {
  return parseTui({
    workspaces: runHerdr(['workspace', 'list']),
    tabs: runHerdr(['tab', 'list']),
    panes: runHerdr(['pane', 'list']),
  });
}

function attachCommand(terminal) {
  return [hcBinary(), ...attachArgv(terminal)].join(' ');
}

// A pane of this TUI tab to split from: a synced pane in it, else any pane in it.
function splitTarget(state, tui, tuiTabId) {
  for (const entry of Object.values(state.panes)) {
    const pane = tui.panes.get(entry.paneId);
    if (pane && pane.tabId === tuiTabId) return entry.paneId;
  }
  for (const [paneId, pane] of tui.panes) {
    if (pane.tabId === tuiTabId) return paneId;
  }
  return null;
}

// Runs one op and updates state and the tui view. `free` holds root panes of new tabs
// that are still empty (tabId -> paneId), so the first terminal uses that pane.
function runOp(op, ctx) {
  const { state, tui, free, onAsk } = ctx;
  switch (op.type) {
    case 'forget':
      delete state.panes[op.terminal];
      delete state.detached[op.terminal];
      delete state.asked[op.terminal];
      return;
    case 'closePane':
      try {
        runHerdr(['pane', 'close', op.paneId]);
      } catch {
        // already gone
      }
      tui.panes.delete(op.paneId);
      delete state.panes[op.terminal];
      return;
    case 'reopen':
      delete state.panes[op.terminal];
      return;
    case 'ask':
      for (const terminal of op.terminals) state.asked[terminal] = Date.now();
      onAsk(op.terminals);
      return;
    case 'unmapSpace':
      delete state.spaces[op.spaceId];
      return;
    case 'unmapTab':
      delete state.tabs[op.tabId];
      return;
    case 'createWorkspace': {
      const args = ['workspace', 'create', '--no-focus', '--label', op.name || 'hc'];
      if (op.folder && fs.existsSync(op.folder)) args.push('--cwd', op.folder);
      const result = runHerdr(args);
      const workspaceId = result.workspace?.workspace_id;
      const tuiTabId = result.tab?.tab_id;
      const rootPane = findPaneId(result);
      if (!workspaceId || !tuiTabId || !rootPane) throw new Error('herdr workspace create returned no ids');
      state.spaces[op.spaceId] = workspaceId;
      tui.workspaces.set(workspaceId, op.name);
      tui.tabs.set(tuiTabId, { label: '', workspaceId });
      tui.panes.set(rootPane, { tabId: tuiTabId, workspaceId });
      // The first app tab of this space takes the workspace's first tab.
      ctx.unclaimedTab.set(op.spaceId, { tuiTabId, rootPane });
      return;
    }
    case 'renameWorkspace':
      runHerdr(['workspace', 'rename', op.workspaceId, op.name]);
      tui.workspaces.set(op.workspaceId, op.name);
      return;
    case 'createTab': {
      const workspaceId = state.spaces[op.spaceId];
      if (!workspaceId) throw new Error(`no TUI workspace for space ${op.spaceId}`);
      let claimed = ctx.unclaimedTab.get(op.spaceId);
      ctx.unclaimedTab.delete(op.spaceId);
      if (!claimed) {
        const args = ['tab', 'create', '--workspace', workspaceId];
        if (op.folder && fs.existsSync(op.folder)) args.push('--cwd', op.folder);
        const result = runHerdr(args);
        claimed = { tuiTabId: result.tab?.tab_id, rootPane: findPaneId(result) };
        if (!claimed.tuiTabId || !claimed.rootPane) throw new Error('herdr tab create returned no ids');
        tui.panes.set(claimed.rootPane, { tabId: claimed.tuiTabId, workspaceId });
      }
      if (op.name) runHerdr(['tab', 'rename', claimed.tuiTabId, op.name]);
      tui.tabs.set(claimed.tuiTabId, { label: op.name, workspaceId });
      state.tabs[op.tabId] = { tuiTabId: claimed.tuiTabId, spaceId: op.spaceId };
      free.set(op.tabId, claimed.rootPane);
      return;
    }
    case 'renameTab':
      runHerdr(['tab', 'rename', op.tuiTabId, op.name]);
      tui.tabs.get(op.tuiTabId).label = op.name;
      return;
    case 'openPane': {
      const tuiTabId = state.tabs[op.tabId]?.tuiTabId;
      if (!tuiTabId) throw new Error(`no TUI tab for app tab ${op.tabId}`);
      let paneId = free.get(op.tabId);
      free.delete(op.tabId);
      if (!paneId) {
        const target = splitTarget(state, tui, tuiTabId);
        if (!target) throw new Error(`no pane to split in TUI tab ${tuiTabId}`);
        const count = Object.values(state.panes).filter((entry) => tui.panes.get(entry.paneId)?.tabId === tuiTabId).length;
        paneId = findPaneId(runHerdr(['pane', 'split', target, '--direction', count % 2 ? 'down' : 'right']));
        if (!paneId) throw new Error('herdr pane split returned no pane id');
      }
      tui.panes.set(paneId, { tabId: tuiTabId, workspaceId: tui.tabs.get(tuiTabId)?.workspaceId });
      runHerdr(['pane', 'run', paneId, attachCommand(op.terminal)]);
      runHerdr(['pane', 'rename', paneId, `${op.terminal} (synced)`]);
      state.panes[op.terminal] = { paneId, tabId: op.tabId };
      return;
    }
    default:
      throw new Error(`unknown op ${op.type}`);
  }
}

// Opens the confirm popup for terminals whose synced TUI pane the user closed.
function openAskPopup(terminals) {
  runHerdr([
    'plugin', 'pane', 'open',
    '--plugin', PLUGIN_ID,
    '--entrypoint', 'confirm-close',
    '--placement', 'popup',
    '--env', `HC_ORPHANS=${terminals.join(',')}`,
    '--focus',
  ]);
}

// One sync pass. Returns { ops, errors }. With dryRun nothing changes.
function syncOnce({ dryRun = false, plan, onAsk = openAskPopup } = {}) {
  const spaces = readApp();
  if (spaces === null) return { ops: [], errors: ['herdr-app ls failed; nothing changed'] };
  if (dryRun) {
    return { ops: plan(spaces, readTui(), loadState()), errors: [] };
  }
  return withState((state) => {
    const tui = readTui();
    const ops = plan(spaces, tui, state);
    const ctx = { state, tui, free: new Map(), unclaimedTab: new Map(), onAsk };
    const errors = [];
    for (const op of ops) {
      try {
        runOp(op, ctx);
      } catch (error) {
        errors.push(`${op.type} ${op.terminal || op.tabId || op.spaceId || ''}: ${error.message}`);
      }
    }
    return { ops, errors };
  });
}

module.exports = { stateDir, loadState, withState, readApp, readTui, attachCommand, syncOnce };
