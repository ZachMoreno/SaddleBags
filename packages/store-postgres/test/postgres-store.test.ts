import { storeContract } from "@saddlebags/core/testing";
import { PostgresStore } from "../src/index.js";

// Always runs: in-process Postgres (PGlite).
storeContract("PostgresStore (PGlite)", () => PostgresStore.pglite());

// Runs against a real server when SADDLEBAGS_TEST_PG_URL is set. Each test gets
// a fresh schema so runs don't interfere.
const url = process.env.SADDLEBAGS_TEST_PG_URL;
if (url) {
  let n = 0;
  storeContract("PostgresStore (server)", () =>
    PostgresStore.connect(url, { schema: `sb_test_${process.pid}_${Date.now()}_${n++}` }),
  );
}
