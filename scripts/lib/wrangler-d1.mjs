import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../services/api');

// Runs one statement against the Worker's D1 database. Output is captured,
// never echoed, because statements can contain credential hashes.
export function executeD1(statement, target = '--remote') {
  return spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'DB', target, '--profile', 'tinkertanker', '--json', '--command', statement],
    { cwd: serviceDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

// The result rows of a successful single execution, or undefined.
export function d1Results(stdout) {
  try {
    const executions = JSON.parse(stdout);
    return executions?.[0]?.success === true ? executions[0].results : undefined;
  } catch {
    return undefined;
  }
}
