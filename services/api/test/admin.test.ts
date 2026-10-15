import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProvider } from "../src/ai/createProvider";
import {
  createConfiguredModelProvider,
  decryptAdminApiKey,
  encryptAdminApiKey,
  belongsToAdminHostSite,
  handleAdminRequest,
  loadConfiguredModelProvider,
} from "../src/admin";
import type { StudioEnv } from "../src/env";

const adminToken = "admin-token-with-at-least-thirty-two-characters";
const encryptionSecret = "encryption-key-with-at-least-thirty-two-characters";

interface SettingsRow {
  provider: string;
  model: string;
  base_url: string;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  updated_at: string;
}

function environment(database: D1Database, configured = true): StudioEnv {
  return {
    DB: database,
    AI_PROVIDER: "fixture",
    AI_MODEL: "fixture-v1",
    AI_BASE_URL: "https://models.example.test/v1",
    ...(configured
      ? {
          ADMIN_TOKEN: adminToken,
          ADMIN_ENCRYPTION_KEY: encryptionSecret,
        }
      : {}),
  } as StudioEnv;
}

function settingsDatabase() {
  let row: SettingsRow | null = null;
  let classCodeValues: unknown[] | null = null;
  let settingsReads = 0;
  const database = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first() {
          settingsReads += 1;
          return row;
        },
        async run() {
          if (query.startsWith("INSERT INTO admin_model_settings")) {
            const preserveApiKey = values[6] === 1 &&
              row?.provider === values[0] && row?.base_url === values[2];
            row = {
              provider: values[0] as string,
              model: values[1] as string,
              base_url: values[2] as string,
              api_key_ciphertext: preserveApiKey
                ? row?.api_key_ciphertext ?? null
                : values[3] as string | null,
              api_key_iv: preserveApiKey
                ? row?.api_key_iv ?? null
                : values[4] as string | null,
              updated_at: values[5] as string,
            };
          } else if (query.startsWith("DELETE FROM admin_model_settings")) {
            row = null;
          } else if (query.startsWith("INSERT INTO class_codes")) {
            classCodeValues = values;
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return {
    database,
    row: () => row,
    classCodeValues: () => classCodeValues,
    settingsReads: () => settingsReads,
  };
}

describe("web operations panel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("migrates existing settings unchanged and permits Anthropic without weakening key constraints", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readFileSync(new URL("../migrations/0011_admin_settings.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO admin_model_settings VALUES(1,?,?,?,?,?,?)").run(
        "openai-compatible", "gpt-4.1", "https://api.openai.com/v1", "encrypted", "iv", "original-date",
      );
      const saved = db.prepare("SELECT * FROM admin_model_settings").get();
      db.exec(readFileSync(new URL("../migrations/0012_anthropic_provider.sql", import.meta.url), "utf8"));
      expect(db.prepare("SELECT * FROM admin_model_settings").get()).toEqual(saved);
      db.exec("UPDATE admin_model_settings SET provider='anthropic',model='claude-haiku-5-5'");
      expect(db.prepare("SELECT provider FROM admin_model_settings").get()?.provider).toBe("anthropic");
      expect(() => db.exec("UPDATE admin_model_settings SET api_key_iv=NULL")).toThrow();
      expect(() => db.exec("UPDATE admin_model_settings SET provider='unknown'")).toThrow();
    } finally { db.close(); }
  });

  it("encrypts provider keys with authenticated encryption", async () => {
    const first = await encryptAdminApiKey(
      "provider-secret",
      encryptionSecret,
      "openai-compatible",
      "https://models.example.test/v1",
    );
    const second = await encryptAdminApiKey(
      "provider-secret",
      encryptionSecret,
      "openai-compatible",
      "https://models.example.test/v1",
    );

    expect(first.ciphertext).not.toBe("provider-secret");
    expect(first).not.toEqual(second);
    await expect(
      decryptAdminApiKey(
        first.ciphertext,
        first.iv,
        encryptionSecret,
        "openai-compatible",
        "https://models.example.test/v1",
      ),
    ).resolves.toBe("provider-secret");
    await expect(
      decryptAdminApiKey(
        first.ciphertext,
        first.iv,
        "a-different-encryption-key-with-thirty-two-characters",
        "openai-compatible",
        "https://models.example.test/v1",
      ),
    ).rejects.toBeDefined();
    await expect(
      decryptAdminApiKey(
        first.ciphertext,
        first.iv,
        encryptionSecret,
        "openrouter",
        "https://attacker.example.test/v1",
      ),
    ).rejects.toBeDefined();
  });

  it("hides the panel until admin secrets are configured and protects its API", async () => {
    const { database } = settingsDatabase();
    const hidden = await handleAdminRequest(
      new Request("https://api.test/admin"),
      environment(database, false),
    );
    expect(hidden?.status).toBe(404);

    const panel = await handleAdminRequest(
      new Request("https://api.test/admin"),
      environment(database),
    );
    expect(panel?.status).toBe(200);
    expect(panel?.headers.get("cache-control")).toContain("no-store");
    expect(panel?.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );

    const denied = await handleAdminRequest(
      new Request("https://api.test/v1/admin/overview", {
        headers: { authorization: "Bearer wrong-token" },
      }),
      environment(database),
    );
    expect(denied?.status).toBe(401);
  });

  it.each(["openai-compatible", "anthropic"])("stores only an encrypted API key and preserves the selected %s model", async (provider) => {
    const { database, row } = settingsDatabase();
    const env = environment(database);
    const response = await handleAdminRequest(
      new Request("https://api.test/v1/admin/model", {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider,
          model: "test-model",
          baseUrl: "https://models.example.test/v1/",
          apiKey: "provider-secret",
        }),
      }),
      env,
    );

    expect(response?.status).toBe(200);
    expect(JSON.stringify(await response?.json())).not.toContain("provider-secret");
    expect(row()?.api_key_ciphertext).not.toContain("provider-secret");
    expect(row()?.base_url).toBe("https://models.example.test/v1");
    await expect(loadConfiguredModelProvider(env)).resolves.toMatchObject({
      name: `${provider}:test-model`,
    });
  });

  it("gets public catalogue options without forwarding admin, managed, or provider credentials", async () => {
    const entry = { id: "catalogue-model", provider: "anthropic", display_name: "Catalogue model", tier: "balanced", is_default: true };
    const fetcher = vi.fn(async () => Response.json({ object: "list", version: 1, data: [entry] }));
    vi.stubGlobal("fetch", fetcher);
    const { database, settingsReads } = settingsDatabase();
    const env = { ...environment(database), TKSLOPPER_GATEWAY_URL: "https://gateway.test", TKSLOPPER_SERVICE_CREDENTIAL: "managed-secret", ANTHROPIC_API_KEY: "provider-secret" };
    const response = await handleAdminRequest(new Request("https://api.test/v1/admin/model-catalogue", {
      headers: { authorization: `Bearer ${adminToken}`, cookie: "private=session" },
    }), env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ source: "tkslopper", data: [entry] });
    expect(settingsReads()).toBe(0);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL("https://gateway.test/v1/model-catalogue"), {
      method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "manual", signal: expect.any(AbortSignal),
    });
  });

  it("requires a new key when its provider or endpoint changes", async () => {
    const { database, row } = settingsDatabase();
    const env = environment(database);
    const update = (provider: string, baseUrl: string, apiKey?: string) =>
      handleAdminRequest(
        new Request("https://api.test/v1/admin/model", {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ provider, model: "test-model", baseUrl, apiKey }),
        }),
        env,
      );

    expect((await update("openai-compatible", "https://first.example.test/v1"))?.status)
      .toBe(422);
    expect(row()).toBeNull();
    expect((await update("openai-compatible", "https://first.example.test/v1", "secret"))?.status)
      .toBe(200);
    expect(row()?.api_key_ciphertext).not.toBeNull();
    expect((await update("openrouter", "https://openrouter.ai/api/v1"))?.status).toBe(422);
    expect(row()?.api_key_ciphertext).not.toBeNull();
    expect((await update("openai-compatible", "https://first.example.test/v1", "secret"))?.status)
      .toBe(200);
    expect((await update("openai-compatible", "https://second.example.test/v1"))?.status)
      .toBe(422);
    expect(row()?.base_url).toBe("https://first.example.test/v1");
  });

  it("loads admin model settings only when the provider is used", async () => {
    const { database, settingsReads } = settingsDatabase();
    const provider = createConfiguredModelProvider(environment(database));

    expect(settingsReads()).toBe(0);
    await provider.generate(
      {
        level: "P5",
        subject: "Mathematics",
        learningObjective: "Compare fractions",
        studentAction: "Choose",
      },
      [],
    );
    expect(settingsReads()).toBe(1);
    expect(provider.name).toBe("fixture");
  });

  it("mints a class code while persisting only its hash", async () => {
    const { database, classCodeValues } = settingsDatabase();
    const expiresAt = "2099-08-24T00:00:00.000Z";
    const response = await handleAdminRequest(
      new Request("https://api.test/v1/admin/class-codes", {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ classNumber: "0042", maximumUses: 30, expiresAt }),
      }),
      environment(database),
    );

    expect(response?.status).toBe(201);
    expect(response?.headers.get("cache-control")).toContain("no-store");
    const body = (await response?.json()) as { code: string };
    expect(body.code).toMatch(/^\d{6}$/);
    const compactCode = body.code.replaceAll("-", "");
    expect(classCodeValues()).toEqual([
      createHash("sha256").update(`class-code:${compactCode}`).digest("hex"),
      "Class 0042",
      30,
      expiresAt,
      expect.any(String),
      null,
      null,
      null,
    ]);
    expect(JSON.stringify(classCodeValues())).not.toContain(compactCode);
  });

  it("allocates another code after a collision without changing the existing class", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE class_codes(code_hash TEXT PRIMARY KEY,label TEXT,maximum_uses INTEGER,use_count INTEGER DEFAULT 0,expires_at TEXT,created_at TEXT,inference_key_ciphertext TEXT,inference_key_iv TEXT,inference_key_hint TEXT)");
    let occupyFirstCandidate = true;
    const database = {
      prepare(query: string) {
        return {
          bind(...values: (string | number | null)[]) {
            return {
              async run() {
                if (occupyFirstCandidate) {
                  sqlite.prepare("INSERT INTO class_codes(code_hash,label,maximum_uses,use_count,expires_at,created_at) VALUES(?,?,?,?,?,?)").run(values[0]!, "Existing class", 9, 7, "2090-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
                  occupyFirstCandidate = false;
                }
                return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    try {
      const response = await handleAdminRequest(new Request("https://api.test/v1/admin/class-codes", {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ classNumber: "0042", maximumUses: 30, expiresAt: "2099-08-24T00:00:00.000Z" }),
      }), environment(database));
      expect(response?.status).toBe(201);
      const body = await response!.json() as { code: string };
      expect(sqlite.prepare("SELECT label,maximum_uses,use_count,expires_at FROM class_codes WHERE label='Existing class'").get()).toEqual({ label: "Existing class", maximum_uses: 9, use_count: 7, expires_at: "2090-01-01T00:00:00.000Z" });
      expect(sqlite.prepare("SELECT label FROM class_codes WHERE code_hash=?").get(createHash("sha256").update(`class-code:${body.code}`).digest("hex"))).toEqual({ label: "Class 0042" });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM class_codes").get()).toEqual({ count: 2 });
    } finally {
      sqlite.close();
    }
  });

  it("uses all fields from a generic admin provider override", async () => {
    const request = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify({ html: "test" }) } }],
      }),
    );
    vi.stubGlobal("fetch", request);
    const { database } = settingsDatabase();
    const provider = createModelProvider(environment(database), {
      provider: "openai-compatible",
      model: "override-model",
      baseUrl: "https://override.example.test/v1",
      apiKey: "override-key",
    });

    await provider.generate(
      {
        level: "P5",
        subject: "Mathematics",
        learningObjective: "Compare fractions",
        studentAction: "Choose",
      },
      [],
    );

    expect(provider.name).toBe("openai-compatible:override-model");
    expect(request).toHaveBeenCalledWith(
      "https://override.example.test/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer override-key",
        }),
      }),
    );
  });

  it("preserves the configured production provider without an admin override", async () => {
    const { database } = settingsDatabase();
    const env = environment(database, false);
    env.AI_PROVIDER = "opencode-go";
    env.AI_MODEL = "muse-spark-1.2-contributor";
    env.OPENCODE_API_KEY = "opencode-key";

    await expect(loadConfiguredModelProvider(env)).resolves.toMatchObject({
      name: "opencode-go:muse-spark-1.2-contributor",
    });
  });
});

describe("operations panel origin", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("redirects the panel to the canonical admin origin and keeps serving it there", async () => {
    const { database } = settingsDatabase();
    const env = { ...environment(database), ADMIN_ORIGIN: "https://tapplet.tk.sg" };
    const moved = await handleAdminRequest(new Request("https://api.workers.dev/admin/"), env);
    expect(moved?.status).toBe(308);
    expect(moved?.headers.get("location")).toBe("https://tapplet.tk.sg/admin");
    expect(moved?.headers.get("cache-control")).toContain("no-store");

    const panel = await handleAdminRequest(new Request("https://tapplet.tk.sg/admin"), env);
    expect(panel?.status).toBe(200);
    expect(await panel?.text()).toContain('id="cost-form"');

    const unset = await handleAdminRequest(new Request("https://api.workers.dev/admin"), environment(database));
    expect(unset?.status).toBe(200);

    const routedDev = await handleAdminRequest(new Request("http://tapplet.tk.sg/admin"), env);
    expect(routedDev?.status).toBe(200);
    const local = await handleAdminRequest(new Request("http://localhost:8787/admin"), env);
    expect(local?.status).toBe(200);
    const blank = await handleAdminRequest(new Request("https://api.workers.dev/admin"), { ...env, ADMIN_ORIGIN: "" });
    expect(blank?.status).toBe(200);
  });

  it("passes non-panel paths on the admin host back to the static site", () => {
    const { database } = settingsDatabase();
    const env = { ...environment(database), ADMIN_ORIGIN: "https://tapplet.tk.sg" };
    const check = (url: string, target: StudioEnv = env) => belongsToAdminHostSite(new Request(url), target);
    expect(check("https://tapplet.tk.sg/administrator")).toBe(true);
    expect(check("https://tapplet.tk.sg/admin?source=bookmark")).toBe(false);
    expect(check("https://tapplet.tk.sg/v1/admin/overview")).toBe(false);
    expect(check("https://api.workers.dev/administrator")).toBe(false);
    expect(check("https://tapplet.tk.sg/administrator", environment(database))).toBe(false);
  });

  it("prices the requested model from OpenRouter's public list without credentials", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [
      { id: "openai/gpt-6-luna:batch", name: "Batch", pricing: { prompt: "0.00000005", completion: "0.00000025" } },
      { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
    ] }));
    vi.stubGlobal("fetch", fetcher);
    const { database } = settingsDatabase();
    const env = { ...environment(database), OPENROUTER_API_KEY: "provider-secret" };
    const request = (model: string) => handleAdminRequest(new Request(`https://api.test/v1/admin/model-pricing?model=${encodeURIComponent(model)}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    }), env);

    const response = await request("gpt-6-luna");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ pricing: {
      source: "openrouter", id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", inputPerMillion: 0.1, outputPerMillion: 0.5,
    } });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://openrouter.ai/api/v1/models", expect.objectContaining({ credentials: "omit" }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("provider-secret");

    expect(await (await request("unknown-model"))?.json()).toEqual({ pricing: null });
    expect((await request(" "))?.status).toBe(400);
  });
});
