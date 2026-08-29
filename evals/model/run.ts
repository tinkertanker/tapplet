import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { chromium, type Browser } from "playwright";
import {
  createModelProvider,
  type ModelProviderConfig,
  type ReasoningEffort,
} from "../../services/api/src/ai/createProvider";
import { PROMPT_VERSION, type PromptBoundaryMode } from "../../services/api/src/ai/prompts";
import type { StudioEnv } from "../../services/api/src/env";
import type { ModelCallTrace } from "../../services/api/src/operationalTrace";
import {
  canonicalRetrievalSnapshotHash,
  ProductionEvaluationHarness,
  type ProductionCaseResult,
  type ProductionEvaluationCase,
  type RetrievalMode,
} from "./production-harness";

const execFileAsync = promisify(execFile);
const RETRIEVAL_MODES: RetrievalMode[] = [
  "production",
  "none",
  "curated-only",
  "published-inclusive",
  "published-only",
];
const BOUNDARY_MODES: PromptBoundaryMode[] = ["bounded", "legacy-unbounded"];
const REASONING_EFFORTS: ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
];

interface EvaluationManifest {
  schemaVersion: "2.0";
  minimumFirstPassRate: number;
  minimumFinalPassRate: number;
  minimumHeuristicFidelityRate: number;
  minimumRevisionPassRate: number;
  minimumBrowserPassRate: number;
  cases: ProductionEvaluationCase[];
}

export interface ProviderSettings {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface EvaluationPlan {
  provider: ProviderSettings;
  retrievalModes: RetrievalMode[];
  repairCounts: number[];
  boundaryModes: PromptBoundaryMode[];
  reasoningEfforts: Array<ReasoningEffort | undefined>;
  repetitions: number;
  browser: boolean;
  selectedCaseIds: string[];
}

interface EvaluationConfiguration {
  retrievalMode: RetrievalMode;
  maxModelRepairs: number;
  promptBoundaryMode: PromptBoundaryMode;
  reasoningEffort?: ReasoningEffort;
}

interface RepeatedCaseResult extends ProductionCaseResult {
  repetition: number;
}

export function parseEvaluationPlan(
  env: NodeJS.ProcessEnv = process.env,
): EvaluationPlan {
  const provider = providerSettings(env);
  const retrievalModes = enumList(
    env.EVAL_RETRIEVAL_MODES ?? env.EVAL_RETRIEVAL_MODE ?? "production",
    "retrieval mode",
    RETRIEVAL_MODES,
  );
  const repairCounts = valueList(
    env.EVAL_MAX_REPAIRS_VALUES ?? env.EVAL_MAX_REPAIRS ?? "2",
    "repair count",
  ).map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2)
      throw new Error("Evaluation repair counts must be whole numbers from 0 to 2.");
    return parsed;
  });
  const boundaryModes = enumList(
    env.EVAL_PROMPT_BOUNDARY_MODES ?? env.EVAL_PROMPT_BOUNDARY_MODE ?? "bounded",
    "prompt boundary mode",
    BOUNDARY_MODES,
  );
  const efforts = valueList(
    env.EVAL_REASONING_EFFORTS ?? env.EVAL_REASONING_EFFORT ?? "default",
    "reasoning effort",
  );
  const reasoningEfforts = efforts.map((effort) => {
    if (effort === "default") return undefined;
    if (!REASONING_EFFORTS.includes(effort as ReasoningEffort))
      throw new Error(`Unsupported reasoning effort: ${effort}.`);
    return effort as ReasoningEffort;
  });
  const repetitions = Number(env.EVAL_REPETITIONS ?? "1");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error("EVAL_REPETITIONS must be a whole number from 1 to 20.");
  const browser = parseBoolean(env.EVAL_BROWSER ?? "true", "EVAL_BROWSER");
  return {
    provider,
    retrievalModes,
    repairCounts,
    boundaryModes,
    reasoningEfforts,
    repetitions,
    browser,
    selectedCaseIds: env.EVAL_CASES ? valueList(env.EVAL_CASES, "case ID") : [],
  };
}

export async function productionEvaluationEnvironment(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const path = resolve(repoRoot, "services/api/wrangler.jsonc");
  const errors: ParseError[] = [];
  const configuration = parse(await readFile(path, "utf8"), errors) as {
    vars?: Record<string, unknown>;
  } | undefined;
  if (errors.length) {
    throw new Error(
      `Could not read production provider settings from services/api/wrangler.jsonc: ${errors
        .map((error) => printParseErrorCode(error.error))
        .join(", ")}.`,
    );
  }
  const vars = configuration?.vars;
  const production = Object.fromEntries(
    ["AI_PROVIDER", "AI_MODEL", "AI_BASE_URL"]
      .flatMap((name) => typeof vars?.[name] === "string" ? [[name, vars[name]]] : []),
  ) as NodeJS.ProcessEnv;
  return { ...production, ...env };
}

export function providerSettings(env: NodeJS.ProcessEnv): ProviderSettings {
  const provider = env.EVAL_PROVIDER ?? env.AI_PROVIDER ?? "openai-compatible";
  const model = env.EVAL_MODEL ?? env.AI_MODEL ?? "deepseek-v4-flash";
  const baseUrl = (
    env.EVAL_BASE_URL
    ?? (provider === "openai-compatible" ? env.AI_BASE_URL : undefined)
    ?? defaultBaseUrl(provider)
  ).replace(/\/$/, "");
  const apiKey = env.EVAL_API_KEY
    ?? (provider.startsWith("opencode") ? env.OPENCODE_API_KEY : undefined)
    ?? (provider === "openrouter" ? env.OPENROUTER_API_KEY : undefined)
    ?? env.AI_API_KEY
    ?? env.DEEPSEEK_API_KEY;
  if (provider !== "fixture" && !apiKey)
    throw new Error(
      "Set EVAL_API_KEY or the configured provider's production API key to run the live eval.",
    );
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("EVAL_BASE_URL must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("EVAL_BASE_URL must be an HTTPS URL without embedded credentials.");
  return { provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) };
}

export function createEvaluationProvider(
  settings: ProviderSettings,
  configuration: Pick<EvaluationConfiguration, "reasoningEffort" | "promptBoundaryMode">,
) {
  const override: ModelProviderConfig = {
    ...settings,
    ...(configuration.reasoningEffort
      ? { reasoningEffort: configuration.reasoningEffort }
      : {}),
    promptBoundaryMode: configuration.promptBoundaryMode,
  };
  return createModelProvider(providerEnvironment(settings), override);
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.env.INIT_CWD ?? process.cwd());
  const manifestPath = resolve(repoRoot, "evals/model/artifact-requests.json");
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestSource) as EvaluationManifest;
  if (manifest.schemaVersion !== "2.0")
    throw new Error("Artifact evaluation manifest must use schemaVersion 2.0.");
  const plan = parseEvaluationPlan(await productionEvaluationEnvironment(repoRoot));
  const cases = selectedCases(manifest.cases, plan.selectedCaseIds);
  const configurations = cartesianConfigurations(plan);
  const browser = plan.browser ? await launchBrowser() : undefined;
  const startedAt = new Date();
  try {
    const runs = [];
    for (const configuration of configurations) {
      runs.push(await runConfiguration(
        repoRoot,
        plan,
        manifest,
        cases,
        configuration,
        browser,
      ));
    }
    const repository = await repositoryProvenance(repoRoot);
    const output = {
      schemaVersion: "3.0",
      provenance: {
        ...repository,
        promptVersion: PROMPT_VERSION,
        manifestSha256: sha256(Buffer.from(manifestSource)),
        retrievalSnapshotSha256: await canonicalRetrievalSnapshotHash(repoRoot),
        provider: publicProviderSettings(plan.provider),
        providerConfigurationSource: "createModelProvider defaults plus services/api/wrangler.jsonc and explicit EVAL_* overrides",
        retrievalRanking: "node:sqlite FTS5 with production D1 MATCH, curated-first, and bm25 ordering",
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        browserEngine: browser
          ? `playwright-chromium/${browser.version()}`
          : "disabled-explicitly",
      },
      privacy: {
        dataClass: "metadata-only",
        retained: [
          "configuration",
          "aggregate metrics",
          "evaluation check and validation issue kinds",
          "provider usage and latency",
          "browser geometry and behavior counts",
        ],
        omitted: [
          "briefs and prompts",
          "evaluation criteria text and scenario names",
          "generated and revised HTML",
          "images",
          "console and exception text",
          "student and teacher data",
          "provider credentials",
        ],
      },
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      repetitions: plan.repetitions,
      caseIds: cases.map((entry) => entry.id),
      runs,
      comparisons: comparisonDeltas(runs),
    };
    const outputName = configurations.length === 1
      ? "latest.v3.json"
      : "latest-ablation.v3.json";
    await mkdir(resolve(repoRoot, "evals/model/results"), { recursive: true });
    await writeFile(
      resolve(repoRoot, "evals/model/results", outputName),
      `${JSON.stringify(output, null, 2)}\n`,
    );
    console.log(JSON.stringify(output, null, 2));
    if (runs.some((run) => !run.passed)) process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

async function runConfiguration(
  repoRoot: string,
  plan: EvaluationPlan,
  manifest: EvaluationManifest,
  cases: ProductionEvaluationCase[],
  configuration: EvaluationConfiguration,
  browser: Browser | undefined,
) {
  const provider = createEvaluationProvider(plan.provider, configuration);
  const harness = await ProductionEvaluationHarness.create({
    repoRoot,
    provider,
    retrievalMode: configuration.retrievalMode,
    maxModelRepairs: configuration.maxModelRepairs,
    ...(browser ? { browser } : {}),
  });
  const results: RepeatedCaseResult[] = [];
  for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
    for (const entry of cases) {
      process.stdout.write(
        `[${configurationLabel(configuration)}] ${entry.id} (${repetition}/${plan.repetitions})… `,
      );
      const result = await harness.run(entry);
      console.log(result.finalValid ? "valid" : "failed");
      results.push({ ...result, repetition });
    }
  }
  const checks = results.flatMap((result) => result.heuristicChecks);
  const revisions = results.flatMap((result) => result.revision ? [result.revision] : []);
  const browserResults = results.flatMap((result) => [
    ...(result.browser ? [result.browser] : []),
    ...(result.revision?.browser ? [result.revision.browser] : []),
  ]);
  const modelTraces = results.flatMap((result) =>
    result.traces.filter((event): event is ModelCallTrace => event.kind === "model_call")
  );
  const metrics = {
    cases: results.length,
    firstPassRate: rate(results, (result) => result.firstPassValid),
    finalPassRate: rate(results, (result) => result.finalValid),
    heuristicFidelityRate: rate(checks, (check) => check.passed),
    revisionPassRate: revisions.length
      ? rate(revisions, (revision) =>
          revision.finalValid
          && revision.staleHeadRejected
          && revision.restoreSucceeded
        )
      : null,
    browserPassRate: plan.browser
      ? browserResults.length
        ? rate(browserResults, (result) => result.passed)
        : null
      : null,
    latencyMs: distribution(results.map((result) => result.latencyMs)),
    repairAttempts: distribution(results.map((result) => result.repairAttempts)),
    modelCalls: {
      count: modelTraces.length,
      errorCount: modelTraces.filter((trace) => trace.status === "error").length,
      durationMs: distribution(modelTraces.map((trace) => trace.durationMs)),
      inputBytes: distribution(modelTraces.map((trace) => trace.inputBytes)),
      inputTokens: distribution(present(modelTraces.map((trace) => trace.inputTokens))),
      cachedInputTokens: distribution(present(
        modelTraces.map((trace) => trace.cachedInputTokens),
      )),
      outputTokens: distribution(present(modelTraces.map((trace) => trace.outputTokens))),
      reasoningTokens: distribution(present(
        modelTraces.map((trace) => trace.reasoningTokens),
      )),
    },
  };
  const revisionRequired = cases.some((entry) => entry.revision);
  const passed = metrics.firstPassRate >= manifest.minimumFirstPassRate
    && metrics.finalPassRate >= manifest.minimumFinalPassRate
    && metrics.heuristicFidelityRate >= manifest.minimumHeuristicFidelityRate
    && (!revisionRequired
      || (metrics.revisionPassRate !== null
        && metrics.revisionPassRate >= manifest.minimumRevisionPassRate))
    && (!plan.browser
      || (metrics.browserPassRate !== null
        && metrics.browserPassRate >= manifest.minimumBrowserPassRate));
  return {
    configuration,
    configurationSha256: sha256(Buffer.from(JSON.stringify(configuration))),
    passed,
    metrics,
    results,
  };
}

function selectedCases(
  cases: ProductionEvaluationCase[],
  ids: string[],
): ProductionEvaluationCase[] {
  if (!ids.length) return cases;
  const selected = cases.filter((entry) => ids.includes(entry.id));
  const missing = ids.filter((id) => !selected.some((entry) => entry.id === id));
  if (missing.length) throw new Error(`Unknown EVAL_CASES: ${missing.join(", ")}.`);
  return selected;
}

function cartesianConfigurations(plan: EvaluationPlan): EvaluationConfiguration[] {
  return plan.retrievalModes.flatMap((retrievalMode) =>
    plan.repairCounts.flatMap((maxModelRepairs) =>
      plan.boundaryModes.flatMap((promptBoundaryMode) =>
        plan.reasoningEfforts.map((reasoningEffort) => ({
          retrievalMode,
          maxModelRepairs,
          promptBoundaryMode,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }))
      )
    )
  );
}

function comparisonDeltas(
  runs: Array<{
    configuration: EvaluationConfiguration;
    metrics: {
      firstPassRate: number;
      finalPassRate: number;
      revisionPassRate: number | null;
      browserPassRate: number | null;
      latencyMs: { p50: number | null; p95: number | null };
      modelCalls: { inputBytes: { p50: number | null }; durationMs: { p50: number | null } };
    };
  }>,
) {
  const baseline = runs[0];
  if (!baseline || runs.length === 1) return [];
  return runs.slice(1).map((run) => ({
    configuration: run.configuration,
    versusConfiguration: baseline.configuration,
    firstPassRateDelta: run.metrics.firstPassRate - baseline.metrics.firstPassRate,
    finalPassRateDelta: run.metrics.finalPassRate - baseline.metrics.finalPassRate,
    revisionPassRateDelta: nullableDelta(
      run.metrics.revisionPassRate,
      baseline.metrics.revisionPassRate,
    ),
    browserPassRateDelta: run.metrics.browserPassRate === null
      || baseline.metrics.browserPassRate === null
      ? null
      : run.metrics.browserPassRate - baseline.metrics.browserPassRate,
    p50LatencyMsDelta: nullableDelta(
      run.metrics.latencyMs.p50,
      baseline.metrics.latencyMs.p50,
    ),
    p50ModelDurationMsDelta: nullableDelta(
      run.metrics.modelCalls.durationMs.p50,
      baseline.metrics.modelCalls.durationMs.p50,
    ),
    p50InputBytesDelta: nullableDelta(
      run.metrics.modelCalls.inputBytes.p50,
      baseline.metrics.modelCalls.inputBytes.p50,
    ),
  }));
}

function distribution(values: number[]) {
  if (!values.length) return { count: 0, p50: null, p95: null, mean: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function rate<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.length ? values.filter(predicate).length / values.length : 1;
}

function present(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => value !== undefined);
}

function nullableDelta(value: number | null, baseline: number | null): number | null {
  return value === null || baseline === null ? null : value - baseline;
}

function valueList(value: string, label: string): string[] {
  const values = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (!values.length) throw new Error(`At least one ${label} is required.`);
  return values;
}

function enumList<T extends string>(
  value: string,
  label: string,
  allowed: readonly T[],
): T[] {
  return valueList(value, label).map((entry) => {
    if (!allowed.includes(entry as T)) throw new Error(`Unsupported ${label}: ${entry}.`);
    return entry as T;
  });
}

function parseBoolean(value: string, label: string): boolean {
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${label} must be true or false.`);
}

function defaultBaseUrl(provider: string): string {
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "opencode") return "https://opencode.ai/zen/v1";
  if (provider === "opencode-go") return "https://opencode.ai/zen/go/v1";
  return "https://api.deepseek.com";
}

function providerEnvironment(settings: ProviderSettings): StudioEnv {
  return {
    AI_PROVIDER: settings.provider,
    AI_MODEL: settings.model,
    AI_BASE_URL: settings.baseUrl,
    AI_API_KEY: settings.apiKey,
    OPENCODE_API_KEY: settings.apiKey,
    OPENROUTER_API_KEY: settings.apiKey,
    PUBLIC_PLAYER_ORIGIN: "https://eval-player.tapplet.invalid",
  } as StudioEnv;
}

function publicProviderSettings(settings: ProviderSettings) {
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    credentialSource: settings.provider === "fixture" ? "not-required" : "environment",
  };
}

function configurationLabel(configuration: EvaluationConfiguration): string {
  return [
    configuration.retrievalMode,
    `${configuration.maxModelRepairs}-repairs`,
    configuration.promptBoundaryMode,
    configuration.reasoningEffort ?? "provider-default-effort",
  ].join("/");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function repositoryProvenance(repoRoot: string): Promise<{
  gitCommit: string;
  workingTreeDirty: boolean;
  sourcePatchSha256: string;
}> {
  const git = async (arguments_: string[]) => (await execFileAsync(
    "git",
    arguments_,
    { cwd: repoRoot, maxBuffer: 20_000_000 },
  )).stdout;
  const gitCommit = (await git(["rev-parse", "HEAD"])).trim();
  const excluded = [
    ":(exclude)evals/model/results/latest.v2.json",
    ":(exclude)evals/model/results/latest-ablation.v2.json",
    ":(exclude)evals/model/results/latest.v3.json",
    ":(exclude)evals/model/results/latest-ablation.v3.json",
    ":(exclude)evals/model/results/latest-moderation.v2.json",
    ":(exclude)evals/browser/results/latest.v1.json",
    ":(exclude)evals/browser/results/latest.v2.json",
  ];
  const diff = await git(["diff", "--binary", "HEAD", "--", ".", ...excluded]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .filter((path) => ![
      "evals/model/results/latest.v2.json",
      "evals/model/results/latest-ablation.v2.json",
      "evals/model/results/latest.v3.json",
      "evals/model/results/latest-ablation.v3.json",
      "evals/model/results/latest-moderation.v2.json",
      "evals/browser/results/latest.v1.json",
      "evals/browser/results/latest.v2.json",
    ].includes(path));
  const hash = createHash("sha256").update(diff);
  for (const path of untracked.sort()) {
    hash.update(path);
    hash.update(await readFile(resolve(repoRoot, path)));
  }
  return {
    gitCommit,
    workingTreeDirty: diff.length > 0 || untracked.length > 0,
    sourcePatchSha256: hash.digest("hex"),
  };
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, args: ["--disable-background-networking"] });
  } catch (error) {
    throw new Error(
      `Chromium is required for production model evaluation. Run npx playwright install chromium. ${
        error instanceof Error ? error.message.split("\n")[0] : ""
      }`.trim(),
    );
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
