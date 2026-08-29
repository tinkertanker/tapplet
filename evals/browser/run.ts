import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { canonicalRetrievalSnapshotHash } from "../model/production-harness";
import { repositoryProvenance } from "../model/run";
import { evaluateHtmlInBrowser } from "./evaluate";

interface SeedManifest {
  seeds: Array<{ id: string; filename: string }>;
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.env.INIT_CWD ?? process.cwd());
  const directory = resolve(repoRoot, "apps/ipad/Resources/Examples");
  const manifestSource = await readFile(resolve(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestSource) as SeedManifest;
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-background-networking"],
  });
  try {
    const results = [];
    for (const seed of manifest.seeds) {
      process.stdout.write(`Rendering ${seed.id}… `);
      const html = await readFile(resolve(directory, seed.filename), "utf8");
      const evaluation = await evaluateHtmlInBrowser(html, { browser });
      console.log(evaluation.passed ? "passed" : "findings");
      results.push({ id: seed.id, ...evaluation });
    }
    const viewports = results.flatMap((result) => result.viewports);
    const rate = (predicate: (result: typeof viewports[number]) => boolean) =>
      viewports.filter(predicate).length / viewports.length;
    const report = {
      schemaVersion: "1.0",
      provenance: {
        ...await repositoryProvenance(repoRoot),
        manifestSha256: createHash("sha256").update(manifestSource).digest("hex"),
        corpusSha256: await canonicalRetrievalSnapshotHash(repoRoot),
        browser: `playwright-chromium/${browser.version()}`,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      privacy: {
        dataClass: "metadata-only-reviewed-seed-corpus",
        rawHtmlRetained: false,
        screenshotsRetained: false,
        consoleAndExceptionTextRetained: false,
      },
      ranAt: new Date().toISOString(),
      summary: {
        artifacts: results.length,
        viewportEvaluations: viewports.length,
        overallPassRate: results.filter((result) => result.passed).length / results.length,
        behaviorPassRate: rate((result) => result.behavior.passed),
        sandboxPassRate: rate((result) => result.sandbox.passed),
        viewportFitPassRate: rate((result) => result.viewportFit.passed),
        accessibilityBasicPassRate: rate((result) => result.accessibilityBasic.passed),
        renderedQualityPassRate: rate((result) => result.renderedQuality.passed),
      },
      results,
    };
    await mkdir(resolve(repoRoot, "evals/browser/results"), { recursive: true });
    await writeFile(
      resolve(repoRoot, "evals/browser/results/latest.v1.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report.summary, null, 2));
    if (report.summary.overallPassRate !== 1) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
