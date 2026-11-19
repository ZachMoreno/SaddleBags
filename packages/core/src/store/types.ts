import type { MemoryEntry, MemoryProposalInput, Scope } from "@saddlebags/sdk";
import type { EvalReport } from "../evals.js";

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

export interface EvalRunRecord {
  id: string;
  bag: string;
  version: string;
  passRate: number;
  report: EvalReport;
  createdAt: string;
}

/**
 * Persistence for the runtime. Async so that SQLite (default) and Postgres
 * share one interface. Both implementations are Drizzle-backed and run the
 * same contract tests.
 */
export interface Store {
  putMemory(e: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry>;
  listMemory(scope: Scope, scopeId: string): Promise<MemoryEntry[]>;

  addProposal(p: MemoryProposalInput, status: ProposalStatus): Promise<MemoryProposal>;
  getProposal(id: string): Promise<MemoryProposal | undefined>;
  listProposals(status?: ProposalStatus): Promise<MemoryProposal[]>;
  setProposalStatus(id: string, status: ProposalStatus): Promise<void>;

  putTrace(t: Omit<TraceRecord, "id" | "createdAt">): Promise<TraceRecord>;
  getTrace(id: string): Promise<TraceRecord | undefined>;
  /** Newest last. */
  listTraces(filter?: { operation?: string; limit?: number }): Promise<TraceRecord[]>;

  setInstall(bag: string, version: string, channel: Channel): Promise<void>;
  listInstalls(bag?: string): Promise<Install[]>;

  putEvalRun(report: EvalReport): Promise<EvalRunRecord>;
  /** The most recent eval run for a bag version. */
  latestEvalRun(bag: string, version: string): Promise<EvalRunRecord | undefined>;

  audit(e: AuditEvent): Promise<void>;
  listAudit(): Promise<Array<AuditEvent & { at: string }>>;

  close(): Promise<void>;
}
