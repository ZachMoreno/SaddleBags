import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemoryProposalInput, Scope } from "@saddlebags/sdk";

export type ProposalStatus = "pending" | "approved" | "rejected";

export interface MemoryProposal extends MemoryProposalInput {
  id: string;
  status: ProposalStatus;
  createdAt: string;
}

export type Channel = "rc" | "latest" | "unpublished";

export interface Install {
  bag: string;
  version: string;
  channel: Channel;
  updatedAt: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  /** Arguments as executed (after any enforce-tool transforms). */
  args: unknown;
  result?: unknown;
  error?: string;
  /** The enforce-tool rule that blocked the call, if any. */
  blockedBy?: string;
}

export interface TraceRecord {
  id: string;
  operation: string;
  bag: string;
  bagVersion: string;
  scope: string;
  model: string;
  fired: Array<{ ruleId: string; reason: string }>;
  attempts: Array<{
    output: unknown;
    rejections: Array<{ ruleId: string; reason: string }>;
    toolCalls?: ToolCallRecord[];
  }>;
  ok: boolean;
  createdAt: string;
}

export interface AuditEvent {
  actor: string;
  action: string;
  subject: string;
  detail?: unknown;
}

/** Persistence for the runtime. SQLite by default; Postgres arrives in M2. */
export interface Store {
  putMemory(e: Omit<MemoryEntry, "id" | "createdAt">): MemoryEntry;
  listMemory(scope: Scope, scopeId: string): MemoryEntry[];
  addProposal(p: MemoryProposalInput, status: ProposalStatus): MemoryProposal;
  getProposal(id: string): MemoryProposal | undefined;
  listProposals(status?: ProposalStatus): MemoryProposal[];
  setProposalStatus(id: string, status: ProposalStatus): void;
  putTrace(t: Omit<TraceRecord, "id" | "createdAt">): TraceRecord;
  listTraces(operation?: string): TraceRecord[];
  setInstall(bag: string, version: string, channel: Channel): void;
  listInstalls(bag?: string): Install[];
  audit(e: AuditEvent): void;
  listAudit(): Array<AuditEvent & { at: string }>;
  close(): void;
}

const now = () => new Date().toISOString();

export class SqliteStore implements Store {
  private db: DatabaseSync;

  /** `path` defaults to an in-memory database. */
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT NOT NULL,
        key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (scope, scope_id, key)
      );
      CREATE TABLE IF NOT EXISTS memory_proposals (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY, operation TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installs (
        bag TEXT NOT NULL, version TEXT NOT NULL, channel TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (bag, version)
      );
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, body TEXT NOT NULL
      );
    `);
  }

  putMemory(e: Omit<MemoryEntry, "id" | "createdAt">): MemoryEntry {
    const entry: MemoryEntry = { ...e, id: randomUUID(), createdAt: now() };
    this.db
      .prepare(
        `INSERT INTO memory (id, scope, scope_id, key, value, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_id, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
      )
      .run(entry.id, entry.scope, entry.scopeId, entry.key, entry.value, entry.createdAt);
    return entry;
  }

  listMemory(scope: Scope, scopeId: string): MemoryEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE scope = ? AND scope_id = ? ORDER BY key`)
      .all(scope, scopeId) as Array<Record<string, string>>;
    return rows.map((r) => ({
      id: r.id!,
      scope: r.scope as Scope,
      scopeId: r.scope_id!,
      key: r.key!,
      value: r.value!,
      createdAt: r.created_at!,
    }));
  }

  addProposal(p: MemoryProposalInput, status: ProposalStatus): MemoryProposal {
    const proposal: MemoryProposal = { ...p, id: randomUUID(), status, createdAt: now() };
    this.db
      .prepare(`INSERT INTO memory_proposals (id, body, status, created_at) VALUES (?, ?, ?, ?)`)
      .run(proposal.id, JSON.stringify(p), status, proposal.createdAt);
    return proposal;
  }

  getProposal(id: string): MemoryProposal | undefined {
    const r = this.db.prepare(`SELECT * FROM memory_proposals WHERE id = ?`).get(id) as
      | Record<string, string>
      | undefined;
    return r && this.rowToProposal(r);
  }

  listProposals(status?: ProposalStatus): MemoryProposal[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM memory_proposals WHERE status = ? ORDER BY created_at`).all(status)
        : this.db.prepare(`SELECT * FROM memory_proposals ORDER BY created_at`).all()
    ) as Array<Record<string, string>>;
    return rows.map((r) => this.rowToProposal(r));
  }

  setProposalStatus(id: string, status: ProposalStatus): void {
    this.db.prepare(`UPDATE memory_proposals SET status = ? WHERE id = ?`).run(status, id);
  }

  putTrace(t: Omit<TraceRecord, "id" | "createdAt">): TraceRecord {
    const trace: TraceRecord = { ...t, id: randomUUID(), createdAt: now() };
    this.db
      .prepare(`INSERT INTO traces (id, operation, body, created_at) VALUES (?, ?, ?, ?)`)
      .run(trace.id, trace.operation, JSON.stringify(trace), trace.createdAt);
    return trace;
  }

  listTraces(operation?: string): TraceRecord[] {
    const rows = (
      operation
        ? this.db.prepare(`SELECT body FROM traces WHERE operation = ? ORDER BY created_at`).all(operation)
        : this.db.prepare(`SELECT body FROM traces ORDER BY created_at`).all()
    ) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body) as TraceRecord);
  }

  setInstall(bag: string, version: string, channel: Channel): void {
    this.db
      .prepare(
        `INSERT INTO installs (bag, version, channel, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (bag, version) DO UPDATE SET channel = excluded.channel, updated_at = excluded.updated_at`,
      )
      .run(bag, version, channel, now());
  }

  listInstalls(bag?: string): Install[] {
    const rows = (
      bag
        ? this.db.prepare(`SELECT * FROM installs WHERE bag = ?`).all(bag)
        : this.db.prepare(`SELECT * FROM installs`).all()
    ) as Array<Record<string, string>>;
    return rows.map((r) => ({
      bag: r.bag!,
      version: r.version!,
      channel: r.channel as Channel,
      updatedAt: r.updated_at!,
    }));
  }

  audit(e: AuditEvent): void {
    this.db.prepare(`INSERT INTO audit (at, body) VALUES (?, ?)`).run(now(), JSON.stringify(e));
  }

  listAudit(): Array<AuditEvent & { at: string }> {
    const rows = this.db.prepare(`SELECT at, body FROM audit ORDER BY seq`).all() as Array<{
      at: string;
      body: string;
    }>;
    return rows.map((r) => ({ ...(JSON.parse(r.body) as AuditEvent), at: r.at }));
  }

  close(): void {
    this.db.close();
  }

  private rowToProposal(r: Record<string, string>): MemoryProposal {
    return {
      ...(JSON.parse(r.body!) as MemoryProposalInput),
      id: r.id!,
      status: r.status as ProposalStatus,
      createdAt: r.created_at!,
    };
  }
}
