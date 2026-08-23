import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProvider } from "../src/ai/createProvider";
import {
  decryptAdminApiKey,
  encryptAdminApiKey,
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
  const database = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first() {
          return row;
        },
        async run() {
          if (query.startsWith("INSERT INTO admin_model_settings")) {
            row = {
              provider: values[0] as string,
              model: values[1] as string,
              base_url: values[2] as string,
              api_key_ciphertext: values[3] as string | null,
              api_key_iv: values[4] as string | null,
              updated_at: values[5] as string,
            };
          } else if (query.startsWith("DELETE FROM admin_model_settings")) {
            row = null;
          } else if (query.startsWith("INSERT INTO class_codes")) {
            classCodeValues = values;
          }
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { database, row: () => row, classCodeValues: () => classCodeValues };
}

describe("web operations panel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encrypts provider keys with authenticated encryption", async () => {
    const first = await encryptAdminApiKey("provider-secret", encryptionSecret);
    const second = await encryptAdminApiKey("provider-secret", encryptionSecret);

    expect(first.ciphertext).not.toBe("provider-secret");
    expect(first).not.toEqual(second);
    await expect(
      decryptAdminApiKey(first.ciphertext, first.iv, encryptionSecret),
    ).resolves.toBe("provider-secret");
    await expect(
      decryptAdminApiKey(
        first.ciphertext,
        first.iv,
        "a-different-encryption-key-with-thirty-two-characters",
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

  it("stores only an encrypted API key and uses the selected model", async () => {
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
          provider: "openai-compatible",
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
      name: "openai-compatible:test-model",
    });
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
    expect(body.code).toMatch(/^0042-[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/);
    const compactCode = body.code.replaceAll("-", "");
    expect(classCodeValues()).toEqual([
      createHash("sha256").update(`class-code:${compactCode}`).digest("hex"),
      "Class 0042",
      30,
      expiresAt,
      expect.any(String),
    ]);
    expect(JSON.stringify(classCodeValues())).not.toContain(compactCode);
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
