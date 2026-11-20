import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SQLITE_MIGRATIONS, SqliteStore, migrateSqlite } from "../src/index.js";

/** A copy of the migrations folder holding only the first `n` migrations. */
function migrationsUpTo(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-mig-"));
  cpSync(SQLITE_MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, n);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("SQLite upgrade from the bag-named schema", () => {
  it("renames bag columns to plugin in place, keeping existing rows", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sb-up-")), "old.db");

    // A database as the pre-rename code left it (migrations 0000 and 0001).
    const old = new DatabaseSync(path);
    migrateSqlite(old, migrationsUpTo(2));
    old.exec(`
      INSERT INTO installs (bag, version, channel, updated_at) VALUES ('@acme/x', '1.0.0', 'latest', '2026-01-01');
      INSERT INTO traces (id, operation, bag, bag_version, scope, model, fired, attempts, ok, created_at)
        VALUES ('t1', 'op', '@acme/x', '1.0.0', 'acme', 'm', '[]', '[]', 1, '2026-01-01');
      INSERT INTO eval_runs (id, bag, version, pass_rate, report, created_at)
        VALUES ('e1', '@acme/x', '1.0.0', 1, '{"bag":"@acme/x","version":"1.0.0","passRate":1,"cases":[]}', '2026-01-01');
      INSERT INTO mcp_connections (id, bag, server, scope, scope_id, credential, created_by, created_at)
        VALUES ('c1', '@acme/x', 'gh', 'org', 'acme', NULL, 'a', '2026-01-01');
      INSERT INTO mcp_pins (bag, version, server, tools, created_at) VALUES ('@acme/x', '1.0.0', 'gh', '[]', '2026-01-01');
    `);
    old.close();

    // The new code opens it and applies 0002.
    const store = new SqliteStore(path);
    expect(await store.listInstalls("@acme/x")).toEqual([expect.objectContaining({ plugin: "@acme/x", channel: "latest" })]);
    expect(await store.getTrace("t1")).toMatchObject({ plugin: "@acme/x", pluginVersion: "1.0.0" });
    const run = await store.latestEvalRun("@acme/x", "1.0.0");
    expect(run).toMatchObject({ plugin: "@acme/x", passRate: 1 });
    expect(run!.report).toEqual({ plugin: "@acme/x", version: "1.0.0", passRate: 1, cases: [] }); // old JSON upgraded
    expect(await store.listConnections({ plugin: "@acme/x" })).toHaveLength(1);
    expect(await store.listPins("@acme/x", "1.0.0")).toHaveLength(1);

    // And it keeps working: the unique index and composite keys now use the renamed columns.
    await store.putConnection({ plugin: "@acme/x", server: "gh", scope: "org", scopeId: "acme", credential: null, createdBy: "b" });
    expect(await store.listConnections({ plugin: "@acme/x" })).toHaveLength(1);
    await store.setInstall("@acme/x", "1.0.0", "unpublished");
    expect((await store.listInstalls("@acme/x"))[0]!.channel).toBe("unpublished");
    await store.close();
  });
});
