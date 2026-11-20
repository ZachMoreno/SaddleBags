import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { DrizzleStore } from "./drizzle-store.js";
import * as schema from "./schema-sqlite.js";

/** drizzle-kit output for the SQLite schema, shipped with the package. */
export const SQLITE_MIGRATIONS = fileURLToPath(new URL("../../drizzle/sqlite", import.meta.url));

/**
 * The default store: SQLite via Node's built-in `node:sqlite` (no native
 * dependencies), driven by Drizzle through its sqlite-proxy driver.
 * Migrations run synchronously on open, so the constructor stays synchronous.
 */
export class SqliteStore extends DrizzleStore {
  private sqlite: DatabaseSync;

  /** `path` defaults to an in-memory database. */
  constructor(path = ":memory:") {
    const sqlite = new DatabaseSync(path);
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    migrateSqlite(sqlite, SQLITE_MIGRATIONS);

    const db = drizzle(async (sql, params, method) => {
      const stmt = sqlite.prepare(sql);
      const args = params as SQLInputValue[];
      if (method === "run") {
        stmt.run(...args);
        return { rows: [] };
      }
      if (method === "get") {
        const row = stmt.get(...args) as Record<string, unknown> | undefined;
        return { rows: row ? Object.values(row) : (undefined as unknown as unknown[]) };
      }
      return { rows: (stmt.all(...args) as Record<string, unknown>[]).map((r) => Object.values(r)) };
    });

    super(db, schema);
    this.sqlite = sqlite;
  }

  async close(): Promise<void> {
    this.sqlite.close();
  }
}

/** Apply pending drizzle-kit migrations, recording them as Drizzle's own migrator does. */
export function migrateSqlite(sqlite: DatabaseSync, migrationsFolder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  const last = sqlite.prepare(`SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`).get() as
    | { created_at: number }
    | undefined;
  const pending = migrations.filter((m) => !last || Number(last.created_at) < m.folderMillis);
  if (!pending.length) return;

  sqlite.exec("BEGIN");
  try {
    for (const m of pending) {
      for (const stmt of m.sql) if (stmt.trim()) sqlite.exec(stmt);
      sqlite.prepare(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`).run(m.hash, m.folderMillis);
    }
    sqlite.exec("COMMIT");
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
}
