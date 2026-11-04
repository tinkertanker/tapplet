import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

const checks = process.argv.slice(2);
if (!checks.length) throw new Error('Pass at least one npm script to check.');
const started = performance.now();
const results = [];

async function run(check) {
  const start = performance.now();
  console.log(`Starting ${check}`);
  const code = await new Promise((resolve) => {
    const child = spawn('npm', ['run', check], { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(`${check}: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const seconds = ((performance.now() - start) / 1000).toFixed(2);
  results.push({ check, code, seconds });
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${check} (${seconds}s)`);
}

// Each test command already owns its workers and browser instances. Two npm
// commands overlap their waits without launching all eight suites at once.
const concurrency = Math.min(2, availableParallelism(), checks.length);
const pending = checks.values();
await Promise.all(Array.from({ length: concurrency }, async () => {
  // Finish every check even after a failure; the aggregate still fails closed.
  for (const check of pending) await run(check);
}));

const report = [
  '## Verification timings',
  '',
  '| Check | Result | Seconds |',
  '| --- | --- | ---: |',
  ...results.map(({ check, code, seconds }) => `| ${check} | ${code === 0 ? 'PASS' : 'FAIL'} | ${seconds} |`),
  '',
  `Wall time: ${((performance.now() - started) / 1000).toFixed(2)}s; concurrency: ${concurrency}`,
  '',
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
process.exitCode = results.some(({ code }) => code !== 0) ? 1 : 0;
