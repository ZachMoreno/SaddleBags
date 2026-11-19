import { fileURLToPath } from "node:url";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { DrizzleStore, type StoreTables } from "@saddlebags/core";
import * as schema from "./schema.js";

export { schema };

/** drizzle-kit output for the Postgres schema, shipped with the package. */
export const PG_MIGRATIONS = fileURLToPath(new URL("../drizzle/pg", import.meta.url));

/**
 * Postgres store for teams and production. It shares DrizzleStore's query
 * logic with the SQLite store: the query-builder calls it uses have the same
 * shape in both dialects, and the shared contract tests check that this holds.
 */
export class PostgresStore extends DrizzleStore {
  private constructor(
    db: unknown,
    private onClose: () => Promise<void>,
  ) {
    super(db as SqliteRemoteDatabase, schema as unknown as StoreTables);
  }

  /**
   * Connect with a Postgres URL and apply pending migrations.
   *
   * `schema` (default `public`) holds both the tables and the migration
   * journal, so several installs can share one database in separate schemas.
   */
  static async connect(
    url: string,
    opts: { schema?: string; migrate?: boolean } = {},
  ): Promise<PostgresStore> {
    const pgSchema = opts.schema ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(pgSchema)) throw new Error(`Invalid Postgres schema name "${pgSchema}"`);
    const client = postgres(url, { onnotice: () => {}, connection: { search_path: pgSchema } });
    const db = drizzlePostgres(client, { schema });
    if (opts.migrate !== false) {
      await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${pgSchema}"`);
      await migratePostgres(db, { migrationsFolder: PG_MIGRATIONS, migrationsSchema: pgSchema });
    }
    return new PostgresStore(db, () => client.end());
  }

  /**
   * In-process Postgres via PGlite, for tests and local tooling. Requires the
   * optional peer dependency `@electric-sql/pglite`.
   */
  static async pglite(dataDir?: string): Promise<PostgresStore> {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite(dataDir);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: PG_MIGRATIONS });
    return new PostgresStore(db, () => client.close());
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}
