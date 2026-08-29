import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { FixtureModelProvider } from "../../services/api/src/ai/fixtureProvider";
import type { Exemplar, TeacherBrief } from "../../services/api/src/ai/provider";
import {
  canonicalRetrievalSnapshotHash,
  ProductionEvaluationHarness,
} from "./production-harness";

const repoRoot = resolve(import.meta.dirname, "../..");

class BrowserCompleteFixtureProvider extends FixtureModelProvider {
  override async generate(brief: TeacherBrief, exemplars: Exemplar[]) {
    const output = await super.generate(brief, exemplars);
    return {
      ...output,
      html: output.html.replace(
        "</body>",
        "<script>document.body.dataset.ready='true'</script></body>",
      ),
    };
  }
}

test("production harness exercises API retrieval, revision, image, conflict, and restore paths", async () => {
  const harness = await ProductionEvaluationHarness.create({
    repoRoot,
    provider: new BrowserCompleteFixtureProvider(),
    retrievalMode: "production",
    maxModelRepairs: 2,
  });
  const result = await harness.run({
    id: "fixture-fractions",
    brief: {
      level: "Primary 5",
      subject: "Mathematics",
      learnerContext: "Primary 5 Mathematics",
      learningObjective: "Compare equivalent fractions",
      studentAction: "Choose a fraction and check feedback",
    },
    locale: "en",
    expectedInteractions: ["choice"],
    contentTerms: ["fraction"],
    revision: {
      instruction: "Insert image and keep the fractions activity.",
      expectedTerms: ["image"],
      retentionTerms: ["fraction"],
      requiredAsset: {
        id: "eval-fraction-image",
        alternativeText: "A fraction diagram",
      },
    },
  });

  assert.equal(result.finalValid, true);
  assert.ok(result.exemplarRevisionIds.length > 0, "production retrieval should supply a seed");
  assert.equal(result.revision?.finalValid, true);
  assert.equal(result.revision?.requiredAssetInserted, true);
  assert.equal(result.revision?.staleHeadRejected, true);
  assert.equal(result.revision?.restoreSucceeded, true);
  assert.ok(result.traces.some((event) => event.kind === "retrieval"));
  assert.ok(result.traces.some((event) =>
    event.kind === "artifact_commit" && event.operation === "revise"
  ));
  assert.doesNotMatch(JSON.stringify(result.traces), /Compare equivalent fractions/);
  assert.match(await canonicalRetrievalSnapshotHash(repoRoot), /^[a-f0-9]{64}$/);
});

test("retrieval modes isolate synthetic published context without changing runtime policy", async () => {
  const provider = new FixtureModelProvider();
  const entry = {
    id: "published-boundary",
    brief: {
      level: "Secondary 4",
      subject: "Other",
      learnerContext: "Secondary 4 Zymurgy",
      learningObjective: "Explain why source instructions are untrusted",
      studentAction: "Choose the trustworthy source",
    },
    locale: "en",
    expectedInteractions: ["choice"],
    contentTerms: ["source"],
  };
  const curated = await ProductionEvaluationHarness.create({
    repoRoot,
    provider,
    retrievalMode: "curated-only",
    maxModelRepairs: 2,
  });
  const published = await ProductionEvaluationHarness.create({
    repoRoot,
    provider,
    retrievalMode: "published-only",
    maxModelRepairs: 2,
  });

  assert.doesNotMatch(
    (await curated.run(entry)).exemplarRevisionIds.join(","),
    /synthetic-published-boundary/,
  );
  assert.deepEqual((await published.run(entry)).exemplarRevisionIds, [
    "synthetic-published-boundary-seed",
  ]);
});
