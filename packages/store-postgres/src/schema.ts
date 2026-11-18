/**
 * Postgres schema. Column names and TypeScript keys must match the SQLite
 * schema in @saddlebags/core (src/store/schema-sqlite.ts) exactly: both are
 * driven by the same DrizzleStore and checked by the same contract tests.
 */
import { boolean, doublePrecision, jsonb, pgTable, primaryKey, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

export const memory = pgTable(
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

export const memoryProposals = pgTable("memory_proposals", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  source: jsonb("source").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const traces = pgTable("traces", {
  seq: serial("seq").primaryKey(),
  id: text("id").notNull().unique(),
  operation: text("operation").notNull(),
  bag: text("bag").notNull(),
  bagVersion: text("bag_version").notNull(),
  scope: text("scope").notNull(),
  model: text("model").notNull(),
  fired: jsonb("fired").notNull(),
  attempts: jsonb("attempts").notNull(),
  ok: boolean("ok").notNull(),
  createdAt: text("created_at").notNull(),
});

export const installs = pgTable(
  "installs",
  {
    bag: text("bag").notNull(),
    version: text("version").notNull(),
    channel: text("channel").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bag, t.version] })],
);

export const evalRuns = pgTable("eval_runs", {
  seq: serial("seq").primaryKey(),
  id: text("id").notNull().unique(),
  bag: text("bag").notNull(),
  version: text("version").notNull(),
  passRate: doublePrecision("pass_rate").notNull(),
  report: jsonb("report").notNull(),
  createdAt: text("created_at").notNull(),
});

export const audit = pgTable("audit", {
  seq: serial("seq").primaryKey(),
  at: text("at").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  subject: text("subject").notNull(),
  detail: jsonb("detail"),
});
