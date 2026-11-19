import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.js";
import { storeContract } from "../src/testing/store-contract.js";

storeContract("SqliteStore (in-memory)", () => new SqliteStore());

describe("SqliteStore on disk", () => {
  it("persists across reopen and doesn't re-run migrations", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "sb-db-")), "saddlebags.db");
    const a = new SqliteStore(path);
    await a.putMemory({ scope: "org", scopeId: "acme", key: "k", value: "v" });
    await a.close();

    const b = new SqliteStore(path);
    expect((await b.listMemory("org", "acme"))[0]!.value).toBe("v");
    await b.close();
  });
});
