import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("publication fixture cleanup trusts only private, origin-bound state", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "tapplet-fixture-test-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url.endsWith("/remix")
      ? { artifact: { id: "fixture-artifact" }, headRevision: { id: "fixture-revision" } }
      : { publication: { slug: "fixture-slug", url: "https://example.test/p/fixture-slug" } }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = resolve(root, "home");
  const temporary = resolve(root, "tmp");
  const directory = resolve(home, ".tapplet-publication-browser-fixture");
  const statePath = resolve(directory, "state.json");
  const state = { origin, artifactId: "unrelated-artifact", slug: "unrelated-slug", url: "https://example.test" };
  const run = (action, selectedOrigin = origin) => promisify(execFile)(
    resolve("node_modules/.bin/tsx"), [resolve(root, "scripts/publication-browser-fixture.ts"), action],
    { env: { ...process.env, HOME: home, TMPDIR: temporary, STUDIO_LIVE_ORIGIN: selectedOrigin } },
  );
  try {
    for (const path of [home, temporary, resolve(root, "scripts"), resolve(root, "apps/ipad/Resources/Examples")]) {
      await mkdir(path, { recursive: true });
    }
    await copyFile(resolve("scripts/publication-browser-fixture.ts"), resolve(root, "scripts/publication-browser-fixture.ts"));
    await writeFile(resolve(root, ".studio-smoke-token"), "disposable-token");
    await writeFile(resolve(root, "apps/ipad/Resources/Examples/manifest.json"), JSON.stringify({ seeds: [{ id: "seed" }] }));
    // The legacy predictable file must never authorise cleanup.
    await writeFile(resolve(temporary, "tapplet-publication-browser-fixture.json"), JSON.stringify(state));
    await assert.rejects(run("cleanup"));
    assert.deepEqual(requests, []);

    await run("prepare");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    const saved = await readFile(statePath, "utf8");
    assert.equal(JSON.parse(saved).origin, origin);
    requests.length = 0;
    await assert.rejects(run("prepare"));
    await assert.rejects(run("cleanup", `${origin}/other-api`));
    assert.deepEqual(requests, []);

    await chmod(directory, 0o777);
    await assert.rejects(run("cleanup"));
    await chmod(directory, 0o700);
    await chmod(statePath, 0o666);
    await assert.rejects(run("cleanup"));
    await rm(statePath);
    const planted = resolve(root, "planted.json");
    await writeFile(planted, JSON.stringify(state), { mode: 0o600 });
    await symlink(planted, statePath);
    await assert.rejects(run("cleanup"));
    assert.deepEqual(requests, []);
    await rm(statePath);
    await writeFile(statePath, saved, { mode: 0o600 });
    await run("cleanup");
    assert.deepEqual(requests, ["DELETE /v1/publications/fixture-slug", "DELETE /v1/artifacts/fixture-artifact"]);
    requests.length = 0;
    await assert.rejects(run("cleanup"));
    assert.deepEqual(requests, []);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
