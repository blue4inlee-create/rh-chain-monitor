import { initializeDatabase, closeDatabase } from './db.mjs';
import {
  initializeDeadLetterStore,
  getDeadLetterStats,
  listDeadLetters,
  requeueFailedJob,
} from './dead_letter.mjs';

function usage() {
  console.log('Usage:');
  console.log('  npm run dead-letters -- [limit] [OPEN|REQUEUED|RESOLVED]');
  console.log('  npm run retry-job -- <jobId> [jobId...]');
}

async function main() {
  initializeDatabase();
  initializeDeadLetterStore();

  const [command = 'list', ...args] = process.argv.slice(2);
  if (command === 'list') {
    const limit = args[0] || 20;
    const status = args[1] || '';
    console.log(JSON.stringify({
      stats: getDeadLetterStats(),
      rows: listDeadLetters({ limit, status }),
    }, null, 2));
    return;
  }

  if (command === 'retry') {
    if (!args.length) {
      usage();
      process.exitCode = 2;
      return;
    }
    const results = args.map(requeueFailedJob);
    console.log(JSON.stringify({ results, stats: getDeadLetterStats() }, null, 2));
    if (results.some(x => !x.ok)) process.exitCode = 1;
    return;
  }

  usage();
  process.exitCode = 2;
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { closeDatabase(); } catch {}
  });
