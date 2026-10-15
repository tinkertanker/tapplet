// A minimal D1 stand-in backed by node:sqlite so storage tests exercise the
// real SQL, constraints and triggers instead of asserting on query text.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

export function sqliteD1Database(
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

export function migratedDatabase() {
  const directory = new URL("../migrations/", import.meta.url);
  return sqliteD1Database(
    readdirSync(directory)
      .sort()
      .map((file) => readFileSync(new URL(file, directory), "utf8"))
      .join("\n"),
  );
}
