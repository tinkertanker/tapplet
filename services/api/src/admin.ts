import { randomInt } from "node:crypto";
import {
  createModelProvider,
  UnavailableModelProvider,
} from "./ai/createProvider";
import type { ModelProviderConfig } from "./ai/createProvider";
import type { ModelProvider } from "./ai/provider";
import { loadModelCatalogue } from "./ai/modelCatalogue";
import { loadModelPricing } from "./ai/modelPricing";
import {
  createTkslopperModelProvider,
  GROUP_KEY_PATTERN,
  inferenceTransport,
  readTkslopperClassConfig,
  readTkslopperConfig,
  TkslopperClient,
} from "./ai/tkslopper";
import {
  decryptAdminApiKey,
  decryptClassKey,
  encryptAdminApiKey,
  encryptClassKey,
} from "./adminCrypto";
import { ADMIN_HTML } from "./adminPage";
import { sha256 } from "./auth";
import type { StudioEnv } from "./env";
import { apiError, HttpError, json, readJson } from "./http";

export { decryptAdminApiKey, decryptClassKey, encryptAdminApiKey, encryptClassKey };

interface ModelSettingsRow {
  provider: string;
  model: string;
  base_url: string;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  updated_at: string;
}

interface CountRow {
  name: string;
  value: number;
}

interface UsageRow {
  date: string;
  generations: number;
  revisions: number;
  uploads: number;
  upload_bytes: number;
}

interface ModelUsageRow {
  model: string;
  count: number;
}

const ADMIN_PATHS = new Set([
  "/admin",
  "/admin/",
  "/v1/admin/overview",
  "/v1/admin/model",
  "/v1/admin/model-catalogue",
  "/v1/admin/model-pricing",
  "/v1/admin/class-codes",
  "/v1/admin/class-codes/key",
]);
const MODEL_PROVIDERS = new Set([
  "anthropic",
  "openai-compatible",
  "opencode",
  "opencode-go",
  "openrouter",
  "fixture",
]);

function environmentApiKey(env: StudioEnv, provider: string): string | undefined {
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY;
  if (provider === "opencode" || provider === "opencode-go")
    return env.OPENCODE_API_KEY;
  if (provider === "openrouter") return env.OPENROUTER_API_KEY;
  return env.AI_API_KEY;
}

function environmentBaseUrl(env: StudioEnv, provider: string): string {
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  if (provider === "opencode") return "https://opencode.ai/zen/v1";
  if (provider === "opencode-go") return "https://opencode.ai/zen/go/v1";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  return env.AI_BASE_URL;
}

function configured(env: StudioEnv): boolean {
  return !!(
    env.ADMIN_TOKEN &&
    env.ADMIN_TOKEN.length >= 32 &&
    env.ADMIN_ENCRYPTION_KEY &&
    env.ADMIN_ENCRYPTION_KEY.length >= 32
  );
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function authorised(request: Request, env: StudioEnv): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!env.ADMIN_TOKEN || !header?.startsWith("Bearer ")) return false;
  const [actual, expected] = await Promise.all([
    digest(header.slice(7)),
    digest(env.ADMIN_TOKEN),
  ]);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < actual.length; index += 1)
    difference |= actual[index]! ^ (expected[index] ?? 0);
  return difference === 0;
}

async function settings(env: StudioEnv): Promise<ModelSettingsRow | null> {
  return env.DB.prepare(
    "SELECT provider,model,base_url,api_key_ciphertext,api_key_iv,updated_at FROM admin_model_settings WHERE id=1",
  ).first<ModelSettingsRow>();
}

function modelSummary(env: StudioEnv, row: ModelSettingsRow | null) {
  return row
    ? {
        provider: row.provider,
        model: row.model,
        baseUrl: row.base_url,
        keyConfigured: !!row.api_key_ciphertext,
        source: "admin" as const,
        updatedAt: row.updated_at,
      }
    : {
        provider: env.AI_PROVIDER,
        model: env.AI_MODEL,
        baseUrl: environmentBaseUrl(env, env.AI_PROVIDER),
        keyConfigured: !!environmentApiKey(env, env.AI_PROVIDER),
        source: "environment" as const,
        updatedAt: null,
      };
}

/**
 * Returns the provider for a non-direct inference transport, or undefined when
 * the direct providers (and the D1 admin override) are in use. The tkslopper
 * transport deliberately ignores the admin override: its aliases are managed
 * in tkslopper, and admin_model_settings cannot store a tkslopper provider.
 */
function transportModelProvider(env: StudioEnv): ModelProvider | undefined {
  const transport = inferenceTransport(env);
  if (transport === "direct") return undefined;
  if (transport === "tkslopper") return createTkslopperModelProvider(env);
  return new UnavailableModelProvider(
    `Unsupported inference transport: ${transport}`,
  );
}

export async function loadConfiguredModelProvider(
  env: StudioEnv,
): Promise<ModelProvider> {
  const transportProvider = transportModelProvider(env);
  if (transportProvider) return transportProvider;
  if (!configured(env)) return createModelProvider(env);
  const row = await settings(env);
  if (!row) return createModelProvider(env);
  let apiKey: string | undefined;
  if (row.api_key_ciphertext && row.api_key_iv) {
    try {
      apiKey = await decryptAdminApiKey(
        row.api_key_ciphertext,
        row.api_key_iv,
        env.ADMIN_ENCRYPTION_KEY!,
        row.provider,
        row.base_url,
      );
    } catch (error) {
      console.error(
        `Admin model key decryption failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const override: ModelProviderConfig = {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    ...(apiKey ? { apiKey } : {}),
  };
  return createModelProvider(env, override);
}

export function createConfiguredModelProvider(env: StudioEnv): ModelProvider {
  const transportProvider = transportModelProvider(env);
  if (transportProvider) return transportProvider;
  let loaded: ModelProvider | undefined;
  let loading: Promise<ModelProvider> | undefined;
  const load = async () => {
    loading ??= loadConfiguredModelProvider(env);
    loaded ??= await loading;
    return loaded;
  };
  return {
    get name() {
      return loaded?.name ?? "configured";
    },
    generate: (...args) => load().then((provider) => provider.generate(...args)),
    revise: (...args) => load().then((provider) => provider.revise(...args)),
    repair: (...args) => load().then((provider) => provider.repair(...args)),
    moderate: (...args) => load().then((provider) => provider.moderate(...args)),
  };
}

/**
 * The tapplet.tk.sg/admin* route also matches paths such as /administrator,
 * which belong to the static site that owns the host's custom domain.
 */
export function belongsToAdminHostSite(request: Request, env: StudioEnv): boolean {
  const adminOrigin = canonicalAdminOrigin(env);
  const url = new URL(request.url);
  return !!adminOrigin && url.host === new URL(adminOrigin).host &&
    !ADMIN_PATHS.has(url.pathname);
}

function canonicalAdminOrigin(env: StudioEnv): string | null {
  try {
    const url = new URL(env.ADMIN_ORIGIN ?? "");
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(response.body, { status: response.status, headers });
}

async function overview(env: StudioEnv): Promise<Response> {
  const transport = inferenceTransport(env);
  const tkslopperConfig =
    transport === "tkslopper" ? readTkslopperConfig(env) : undefined;
  const [row, results, aliasMetadata] = await Promise.all([
    settings(env),
    env.DB.batch([
      env.DB.prepare(
        `SELECT 'artifacts' name,count(*) value FROM artifacts
         UNION ALL SELECT 'revisions',count(*) FROM revisions
         UNION ALL SELECT 'activePublications',count(*) FROM publications WHERE revoked_at IS NULL AND datetime(expires_at)>datetime('now')
         UNION ALL SELECT 'activeClassCodes',count(*) FROM class_codes WHERE use_count<maximum_uses AND datetime(expires_at)>datetime('now')
         UNION ALL SELECT 'unreviewedReports',count(*) FROM content_reports WHERE reviewed_at IS NULL`,
      ),
      env.DB.prepare(
        `WITH RECURSIVE dates(date) AS (
           SELECT date('now','-13 days') UNION ALL SELECT date(date,'+1 day') FROM dates WHERE date<date('now')
         ), revision_counts AS (
           SELECT substr(created_at,1,10) date,
             sum(CASE WHEN kind='generation' THEN 1 ELSE 0 END) generations,
             sum(CASE WHEN kind='revision' THEN 1 ELSE 0 END) revisions
           FROM revisions WHERE created_at>=date('now','-13 days') GROUP BY substr(created_at,1,10)
         ), upload_counts AS (
           SELECT usage_date date,sum(upload_count) uploads,sum(total_bytes) upload_bytes
           FROM asset_usage WHERE usage_date>=date('now','-13 days') AND owner_hash NOT LIKE 'network:%' GROUP BY usage_date
         )
         SELECT dates.date,coalesce(generations,0) generations,coalesce(revisions,0) revisions,
           coalesce(uploads,0) uploads,coalesce(upload_bytes,0) upload_bytes
         FROM dates LEFT JOIN revision_counts USING(date) LEFT JOIN upload_counts USING(date) ORDER BY dates.date`,
      ),
      env.DB.prepare(
        "SELECT model_version model,count(*) count FROM revisions GROUP BY model_version ORDER BY count DESC LIMIT 8",
      ),
    ]),
    tkslopperConfig?.ok
      ? new TkslopperClient(tkslopperConfig.config).listModelMetadata()
      : [],
  ]);
  const counts = Object.fromEntries(
    ((results[0]?.results ?? []) as CountRow[]).map((item) => [
      item.name,
      item.value,
    ]),
  );
  return json({
    transport,
    aliasMetadata,
    transportProblem:
      transport !== "direct" && transport !== "tkslopper"
        ? `Unsupported inference transport: ${transport}`
        : tkslopperConfig && !tkslopperConfig.ok
          ? tkslopperConfig.reason
          : null,
    aliases:
      transport === "tkslopper"
        ? {
            artifact: env.TKSLOPPER_ARTIFACT_ALIAS?.trim() || null,
            review: env.TKSLOPPER_REVIEW_ALIAS?.trim() || null,
            image: env.TKSLOPPER_IMAGE_ALIAS?.trim() || null,
          }
        : null,
    model: modelSummary(env, row),
    counts,
    usage: (results[1]?.results ?? []) as UsageRow[],
    models: (results[2]?.results ?? []) as ModelUsageRow[],
  });
}

async function updateModel(request: Request, env: StudioEnv): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 8_000);
  const provider = body.provider;
  const model = body.model;
  const baseUrl = body.baseUrl;
  if (typeof provider !== "string" || !MODEL_PROVIDERS.has(provider))
    return apiError(422, "INVALID_PROVIDER", "Choose an available provider.");
  if (typeof model !== "string" || !model.trim() || model.trim().length > 200)
    return apiError(422, "INVALID_MODEL", "Enter a model name.");
  if (typeof baseUrl !== "string" || baseUrl.length > 500)
    return apiError(422, "INVALID_BASE_URL", "Enter a valid provider URL.");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return apiError(422, "INVALID_BASE_URL", "Enter a valid provider URL.");
  }
  if (parsedUrl.protocol !== "https:")
    return apiError(422, "INVALID_BASE_URL", "Provider URLs must use HTTPS.");

  const normalisedBaseUrl = parsedUrl.toString().replace(/\/$/, "");
  const current = await settings(env);
  let ciphertext: string | null = null;
  let iv: string | null = null;
  const preserveApiKey = body.clearApiKey !== true &&
    (body.apiKey === undefined || body.apiKey === "");
  const canPreserveApiKey = !!(
    current?.api_key_ciphertext &&
    current.api_key_iv &&
    current.provider === provider &&
    current.base_url === normalisedBaseUrl
  );
  if (preserveApiKey && provider !== "fixture" && !canPreserveApiKey)
    return apiError(
      422,
      "API_KEY_REQUIRED",
      "Enter an API key when creating an override or changing its provider URL.",
    );
  if (!preserveApiKey && body.clearApiKey !== true) {
    if (typeof body.apiKey !== "string" || body.apiKey.length > 2_000)
      return apiError(422, "INVALID_API_KEY", "The API key is too long.");
    const encrypted = await encryptAdminApiKey(
      body.apiKey,
      env.ADMIN_ENCRYPTION_KEY!,
      provider,
      normalisedBaseUrl,
    );
    ciphertext = encrypted.ciphertext;
    iv = encrypted.iv;
  }
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_model_settings(id,provider,model,base_url,api_key_ciphertext,api_key_iv,updated_at)
     VALUES(1,?1,?2,?3,?4,?5,?6)
     ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,base_url=excluded.base_url,
       api_key_ciphertext=CASE WHEN ?7=1 AND admin_model_settings.provider=excluded.provider AND admin_model_settings.base_url=excluded.base_url THEN admin_model_settings.api_key_ciphertext ELSE excluded.api_key_ciphertext END,
       api_key_iv=CASE WHEN ?7=1 AND admin_model_settings.provider=excluded.provider AND admin_model_settings.base_url=excluded.base_url THEN admin_model_settings.api_key_iv ELSE excluded.api_key_iv END,
       updated_at=excluded.updated_at`,
  )
    .bind(
      provider,
      model.trim(),
      normalisedBaseUrl,
      ciphertext,
      iv,
      updatedAt,
      preserveApiKey ? 1 : 0,
    )
    .run();
  return json({ model: modelSummary(env, await settings(env)) });
}

async function resetModel(env: StudioEnv): Promise<Response> {
  await env.DB.prepare("DELETE FROM admin_model_settings WHERE id=1").run();
  return json({ model: modelSummary(env, null) });
}

function createClassCode(): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

interface VerifiedClassKey {
  key: string;
  hint: string;
  warning?: string;
}

/**
 * Checks a tkslopper classroom group key before it is stored. Unknown keys and
 * keys missing Tapplet's aliases are rejected; a class that is paused or not
 * yet started (403) or an unreachable gateway is saved with a warning.
 */
async function verifyClassKey(
  env: StudioEnv,
  value: unknown,
): Promise<VerifiedClassKey> {
  const key = typeof value === "string" ? value.trim() : "";
  if (!GROUP_KEY_PATTERN.test(key))
    throw new HttpError(422, "INVALID_CLASS_KEY", "Enter a tkslopper class key starting with tkgk_.");
  const config = readTkslopperClassConfig(env, key);
  if (!config.ok)
    throw new HttpError(409, "CLASS_KEY_UNCONFIGURED", config.reason);
  const probe = await new TkslopperClient(config.config).probeAliases();
  const hint = key.slice(-4);
  if (probe.status === 401)
    throw new HttpError(422, "INVALID_CLASS_KEY", "tkslopper did not recognise this class key.");
  if (probe.status === 200) {
    const required = [
      config.config.artifactAlias,
      config.config.reviewAlias,
      config.config.imageAlias,
    ];
    const missing = [...new Set(required)].filter((alias) => !probe.aliases.includes(alias));
    if (missing.length)
      throw new HttpError(
        422,
        "CLASS_KEY_ALIASES_MISSING",
        `This class key does not allow: ${missing.join(", ")}.`,
      );
    return { key, hint };
  }
  return {
    key,
    hint,
    warning:
      probe.status === 403
        ? "Saved, but tkslopper is refusing this class right now: it may be paused, revoked or outside its schedule."
        : "Saved without checking: tkslopper could not be reached.",
  };
}

function normalisedClassCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase().replaceAll("-", "") : "";
  if (!/^(?:\d{6}|[A-Z]{6}|\d{4}[A-Z]{8})$/.test(code))
    throw new HttpError(422, "INVALID_CLASS_CODE", "Enter the class access code.");
  return code;
}

async function setClassKey(request: Request, env: StudioEnv): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 2_000);
  const code = normalisedClassCode(body.code);
  const row = await env.DB.prepare(
    "SELECT code_hash,label,inference_key_version FROM class_codes WHERE code_hash=?1 OR short_code_hash=?1",
  )
    .bind(await sha256(`class-code:${code}`))
    .first<{ code_hash: string; label: string; inference_key_version: number }>();
  if (!row)
    return apiError(404, "CLASS_CODE_NOT_FOUND", "No class uses this access code.");
  if (body.classKey === null) {
    await env.DB.prepare(
      "UPDATE class_codes SET inference_key_ciphertext=NULL,inference_key_iv=NULL,inference_key_hint=NULL,inference_key_version=inference_key_version+1 WHERE code_hash=?1",
    )
      .bind(row.code_hash)
      .run();
    return json({ label: row.label, keyHint: null });
  }
  const verified = await verifyClassKey(env, body.classKey);
  const encrypted = await encryptClassKey(
    verified.key,
    env.ADMIN_ENCRYPTION_KEY!,
    row.code_hash,
  );
  // Verification awaits the gateway, so only write if no attach or removal
  // happened meanwhile: the newer change wins instead of being undone.
  const updated = await env.DB.prepare(
    "UPDATE class_codes SET inference_key_ciphertext=?1,inference_key_iv=?2,inference_key_hint=?3,inference_key_version=inference_key_version+1 WHERE code_hash=?4 AND inference_key_version=?5",
  )
    .bind(encrypted.ciphertext, encrypted.iv, verified.hint, row.code_hash, row.inference_key_version)
    .run();
  if (updated.meta.changes !== 1)
    return apiError(409, "CLASS_KEY_CHANGED", "This class's key changed while it was being checked. Try again.");
  return json({
    label: row.label,
    keyHint: verified.hint,
    ...(verified.warning ? { warning: verified.warning } : {}),
  });
}

async function mintClassCode(request: Request, env: StudioEnv): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 2_000);
  const classNumber = body.classNumber;
  const maximumUses = body.maximumUses;
  const expiresAt = body.expiresAt;
  if (typeof classNumber !== "string" || !/^\d{4}$/.test(classNumber))
    return apiError(422, "INVALID_CLASS_NUMBER", "Enter a four-digit class number.");
  if (
    typeof maximumUses !== "number" ||
    !Number.isSafeInteger(maximumUses) ||
    maximumUses < 1 ||
    maximumUses > 100
  )
    return apiError(422, "INVALID_MAXIMUM_USES", "Activations must be from 1 to 100.");
  if (
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(Date.parse(expiresAt)).toISOString() !== expiresAt ||
    Date.parse(expiresAt) <= Date.now()
  )
    return apiError(422, "INVALID_EXPIRY", "Choose a future expiry date and time.");
  const classKey =
    body.classKey === undefined || body.classKey === null || body.classKey === ""
      ? undefined
      : await verifyClassKey(env, body.classKey);

  const createdAt = new Date().toISOString();
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = createClassCode();
    const codeHash = await sha256(`class-code:${code}`);
    // The ciphertext is bound to its row, so it is re-encrypted per attempt.
    const encrypted = classKey
      ? await encryptClassKey(classKey.key, env.ADMIN_ENCRYPTION_KEY!, codeHash)
      : undefined;
    const result = await env.DB.prepare(
      `INSERT INTO class_codes(code_hash,label,maximum_uses,expires_at,created_at,inference_key_ciphertext,inference_key_iv,inference_key_hint)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(code_hash) DO NOTHING`,
    )
      .bind(
        codeHash,
        `Class ${classNumber}`,
        maximumUses,
        expiresAt,
        createdAt,
        encrypted?.ciphertext ?? null,
        encrypted?.iv ?? null,
        classKey?.hint ?? null,
      )
      .run();
    if (result.meta.changes === 1)
      return json(
        {
          code,
          classNumber,
          maximumUses,
          expiresAt,
          createdAt,
          keyHint: classKey?.hint ?? null,
          ...(classKey?.warning ? { warning: classKey.warning } : {}),
        },
        { status: 201 },
      );
  }
  return apiError(503, "CLASS_CODE_ALLOCATION_FAILED", "Could not allocate a class code. Try again.");
}

export async function handleAdminRequest(
  request: Request,
  env: StudioEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (!ADMIN_PATHS.has(pathname)) return null;
  if (!configured(env)) return new Response("Not found.", { status: 404 });
  if (pathname === "/admin" || pathname === "/admin/") {
    if (request.method !== "GET") return new Response("Not found.", { status: 404 });
    const adminOrigin = canonicalAdminOrigin(env);
    // Compare hosts: wrangler dev presents route hosts over http, and the zone
    // already upgrades http at the edge. Loopback hosts never redirect, so
    // local development cannot send an operator (and their token) to production.
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (adminOrigin && !loopback && url.host !== new URL(adminOrigin).host)
      return secured(Response.redirect(`${adminOrigin}/admin`, 308));
    return secured(
      new Response(ADMIN_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      }),
    );
  }
  if (!(await authorised(request, env)))
    return secured(apiError(401, "ADMIN_UNAUTHORIZED", "Admin access required."));
  try {
    if (pathname === "/v1/admin/overview" && request.method === "GET")
      return secured(await overview(env));
    if (pathname === "/v1/admin/model-catalogue" && request.method === "GET")
      return secured(json(await loadModelCatalogue(env.TKSLOPPER_GATEWAY_URL)));
    if (pathname === "/v1/admin/model-pricing" && request.method === "GET") {
      const model = url.searchParams.get("model")?.trim() ?? "";
      if (!model || model.length > 200)
        return secured(apiError(400, "INVALID_MODEL", "Choose a model to price."));
      return secured(json({ pricing: await loadModelPricing(model) }));
    }
    if (pathname === "/v1/admin/model" && request.method === "PATCH")
      return secured(await updateModel(request, env));
    if (pathname === "/v1/admin/model" && request.method === "DELETE")
      return secured(await resetModel(env));
    if (pathname === "/v1/admin/class-codes" && request.method === "POST")
      return secured(await mintClassCode(request, env));
    if (pathname === "/v1/admin/class-codes/key" && request.method === "POST")
      return secured(await setClassKey(request, env));
    return secured(apiError(404, "NOT_FOUND", "Endpoint not found."));
  } catch (error) {
    if (error instanceof HttpError)
      return secured(apiError(error.status, error.code, error.message, error.details));
    console.error(
      `Admin request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return secured(apiError(500, "INTERNAL_ERROR", "Admin request failed."));
  }
}
