import type { MemoryEntry, MemoryProposalInput, Scope, ScopeRef } from "@saddlebags/sdk";
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
  /** For MCP tools: the server, and the connection used (`<scope>:<scopeId>`). */
  server?: string;
  connection?: string;
}

/** Something about a run that isn't a rule or an attempt, e.g. MCP tools left out. */
export interface TraceNote {
  kind: "mcp.omitted" | "mcp.drift" | "mcp.unpinned";
  server: string;
  tool?: string;
  detail: string;
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
  /** Who ran it: `api`, `cli`, `eval`, `mcp:<tokenId>`. */
  caller?: string;
  notes?: TraceNote[];
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

/** An admin's connection of a bag-declared MCP server, at one scope. */
export interface McpConnection {
  id: string;
  bag: string;
  server: string;
  scope: Scope;
  scopeId: string;
  /** Encrypted credential (opaque to the store), or null for `auth: "none"`. */
  credential: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PinnedTool {
  name: string;
  description: string;
  /** sha256 of the tool's input schema (canonical JSON). */
  schemaHash: string;
}

/** The tool definitions of one server, snapshotted when a bag version is promoted. */
export interface McpPin {
  bag: string;
  version: string;
  server: string;
  tools: PinnedTool[];
  createdAt: string;
}

/** A bearer token for the /mcp endpoint, bound to a scope. */
export interface ApiToken {
  id: string;
  name: string;
  scope: ScopeRef;
  /** sha256 of the token secret. The secret itself is never stored. */
  secretHash: string;
  createdAt: string;
  revokedAt: string | null;
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

  /** Upsert by (bag, server, scope, scopeId). */
  putConnection(c: Omit<McpConnection, "id" | "createdAt">): Promise<McpConnection>;
  listConnections(filter?: { bag?: string; server?: string }): Promise<McpConnection[]>;
  deleteConnection(id: string): Promise<boolean>;

  /** Upsert by (bag, version, server). */
  setPin(pin: Omit<McpPin, "createdAt">): Promise<void>;
  listPins(bag: string, version: string): Promise<McpPin[]>;

  putApiToken(t: Omit<ApiToken, "createdAt" | "revokedAt">): Promise<ApiToken>;
  getApiToken(id: string): Promise<ApiToken | undefined>;
  listApiTokens(): Promise<ApiToken[]>;
  revokeApiToken(id: string): Promise<boolean>;

  audit(e: AuditEvent): Promise<void>;
  listAudit(): Promise<Array<AuditEvent & { at: string }>>;

  close(): Promise<void>;
}
