import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = new URL('./run-checks.mjs', import.meta.url);

test('check runner completes every check, bounds concurrency, and propagates any failure', async (t) => {
  for (const failed of ['', 'first', 'second', 'third']) {
    await t.test(failed ? `${failed} fails` : 'all pass', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'tapplet-checks-'));
      try {
        const checks = ['first', 'second', 'third'];
        await writeFile(join(directory, 'package.json'), JSON.stringify({
          scripts: Object.fromEntries(checks.map((name) => [name, `node check.mjs ${name}`])),
        }));
        await writeFile(join(directory, 'check.mjs'), `
          import { appendFileSync, readFileSync } from 'node:fs';
          import { availableParallelism } from 'node:os';
          import { setTimeout } from 'node:timers/promises';
          const name = process.argv[2];
          appendFileSync('events', name + ':start\\n');
          // The first pair rendezvous: this fails a serial implementation on
          // multi-core hosts without depending on process startup speed.
          const deadline = Date.now() + 5000;
          while (readFileSync('events', 'utf8').split(':start').length - 1 < Math.min(2, availableParallelism())) {
            if (Date.now() > deadline) throw new Error('checks did not overlap');
            await setTimeout(10);
          }
          await setTimeout(name === 'second' ? 200 : 10);
          appendFileSync('events', name + ':end\\n');
          console.log('completed ' + name);
          process.exitCode = name === process.env.FAIL_CHECK ? 7 : 0;
        `);
        const summary = join(directory, 'summary');
        const child = spawn(process.execPath, [fileURLToPath(runner), ...checks], {
          cwd: directory,
          env: { ...process.env, FAIL_CHECK: failed, GITHUB_STEP_SUMMARY: summary },
        });
        let output = '';
        child.stdout.on('data', (data) => { output += data; });
        child.stderr.on('data', (data) => { output += data; });
        const code = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        assert.equal(code, failed ? 1 : 0, output);
        const events = (await readFile(join(directory, 'events'), 'utf8')).trim().split('\n');
        assert.deepEqual(events.filter((event) => event.endsWith(':end')).sort(), checks.map((name) => `${name}:end`));
        let active = 0;
        let peak = 0;
        for (const event of events) {
          active += event.endsWith(':start') ? 1 : -1;
          peak = Math.max(peak, active);
        }
        assert.equal(active, 0);
        assert.equal(peak, Math.min(2, availableParallelism()));
        const report = await readFile(summary, 'utf8');
        for (const name of checks) {
          assert.match(output, new RegExp(`completed ${name}`));
          assert.match(report, new RegExp(`\\| ${name} \\| ${name === failed ? 'FAIL' : 'PASS'} \\|`));
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
