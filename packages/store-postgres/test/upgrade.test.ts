import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { PG_MIGRATIONS, PostgresStore } from "../src/index.js";

/** A copy of the migrations folder holding only the first `n` migrations. */
function migrationsUpTo(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-pgmig-"));
  cpSync(PG_MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, n);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/** Rows as the pre-rename (bag-named) schema stored them. */
const OLD_ROWS = `
  INSERT INTO installs (bag, version, channel, updated_at) VALUES ('@acme/x', '1.0.0', 'latest', '2026-01-01');
  INSERT INTO traces (id, operation, bag, bag_version, scope, model, fired, attempts, ok, created_at)
    VALUES ('t1', 'op', '@acme/x', '1.0.0', 'acme', 'm', '[]', '[]', true, '2026-01-01');
  INSERT INTO eval_runs (id, bag, version, pass_rate, report, created_at)
    VALUES ('e1', '@acme/x', '1.0.0', 1, '{"bag":"@acme/x","version":"1.0.0","passRate":1,"cases":[]}', '2026-01-01');
  INSERT INTO mcp_connections (id, bag, server, scope, scope_id, credential, created_by, created_at)
    VALUES ('c1', '@acme/x', 'gh', 'org', 'acme', NULL, 'a', '2026-01-01');
  INSERT INTO mcp_pins (bag, version, server, tools, created_at) VALUES ('@acme/x', '1.0.0', 'gh', '[]', '2026-01-01');
`;

async function expectUpgraded(store: PostgresStore) {
  expect(await store.listInstalls("@acme/x")).toEqual([expect.objectContaining({ plugin: "@acme/x", channel: "latest" })]);
  expect(await store.getTrace("t1")).toMatchObject({ plugin: "@acme/x", pluginVersion: "1.0.0" });
  expect((await store.latestEvalRun("@acme/x", "1.0.0"))!.report).toMatchObject({ plugin: "@acme/x" });
  expect(await store.listConnections({ plugin: "@acme/x" })).toHaveLength(1);
  expect(await store.listPins("@acme/x", "1.0.0")).toHaveLength(1);
  // The renamed primary keys and unique index still enforce upserts.
  await store.setInstall("@acme/x", "1.0.0", "unpublished");
  expect(await store.listInstalls("@acme/x")).toHaveLength(1);
  await store.setPin({ plugin: "@acme/x", version: "1.0.0", server: "gh", tools: [] });
  expect(await store.listPins("@acme/x", "1.0.0")).toHaveLength(1);
  await store.putConnection({ plugin: "@acme/x", server: "gh", scope: "org", scopeId: "acme", credential: null, createdBy: "b" });
  expect(await store.listConnections({ plugin: "@acme/x" })).toHaveLength(1);
}

describe("Postgres upgrade from the bag-named schema", () => {
  it("PGlite: renames bag columns and constraints in place, keeping rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sb-pglite-"));
    const old = new PGlite(dataDir);
    await migratePglite(drizzlePglite(old), { migrationsFolder: migrationsUpTo(2) });
    await old.exec(OLD_ROWS);
    await old.close();

    const store = await PostgresStore.pglite(dataDir);
    try {
      await expectUpgraded(store);
    } finally {
      await store.close();
    }
  });

  const url = process.env.SADDLEBAGS_TEST_PG_URL;
  it.skipIf(!url)("Postgres server: same upgrade in a dedicated schema", async () => {
    const schema = `sb_upgrade_${process.pid}_${Date.now()}`;
    const client = postgres(url!, { onnotice: () => {}, connection: { search_path: schema } });
    await client.unsafe(`CREATE SCHEMA "${schema}"`);
    await migratePostgres(drizzlePostgres(client), { migrationsFolder: migrationsUpTo(2), migrationsSchema: schema });
    await client.unsafe(OLD_ROWS);
    await client.end();

    const store = await PostgresStore.connect(url!, { schema });
    try {
      await expectUpgraded(store);
    } finally {
      await store.close();
    }
  });
});
