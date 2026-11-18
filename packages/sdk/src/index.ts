/**
 * @saddlebags/sdk — authoring types for SaddleBags bags.
 *
 * MIT licensed so that bags (including proprietary ones) can be written
 * against it freely. The runtime lives in @saddlebags/core (AGPL-3.0).
 */
import type { z } from "zod";

// ─── Identity & scopes ────────────────────────────────────────────────────

/** Memory and policy scopes, broadest first. */
export const SCOPES = ["org", "group", "user"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ScopeRef {
  orgId: string;
  groupId?: string;
  userId?: string;
}

/** Who can change a lever. The essay's "who" axis, made explicit. */
export type Author = "engineer" | "domain-expert";

// ─── Operation context ────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  scope: Scope;
  scopeId: string;
  key: string;
  value: string;
  createdAt: string;
}

export interface StepRecord {
  operation: string;
  output: unknown;
}

/** Everything a condition or directive can see about the current operation. */
export interface OperationContext<I = unknown> {
  operation: string;
  input: I;
  scope: ScopeRef;
  memory: MemoryEntry[];
  /** Outputs of earlier operations in the same session. */
  history: StepRecord[];
  meta: Record<string, unknown>;
}

// ─── Rules: condition + directive ─────────────────────────────────────────

export type Condition<I = unknown> =
  /** Loaded on every applicable operation. */
  | { kind: "always" }
  /** A selector model reads `description` and decides. Probabilistic. */
  | { kind: "model"; description: string }
  /** A predicate over the context. Deterministic, Turing complete. */
  | { kind: "code"; when: (ctx: OperationContext<I>) => boolean | Promise<boolean> };

export type EnforceResult =
  | { action: "pass" }
  | { action: "transform"; value: unknown }
  | { action: "reject"; reason: string };

export type Directive<I = unknown, O = unknown> =
  /** Guides the model. Shapes behavior without guaranteeing it. */
  | { kind: "prose"; text: string }
  /** Enforces in code: pass, transform the output, or reject (→ retry). */
  | {
      kind: "enforce";
      check: (output: O, ctx: OperationContext<I>) => EnforceResult | Promise<EnforceResult>;
    }
  /** Enforces on a tool call before it runs. */
  | {
      kind: "enforce-tool";
      tool: string;
      check: (args: unknown, ctx: OperationContext<I>) => EnforceResult | Promise<EnforceResult>;
    };

export interface Rule<I = unknown, O = unknown> {
  id: string;
  /** Human-readable summary, shown in the Stable. */
  title?: string;
  /** Operations this rule is scoped to. Omit for all operations. */
  operations?: string[];
  condition: Condition<I>;
  directive: Directive<I, O>;
  authoredBy?: Author;
  /** Where the rule may be edited: only in code, or also as a Stable overlay. */
  editableIn?: "code" | "stable";
}

// ─── Tools ────────────────────────────────────────────────────────────────

export interface Tool<S extends z.ZodType = z.ZodType, R = unknown> {
  name: string;
  description: string;
  input: S;
  run: (args: z.infer<S>, ctx: OperationContext) => R | Promise<R>;
}

// ─── Models & routes ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  /** Pinned model id, e.g. "claude-sonnet-5-5". */
  model: string;
  system: string;
  messages: ChatMessage[];
  /** JSON Schema the output must conform to, when the route is typed. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResponse {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ModelProvider {
  /** e.g. "anthropic", "openai", "google". */
  id: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

/** The per-operation model choice. */
export interface ModelRoute<S extends z.ZodType = z.ZodType> {
  operation: string;
  /** "provider:model", with a pinned model version. */
  model: `${string}:${string}`;
  system?: string;
  /** Optional typed output: the "type-safe decision model". */
  output?: S;
  maxTokens?: number;
  temperature?: number;
  /** Max attempts when enforce directives reject. Default 3. */
  maxAttempts?: number;
}

// ─── Memory ───────────────────────────────────────────────────────────────

export type MemoryDecision = "approve" | "reject" | "review";

export type MemoryWritePolicy =
  | "auto"
  | "review"
  | {
      code: (proposal: MemoryProposalInput) => MemoryDecision | Promise<MemoryDecision>;
    };

export interface MemoryProposalInput {
  scope: Scope;
  scopeId: string;
  key: string;
  value: string;
  /** Who proposed it: a model operation, a human, or a seed. */
  source: { kind: "model"; operation: string } | { kind: "human"; userId: string } | { kind: "seed" };
}

export interface MemorySchema {
  /** Write policy per scope. Unset scopes default to "review". */
  policy: Partial<Record<Scope, MemoryWritePolicy>>;
  seed?: Array<Omit<MemoryProposalInput, "source" | "scopeId"> & { scopeId?: string }>;
}

// ─── Evals ────────────────────────────────────────────────────────────────

export type Grader<O = unknown> =
  | { kind: "code"; name: string; assert: (output: O) => boolean | string }
  | { kind: "judge"; name: string; rubric: string; model: `${string}:${string}` };

export interface EvalCase<I = unknown, O = unknown> {
  id: string;
  operation: string;
  input: I;
  graders: Grader<O>[];
}

// ─── Bag ──────────────────────────────────────────────────────────────────

export interface Bag {
  name: string;
  version: string;
  description?: string;
  routes: ModelRoute[];
  rules?: Rule<any, any>[];
  tools?: Tool<any, any>[];
  memory?: MemorySchema;
  evals?: EvalCase<any, any>[];
}

// ─── define* helpers (identity functions for inference) ───────────────────

export const defineBag = (bag: Bag): Bag => bag;
export const defineRule = <I = unknown, O = unknown>(rule: Rule<I, O>): Rule<I, O> => rule;
export const defineTool = <S extends z.ZodType, R>(tool: Tool<S, R>): Tool<S, R> => tool;
export const defineRoute = <S extends z.ZodType>(route: ModelRoute<S>): ModelRoute<S> => route;
export const defineEval = <I = unknown, O = unknown>(c: EvalCase<I, O>): EvalCase<I, O> => c;

// ─── Directive helpers ────────────────────────────────────────────────────

export const pass = (): EnforceResult => ({ action: "pass" });
export const reject = (reason: string): EnforceResult => ({ action: "reject", reason });
export const transform = (value: unknown): EnforceResult => ({ action: "transform", value });

// ─── Artifact library ─────────────────────────────────────────────────────

export type ArtifactStatus = "pending" | "approved" | "rejected";

export interface ArtifactMeta {
  /** Content hash (sha256 hex). */
  id: string;
  operation: string;
  contentType: string;
  status: ArtifactStatus;
  tags: Record<string, string>;
  createdAt: string;
}

/** Pre-baked ↔ live: a content-addressed store of operation outputs. */
export interface ArtifactStore {
  put(
    body: Uint8Array | string,
    meta: { operation: string; contentType: string; tags?: Record<string, string> },
  ): Promise<ArtifactMeta>;
  get(id: string): Promise<{ meta: ArtifactMeta; body: Uint8Array } | undefined>;
  list(filter?: { operation?: string; status?: ArtifactStatus }): Promise<ArtifactMeta[]>;
  setStatus(id: string, status: ArtifactStatus): Promise<ArtifactMeta>;
}
