import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptClassKey, encryptClassKey, handleAdminRequest } from "../src/admin";
import { FixtureModelProvider } from "../src/ai/fixtureProvider";
import { ModelProviderError } from "../src/ai/provider";
import type { ModelProvider } from "../src/ai/provider";
import type { AssetStore } from "../src/assets";
import {
  ClassAccessError,
  readTkslopperClassConfig,
  TkslopperClient,
  TkslopperModelProvider,
} from "../src/ai/tkslopper";
import type { TkslopperClassConfig } from "../src/ai/tkslopper";
import { createStudioApp } from "../src/app";
import { ownerHashFrom } from "../src/auth";
import { createClassInference } from "../src/classInference";
import type { StudioEnv } from "../src/env";
import type { ImageSafetyInspector } from "../src/imageSafety";
import { MemorySourceStore } from "../src/sourceStore";
import { D1StudioRepository } from "../src/storage/d1Repository";
import { MemoryStudioRepository } from "../src/storage/memoryRepository";

const GATEWAY = "https://gateway.tkslopper.test";
const ARTIFACT = "tapplet.artifact.v1";
const REVIEW = "tapplet.review.v1";
const IMAGE = "tapplet.image.v1";
const GROUP_KEY = "tkgk_class-key-secret-0123456789";
const adminToken = "admin-token-with-at-least-thirty-two-characters";
const encryptionSecret = "encryption-key-with-at-least-thirty-two-characters";
const brief = {
  level: "P5",
  subject: "Maths",
  learningObjective: "Fractions",
  studentAction: "Choose",
};
const artifactJson = JSON.stringify({ html: "<!doctype html><html><head></head><body>Hi</body></html>" });

// Class keys need only the gateway and aliases: no control plane, no service
// credential, and the fleet stays on the direct transport.
function env(values: Partial<StudioEnv> = {}): StudioEnv {
  return {
    AI_PROVIDER: "fixture",
    AI_MODEL: "fixture-v1",
    AI_BASE_URL: "https://models.example.test/v1",
    INFERENCE_TRANSPORT: "direct",
    TKSLOPPER_GATEWAY_URL: GATEWAY,
    TKSLOPPER_ARTIFACT_ALIAS: ARTIFACT,
    TKSLOPPER_REVIEW_ALIAS: REVIEW,
    TKSLOPPER_IMAGE_ALIAS: IMAGE,
    ADMIN_TOKEN: adminToken,
    ADMIN_ENCRYPTION_KEY: encryptionSecret,
    ...values,
  } as StudioEnv;
}

function classConfig(): TkslopperClassConfig {
  const result = readTkslopperClassConfig(env(), GROUP_KEY);
  if (!result.ok) throw new Error(result.reason);
  return result.config;
}

function completed(): Response {
  return Response.json(
    {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: artifactJson, annotations: [] }],
        },
      ],
    },
    { headers: { "x-tkslopper-request-id": "req_1" } },
  );
}

function denied(status: number): Response {
  return Response.json(
    { error: { message: "denied", type: "denied", code: "denied" } },
    { status },
  );
}

function recordingFetch(replies: Array<Response | (() => Response)>) {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const next = replies.shift();
    if (!next) throw new Error(`Unexpected request to ${request.url}`);
    return typeof next === "function" ? next() : next;
  });
  return { fetch: fetcher as unknown as typeof fetch, requests };
}

function models(ids: string[]): Response {
  return Response.json({ object: "list", data: ids.map((id) => ({ id })) });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tkslopper class keys", () => {
  it("configure without the control plane or service credential", () => {
    expect(readTkslopperClassConfig(env(), GROUP_KEY)).toMatchObject({
      ok: true,
      config: { groupKey: GROUP_KEY, artifactAlias: ARTIFACT, gateway: { url: GATEWAY } },
    });
    const invalid = readTkslopperClassConfig(env({ TKSLOPPER_GATEWAY_URL: "" }), "tksvc_wrong-kind-of-key");
    expect(invalid.ok).toBe(false);
    expect(invalid.ok ? "" : invalid.reason).toContain("tkgk_");
    expect(invalid.ok ? "" : invalid.reason).toContain("TKSLOPPER_GATEWAY_URL");
    expect(invalid.ok ? "" : invalid.reason).not.toContain("tksvc_wrong");
  });

  it("send the key as the gateway Bearer without a grant exchange", async () => {
    const recorded = recordingFetch([completed()]);
    const provider = new TkslopperModelProvider(classConfig(), { fetch: recorded.fetch });
    await expect(provider.generate(brief, [])).resolves.toEqual(JSON.parse(artifactJson));
    expect(recorded.requests.map((request) => request.url)).toEqual([`${GATEWAY}/v1/responses`]);
    expect(recorded.requests[0]?.headers.get("authorization")).toBe(`Bearer ${GROUP_KEY}`);
  });

  it.each([
    [402, "allowance"],
    [403, "unavailable"],
    [401, "unavailable"],
  ] as const)("map HTTP %i to a class %s denial without retrying", async (status, denial) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recorded = recordingFetch([denied(status)]);
    const provider = new TkslopperModelProvider(classConfig(), { fetch: recorded.fetch });
    const error = await provider.generate(brief, []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClassAccessError);
    expect((error as ClassAccessError).denial).toBe(denial);
    expect((error as ClassAccessError).retryable).toBe(false);
    expect(recorded.requests).toHaveLength(1);
  });

  it("probe the aliases a key may use", async () => {
    const recorded = recordingFetch([models([ARTIFACT, IMAGE, "other.v1"]), denied(401)]);
    const client = new TkslopperClient(classConfig(), { fetch: recorded.fetch });
    await expect(client.probeAliases()).resolves.toEqual({ status: 200, aliases: [ARTIFACT, IMAGE] });
    await expect(client.probeAliases()).resolves.toEqual({ status: 401, aliases: [] });
    expect(recorded.requests[0]?.headers.get("authorization")).toBe(`Bearer ${GROUP_KEY}`);
  });
});

describe("class inference", () => {
  const classCodeHash = "class-hash";

  it("uses the class key bound to its class row", async () => {
    const encrypted = await encryptClassKey(GROUP_KEY, encryptionSecret, classCodeHash);
    const recorded = recordingFetch([completed()]);
    vi.stubGlobal("fetch", recorded.fetch);
    const inference = await createClassInference(env(), { classCodeHash, ...encrypted });
    await inference.provider.generate(brief, []);
    expect(inference.provider.name).toBe(`tkslopper:${ARTIFACT}`);
    expect(recorded.requests[0]?.headers.get("authorization")).toBe(`Bearer ${GROUP_KEY}`);
  });

  it.each([
    ["a key copied to another class", {}, "other-class"],
    ["the fleet kill switch", { INFERENCE_TRANSPORT: "off" }, classCodeHash],
    ["a missing gateway", { TKSLOPPER_GATEWAY_URL: "" }, classCodeHash],
  ] as const)("fails closed for %s", async (_, values, rowHash) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const encrypted = await encryptClassKey(GROUP_KEY, encryptionSecret, classCodeHash);
    const inference = await createClassInference(env(values), { classCodeHash: rowHash, ...encrypted });
    await expect(inference.provider.generate(brief, [])).rejects.toBeInstanceOf(ModelProviderError);
    await expect(inference.imageSafety.inspect(new Uint8Array([1]), "image/jpeg")).resolves.toEqual({ status: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function sqliteD1(sqlite: DatabaseSync): D1Database {
  const statement = (query: string, values: Array<string | number | null> = []) => {
    const sql = query.replace(/\?\d+/g, "?");
    const ordered = [...query.matchAll(/\?(\d+)/g)].map((match) => values[Number(match[1]) - 1] ?? null);
    return {
      bind: (...bound: Array<string | number | null>) => statement(query, bound),
      first: async () => sqlite.prepare(sql).get(...ordered) ?? null,
      run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...ordered).changes) } }),
      all: async () => ({ results: sqlite.prepare(sql).all(...ordered) }),
    };
  };
  return {
    prepare: (query: string) => statement(query),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function classDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE class_codes(code_hash TEXT PRIMARY KEY,label TEXT NOT NULL,maximum_uses INTEGER NOT NULL,use_count INTEGER NOT NULL DEFAULT 0,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT,short_code_hash TEXT UNIQUE,allocation_id TEXT,inference_key_ciphertext TEXT,inference_key_iv TEXT,inference_key_hint TEXT);" +
      "CREATE TABLE generation_usage(owner_hash TEXT NOT NULL,usage_date TEXT NOT NULL,request_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_hash,usage_date));" +
      "CREATE TABLE device_classes(owner_hash TEXT PRIMARY KEY,class_code_hash TEXT NOT NULL,created_at TEXT NOT NULL);",
  );
  return { sqlite, database: sqliteD1(sqlite) };
}

const hashOf = (code: string) => createHash("sha256").update(`class-code:${code}`).digest("hex");

describe("class registration", () => {
  it("links a device to the canonical class only when its activation commits", async () => {
    const { sqlite, database } = classDatabase();
    sqlite
      .prepare("INSERT INTO class_codes(code_hash,short_code_hash,label,maximum_uses,expires_at,created_at,inference_key_ciphertext,inference_key_iv) VALUES(?,?,?,?,?,?,?,?)")
      .run("full", "short", "Class 1234", 5, "2099-01-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "cipher", "iv");
    const repository = new D1StudioRepository(database);
    const now = "2026-10-10T00:00:00.000Z";
    await expect(repository.consumeRegistration("short", now, "network-a", "2026-10-10", 1, "owner-a")).resolves.toBe("success");
    await expect(repository.consumeRegistration("full", now, "network-a", "2026-10-10", 1, "owner-b")).resolves.toBe("network-limit");
    await expect(repository.consumeRegistration("missing", now, "network-c", "2026-10-10", 1, "owner-c")).resolves.toBe("invalid-class-code");
    expect(sqlite.prepare("SELECT owner_hash,class_code_hash FROM device_classes").all()).toEqual([
      { owner_hash: "owner-a", class_code_hash: "full" },
    ]);
    await expect(repository.getClassInferenceKey("owner-a")).resolves.toEqual({ classCodeHash: "full", ciphertext: "cipher", iv: "iv" });
    await expect(repository.getClassInferenceKey("owner-b")).resolves.toBeNull();
    sqlite.prepare("UPDATE class_codes SET inference_key_iv=NULL").run();
    const incomplete = await repository.getClassInferenceKey("owner-a");
    expect(incomplete).toEqual({ classCodeHash: "full", ciphertext: "cipher", iv: "" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inference = await createClassInference(env(), incomplete!);
    await expect(inference.provider.generate(brief, [])).rejects.toBeInstanceOf(ModelProviderError);
    sqlite.prepare("UPDATE class_codes SET inference_key_ciphertext=NULL,inference_key_iv=NULL").run();
    await expect(repository.getClassInferenceKey("owner-a")).resolves.toBeNull();
    sqlite.close();
  });
});

describe("class-scoped API requests", () => {
  const config = {
    publicPlayerOrigin: "https://play.test",
    allowedOrigins: new Set(["https://studio.test"]),
    dailyGenerationLimit: 20,
    dailyNetworkGenerationLimit: 1_000,
    dailySafetyReviewLimit: 50,
    dailyNetworkSafetyReviewLimit: 1_000,
    dailyNetworkUploadLimit: 200,
    dailyNetworkUploadBytes: 200_000_000,
    dailyDraftCreationLimit: 50,
    dailyNetworkDraftCreationLimit: 500,
    maximumDraftsPerOwner: 100,
    dailyNetworkRegistrationLimit: 100,
    dailyNetworkClassCodeFailureLimit: 500,
    classCodeFailureLockout: 10,
    publicationTtlDays: 90,
    deviceTokenSigningSecret: "test-device-signing-secret-with-at-least-32-characters",
    seedImportToken: "test-seed-import-token",
  };
  const creationBrief = {
    creationBrief: "Create a Primary 5 fractions comparison activity.",
    brief: {
      learnerContext: "Primary 5 Mathematics",
      learningObjective: "Compare fractions with unlike denominators",
      studentAction: "Choose the larger fraction and check the feedback",
      feedback: "Explain each answer",
      classroomFit: "Five minutes independently",
    },
  };

  const classInspector: ImageSafetyInspector = {
    inspect: async () => ({ status: "unavailable" as const }),
  };

  function setup(
    classProvider: (ownerHash: string) => ModelProvider | null,
    options: { provider?: ModelProvider; assets?: AssetStore } = {},
  ) {
    const repository = new MemoryStudioRepository();
    repository.classCodes.set(hashOf("123456"), { maximumUses: 5, uses: 0, expiresAt: "2099-01-01T00:00:00Z" });
    const app = createStudioApp({
      repository,
      provider: options.provider ?? new FixtureModelProvider(),
      ...(options.assets ? { assets: options.assets } : {}),
      classInference: async (ownerHash) => {
        const provider = classProvider(ownerHash);
        return provider ? { provider, imageSafety: classInspector } : null;
      },
      config,
      sources: new MemorySourceStore(),
      now: () => new Date("2026-10-10T00:00:00Z"),
    });
    const register = async () => {
      const response = await app.fetch(
        new Request("https://api.test/v1/devices/register", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
          body: JSON.stringify({ accessCode: "123456" }),
        }),
      );
      expect(response.status).toBe(201);
      return ((await response.json()) as { token: string }).token;
    };
    const send = (token: string, path: string, body?: unknown) =>
      app.fetch(
        new Request(`https://api.test${path}`, {
          method: "POST",
          headers: {
            "x-device-token": token,
            "cf-connecting-ip": "192.0.2.1",
            origin: "https://studio.test",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const generate = (token: string) => send(token, "/v1/artifacts/generate", creationBrief);
    return { repository, register, generate, send };
  }

  it("records the joined class and generates with the class provider", async () => {
    const owners: string[] = [];
    const classProvider = Object.assign(new FixtureModelProvider(), { name: "tkslopper:class" });
    const { repository, register, generate } = setup((ownerHash) => {
      owners.push(ownerHash);
      return repository.deviceClasses.get(ownerHash) === hashOf("123456") ? classProvider : null;
    });
    const token = await register();
    const ownerHash = await ownerHashFrom(
      new Request("https://api.test", { headers: { "x-device-token": token } }),
      config.deviceTokenSigningSecret,
    );
    expect(repository.deviceClasses.get(ownerHash)).toBe(hashOf("123456"));
    const response = await generate(token);
    expect(response.status).toBe(201);
    expect(owners).toEqual([ownerHash]);
    const body = (await response.json()) as { artifact: { id: string } };
    const artifact = await repository.getArtifact(body.artifact.id, ownerHash);
    expect(repository.revisions.get(artifact!.headRevisionId)?.modelVersion).toBe("tkslopper:class");
  });

  it("revises with the class provider and keeps class review advisory without fleet fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fleet = Object.assign(new FixtureModelProvider(), { name: "fleet" });
    const fleetModerate = vi.spyOn(fleet, "moderate");
    const classProvider = Object.assign(new FixtureModelProvider(), {
      name: "tkslopper:class",
      moderate: () => Promise.reject(new ClassAccessError("allowance", 402)),
    });
    const put = vi.fn().mockResolvedValue({
      id: "asset-1",
      ownerHash: "owner",
      objectKey: "assets/owner/asset-1.jpg",
      contentType: "image/jpeg",
      byteLength: 3,
      width: 1,
      height: 1,
      sha256: "hash",
      alternativeText: "A diagram",
      decorative: false,
      createdAt: "2026-10-10T00:00:00Z",
      warnings: [],
    });
    const { repository, register, generate, send } = setup(() => classProvider, {
      provider: fleet,
      assets: { put } as unknown as AssetStore,
    });
    const token = await register();
    const first = (await (await generate(token)).json()) as {
      artifact: { id: string };
      headRevision: { id: string };
    };

    const revised = await send(token, `/v1/artifacts/${first.artifact.id}/revisions`, {
      instruction: "Use a number line",
      expectedHeadRevisionId: first.headRevision.id,
    });
    expect(revised.status).toBe(201);
    const second = (await revised.json()) as { headRevision: { id: string } };
    expect(repository.revisions.get(second.headRevision.id)?.modelVersion).toBe("tkslopper:class");

    const published = await send(token, `/v1/artifacts/${first.artifact.id}/publish`, {
      expectedHeadRevisionId: second.headRevision.id,
    });
    expect(published.status).toBe(201);
    expect(((await published.json()) as { warnings: Array<{ code: string }> }).warnings).toContainEqual(
      expect.objectContaining({ code: "AI_CONTENT_REVIEW_UNAVAILABLE" }),
    );
    expect(fleetModerate).not.toHaveBeenCalled();

    expect((await send(token, "/v1/assets")).status).toBe(201);
    expect(put.mock.calls[0]?.[1]).toMatchObject({ imageSafety: classInspector });
  });

  it.each([
    ["allowance", 429, "CLASS_AI_ALLOWANCE_REACHED"],
    ["unavailable", 403, "CLASS_AI_UNAVAILABLE"],
  ] as const)("explains a class %s denial to the teacher", async (denial, status, code) => {
    const failing = Object.assign(new FixtureModelProvider(), {
      generate: () => Promise.reject(new ClassAccessError(denial, denial === "allowance" ? 402 : 403)),
    });
    const { register, generate } = setup(() => failing);
    const response = await generate(await register());
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
  });
});

describe("class key administration", () => {
  function adminRequest(path: string, body: unknown) {
    return new Request(`https://api.test${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function seeded() {
    const { sqlite, database } = classDatabase();
    sqlite
      .prepare("INSERT INTO class_codes(code_hash,short_code_hash,label,maximum_uses,expires_at,created_at) VALUES(?,?,?,?,?,?)")
      .run(hashOf("1234ABCDEFGH"), hashOf("CDEFGH"), "Class 1234", 30, "2099-01-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    return { sqlite, database };
  }

  it("attaches a verified key by short code, storing only ciphertext and a hint", async () => {
    const { sqlite, database } = seeded();
    const recorded = recordingFetch([models([ARTIFACT, REVIEW, IMAGE])]);
    vi.stubGlobal("fetch", recorded.fetch);
    const response = await handleAdminRequest(
      adminRequest("/v1/admin/class-codes/key", { code: "cdefgh", classKey: GROUP_KEY }),
      env({ DB: database }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ label: "Class 1234", keyHint: "6789" });
    expect(recorded.requests[0]?.url).toBe(`${GATEWAY}/v1/models`);
    const row = sqlite.prepare("SELECT * FROM class_codes").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(GROUP_KEY);
    await expect(
      decryptClassKey(row.inference_key_ciphertext!, row.inference_key_iv!, encryptionSecret, hashOf("1234ABCDEFGH")),
    ).resolves.toBe(GROUP_KEY);

    const removed = await handleAdminRequest(
      adminRequest("/v1/admin/class-codes/key", { code: "1234-ABCD-EFGH", classKey: null }),
      env({ DB: database }),
    );
    expect(await removed?.json()).toEqual({ label: "Class 1234", keyHint: null });
    expect(sqlite.prepare("SELECT inference_key_ciphertext,inference_key_hint FROM class_codes").get()).toEqual({
      inference_key_ciphertext: null,
      inference_key_hint: null,
    });
    sqlite.close();
  });

  it.each([
    ["an unknown key", [denied(401)], 422, "INVALID_CLASS_KEY"],
    ["a key without Tapplet's aliases", [models([ARTIFACT])], 422, "CLASS_KEY_ALIASES_MISSING"],
  ] as const)("rejects %s", async (_, replies, status, code) => {
    const { sqlite, database } = seeded();
    vi.stubGlobal("fetch", recordingFetch([...replies]).fetch);
    const response = await handleAdminRequest(
      adminRequest("/v1/admin/class-codes/key", { code: "CDEFGH", classKey: GROUP_KEY }),
      env({ DB: database }),
    );
    expect(response?.status).toBe(status);
    expect(((await response?.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(sqlite.prepare("SELECT inference_key_ciphertext FROM class_codes").get()).toEqual({ inference_key_ciphertext: null });
    sqlite.close();
  });

  it("saves a key for a class tkslopper is not serving yet, with a warning", async () => {
    const { sqlite, database } = seeded();
    vi.stubGlobal("fetch", recordingFetch([denied(403)]).fetch);
    const response = await handleAdminRequest(
      adminRequest("/v1/admin/class-codes/key", { code: "CDEFGH", classKey: GROUP_KEY }),
      env({ DB: database }),
    );
    expect(response?.status).toBe(200);
    expect(((await response?.json()) as { warning: string }).warning).toContain("paused");
    expect(sqlite.prepare("SELECT inference_key_hint FROM class_codes").get()).toEqual({ inference_key_hint: "6789" });
    sqlite.close();
  });

  it("mints a code with a key bound to the new class row", async () => {
    const { sqlite, database } = classDatabase();
    vi.stubGlobal("fetch", recordingFetch([models([ARTIFACT, REVIEW, IMAGE])]).fetch);
    const response = await handleAdminRequest(
      adminRequest("/v1/admin/class-codes", {
        classNumber: "0042",
        maximumUses: 30,
        expiresAt: "2099-08-24T00:00:00.000Z",
        classKey: GROUP_KEY,
      }),
      env({ DB: database }),
    );
    expect(response?.status).toBe(201);
    const body = (await response?.json()) as { code: string; keyHint: string };
    expect(body.keyHint).toBe("6789");
    const row = sqlite.prepare("SELECT * FROM class_codes WHERE code_hash=?").get(hashOf(body.code)) as Record<string, string>;
    await expect(
      decryptClassKey(row.inference_key_ciphertext!, row.inference_key_iv!, encryptionSecret, hashOf(body.code)),
    ).resolves.toBe(GROUP_KEY);
    sqlite.close();
  });
});
