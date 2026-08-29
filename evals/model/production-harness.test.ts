import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { FixtureModelProvider } from "../../services/api/src/ai/fixtureProvider";
import type { Exemplar, TeacherBrief } from "../../services/api/src/ai/provider";
import {
  canonicalRetrievalSnapshotHash,
  ProductionEvaluationHarness,
  ProductionRankedMemoryRepository,
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

class DestructiveRevisionFixtureProvider extends FixtureModelProvider {
  override async generate() {
    return {
      html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fractions</title><style>body{font:16px system-ui}</style></head><body><main><h1>Fractions</h1><label>Compare <input type="range" min="1" max="10"></label></main><script>document.querySelector("input").oninput=()=>{document.body.dataset.changed="true"}</script></body></html>',
      designCard: { title: "Fractions", description: "Range comparison" },
    };
  }

  override async revise() {
    return {
      html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fractions</title><style>body{font:16px system-ui}</style></head><body><main><h1>Fractions</h1><p>Visual fraction comparison retained in words only.</p><button type="button">Reset</button></main><script>document.querySelector("button").onclick=()=>{document.body.dataset.reset="true"}</script></body></html>',
      designCard: undefined,
    };
  }
}

class InertRevisionFixtureProvider extends FixtureModelProvider {
  override async generate() {
    return {
      html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fractions</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}</style></head><body><main><h1>Fractions</h1><p>Choose a fraction.</p><button type="button">Choose fraction</button></main><script>document.querySelector("button").onclick=()=>{document.body.dataset.chosen="true"}</script></body></html>',
      designCard: { title: "Fractions", description: "Fraction choice" },
    };
  }

  override async revise() {
    return {
      html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fractions</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}</style></head><body><main><h1>Fractions</h1><p>Visual fraction choice retained.</p><button type="button">Choose fraction</button></main></body></html>',
      designCard: undefined,
    };
  }
}

class HiddenRetentionRevisionFixtureProvider extends InertRevisionFixtureProvider {
  override async revise() {
    return {
      html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Revised lesson</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}</style></head><body><main><h1>Revised lesson</h1><p>Visual choice retained.</p><button type="button">Choose</button></main><script>const sourceOnlyRetention="fraction";document.querySelector("button").onclick=event=>{event.currentTarget.textContent="Chosen"}</script></body></html>',
      designCard: undefined,
    };
  }
}

class HiddenExpectedRevisionFixtureProvider extends InertRevisionFixtureProvider {
  override async revise() {
    return {
      html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Revised lesson</title><style>body{font:16px system-ui}button{min-width:120px;min-height:48px}.hidden{opacity:0;position:fixed;left:-9999px}</style></head><body><main><h1>Revised lesson</h1><p>Fraction choice retained.</p><span class="hidden">Visual</span><button type="button">Choose</button></main><script>document.querySelector("button").onclick=event=>{event.currentTarget.textContent="Chosen"}</script></body></html>',
      designCard: undefined,
    };
  }
}

class RejectedPrivateSourceFixtureProvider extends FixtureModelProvider {
  override async generate() {
    return {
      html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Private source</title><style>body{font:16px system-ui}</style></head><body><main><h1>Private source</h1><a href="https://example.invalid/?student=PRIVATE_STUDENT_MARKER">Choice</a></main><script>document.body.dataset.ready="true"</script></body></html>',
      designCard: { title: "Private source", description: "Rejected private source" },
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

test("evaluation retrieval uses production FTS relevance rather than insertion order", async () => {
  const repository = new ProductionRankedMemoryRepository();
  repository.retrieval.set("first-inserted", {
    artifactId: "first-inserted",
    revisionId: "first-revision",
    title: "Fraction lesson",
    descriptor: "fraction practice",
    html: "",
    curated: true,
  });
  repository.retrieval.set("more-relevant", {
    artifactId: "more-relevant",
    revisionId: "relevant-revision",
    title: "Equivalent fraction lesson",
    descriptor: "equivalent fraction comparison",
    html: "",
    curated: true,
  });

  const results = await repository.searchRetrieval(
    '"fraction" OR "equivalent"',
    2,
    "2026-08-29T00:00:00.000Z",
  );
  assert.deepEqual(results.map((entry) => entry.artifactId), [
    "more-relevant",
    "first-inserted",
  ]);
});

test("production harness returns validation issue codes without source-derived messages", async () => {
  const harness = await ProductionEvaluationHarness.create({
    repoRoot,
    provider: new RejectedPrivateSourceFixtureProvider(),
    retrievalMode: "production",
    maxModelRepairs: 0,
  });
  const result = await harness.run({
    id: "private-source-rejection",
    brief: {
      level: "Primary 5",
      subject: "Mathematics",
      learningObjective: "Choose a fraction",
      studentAction: "Choose an answer",
    },
    locale: "en",
    expectedInteractions: ["choice"],
    contentTerms: ["fraction"],
  });

  assert.equal(result.finalValid, false);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every((issue) => Object.keys(issue).length === 1));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STUDENT_MARKER|student=/);
});

test("revision retention fails when requested terms remain but the original interaction is removed", async () => {
  const harness = await ProductionEvaluationHarness.create({
    repoRoot,
    provider: new DestructiveRevisionFixtureProvider(),
    retrievalMode: "production",
    maxModelRepairs: 2,
  });
  const result = await harness.run({
    id: "destructive-revision",
    brief: {
      level: "Primary 5",
      subject: "Mathematics",
      learningObjective: "Compare equivalent fractions",
      studentAction: "Move a range control to compare fractions",
    },
    locale: "en",
    expectedInteractions: ["range"],
    contentTerms: ["fraction"],
    revision: {
      instruction: "Add a visual prompt and retain the range interaction.",
      expectedTerms: ["visual"],
      retentionTerms: ["fraction"],
    },
  });

  assert.equal(result.finalValid, true);
  assert.equal(result.revision?.requestedChangeRetained, true);
  assert.equal(result.revision?.priorContentRetained, true);
  assert.equal(result.revision?.finalValid, false);
  assert.deepEqual(result.revision?.checks.find((check) =>
    check.kind === "interaction" && !check.passed
  ), { kind: "interaction", passed: false });
});

test("revision validity includes isolated browser behavior and visible retention checks", async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-background-networking"],
  });
  try {
    const harness = await ProductionEvaluationHarness.create({
      repoRoot,
      provider: new InertRevisionFixtureProvider(),
      retrievalMode: "production",
      maxModelRepairs: 2,
      browser,
    });
    const result = await harness.run({
      id: "inert-revision",
      brief: {
        level: "Primary 5",
        subject: "Mathematics",
        learningObjective: "Choose an equivalent fraction",
        studentAction: "Choose a fraction and receive feedback",
      },
      locale: "en",
      expectedInteractions: ["choice"],
      contentTerms: ["fraction"],
      revision: {
        instruction: "Add a visual prompt and retain the fraction choice.",
        expectedTerms: ["visual"],
        retentionTerms: ["fraction"],
      },
    });

    assert.ok(result.revision?.checks.every((check) => check.passed));
    assert.equal(result.revision?.browser?.passed, false);
    assert.equal(result.revision?.browser?.viewports[0]?.behavior.passed, false);
    assert.equal(result.revision?.browser?.viewports[0]?.behavior.interactionPassRate, 0);
    assert.equal(result.revision?.finalValid, false);

    const hiddenHarness = await ProductionEvaluationHarness.create({
      repoRoot,
      provider: new HiddenRetentionRevisionFixtureProvider(),
      retrievalMode: "production",
      maxModelRepairs: 2,
      browser,
    });
    const hidden = await hiddenHarness.run({
      id: "hidden-retention",
      brief: {
        level: "Primary 5",
        subject: "Mathematics",
        learningObjective: "Choose an equivalent fraction",
        studentAction: "Choose a fraction and receive feedback",
      },
      locale: "en",
      expectedInteractions: ["choice"],
      contentTerms: ["fraction"],
      revision: {
        instruction: "Add a visual prompt and retain the fraction choice.",
        expectedTerms: ["visual"],
        retentionTerms: ["fraction"],
      },
    });
    const visibleContentScenario = hidden.revision?.browser?.viewports[0]?.behavior.scenarios[0];
    assert.ok(hidden.revision?.checks.every((check) => check.passed));
    assert.equal(hidden.revision?.browser?.viewports[0]?.behavior.interactionPassRate, 1);
    assert.equal(visibleContentScenario?.passed, false);
    assert.equal(hidden.revision?.finalValid, false);

    const hiddenExpectedHarness = await ProductionEvaluationHarness.create({
      repoRoot,
      provider: new HiddenExpectedRevisionFixtureProvider(),
      retrievalMode: "production",
      maxModelRepairs: 2,
      browser,
    });
    const hiddenExpected = await hiddenExpectedHarness.run({
      id: "hidden-expected-change",
      brief: {
        level: "Primary 5",
        subject: "Mathematics",
        learningObjective: "Choose an equivalent fraction",
        studentAction: "Choose a fraction and receive feedback",
      },
      locale: "en",
      expectedInteractions: ["choice"],
      contentTerms: ["fraction"],
      revision: {
        instruction: "Add a visual prompt and retain the fraction choice.",
        expectedTerms: ["visual"],
        retentionTerms: ["fraction"],
      },
    });
    const expectedContentScenario = hiddenExpected.revision?.browser?.viewports[0]
      ?.behavior.scenarios[0];
    assert.ok(hiddenExpected.revision?.checks.every((check) => check.passed));
    assert.equal(hiddenExpected.revision?.browser?.viewports[0]?.behavior.interactionPassRate, 1);
    assert.equal(expectedContentScenario?.passed, false);
    assert.equal(hiddenExpected.revision?.finalValid, false);
  } finally {
    await browser.close();
  }
});
