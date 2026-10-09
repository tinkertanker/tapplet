import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  createEvaluationProvider,
  parseEvaluationPlan,
  productionEvaluationEnvironment,
  providerSettings,
} from "./run";

test("Claude evaluation uses its own defaults and credential, not another production provider", () => {
  const settings = providerSettings({
    AI_PROVIDER: "opencode-go", AI_MODEL: "muse-spark-1.2-contributor",
    AI_BASE_URL: "https://api.deepseek.com", AI_API_KEY: "wrong-test-key",
    EVAL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "claude-test-key",
  });
  assert.deepEqual(settings, { provider: "anthropic", model: "claude-haiku-5-5",
    baseUrl: "https://api.anthropic.com/v1", apiKey: "claude-test-key" });
  assert.throws(() => providerSettings({ EVAL_PROVIDER: "anthropic", AI_API_KEY: "wrong-test-key" }), /API key/);
  assert.equal(providerSettings({ EVAL_API_KEY: "test-key" }).model, "gpt-6-luna");
  const custom = { EVAL_PROVIDER: "anthropic", EVAL_BASE_URL: "https://custom-claude.example/v1", ANTHROPIC_API_KEY: "claude-test-key" };
  assert.throws(() => providerSettings(custom), /API key/);
  assert.equal(providerSettings({ ...custom, EVAL_API_KEY: "explicit-custom-key" }).apiKey, "explicit-custom-key");
});

test("evaluation never carries a generic production key to a different endpoint", () => {
  const production = { AI_PROVIDER: "opencode-go", AI_BASE_URL: "https://api.deepseek.com", AI_API_KEY: "paired-test-key" };
  assert.throws(() => providerSettings({ ...production, EVAL_PROVIDER: "openai-compatible" }), /API key/);
  assert.equal(providerSettings({ ...production, EVAL_PROVIDER: "openai-compatible", EVAL_API_KEY: "explicit-test-key" }).apiKey, "explicit-test-key");
  assert.equal(providerSettings({ ...production, AI_PROVIDER: "openai-compatible" }).apiKey, "paired-test-key");
  assert.throws(() => providerSettings({ ...production, AI_PROVIDER: "openai-compatible", EVAL_BASE_URL: "https://api.openai.com/v1" }), /API key/);
});

test("evaluation plan expands explicit controlled ablation dimensions", () => {
  const plan = parseEvaluationPlan({
    EVAL_PROVIDER: "fixture",
    EVAL_MODEL: "fixture-v1",
    EVAL_RETRIEVAL_MODES: "curated-only,published-only",
    EVAL_MAX_REPAIRS_VALUES: "0,2",
    EVAL_PROMPT_BOUNDARY_MODES: "bounded,legacy-unbounded",
    EVAL_REASONING_EFFORTS: "default,low",
    EVAL_REPETITIONS: "2",
    EVAL_BROWSER: "false",
  });

  assert.deepEqual(plan.retrievalModes, ["curated-only", "published-only"]);
  assert.deepEqual(plan.repairCounts, [0, 2]);
  assert.deepEqual(plan.boundaryModes, ["bounded", "legacy-unbounded"]);
  assert.deepEqual(plan.reasoningEfforts, [undefined, "low"]);
  assert.equal(plan.repetitions, 2);
  assert.equal(plan.browser, false);
  assert.equal(
    createEvaluationProvider(plan.provider, { promptBoundaryMode: "bounded" }).name,
    "fixture",
  );
});

test("evaluation plan rejects invalid or provenance-unsafe settings", () => {
  assert.throws(() => parseEvaluationPlan({
    EVAL_PROVIDER: "fixture",
    EVAL_BASE_URL: "https://user:secret@example.invalid",
  }), /without embedded credentials/);
  assert.throws(() => parseEvaluationPlan({
    EVAL_PROVIDER: "fixture",
    EVAL_MAX_REPAIRS: "3",
  }), /0 to 2/);
  assert.throws(() => parseEvaluationPlan({
    EVAL_PROVIDER: "fixture",
    EVAL_PROMPT_BOUNDARY_MODE: "invented",
  }), /Unsupported prompt boundary mode/);
});

test("production plan reads the deployed provider and model source of truth", async () => {
  const environment = await productionEvaluationEnvironment(
    resolve(import.meta.dirname, "../.."),
    {},
  );
  assert.equal(environment.AI_PROVIDER, "opencode-go");
  assert.equal(environment.AI_MODEL, "muse-spark-1.2-contributor");
  assert.equal(
    parseEvaluationPlan({
      AI_PROVIDER: "openai-compatible",
      AI_MODEL: "configured-model",
      AI_BASE_URL: "https://configured-provider.example/v1",
      AI_API_KEY: "evaluation-secret",
      EVAL_BROWSER: "false",
    }).provider.baseUrl,
    "https://configured-provider.example/v1",
  );
  assert.equal(
    parseEvaluationPlan({
      AI_PROVIDER: "opencode-go",
      AI_MODEL: "configured-model",
      AI_BASE_URL: "https://unused-for-named-provider.example/v1",
      OPENCODE_API_KEY: "evaluation-secret",
      EVAL_BROWSER: "false",
    }).provider.baseUrl,
    "https://opencode.ai/zen/go/v1",
  );
});
