'use strict';

// Pure logic for "hc: convert panes to synced": sort TUI panes by what runs in them.
// No I/O here.

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'hc-shell']);

function baseName(value) {
  return String(value || '').replace(/^-/, '').split('/').pop();
}

function isShell(proc) {
  return SHELLS.has(baseName(proc.argv?.[0] || proc.argv0 || proc.name));
}

function isAttach(proc) {
  const argv = proc.argv || [];
  return baseName(argv[0]) === 'hc' && argv[1] === 'attach';
}

// One pane from `herdr pane list` and its `pane process-info`. Returns
//   synced   already an `hc attach` pane (or recorded as one)
//   idle     a shell at its prompt: safe to swap
//   busy     a shell running a program (an agent, an editor): swap ends that program
//   program  the pane runs a program with no shell (a plugin pane): never swapped
function classifyPane(processInfo, syncedPaneIds) {
  const paneId = processInfo.pane_id;
  if (syncedPaneIds.has(paneId)) return 'synced';
  const procs = Array.isArray(processInfo.foreground_processes) ? processInfo.foreground_processes : [];
  if (procs.some(isAttach)) return 'synced';
  if (procs.length === 0) return 'program';
  if (procs.every(isShell)) return 'idle';
  if (procs.some((proc) => proc.pid === processInfo.shell_pid)) return 'program';
  return 'busy';
}

// What a busy pane runs, for the confirm list: "opencode --standalone".
function paneCommand(processInfo) {
  const procs = Array.isArray(processInfo.foreground_processes) ? processInfo.foreground_processes : [];
  const main = procs.find((proc) => proc.pid === processInfo.foreground_process_group_id) || procs[0];
  return main ? String(main.cmdline || main.name || '') : '';
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESUME = {
  opencode: (id) => `opencode -s ${id}`,
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
};
const ACTIVE_STATUSES = new Set(['working', 'blocked']);

// The command that resumes the agent session of a `herdr pane list` entry, or null
// when the agent is unknown or the session id is missing or unsafe for a shell.
function resumeCommand(pane) {
  const session = pane?.agent_session;
  const agent = session?.agent || pane?.agent;
  const build = RESUME[agent];
  if (!build || session?.kind !== 'id' || !SESSION_ID_RE.test(String(session.value || ''))) return null;
  return build(session.value);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// argv tail for `hc run -- ...`: the shell starts the resume command and keeps a shell
// when the agent exits. Without a command it is the plain shell.
function shellArgv(shell, command) {
  const sh = shell || '/bin/sh';
  if (!command) return [sh];
  return [sh, '-ic', `${command}; exec ${shellQuote(sh)}`];
}

// Resume facts for one busy pane: what it resumes and whether converting it needs the
// extra confirm because the agent is working or blocked.
function planPane(pane) {
  const resume = resumeCommand(pane);
  return {
    agent: pane?.agent || '',
    sessionId: resume ? pane.agent_session.value : '',
    resume,
    active: Boolean(pane?.agent) && ACTIVE_STATUSES.has(pane.agent_status),
  };
}

module.exports = { classifyPane, paneCommand, resumeCommand, shellArgv, planPane };
