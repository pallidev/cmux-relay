import { parseCliArgs } from './cli.js';
import { runLocalMode } from './local-mode.js';
import { runCloudMode, loadSavedAuth } from './cloud-mode.js';

const opts = parseCliArgs();

async function main() {
  if (opts.isLocal) {
    await runLocalMode(opts);
  } else {
    const savedAuth = await loadSavedAuth();
    await runCloudMode(opts, savedAuth);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
