/**
 * SQLite schema. Column names and TypeScript keys must match the Postgres
 * schema in @saddlebags/store-postgres exactly: both are driven by the same
 * DrizzleStore and checked by the same contract tests.
 */
import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const memory = sqliteTable(
  "memory",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("memory_scope_key").on(t.scope, t.scopeId, t.key)],
);

export const memoryProposals = sqliteTable("memory_proposals", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  source: text("source", { mode: "json" }).notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const traces = sqliteTable("traces", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(),
  operation: text("operation").notNull(),
  plugin: text("plugin").notNull(),
  pluginVersion: text("plugin_version").notNull(),
  scope: text("scope").notNull(),
  model: text("model").notNull(),
  fired: text("fired", { mode: "json" }).notNull(),
  attempts: text("attempts", { mode: "json" }).notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  caller: text("caller"),
  notes: text("notes", { mode: "json" }),
  createdAt: text("created_at").notNull(),
});

export const installs = sqliteTable(
  "installs",
  {
    plugin: text("plugin").notNull(),
    version: text("version").notNull(),
    channel: text("channel").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.plugin, t.version] })],
);

export const evalRuns = sqliteTable("eval_runs", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(),
  plugin: text("plugin").notNull(),
  version: text("version").notNull(),
  passRate: real("pass_rate").notNull(),
  report: text("report", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const audit = sqliteTable("audit", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  subject: text("subject").notNull(),
  detail: text("detail", { mode: "json" }),
});

export const mcpConnections = sqliteTable(
  "mcp_connections",
  {
    id: text("id").primaryKey(),
    plugin: text("plugin").notNull(),
    server: text("server").notNull(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    credential: text("credential"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("mcp_connections_target").on(t.plugin, t.server, t.scope, t.scopeId)],
);

export const mcpPins = sqliteTable(
  "mcp_pins",
  {
    plugin: text("plugin").notNull(),
    version: text("version").notNull(),
    server: text("server").notNull(),
    tools: text("tools", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.plugin, t.version, t.server] })],
);

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  orgId: text("org_id").notNull(),
  groupId: text("group_id"),
  userId: text("user_id"),
  secretHash: text("secret_hash").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
});
