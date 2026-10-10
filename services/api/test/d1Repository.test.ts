import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CloudflareAssetStore } from "../src/assets";
import { D1StudioRepository } from "../src/storage/d1Repository";
import {
  CURATED_SEED_OWNER,
  type ArtifactRecord,
  type RevisionRecord,
} from "../src/storage/repository";

const revision: RevisionRecord = {
  id: "r2",
  artifactId: "a1",
  parentRevisionId: "r1",
  sourceHash: "hash",
  sourceBytes: 10,
  kind: "revision",
  instruction: "change",
  designCard: null,
  exemplars: [],
  modelVersion: "fixture",
  promptVersion: "v1",
  screenshotKey: null,
  createdAt: "2026-08-02T00:00:00Z",
};
const artifact: ArtifactRecord = {
  id: "a1",
  ownerHash: "owner-a",
  title: "Fractions",
  summary: "Compare fractions",
  subject: "Mathematics",
  level: "Primary 5",
  locale: "en-SG",
  learningObjective: "Compare fractions",
  tags: ["fractions"],
  creationBrief: "{}",
  generationBrief: "{}",
  headRevisionId: revision.id,
  remixedFromRevisionId: null,
  createdAt: revision.createdAt,
  updatedAt: revision.createdAt,
};

function sqliteD1Database(
  schema = "CREATE TABLE class_codes(code_hash TEXT PRIMARY KEY,label TEXT NOT NULL,maximum_uses INTEGER NOT NULL,use_count INTEGER NOT NULL DEFAULT 0,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT,short_code_hash TEXT UNIQUE);" +
    "CREATE TABLE generation_usage(owner_hash TEXT NOT NULL,usage_date TEXT NOT NULL,request_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_hash,usage_date));",
) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const database = {
    prepare(query: string) {
      const parameterIndexes = [...query.matchAll(/\?(\d+)/g)].map(
        (match) => Number(match[1]) - 1,
      );
      const sqliteQuery = query.replace(/\?\d+/g, "?");
      let values: Array<string | number | bigint | null> = [];
      const statement = {
        bind(...bound: unknown[]) {
          if (
            !bound.every(
              (value) =>
                value === null ||
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "bigint",
            )
          )
            throw new Error("Unsupported SQLite test binding");
          values = bound as Array<string | number | bigint | null>;
          return statement;
        },
        async run() {
          const positionalValues = parameterIndexes.length
            ? parameterIndexes.map((index) => {
                const value = values[index];
                if (value === undefined)
                  throw new Error("Missing SQLite test binding");
                return value;
              })
            : values;
          const prepared = sqlite.prepare(sqliteQuery),
            before = (
              sqlite.prepare("SELECT total_changes() changes").get() as {
                changes: number;
              }
            ).changes;
          const results = prepared.columns().length
            ? prepared.all(...positionalValues)
            : (prepared.run(...positionalValues), []);
          const after = (
            sqlite.prepare("SELECT total_changes() changes").get() as {
              changes: number;
            }
          ).changes;
          return { results, meta: { changes: after - before } };
        },
        async all() {
          return statement.run();
        },
        async first() {
          return (await statement.run()).results[0] ?? null;
        },
      };
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { database, sqlite };
}

function migratedDatabase() {
  const directory = new URL("../migrations/", import.meta.url);
  return sqliteD1Database(
    readdirSync(directory)
      .sort()
      .map((file) => readFileSync(new URL(file, directory), "utf8"))
      .join("\n"),
  );
}

describe("atomic storage admission with migrated SQLite", () => {
  it("returns expired screenshot references despite FK cascade changes", async () => {
    const { database, sqlite } = migratedDatabase();
    try {
      const repository = new D1StudioRepository(database);
      await repository.createArtifact({
        artifact,
        revision: {
          ...revision,
          parentRevisionId: null,
          screenshotKey: "screens/expired.jpg",
        },
        assetIds: [],
      });
      const before = sqlite.prepare("SELECT total_changes() n").get() as {
        n: number;
      };
      const references = await repository.deleteExpiredArtifacts(
        "2026-08-03",
        "2026-08-04",
      );
      const after = sqlite.prepare("SELECT total_changes() n").get() as {
        n: number;
      };
      expect(after.n - before.n).toBe(2);
      expect(sqlite.prepare("SELECT * FROM artifacts").all()).toEqual([]);
      expect(references).toEqual([{ screenshotKeys: ["screens/expired.jpg"] }]);
    } finally {
      sqlite.close();
    }
  });

  it("admits only the final artifact slot without partial revisions or references", async () => {
    const { database, sqlite } = migratedDatabase();
    try {
      const repository = new D1StudioRepository(database);
      sqlite
        .prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          "image",
          "owner-a",
          "image.jpg",
          "image/jpeg",
          1,
          1,
          1,
          "hash",
          null,
          1,
          revision.createdAt,
        );
      const input = (id: string) => ({
        artifact: { ...artifact, id, headRevisionId: `${id}-r` },
        revision: {
          ...revision,
          id: `${id}-r`,
          artifactId: id,
          parentRevisionId: null,
        },
        assetIds: ["image"],
      });
      for (let i = 0; i < 99; i++)
        await repository.createArtifact(input(`existing-${i}`));
      // Both callers have passed the same preflight check before either commits.
      expect(await repository.countArtifacts("owner-a")).toBe(99);
      expect(await repository.countArtifacts("owner-a")).toBe(99);
      const winner = await repository.createArtifact(input("winner"), 100);
      const loser = await repository.createArtifact(input("loser"), 100);
      for (const table of ["artifacts", "revisions", "revision_assets"])
        expect(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual(
          { n: 100 },
        );
      expect(winner).toBe(true);
      expect(loser).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it.each(["count", "bytes"])(
    "rejects concurrent image admission at the stored %s limit and deletes losing R2 object",
    async (limit) => {
      const { database, sqlite } = migratedDatabase();
      try {
        const jpeg = Uint8Array.from([
          255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8,
          1, 1, 0, 0, 63, 0, 0, 255, 217,
        ]);
        const insert = sqlite.prepare(
          "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        );
        for (let i = 0; i < (limit === "count" ? 49 : 1); i++)
          insert.run(
            `existing-${i}`,
            "owner-a",
            `existing-${i}.jpg`,
            "image/jpeg",
            limit === "count" ? 1 : 50_000_000 - jpeg.length,
            1,
            1,
            "hash",
            null,
            1,
            revision.createdAt,
          );
        const objects = new Set<string>();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const store = new CloudflareAssetStore(
          database,
          {
            async put(key: string) {
              objects.add(key);
              if (objects.size === 2) release();
              await gate;
            },
            async delete(key: string) {
              objects.delete(key);
            },
          } as unknown as R2Bucket,
          {
            async normalize() {
              return jpeg;
            },
          },
        );
        const upload = () =>
          store.put(
            new Request("https://api.test/v1/assets", {
              method: "POST",
              headers: {
                "content-type": "image/png",
                "x-image-width": "1",
                "x-image-height": "1",
                "x-image-decorative": "true",
              },
              body: Uint8Array.from([1, 2, 3]),
            }),
            {
              ownerHash: "owner-a",
              networkHash: "network-a",
              now: revision.createdAt,
              maximumNetworkCount: 100,
              maximumNetworkBytes: 10_000_000,
            },
          );
        const results = await Promise.allSettled([upload(), upload()]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.find((result) => result.status === "rejected"),
        ).toMatchObject({ reason: { code: "ASSET_STORAGE_LIMIT_REACHED" } });
        expect(objects.size).toBe(1);
        expect(sqlite.prepare("SELECT count(*) n FROM assets").get()).toEqual({
          n: limit === "count" ? 50 : 2,
        });
      } finally {
        sqlite.close();
      }
    },
  );
});

describe("D1StudioRepository publication listing", () => {
  it("loads every active publication for an owner in one query", async () => {
    const sql: string[] = [];
    const database = {
      prepare(text: string) {
        sql.push(text);
        const statement = {
          bind() {
            return statement;
          },
          all() {
            return Promise.resolve({
              results: [
                {
                  slug: "live-slug",
                  artifact_id: "a1",
                  revision_id: "r1",
                  owner_hash: "owner-a",
                  title: "Fractions",
                  source_hash: "hash",
                  created_at: revision.createdAt,
                  expires_at: "2026-09-01T00:00:00Z",
                  revoked_at: null,
                },
              ],
            });
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    await expect(
      new D1StudioRepository(database).listActivePublicationsForOwner("owner-a"),
    ).resolves.toEqual([
      {
        slug: "live-slug",
        artifactId: "a1",
        revisionId: "r1",
        ownerHash: "owner-a",
        title: "Fractions",
        sourceHash: "hash",
        createdAt: revision.createdAt,
        expiresAt: "2026-09-01T00:00:00Z",
        revokedAt: null,
      },
    ]);
    expect(sql[0]).toContain("owner_hash=?1 AND revoked_at IS NULL");
  });
});

describe("D1StudioRepository conditional revision writes", () => {
  it("uses one batch whose insert checks owner, expected head, and same-artifact parent", async () => {
    const sql: string[] = [];
    const database = {
      prepare(text: string) {
        sql.push(text);
        const statement = { bind: () => statement };
        return statement;
      },
      batch(statements: unknown[]) {
        expect(statements).toHaveLength(3);
        return Promise.resolve(
          statements.map(() => ({ meta: { changes: 1 } })),
        );
      },
    } as unknown as D1Database;
    const repository = new D1StudioRepository(database);
    await expect(
      repository.createRevision(revision, "owner-a", "r1", ["asset-1"]),
    ).resolves.toBe(true);
    expect(sql[0]).toContain("parent.artifact_id=a.id");
    expect(sql[0]).toContain("a.owner_hash=?14");
    expect(sql[0]).toContain("a.head_revision_id=?3");
    expect(sql[1]).toContain("WHERE EXISTS");
    expect(sql[2]).toContain("head_revision_id=?5");
  });

  it("returns false for a stale conditional insert without orphan revision assets", async () => {
    const database = {
      prepare() {
        const statement = { bind: () => statement };
        return statement;
      },
      batch() {
        return Promise.resolve([
          { meta: { changes: 0 } },
          { meta: { changes: 0 } },
          { meta: { changes: 0 } },
        ]);
      },
    } as unknown as D1Database;
    await expect(
      new D1StudioRepository(database).createRevision(
        revision,
        "owner-a",
        "r1",
        ["asset-1"],
      ),
    ).resolves.toBe(false);
  });

  it("rejects a mismatched parent before issuing SQL and does not swallow database failures", async () => {
    let prepared = false;
    const database = {
      prepare() {
        prepared = true;
        throw new Error("unexpected");
      },
    } as unknown as D1Database;
    await expect(
      new D1StudioRepository(database).createRevision(
        revision,
        "owner-a",
        "other",
        [],
      ),
    ).resolves.toBe(false);
    expect(prepared).toBe(false);

    const failing = {
      prepare() {
        const statement = { bind: () => statement };
        return statement;
      },
      batch() {
        return Promise.reject(new Error("D1 unavailable"));
      },
    } as unknown as D1Database;
    await expect(
      new D1StudioRepository(failing).createRevision(
        revision,
        "owner-a",
        "r1",
        [],
      ),
    ).rejects.toThrow("D1 unavailable");
  });

  it("publishes and updates retrieval in one guarded batch", async () => {
    const sql: string[] = [];
    const publication = {
      slug: "new-slug",
      artifact_id: artifact.id,
      revision_id: revision.id,
      owner_hash: artifact.ownerHash,
      title: artifact.title,
      source_hash: revision.sourceHash,
      created_at: revision.createdAt,
      expires_at: "2026-09-01T00:00:00Z",
      revoked_at: null,
    };
    const retrieval = {
      artifact_id: artifact.id,
      revision_id: revision.id,
      descriptor: "<!doctype html><html></html>",
      curated: 0,
      updated_at: revision.createdAt,
    };
    const database = {
      prepare(text: string) {
        sql.push(text);
        const statement = {
          bind: () => statement,
        };
        return statement;
      },
      batch(statements: unknown[]) {
        expect(statements).toHaveLength(2);
        return Promise.resolve([
          { meta: { changes: 1 }, results: [publication] },
          { meta: { changes: 4 }, results: [retrieval] },
        ]);
      },
    } as unknown as D1Database;

    await expect(
      new D1StudioRepository(database).publish(
        "new-slug",
        artifact,
        revision,
        "2026-09-01T00:00:00Z",
        revision.createdAt,
        "<!doctype html><html></html>",
      ),
    ).resolves.toMatchObject({
      slug: "new-slug",
      artifactId: artifact.id,
      revisionId: revision.id,
    });

    expect(sql[0]).toContain(
      "ON CONFLICT(artifact_id) WHERE revoked_at IS NULL",
    );
    expect(sql[0]).toContain("head_revision_id=?3");
    expect(sql[0]).toContain("publications.owner_hash=?4");
    expect(sql[0]).toContain("RETURNING *");
    expect(sql[1]).toContain("p.revision_id=?2 AND p.revoked_at IS NULL");
    expect(sql[1]).toContain("a.head_revision_id=?2");
    expect(sql[1]).toContain("RETURNING artifact_id,revision_id");
  });

  it("executes guarded publication and retrieval upserts with FTS triggers", async () => {
    const { database, sqlite } = sqliteD1Database(
      "CREATE TABLE artifacts(id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,title TEXT NOT NULL,head_revision_id TEXT NOT NULL);" +
        "CREATE TABLE revisions(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL);" +
        "CREATE TABLE publications(slug TEXT PRIMARY KEY,artifact_id TEXT NOT NULL,revision_id TEXT NOT NULL,owner_hash TEXT NOT NULL,title TEXT NOT NULL,source_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT);" +
        "CREATE UNIQUE INDEX publications_one_active ON publications(artifact_id) WHERE revoked_at IS NULL;" +
        "CREATE TABLE retrieval_entries(artifact_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,descriptor TEXT NOT NULL,curated INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);" +
        "CREATE VIRTUAL TABLE retrieval_fts USING fts5(artifact_id UNINDEXED,title,descriptor);" +
        "CREATE TRIGGER retrieval_ai AFTER INSERT ON retrieval_entries BEGIN INSERT INTO retrieval_fts(artifact_id,title,descriptor) SELECT new.artifact_id,title,new.descriptor FROM artifacts WHERE id=new.artifact_id; END;" +
        "CREATE TRIGGER retrieval_au AFTER UPDATE ON retrieval_entries BEGIN DELETE FROM retrieval_fts WHERE artifact_id=old.artifact_id; INSERT INTO retrieval_fts(artifact_id,title,descriptor) SELECT new.artifact_id,title,new.descriptor FROM artifacts WHERE id=new.artifact_id; END;",
    );
    sqlite
      .prepare(
        "INSERT INTO artifacts(id,owner_hash,title,head_revision_id) VALUES(?,?,?,?)",
      )
      .run(artifact.id, artifact.ownerHash, artifact.title, revision.id);
    sqlite
      .prepare("INSERT INTO revisions(id,artifact_id) VALUES(?,?)")
      .run(revision.id, artifact.id);
    const repository = new D1StudioRepository(database),
      descriptor = "<!doctype html><html></html>";

    await expect(
      repository.publish(
        "new-slug",
        artifact,
        revision,
        "2026-09-01T00:00:00Z",
        revision.createdAt,
        descriptor,
      ),
    ).resolves.toMatchObject({
      artifactId: artifact.id,
      revisionId: revision.id,
    });
    expect(
      sqlite
        .prepare("SELECT descriptor FROM retrieval_fts WHERE artifact_id=?")
        .get(artifact.id),
    ).toEqual({ descriptor });

    sqlite
      .prepare("UPDATE artifacts SET head_revision_id='competing-revision'")
      .run();
    await expect(
      repository.publish(
        "unused-slug",
        artifact,
        revision,
        "2026-10-01T00:00:00Z",
        "2026-08-03T00:00:00Z",
        "stale descriptor",
      ),
    ).resolves.toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT revision_id,descriptor FROM retrieval_entries WHERE artifact_id=?",
        )
        .get(artifact.id),
    ).toEqual({ revision_id: revision.id, descriptor });
  });

  it("rejects publish batches that did not return both guarded writes", async () => {
    const database = {
      prepare() {
        const statement = { bind: () => statement };
        return statement;
      },
      batch() {
        return Promise.resolve([
          { meta: { changes: 1 }, results: [] },
          { meta: { changes: 3 }, results: [] },
        ]);
      },
    } as unknown as D1Database;

    await expect(
      new D1StudioRepository(database).publish(
        "new-slug",
        artifact,
        revision,
        "2026-09-01T00:00:00Z",
        revision.createdAt,
        "<!doctype html><html></html>",
      ),
    ).resolves.toBeNull();
  });

  it("upserts curated seed metadata, revision, and retrieval atomically", async () => {
    const sql: string[] = [];
    const database = {
      prepare(text: string) {
        sql.push(text);
        const statement = { bind: () => statement };
        return statement;
      },
      batch(statements: unknown[]) {
        expect(statements).toHaveLength(3);
        return Promise.resolve(
          statements.map(() => ({ meta: { changes: 1 } })),
        );
      },
    } as unknown as D1Database;
    const seedArtifact = {
      ...artifact,
      id: "fraction-seed",
      ownerHash: CURATED_SEED_OWNER,
      headRevisionId: "fraction-seed-seed",
    };
    const seedRevision = {
      ...revision,
      id: "fraction-seed-seed",
      artifactId: seedArtifact.id,
      parentRevisionId: null,
      kind: "import" as const,
    };

    await new D1StudioRepository(database).upsertCuratedSeed({
      artifact: seedArtifact,
      revision: seedRevision,
      assetIds: [],
      descriptor: "fractions diagnostic",
    });

    expect(sql[0]).toContain("ON CONFLICT(id) DO UPDATE");
    expect(sql[0]).toContain("WHERE artifacts.owner_hash=?2");
    expect(sql[1]).toContain("revisions.kind='import'");
    expect(sql[2]).toContain("curated=1");
  });

  it("refreshes retrieval titles and excludes expired teacher publications", async () => {
    const sql: string[] = [];
    const database = {
      prepare(text: string) {
        sql.push(text);
        const statement = {
          bind: () => statement,
          first: () => Promise.resolve(null),
          all: () => Promise.resolve({ results: [] }),
        };
        return statement;
      },
      batch(statements: unknown[]) {
        expect(statements).toHaveLength(2);
        return Promise.resolve(
          statements.map(() => ({ meta: { changes: 1 } })),
        );
      },
    } as unknown as D1Database;
    const repository = new D1StudioRepository(database);

    await repository.updateArtifactMetadata(
      artifact.id,
      artifact.ownerHash,
      { ...artifact, title: "Decimal Quokka" },
      revision.createdAt,
    );
    await repository.isRevisionRetrievable(revision.id, revision.createdAt);
    await repository.searchRetrieval('"Quokka"', 10, revision.createdAt);

    expect(sql[1]).toContain("UPDATE retrieval_entries SET descriptor=");
    expect(sql[1]).toContain("design_card_json");
    expect(sql[3]).toContain("p.expires_at>?2");
    expect(sql[4]).toContain("p.expires_at>?3");
    expect(sql[3]).toContain("r.curated=1");
    expect(sql[4]).toContain("r.curated=1");
  });

  it("returns screenshot cleanup only for artifacts deleted after the expiry recheck", async () => {
    const sql: string[] = [];
    const database = {
      prepare(text: string) {
        sql.push(text);
        const statement = {
          bind: () => statement,
          all: () =>
            Promise.resolve({
              results: text.startsWith("WITH candidates")
                ? [
                    {
                      id: "expired",
                      owner_hash: "owner-a",
                      screenshot_key: "screens/expired.jpg",
                    },
                    {
                      id: "changed",
                      owner_hash: "owner-b",
                      screenshot_key: "screens/changed.jpg",
                    },
                  ]
                : [],
            }),
        };
        return statement;
      },
      batch(statements: unknown[]) {
        expect(statements).toHaveLength(2);
        return Promise.resolve([
          { meta: { changes: 2 }, results: [{ id: "expired" }] },
          { meta: { changes: 0 }, results: [] },
        ]);
      },
    } as unknown as D1Database;

    await expect(
      new D1StudioRepository(database).deleteExpiredArtifacts(
        "2026-01-01T00:00:00Z",
        "2026-08-02T00:00:00Z",
      ),
    ).resolves.toEqual([{ screenshotKeys: ["screens/expired.jpg"] }]);
    expect(sql[0]).toContain(`owner_hash<>?4`);
    expect(sql[1]).toContain("updated_at<?3");
    expect(sql[1]).toContain("p.expires_at>?4");
    expect(sql[1]).toContain("RETURNING id");
  });
});

describe("D1StudioRepository owner token versions", () => {
  it("defaults to zero and returns the bumped version", async () => {
    const results: Array<Record<string, number> | undefined> = [
      undefined,
      { token_version: 3 },
    ];
    const sql: string[] = [];
    const database = {
      prepare(text: string) {
        sql.push(text);
        const statement = {
          bind: () => statement,
          first: () => Promise.resolve(results.shift()),
        };
        return statement;
      },
    } as unknown as D1Database;
    const repository = new D1StudioRepository(database);
    await expect(repository.getOwnerTokenVersion("owner-a")).resolves.toBe(0);
    await expect(repository.bumpOwnerTokenVersion("owner-a")).resolves.toBe(3);
    expect(sql[1]).toContain("ON CONFLICT(owner_hash) DO UPDATE");
  });
});

describe("D1StudioRepository generation usage", () => {
  it("refunds one consumed unit without dropping below zero", async () => {
    const { database, sqlite } = sqliteD1Database();
    const repository = new D1StudioRepository(database);
    await expect(repository.consumeGeneration("generation:o", "2026-08-02", 1)).resolves.toBe(true);
    await expect(repository.consumeGeneration("generation:o", "2026-08-02", 1)).resolves.toBe(false);
    await repository.refundGeneration("generation:o", "2026-08-02");
    await repository.refundGeneration("generation:o", "2026-08-02");
    await repository.refundGeneration("generation:missing", "2026-08-02");
    expect(sqlite.prepare("SELECT owner_hash,request_count FROM generation_usage").all()).toEqual([
      { owner_hash: "generation:o", request_count: 0 },
    ]);
    await expect(repository.consumeGeneration("generation:o", "2026-08-02", 1)).resolves.toBe(true);
    sqlite.close();
  });
});

describe("D1StudioRepository registration transaction", () => {
  it("shares legacy suffix capacity and expiry while rolling back network-limited activations", async () => {
    const { database, sqlite } = sqliteD1Database();
    sqlite.prepare(
      "INSERT INTO class_codes(code_hash,short_code_hash,label,maximum_uses,use_count,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run("full", "suffix", "Legacy class", 3, 1, "2029-07-04T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    const repository = new D1StudioRepository(database);
    const now = "2026-10-09T00:00:00.000Z";
    await expect(repository.consumeRegistration("suffix", now, "network-a", "2026-10-09", 1)).resolves.toBe("success");
    await expect(repository.consumeRegistration("full", now, "network-a", "2026-10-09", 1)).resolves.toBe("network-limit");
    expect(sqlite.prepare("SELECT use_count,last_used_at FROM class_codes").get()).toEqual({ use_count: 2, last_used_at: now });
    await expect(repository.consumeRegistration("full", now, "network-b", "2026-10-09", 1)).resolves.toBe("success");
    await expect(repository.consumeRegistration("suffix", now, "network-c", "2026-10-09", 1)).resolves.toBe("invalid-class-code");
    sqlite.prepare("UPDATE class_codes SET use_count=0").run();
    await expect(repository.consumeRegistration("suffix", "2029-07-04T00:00:00.000Z", "network-c", "2029-07-04", 1)).resolves.toBe("invalid-class-code");
    expect(sqlite.prepare("SELECT COUNT(*) AS rows,SUM(request_count) AS uses FROM generation_usage").get()).toEqual({ rows: 2, uses: 2 });
    sqlite.close();
  });

  it("spends both counters on success and restores class state at the network limit", async () => {
    const { database, sqlite } = sqliteD1Database();
    sqlite
      .prepare(
        "INSERT INTO class_codes(code_hash,label,maximum_uses,expires_at,created_at,last_used_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        "valid",
        "Class 1234",
        2,
        "2026-09-01T00:00:00Z",
        "2026-08-01T00:00:00Z",
        "2026-08-01T01:00:00Z",
      );
    const repository = new D1StudioRepository(database);

    await expect(
      repository.consumeRegistration(
        "valid",
        "2026-08-20T00:00:00Z",
        "registration:network",
        "2026-08-20",
        1,
      ),
    ).resolves.toBe("success");
    await expect(
      repository.consumeRegistration(
        "valid",
        "2026-08-20T00:01:00Z",
        "registration:network",
        "2026-08-20",
        1,
      ),
    ).resolves.toBe("network-limit");
    await expect(
      repository.consumeRegistration(
        "missing",
        "2026-08-20T00:02:00Z",
        "registration:other-network",
        "2026-08-20",
        1,
      ),
    ).resolves.toBe("invalid-class-code");

    expect(
      sqlite
        .prepare(
          "SELECT use_count,last_used_at FROM class_codes WHERE code_hash='valid'",
        )
        .get(),
    ).toEqual({
      use_count: 1,
      last_used_at: "2026-08-20T00:00:00Z",
    });
    expect(
      sqlite.prepare("SELECT owner_hash,request_count FROM generation_usage").all(),
    ).toEqual([
      { owner_hash: "registration:network", request_count: 1 },
    ]);
  });
});
