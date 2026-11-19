import { defineConfig } from "drizzle-kit";

// `pnpm --filter @saddlebags/core db:generate` after changing the schema.
// Keep packages/store-postgres/src/schema.ts in step: same tables, same columns.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/store/schema-sqlite.ts",
  out: "./drizzle/sqlite",
});
