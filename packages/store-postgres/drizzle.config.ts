import { defineConfig } from "drizzle-kit";

// `pnpm --filter @saddlebags/store-postgres db:generate` after changing the schema.
// Keep packages/core/src/store/schema-sqlite.ts in step: same tables, same columns.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle/pg",
});
