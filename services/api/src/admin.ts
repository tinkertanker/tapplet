import { randomInt } from "node:crypto";
import {
  createModelProvider,
  UnavailableModelProvider,
} from "./ai/createProvider";
import type { ModelProviderConfig } from "./ai/createProvider";
import type { ModelProvider } from "./ai/provider";
import { BUNDLED_MODELS, loadModelCatalogue } from "./ai/modelCatalogue";
import { loadModelPricing } from "./ai/modelPricing";
import {
  createTkslopperModelProvider,
  GROUP_KEY_PATTERN,
  inferenceTransport,
  readTkslopperClassConfig,
  readTkslopperConfig,
  TkslopperClient,
} from "./ai/tkslopper";
import { sha256 } from "./auth";
import type { StudioEnv } from "./env";
import { apiError, HttpError, json, readJson } from "./http";

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function modelKeyScope(provider: string, baseUrl: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(
      `tapplet-admin-model-key:v1:${JSON.stringify([1, provider, baseUrl])}`,
    ),
  );
}

export async function encryptAdminApiKey(
  value: string,
  secret: string,
  provider: string,
  baseUrl: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: modelKeyScope(provider, baseUrl) },
    await encryptionKey(secret),
    new TextEncoder().encode(value),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptAdminApiKey(
  ciphertext: string,
  iv: string,
  secret: string,
  provider: string,
  baseUrl: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(iv),
      additionalData: modelKeyScope(provider, baseUrl),
    },
    await encryptionKey(secret),
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

// Binds each class key to its class row; admin_model_settings cannot store
// this provider name, so model keys and class keys are never interchangeable.
const CLASS_KEY_SCOPE = "tkslopper-class";

export function encryptClassKey(
  key: string,
  secret: string,
  classCodeHash: string,
): Promise<{ ciphertext: string; iv: string }> {
  return encryptAdminApiKey(key, secret, CLASS_KEY_SCOPE, classCodeHash);
}

export function decryptClassKey(
  ciphertext: string,
  iv: string,
  secret: string,
  classCodeHash: string,
): Promise<string> {
  return decryptAdminApiKey(ciphertext, iv, secret, CLASS_KEY_SCOPE, classCodeHash);
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
    ((results[0]?.results ?? []) as unknown as CountRow[]).map((item) => [
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
    usage: (results[1]?.results ?? []) as unknown as UsageRow[],
    models: (results[2]?.results ?? []) as unknown as ModelUsageRow[],
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

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Operations · Tapplet</title><meta name="robots" content="noindex"><link rel="icon" href="/AppIcon-1024.png" type="image/png"><style>
[hidden],.hidden{display:none!important}
:root{color-scheme:light;--canvas:#f8f6f1;--surface:#fff;--ink:#171718;--muted:#6f6d67;--border:#dfdeda;--accent:#bd3a34;--accent-bright:#f05d57;--secondary:#ece8df;--good:#25623b;--danger:#9a2c27;--display:ui-rounded,"SF Pro Rounded","Hiragino Maru Gothic ProN",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--text:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--canvas);color:var(--ink);font:15px/1.55 var(--text)}button,input,select{font:inherit}a{color:var(--accent);text-underline-offset:.18em}
.site-header{width:min(1080px,calc(100% - 32px));margin:0 auto;padding:22px 0;display:flex;align-items:center;justify-content:space-between;gap:16px}
.home-link{display:inline-flex;align-items:center;gap:.6rem;color:var(--ink);font-family:var(--display);font-weight:700;font-size:18px;text-decoration:none}.home-link img{width:40px;height:40px}
main{flex:1;width:min(1080px,calc(100% - 32px));margin:0 auto;padding:8px 0 56px}
h1{font-family:var(--display);font-size:clamp(28px,4.5vw,40px);line-height:1.1;margin:0;letter-spacing:-.02em}h1::after{content:"";display:block;width:40px;height:3px;margin-top:14px;border-radius:2px;background:var(--accent-bright)}
h2{font-family:var(--display);font-size:18px;line-height:1.3;margin:0 0 4px}h3{font-size:14px;margin:18px 0 8px}p{margin:0;color:var(--muted)}
.summary{margin:18px 0 32px;font-size:16px;color:var(--ink)}.summary b{font-variant-numeric:tabular-nums}.summary .sep{color:var(--muted);margin:0 .5em}.summary .attention{color:var(--accent);font-weight:700}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px}.panel>p.lede{margin-bottom:18px;font-size:14px}
.login{max-width:440px;margin:10vh auto 0}.login form{display:grid;gap:14px;margin-top:22px}.login h1{margin-bottom:12px}
.columns{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.75fr);gap:20px;align-items:start}.stack{display:grid;gap:20px}
label{display:grid;gap:6px;font-weight:600;font-size:14px}input,select{width:100%;border:1px solid #76736c;border-radius:10px;padding:9px 12px;background:#fff;color:var(--ink)}input:focus,select:focus,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}.wide{grid-column:1/-1}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:18px}
button{border:0;border-radius:12px;padding:9px 15px;font-weight:700;cursor:pointer;background:var(--accent);color:#fff}button.secondary{background:var(--secondary);color:var(--ink)}button.danger{background:#fbe7e5;color:var(--danger)}button.link{background:none;padding:0;color:var(--accent);font-weight:600;text-decoration:underline;text-underline-offset:.18em}button:disabled{opacity:.55;cursor:wait}
.pill{display:inline-flex;border-radius:999px;background:var(--secondary);padding:4px 9px;font-size:12px;font-weight:700}.pill.good{background:#e7f3e9;color:var(--good)}
.note{font-size:13px;margin-top:8px}.status{min-height:22px;margin-top:10px;font-size:13px}.error{color:var(--danger)}
.chart{height:150px;display:flex;align-items:end;gap:5px;border-bottom:1px solid var(--border);margin-top:18px}.bar-group{height:100%;flex:1;display:flex;align-items:end;gap:2px;position:relative}.bar{min-height:2px;flex:1;background:var(--accent);border-radius:3px 3px 0 0}.bar.revision{background:var(--ink)}.bar-group span{position:absolute;bottom:-24px;left:50%;transform:translateX(-50%);font-size:10px;color:var(--muted);white-space:nowrap}
.legend{display:flex;gap:16px;margin-top:30px;font-size:12px;color:var(--muted)}.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:var(--accent)}.dot.dark{background:var(--ink)}
details{margin-top:14px;font-size:13px}summary{cursor:pointer;color:var(--accent);font-weight:600}
.models{display:grid;gap:10px;margin-top:14px}.model-row{display:grid;grid-template-columns:1fr auto;gap:12px;font-size:14px}.model-row b{font-variant-numeric:tabular-nums}.meter{height:5px;background:var(--secondary);border-radius:99px;overflow:hidden;margin-top:5px}.meter i{display:block;height:100%;background:var(--accent)}
.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:14px 0 0;font-size:14px}.facts dt{color:var(--muted)}.facts dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums}
.estimate{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin-top:20px;border-top:1px solid var(--border);padding-top:16px}.estimate div{display:grid}.estimate span{font-size:13px;color:var(--muted)}.estimate strong{font-family:var(--display);font-size:24px;font-variant-numeric:tabular-nums}
.site-footer{padding:22px;text-align:center;font-size:14px}.site-footer a{color:var(--muted);margin:0 .6em}.site-footer a:hover{color:var(--ink)}
@media(max-width:820px){.columns{grid-template-columns:1fr}.fields{grid-template-columns:1fr}.wide{grid-column:auto}.estimate{grid-template-columns:1fr;gap:10px}}
</style></head><body><header class="site-header"><a class="home-link" href="/"><img src="/AppIcon-1024.png" width="40" height="40" alt="">Tapplet</a><button id="sign-out" class="secondary" hidden>Sign out</button></header><main>
<section id="login" class="panel login"><h1>Sign in</h1><p>Enter the admin token configured on the Worker. It stays in this browser tab only.</p><form id="login-form"><label>Admin token<input id="token" type="password" autocomplete="current-password" required></label><button>Open dashboard</button><div id="login-error" class="status error" role="alert"></div></form></section>
<section id="dashboard" class="hidden"><h1>Operations</h1><p id="summary" class="summary"></p>
<div class="columns"><div class="stack">
<section class="panel"><h2>Model configuration</h2><p class="lede">The provider and model Tapplet Studio uses to make and revise tapplets.</p><form id="model-form"><div class="fields">
<label>Provider<select id="provider"><option value="opencode-go">OpenCode Go</option><option value="opencode">OpenCode Zen</option><option value="openrouter">OpenRouter</option><option value="openai-compatible">OpenAI / compatible</option><option value="anthropic">Claude (Anthropic)</option><option value="fixture">Fixture (testing only)</option></select></label><label>Model<input id="model" required maxlength="200"></label>
<label id="preset-label" class="wide">Suggested model<select id="model-preset" aria-describedby="preset-note"></select></label><p id="preset-note" class="wide note">Suggestions never replace a saved model. Custom model IDs remain supported.</p>
<label class="wide">Base URL<input id="base-url" type="url" required maxlength="500"></label><label class="wide">Replace API key<input id="api-key" type="password" maxlength="2000" autocomplete="new-password" placeholder="Blank keeps the existing key"></label></div><p id="key-state" class="note"></p><p id="transport" class="note"></p><p id="transport-problem" class="note error" role="alert"></p><div class="actions"><button id="save-model">Save configuration</button><button id="clear-key" type="button" class="danger">Remove key</button><button id="reset-model" type="button" class="secondary">Use environment defaults</button><span id="source" class="pill"></span></div><div id="model-status" class="status" role="status"></div></form></section>
<section class="panel" aria-labelledby="cost-title"><h2 id="cost-title">Cost estimator</h2><p class="lede">Projects model spend from list prices and assumed token use. Tapplet does not record actual tokens, so treat this as a planning range.</p><form id="cost-form"><div class="fields">
<label>Input price (USD per 1M tokens)<input id="price-in" type="number" min="0" step="any" inputmode="decimal" required></label><label>Output price (USD per 1M tokens)<input id="price-out" type="number" min="0" step="any" inputmode="decimal" required></label>
<p id="price-source" class="wide note" role="status"></p>
<label>Input tokens per request<input id="tokens-in" type="number" min="0" step="100" value="6000" required></label><label>Output tokens per request<input id="tokens-out" type="number" min="0" step="100" value="4000" required></label>
<label class="wide">Requests per month<input id="requests" type="number" min="0" step="1" value="0" required aria-describedby="requests-note"></label><p id="requests-note" class="wide note"></p></div>
<div class="estimate"><div><span>Per request</span><strong id="cost-request">–</strong></div><div><span>Per month</span><strong id="cost-month" aria-live="polite">–</strong></div><div><span>Per year</span><strong id="cost-year">–</strong></div></div>
<details><summary>How the defaults are chosen</summary><p class="note">A request is one generation or revision. Its input is the system prompt, up to two example tapplets and the teacher's brief or current tapplet (about 6,000 tokens); its output is the tapplet HTML plus low-effort reasoning (about 4,000 tokens). Repairs, safety reviews and image checks add calls on top. Prices come from OpenRouter's public list when the configured model is listed there; edit them to match your provider.</p></details></form></section>
<section class="panel"><h2>Class access</h2><p class="lede">Mint a code for a class, or attach a tkslopper key to an existing one.</p>
<form id="code-form"><h3>Mint a class access code</h3><div class="fields"><label>Class number<input id="class-number" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" placeholder="1234" required></label><label>Maximum activations<input id="maximum-uses" type="number" min="1" max="100" value="30" required></label><label class="wide">Expires at<input id="expires-at" type="datetime-local" required></label><label class="wide">tkslopper class key (optional)<input id="mint-class-key" type="password" maxlength="200" autocomplete="off" placeholder="tkgk_…" aria-describedby="mint-class-key-note"></label><p id="mint-class-key-note" class="wide note">With a key, this class uses its tkslopper aliases, budget and pause. Without one, it uses the model configuration above.</p></div><div class="actions"><button id="mint-code">Mint code</button></div><div id="code-result" class="status" role="status"></div><p class="note">The code is shown once. Copy it to a protected location before leaving this page; only its hash is stored.</p></form>
<form id="class-key-form"><h3>Class AI key</h3><div class="fields"><label>Class access code<input id="class-key-code" autocomplete="off" maxlength="20" required></label><label>tkslopper class key<input id="class-key" type="password" maxlength="200" autocomplete="off" placeholder="tkgk_…"></label></div><div class="actions"><button id="attach-class-key">Attach key</button><button id="remove-class-key" type="button" class="danger">Remove key</button></div><div id="class-key-result" class="status" role="status"></div><p class="note">Attaching replaces the class's key for every iPad that joined with this code since class AI access was deployed; earlier iPads keep the model configuration above. Removing it returns the class to that configuration.</p></form></section>
</div><div class="stack">
<section class="panel"><h2>Activity</h2><p>Last 14 days</p><div id="chart" class="chart" aria-hidden="true"></div><div class="legend" aria-hidden="true"><span><i class="dot"></i>Generations</span><span><i class="dot dark"></i>Revisions</span></div><details><summary>Daily figures</summary><div id="activity-summary" class="models"></div></details></section>
<section class="panel"><h2>Uploads</h2><p>Last 14 days</p><dl id="upload-summary" class="facts"></dl><p class="note">Counts successful owner upload reservations; network safety counters are excluded.</p></section>
<section class="panel"><h2>Models used</h2><p>All persisted revisions</p><div id="models" class="models"></div></section>
</div></div></section>
</main><footer class="site-footer"><a href="/">Home</a><a href="/privacy">Privacy</a></footer><script>
const $=id=>document.getElementById(id);let token=sessionStorage.getItem('tapplet-admin-token')||'';let data;
async function api(path,options={}){const response=await fetch(path,{...options,headers:{authorization:'Bearer '+token,...(options.body?{'content-type':'application/json'}:{}),...options.headers}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error?.message||'Request failed');return body}
function number(value){return new Intl.NumberFormat().format(value||0)}
function render(){const counts=data.counts;const facts=[[counts.artifacts,'tapplet','tapplets'],[counts.revisions,'revision','revisions'],[counts.activePublications,'live share','live shares'],[counts.activeClassCodes,'active class code','active class codes']];const reports=counts.unreviewedReports||0;$('summary').innerHTML=facts.map(([value,one,many])=>'<b>'+number(value)+'</b> '+(value===1?one:many)).join('<span class="sep" aria-hidden="true">·</span>')+'<span class="sep" aria-hidden="true">·</span>'+(reports?'<span class="attention">'+number(reports)+(reports===1?' report needs':' reports need')+' review</span>':'No reports to review');const m=data.model;$('provider').value=m.provider;$('model').value=m.model;$('base-url').value=m.baseUrl;$('api-key').value='';$('key-state').textContent=m.source==='environment'?'Enter a key to create an admin override.':m.keyConfigured?'A key is configured. Enter a new one only to replace it.':'No API key is configured.';$('source').textContent=m.source==='admin'?'Admin override':'Environment default';$('source').className='pill '+(m.keyConfigured?'good':'');$('clear-key').disabled=!m.keyConfigured||m.source!=='admin';$('reset-model').disabled=m.source!=='admin';$('transport').textContent=data.transport==='tkslopper'?'Transport: tkslopper (admin model override inactive)'+(data.aliases?' · Aliases: '+[data.aliases.artifact,data.aliases.review,data.aliases.image].map(aliasLabel).join(', '):''):'Transport: '+data.transport;$('transport-problem').textContent=data.transportProblem||'';$('transport-problem').hidden=!data.transportProblem;const max=Math.max(1,...data.usage.map(x=>x.generations+x.revisions));$('chart').innerHTML=data.usage.map((x,i)=>'<div class="bar-group"><i class="bar" style="height:'+Math.max(1,x.generations/max*100)+'%"></i><i class="bar revision" style="height:'+Math.max(1,x.revisions/max*100)+'%"></i>'+(i%3===0||i===data.usage.length-1?'<span>'+x.date.slice(5)+'</span>':'')+'</div>').join('');$('activity-summary').innerHTML=data.usage.map(x=>'<div class="model-row"><span>'+escapeHtml(x.date)+'</span><span>'+number(x.generations)+' generations · '+number(x.revisions)+' revisions</span></div>').join('');const modelMax=Math.max(1,...data.models.map(x=>x.count));$('models').innerHTML=data.models.length?data.models.map(x=>'<div class="model-row"><div><strong>'+escapeHtml(x.model)+'</strong><div class="meter"><i style="width:'+(x.count/modelMax*100)+'%"></i></div></div><b>'+number(x.count)+'</b></div>').join(''):'<p>No revisions yet.</p>';const uploads=data.usage.reduce((a,x)=>({count:a.count+x.uploads,bytes:a.bytes+x.upload_bytes}),{count:0,bytes:0});$('upload-summary').innerHTML='<dt>Uploads</dt><dd>'+number(uploads.count)+'</dd><dt>Processed</dt><dd>'+new Intl.NumberFormat(undefined,{style:'unit',unit:'megabyte',maximumFractionDigits:1}).format(uploads.bytes/1000000)+'</dd>';renderCostDefaults()}
function aliasLabel(id){if(!id)return 'not set';const m=data.aliasMetadata?.find(x=>x.id===id);const details=[m?.display_name,m?.provider,m?.tier].filter(Boolean);return id+(details.length?' ('+details.join(' · ')+')':'')}
function escapeHtml(value){const node=document.createElement('span');node.textContent=value;return node.innerHTML}
const bundledModels=${JSON.stringify(BUNDLED_MODELS)};
let catalogue={source:'fallback',data:bundledModels},catalogueRequested=false;
const drafts={};let editingProvider;
function catalogueProvider(){const p=$('provider').value;if(p==='openai-compatible'){const url=$('base-url').value.replace(/\/$/,'');return url==='https://api.openai.com/v1'?'openai':['https://api.deepseek.com','https://api.deepseek.com/v1'].includes(url)?'deepseek':null}return p==='opencode'?'opencode-zen':p}
function availableModels(){const p=catalogueProvider();const remote=catalogue.source==='tkslopper'?catalogue.data.filter(x=>x.provider===p):[];return {models:remote.length?remote:bundledModels.filter(x=>x.provider===p),remote:!!remote.length}}
function suggestions(){const {models,remote}=availableModels();$('preset-label').hidden=!models.length;$('preset-note').textContent=(remote?'Suggestions from tkslopper. ':models.length?'Bundled suggestions (catalogue unavailable for this provider). ':'No catalogue suggestions for this endpoint. ')+ 'Saved and custom model IDs are always retained.';$('model-preset').replaceChildren(new Option('Custom / saved model',''),...models.map(x=>new Option(x.display_name+' · '+x.tier+(x.is_default?' · default':''),x.id)));$('model-preset').value=models.some(x=>x.id===$('model').value)?$('model').value:''}
async function loadCatalogue(){try{catalogue=await api('/v1/admin/model-catalogue',{signal:AbortSignal.timeout(4500)})}catch{catalogue={source:'fallback',data:bundledModels}}suggestions()}
function modelLoaded(){editingProvider=data.model.provider;drafts[editingProvider]={model:data.model.model,baseUrl:data.model.baseUrl};suggestions()}
async function load(){data=await api('/v1/admin/overview');$('login').classList.add('hidden');$('dashboard').classList.remove('hidden');$('sign-out').hidden=false;render();modelLoaded();if(!catalogueRequested){catalogueRequested=true;void loadCatalogue()}}
$('provider').onchange=()=>{drafts[editingProvider]={model:$('model').value,baseUrl:$('base-url').value};const p=$('provider').value;const defaults={'opencode':'https://opencode.ai/zen/v1','opencode-go':'https://opencode.ai/zen/go/v1','openrouter':'https://openrouter.ai/api/v1','openai-compatible':'https://api.openai.com/v1','anthropic':'https://api.anthropic.com/v1','fixture':'https://models.example.test/v1'};$('base-url').value=drafts[p]?.baseUrl??defaults[p];$('model').value=drafts[p]?.model??availableModels().models.find(x=>x.is_default)?.id??'';$('api-key').value='';editingProvider=p;suggestions()};
$('model-preset').onchange=()=>{if($('model-preset').value)$('model').value=$('model-preset').value};
$('model').oninput=suggestions;$('base-url').oninput=suggestions;
$('login-form').onsubmit=async event=>{event.preventDefault();token=$('token').value;$('login-error').textContent='';try{await load();sessionStorage.setItem('tapplet-admin-token',token)}catch(error){token='';$('login-error').textContent=error.message}};
$('model-form').onsubmit=async event=>{event.preventDefault();const button=$('save-model');button.disabled=true;$('model-status').className='status';$('model-status').textContent='Saving…';try{await api('/v1/admin/model',{method:'PATCH',body:JSON.stringify({provider:$('provider').value,model:$('model').value,baseUrl:$('base-url').value,apiKey:$('api-key').value})});await load();$('model-status').textContent='Configuration saved.'}catch(error){$('model-status').className='status error';$('model-status').textContent=error.message}finally{button.disabled=false}};
$('code-form').onsubmit=async event=>{event.preventDefault();const button=$('mint-code');button.disabled=true;$('code-result').className='status';$('code-result').textContent='Minting…';try{const expiry=new Date($('expires-at').value);const result=await api('/v1/admin/class-codes',{method:'POST',body:JSON.stringify({classNumber:$('class-number').value,maximumUses:Number($('maximum-uses').value),expiresAt:expiry.toISOString(),classKey:$('mint-class-key').value})});$('mint-class-key').value='';$('code-result').innerHTML='Class access code: <strong style="font-size:20px">'+escapeHtml(result.code)+'</strong><br>'+(result.keyHint?'tkslopper class key …'+escapeHtml(result.keyHint)+' attached.<br>':'')+(result.warning?escapeHtml(result.warning)+'<br>':'')+'Copy it now — it cannot be retrieved later.';try{data=await api('/v1/admin/overview');render();modelLoaded()}catch{}}catch(error){$('code-result').className='status error';$('code-result').textContent=error.message}finally{button.disabled=false}};
$('clear-key').onclick=async()=>{if(!confirm('Remove the stored API key? Model requests will stop until another key is configured.'))return;const button=$('clear-key'),m=data.model;let completed=false;button.disabled=true;$('model-status').className='status';$('model-status').textContent='Removing…';try{await api('/v1/admin/model',{method:'PATCH',body:JSON.stringify({provider:m.provider,model:m.model,baseUrl:m.baseUrl,clearApiKey:true})});await load();completed=true;$('model-status').textContent='API key removed.'}catch(error){$('model-status').className='status error';$('model-status').textContent=error.message}finally{if(!completed)button.disabled=false}};
$('reset-model').onclick=async()=>{if(!confirm('Discard the admin override and use Worker environment defaults?'))return;const button=$('reset-model');let completed=false;button.disabled=true;$('model-status').className='status';$('model-status').textContent='Resetting…';try{await api('/v1/admin/model',{method:'DELETE'});await load();completed=true;$('model-status').textContent='Using environment defaults.'}catch(error){$('model-status').className='status error';$('model-status').textContent=error.message}finally{if(!completed)button.disabled=false}};
async function setClassKey(classKey){const buttons=[$('attach-class-key'),$('remove-class-key')];if(buttons.some(x=>x.disabled))return;buttons.forEach(x=>x.disabled=true);$('class-key-result').className='status';$('class-key-result').textContent=classKey===null?'Removing…':'Checking with tkslopper…';try{const result=await api('/v1/admin/class-codes/key',{method:'POST',body:JSON.stringify({code:$('class-key-code').value,classKey})});$('class-key').value='';$('class-key-result').textContent=result.label+': '+(result.keyHint?'tkslopper class key …'+result.keyHint+' attached.':'class key removed; using the model configuration.')+(result.warning?' '+result.warning:'')}catch(error){$('class-key-result').className='status error';$('class-key-result').textContent=error.message}finally{buttons.forEach(x=>x.disabled=false)}}
$('class-key-form').onsubmit=event=>{event.preventDefault();void setClassKey($('class-key').value)};
$('remove-class-key').onclick=()=>{if(!$('class-key-code').reportValidity())return;if(!confirm('Remove this class key? iPads in the class will use the model configuration instead.'))return;void setClassKey(null)};
const money=value=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',minimumFractionDigits:value>0&&value<1?4:2,maximumFractionDigits:value>0&&value<1?4:2}).format(value);
let pricedModel,requestsEdited=false;
function recentMonthlyRequests(){const total=data.usage.reduce((a,x)=>a+x.generations+x.revisions,0);return Math.round(total/Math.max(1,data.usage.length)*30)}
function renderCostDefaults(){const recent=recentMonthlyRequests();$('requests-note').innerHTML='';$('requests-note').append('At the last 14 days’ pace: '+number(recent)+' a month. ');const reset=document.createElement('button');reset.type='button';reset.className='link';reset.textContent='Use this';reset.onclick=()=>{requestsEdited=false;$('requests').value=recent;estimate()};$('requests-note').append(reset);if(!requestsEdited)$('requests').value=recent;const model=data.transport==='tkslopper'?'':['openrouter','anthropic','openai-compatible'].includes(data.model.provider)?data.model.model:null;if(model!==pricedModel){pricedModel=model;$('price-in').value='';$('price-out').value='';void loadPricing(model)}estimate()}
async function loadPricing(model){if(model===''){$('price-source').textContent='Requests go through tkslopper; enter the prices of its configured aliases.';return}if(model===null){$('price-source').textContent='This provider is not priced per token on a public list; enter your plan’s effective prices.';return}$('price-source').textContent='Looking up the list price for '+model+'…';try{const {pricing}=await api('/v1/admin/model-pricing?model='+encodeURIComponent(model),{signal:AbortSignal.timeout(6000)});if(model!==pricedModel)return;if(!pricing){$('price-source').textContent='No public list price found for '+model+'. Enter your provider’s prices.';return}$('price-in').value=pricing.inputPerMillion;$('price-out').value=pricing.outputPerMillion;$('price-source').textContent='OpenRouter list price for '+pricing.name+' ('+pricing.id+').'}catch{if(model===pricedModel)$('price-source').textContent='Could not load list prices. Enter your provider’s prices.'}estimate()}
function estimate(){const values=['price-in','price-out','tokens-in','tokens-out','requests'].map(id=>$(id).valueAsNumber);if(values.some(x=>!Number.isFinite(x)||x<0)){['cost-request','cost-month','cost-year'].forEach(id=>$(id).textContent='–');return}const [priceIn,priceOut,tokensIn,tokensOut,requests]=values;const perRequest=(tokensIn*priceIn+tokensOut*priceOut)/1e6;$('cost-request').textContent=money(perRequest);$('cost-month').textContent=money(perRequest*requests);$('cost-year').textContent=money(perRequest*requests*12)}
$('cost-form').oninput=event=>{if(event.target.id==='requests')requestsEdited=true;estimate()};$('cost-form').onsubmit=event=>event.preventDefault();
$('sign-out').onclick=()=>{sessionStorage.removeItem('tapplet-admin-token');location.reload()};if(token)load().catch(()=>{sessionStorage.removeItem('tapplet-admin-token');token=''})
</script></body></html>`;
