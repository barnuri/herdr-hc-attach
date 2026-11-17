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

## Caveats

- Resize: each attach resizes the terminal to its pane. Use watch for a view-only side.
- Status chips are not shown. The old TUI (0.9.5) does not render them.
- Finished terminals are hidden. Start a terminal with `hc run --bg sh`.

## Tests

```bash
npm test
```

The tests cover the pure logic in `lib/hc.js` (parse, filter, attach argv, pane title, confirm threshold). They do not start herdr or hc.

## Licence

MIT.
