'use strict';

// Action entry: opens the picker as a popup pane. Argument: attach | watch | all.

const { PLUGIN_ID, runHerdr } = require('../lib/herdr');

const MODES = new Set(['attach', 'watch', 'all']);

function main() {
  const mode = process.argv[2];
  if (!MODES.has(mode)) {
    process.stderr.write(`usage: open.js attach|watch|all\n`);
    process.exit(2);
  }
  const origin = process.env.HERDR_PANE_ID || '';
  runHerdr([
    'plugin', 'pane', 'open',
    '--plugin', PLUGIN_ID,
    '--entrypoint', 'picker',
    '--placement', 'popup',
    '--env', `HC_MODE=${mode}`,
    '--env', `HC_ORIGIN_PANE=${origin}`,
    '--focus',
  ]);
}

main();
