# herdr-hc-attach

A herdr 0.9.5 plugin that opens live herdr-core (`hc`) terminals as herdr panes. The same terminal can then be worked from the herdr app and from the TUI.

## Install (1 minute)

```bash
herdr plugin link ~/sandbox/private/herdr-hc-attach
herdr plugin list   # barnuri.hc-attach should be listed and enabled
```

Needs `hc` on PATH and Node 22 or later. Zero runtime dependencies.

## Actions

- `hc: attach a terminal`: a popup lists the live terminals (`hc ls`: address, agent, cwd). Type to filter, arrow keys to move, Enter opens the chosen terminal as a split pane running `hc attach <t>`.
- `hc: watch a terminal`: the same list, opened with `hc attach --observe`. Watch never types or resizes.
- `hc: attach all`: opens every live terminal in one new tab. Asks first when there are more than 6.

Each pane title shows the terminal address and agent, for example `t29 sh`, and `(watch)` in observe mode.

- `hc: new synced terminal (shows in the herdr app)`: starts a kept shell with `hc run --bg --keep --label herdr.space=<id> --label herdr.tab=<id> -- $SHELL` in the folder of the current pane, then opens it in a split on the right. The ids come from the app space and tab that this TUI workspace and tab are synced with. When there is no synced space or tab, new ids are made, and the herdr app makes a new space or tab for them. herdr 0.9.5 plugins cannot bind keys, so run it from the action list.

## Sync with the herdr app

A background watcher (`bin/sync.js`, started by `[[startup]]` and restarted on the next pane focus when it died) reads `herdr-app ls` every 3 seconds (`HC_SYNC_MS`). It keeps:

- one TUI workspace for each local app space that has terminals, with the space's name;
- one TUI tab for each app tab that has terminals, with the tab's name;
- one pane per terminal, running `hc attach <t>`, titled `<t> (synced)`.

What it does:

| In the app | In the TUI |
| --- | --- |
| a new terminal | a new pane, split in its tab (a new workspace and tab when needed) |
| a terminal ends, or its pane is closed | the watcher closes the TUI pane |
| a space or tab is renamed | the TUI workspace or tab is renamed |

| In the TUI | In the app |
| --- | --- |
| `hc: new synced terminal` | the terminal shows in the synced space and tab |
| you close a synced pane | a popup asks: `k` ends the terminal (the app pane goes too), `r` opens the pane again, `d`/Esc keeps it in the app only (not reopened until it ends) |

The mapping (app space → TUI workspace, app tab → TUI tab, terminal → pane) is kept in `sync-state.json` in the plugin state dir (`$HERDR_PLUGIN_STATE_DIR`, else `~/.local/state/herdr/plugins/barnuri.hc-attach/`, where herdr puts it), under a lock shared with the actions. A restart never opens a pane twice. When every synced pane is gone at once (the TUI server restarted), the watcher opens them again without asking.

Check what one pass would do, without changing anything:

```bash
node bin/sync.js --dry-run   # prints the ops as JSON
node bin/sync.js --once      # runs one pass
```

Limits:

- Focus, zoom and splits are not synced. The TUI splits each tab right and down in turn.
- A plain TUI pane cannot be moved into hc: its program is not an hc terminal. Start new work with `hc: new synced terminal` instead.
- The TUI cannot ask before a pane closes. The question comes right after: the `hc attach` in the pane has ended, and the terminal still runs.
- Spaces on other machines are skipped, as are app tabs with no terminals.
- When `herdr-app ls` fails (the app is not running), the watcher changes nothing.
- Moving a terminal to another app tab does not move its TUI pane.
- `hc: new synced terminal` in an unsynced TUI workspace makes a new app space. The watcher then renames the TUI workspace to the app's name for it (its folder).
- Workspaces and tabs the watcher opened stay when their app space or tab closes; their panes close.

## Caveats

- Size: a synced pane is a normal attach, so the app and the TUI resize the terminal to their own pane in turn ("size fights"). The program redraws at the last size set. Use watch for a view-only side.

- Status chips are not shown. The old TUI (0.9.5) does not render them.
- Finished terminals are hidden. Start a terminal with `hc run --bg sh`.

## Tests

```bash
npm test
```

The tests cover the pure logic in `lib/hc.js` (parse, filter, attach argv, pane title, confirm threshold) and `lib/sync.js` (parse `herdr-app ls` and the TUI lists, the desired-vs-current diff into open, close, rename, ask and reopen ops, the reverse lookup and the `hc run` argv). They do not start herdr or hc.

## Licence

MIT.
