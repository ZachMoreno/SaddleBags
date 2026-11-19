import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type { MemoryEntry, MemoryProposalInput, Scope, ScopeRef } from "@saddlebags/sdk";
import type { EvalReport } from "../evals.js";
import * as schema from "./schema-sqlite.js";
import type {
  ApiToken,
  AuditEvent,
  Channel,
  McpConnection,
  McpPin,
  PinnedTool,
  EvalRunRecord,
  Install,
  MemoryProposal,
  ProposalStatus,
  Store,
  TraceNote,
  TraceRecord,
} from "./types.js";

/** The tables a DrizzleStore needs. Both dialect schemas have this shape. */
export type StoreTables = typeof schema;

/**
 * Store logic shared by every dialect. It only uses query-builder calls whose
 * shape is identical in Drizzle's SQLite and Postgres APIs (select, insert,
 * onConflictDoUpdate, update, returning). Other dialects pass their db and
 * tables cast to these types; the shared contract tests check that this holds.
 */
export abstract class DrizzleStore implements Store {
  protected constructor(
    protected db: SqliteRemoteDatabase,
    protected t: StoreTables,
  ) {}

  abstract close(): Promise<void>;

  async putMemory(e: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    const createdAt = now();
    const [row] = await this.db
      .insert(this.t.memory)
      .values({ id: randomUUID(), ...e, createdAt })
      .onConflictDoUpdate({
        target: [this.t.memory.scope, this.t.memory.scopeId, this.t.memory.key],
        set: { value: e.value, createdAt },
      })
      .returning();
    return toMemory(row!);
  }

  async listMemory(scope: Scope, scopeId: string): Promise<MemoryEntry[]> {
    const m = this.t.memory;
    const rows = await this.db
      .select()
      .from(m)
      .where(and(eq(m.scope, scope), eq(m.scopeId, scopeId)))
      .orderBy(asc(m.key));
    return rows.map(toMemory);
  }

  async addProposal(p: MemoryProposalInput, status: ProposalStatus): Promise<MemoryProposal> {
    const proposal: MemoryProposal = { ...p, id: randomUUID(), status, createdAt: now() };
    await this.db.insert(this.t.memoryProposals).values({
      id: proposal.id,
      scope: p.scope,
      scopeId: p.scopeId,
      key: p.key,
      value: p.value,
      source: p.source,
      status,
      createdAt: proposal.createdAt,
    });
    return proposal;
  }

  async getProposal(id: string): Promise<MemoryProposal | undefined> {
    const mp = this.t.memoryProposals;
    const [row] = await this.db.select().from(mp).where(eq(mp.id, id));
    return row && toProposal(row);
  }

  async listProposals(status?: ProposalStatus): Promise<MemoryProposal[]> {
    const mp = this.t.memoryProposals;
    const q = this.db.select().from(mp);
    const rows = await (status ? q.where(eq(mp.status, status)) : q).orderBy(asc(mp.createdAt), asc(mp.id));
    return rows.map(toProposal);
  }

  async setProposalStatus(id: string, status: ProposalStatus): Promise<void> {
    const mp = this.t.memoryProposals;
    await this.db.update(mp).set({ status }).where(eq(mp.id, id));
  }

  async putTrace(t: Omit<TraceRecord, "id" | "createdAt">): Promise<TraceRecord> {
    const trace: TraceRecord = { ...t, id: randomUUID(), createdAt: now() };
    await this.db.insert(this.t.traces).values({ ...trace, caller: t.caller ?? null, notes: t.notes ?? null });
    return trace;
  }

  async getTrace(id: string): Promise<TraceRecord | undefined> {
    const tr = this.t.traces;
    const [row] = await this.db.select().from(tr).where(eq(tr.id, id));
    return row && toTrace(row);
  }

  async listTraces(filter: { operation?: string; limit?: number } = {}): Promise<TraceRecord[]> {
    const tr = this.t.traces;
    const q = this.db.select().from(tr);
    const rows = await (filter.operation ? q.where(eq(tr.operation, filter.operation)) : q)
      .orderBy(desc(tr.seq))
      .limit(filter.limit ?? 100);
    return rows.reverse().map(toTrace);
  }

  async setInstall(bag: string, version: string, channel: Channel): Promise<void> {
    const i = this.t.installs;
    const updatedAt = now();
    await this.db
      .insert(i)
      .values({ bag, version, channel, updatedAt })
      .onConflictDoUpdate({ target: [i.bag, i.version], set: { channel, updatedAt } });
  }

  async listInstalls(bag?: string): Promise<Install[]> {
    const i = this.t.installs;
    const q = this.db.select().from(i);
    const rows = await (bag ? q.where(eq(i.bag, bag)) : q).orderBy(asc(i.bag), asc(i.updatedAt));
    return rows.map((r) => ({ bag: r.bag, version: r.version, channel: r.channel as Channel, updatedAt: r.updatedAt }));
  }

  async putEvalRun(report: EvalReport): Promise<EvalRunRecord> {
    const run: EvalRunRecord = {
      id: randomUUID(),
      bag: report.bag,
      version: report.version,
      passRate: report.passRate,
      report,
      createdAt: now(),
    };
    await this.db.insert(this.t.evalRuns).values(run);
    return run;
  }

  async latestEvalRun(bag: string, version: string): Promise<EvalRunRecord | undefined> {
    const e = this.t.evalRuns;
    const [row] = await this.db
      .select()
      .from(e)
      .where(and(eq(e.bag, bag), eq(e.version, version)))
      .orderBy(desc(e.seq))
      .limit(1);
    return (
      row && {
        id: row.id,
        bag: row.bag,
        version: row.version,
        passRate: row.passRate,
        report: row.report as EvalReport,
        createdAt: row.createdAt,
      }
    );
  }

  async putConnection(c: Omit<McpConnection, "id" | "createdAt">): Promise<McpConnection> {
    const mc = this.t.mcpConnections;
    const createdAt = now();
    const [row] = await this.db
      .insert(mc)
      .values({ id: randomUUID(), ...c, createdAt })
      .onConflictDoUpdate({
        target: [mc.bag, mc.server, mc.scope, mc.scopeId],
        set: { credential: c.credential, createdBy: c.createdBy, createdAt },
      })
      .returning();
    return toConnection(row!);
  }

  async listConnections(filter: { bag?: string; server?: string } = {}): Promise<McpConnection[]> {
    const mc = this.t.mcpConnections;
    const conds = [filter.bag ? eq(mc.bag, filter.bag) : undefined, filter.server ? eq(mc.server, filter.server) : undefined];
    const rows = await this.db
      .select()
      .from(mc)
      .where(and(...conds))
      .orderBy(asc(mc.bag), asc(mc.server), asc(mc.scope), asc(mc.scopeId));
    return rows.map(toConnection);
  }

  async deleteConnection(id: string): Promise<boolean> {
    const mc = this.t.mcpConnections;
    const rows = await this.db.delete(mc).where(eq(mc.id, id)).returning();
    return rows.length > 0;
  }

  async setPin(pin: Omit<McpPin, "createdAt">): Promise<void> {
    const p = this.t.mcpPins;
    const createdAt = now();
    await this.db
      .insert(p)
      .values({ ...pin, createdAt })
      .onConflictDoUpdate({ target: [p.bag, p.version, p.server], set: { tools: pin.tools, createdAt } });
  }

  async listPins(bag: string, version: string): Promise<McpPin[]> {
    const p = this.t.mcpPins;
    const rows = await this.db
      .select()
      .from(p)
      .where(and(eq(p.bag, bag), eq(p.version, version)))
      .orderBy(asc(p.server));
    return rows.map((r) => ({
      bag: r.bag,
      version: r.version,
      server: r.server,
      tools: r.tools as PinnedTool[],
      createdAt: r.createdAt,
    }));
  }

  async putApiToken(t: Omit<ApiToken, "createdAt" | "revokedAt">): Promise<ApiToken> {
    const token: ApiToken = { ...t, createdAt: now(), revokedAt: null };
    await this.db.insert(this.t.apiTokens).values({
      id: t.id,
      name: t.name,
      orgId: t.scope.orgId,
      groupId: t.scope.groupId ?? null,
      userId: t.scope.userId ?? null,
      secretHash: t.secretHash,
      createdAt: token.createdAt,
      revokedAt: null,
    });
    return token;
  }

  async getApiToken(id: string): Promise<ApiToken | undefined> {
    const at = this.t.apiTokens;
    const [row] = await this.db.select().from(at).where(eq(at.id, id));
    return row && toApiToken(row);
  }

  async listApiTokens(): Promise<ApiToken[]> {
    const at = this.t.apiTokens;
    const rows = await this.db.select().from(at).orderBy(asc(at.createdAt), asc(at.id));
    return rows.map(toApiToken);
  }

  async revokeApiToken(id: string): Promise<boolean> {
    const at = this.t.apiTokens;
    const rows = await this.db
      .update(at)
      .set({ revokedAt: now() })
      .where(and(eq(at.id, id), isNull(at.revokedAt)))
      .returning();
    return rows.length > 0;
  }

  async audit(e: AuditEvent): Promise<void> {
    await this.db.insert(this.t.audit).values({ at: now(), ...e, detail: e.detail ?? null });
  }

  async listAudit(): Promise<Array<AuditEvent & { at: string }>> {
    const rows = await this.db.select().from(this.t.audit).orderBy(asc(this.t.audit.seq));
    return rows.map((r) => ({
      at: r.at,
      actor: r.actor,
      action: r.action,
      subject: r.subject,
      ...(r.detail != null && { detail: r.detail }),
    }));
  }
}

const now = () => new Date().toISOString();

function toMemory(r: typeof schema.memory.$inferSelect): MemoryEntry {
  return { id: r.id, scope: r.scope as Scope, scopeId: r.scopeId, key: r.key, value: r.value, createdAt: r.createdAt };
}

function toProposal(r: typeof schema.memoryProposals.$inferSelect): MemoryProposal {
  return {
    id: r.id,
    scope: r.scope as Scope,
    scopeId: r.scopeId,
    key: r.key,
    value: r.value,
    source: r.source as MemoryProposalInput["source"],
    status: r.status as ProposalStatus,
    createdAt: r.createdAt,
  };
}

function toTrace(r: typeof schema.traces.$inferSelect): TraceRecord {
  return {
    id: r.id,
    operation: r.operation,
    bag: r.bag,
    bagVersion: r.bagVersion,
    scope: r.scope,
    model: r.model,
    fired: r.fired as TraceRecord["fired"],
    attempts: r.attempts as TraceRecord["attempts"],
    ok: r.ok,
    ...(r.caller != null && { caller: r.caller }),
    ...(r.notes != null && { notes: r.notes as TraceNote[] }),
    createdAt: r.createdAt,
  };
}

function toConnection(r: typeof schema.mcpConnections.$inferSelect): McpConnection {
  return {
    id: r.id,
    bag: r.bag,
    server: r.server,
    scope: r.scope as Scope,
    scopeId: r.scopeId,
    credential: r.credential,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

function toApiToken(r: typeof schema.apiTokens.$inferSelect): ApiToken {
  const scope: ScopeRef = { orgId: r.orgId };
  if (r.groupId != null) scope.groupId = r.groupId;
  if (r.userId != null) scope.userId = r.userId;
  return { id: r.id, name: r.name, scope, secretHash: r.secretHash, createdAt: r.createdAt, revokedAt: r.revokedAt };
}
