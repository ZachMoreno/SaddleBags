import {
  SCOPES,
  type MemoryEntry,
  type MemoryProposalInput,
  type MemorySchema,
  type MemoryWritePolicy,
  type Scope,
  type ScopeRef,
} from "@saddlebags/sdk";
import type { MemoryProposal, Store } from "./store.js";

export interface ProposalOutcome {
  proposal: MemoryProposal;
  /** The written entry, if the policy approved it immediately. */
  entry?: MemoryEntry;
}

/**
 * Memory with a write policy per scope. The policy decides whether a
 * model's write lands (`auto`), waits for a human (`review`), or is decided
 * by a code function. Anything unspecified defaults to `review`, because one
 * bad write shapes every later session.
 */
export class Memory {
  constructor(
    private store: Store,
    private schema: MemorySchema = { policy: {} },
  ) {}

  policyFor(scope: Scope): MemoryWritePolicy {
    return this.schema.policy[scope] ?? "review";
  }

  async propose(input: MemoryProposalInput): Promise<ProposalOutcome> {
    // Human and seed writes are trusted; policies govern model writes.
    let decision: "approve" | "reject" | "review";
    if (input.source.kind !== "model") {
      decision = "approve";
    } else {
      const policy = this.policyFor(input.scope);
      decision =
        policy === "auto" ? "approve" : policy === "review" ? "review" : await policy.code(input);
    }

    const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "pending";
    const proposal = this.store.addProposal(input, status);
    this.store.audit({
      actor: actorOf(input),
      action: `memory.propose.${status}`,
      subject: `${input.scope}:${input.scopeId}:${input.key}`,
      detail: { proposalId: proposal.id },
    });

    if (status !== "approved") return { proposal };
    const entry = this.write(input);
    return { proposal, entry };
  }

  /** A human resolves a pending proposal (in the Stable). */
  resolve(proposalId: string, approve: boolean, reviewer: string): MemoryEntry | undefined {
    const p = this.store.getProposal(proposalId);
    if (!p) throw new Error(`No memory proposal ${proposalId}`);
    if (p.status !== "pending") throw new Error(`Proposal ${proposalId} is already ${p.status}`);
    this.store.setProposalStatus(proposalId, approve ? "approved" : "rejected");
    this.store.audit({
      actor: `human:${reviewer}`,
      action: approve ? "memory.approve" : "memory.reject",
      subject: `${p.scope}:${p.scopeId}:${p.key}`,
      detail: { proposalId },
    });
    return approve ? this.write(p) : undefined;
  }

  /** Memory for a scope ref, broadest first. Narrower scopes override by key. */
  load(ref: ScopeRef): MemoryEntry[] {
    const byKey = new Map<string, MemoryEntry>();
    for (const scope of SCOPES) {
      const id = scopeId(ref, scope);
      if (!id) continue;
      for (const e of this.store.listMemory(scope, id)) byKey.set(e.key, e);
    }
    return [...byKey.values()];
  }

  async seed(ref: ScopeRef): Promise<void> {
    for (const s of this.schema.seed ?? []) {
      const id = s.scopeId ?? scopeId(ref, s.scope);
      if (!id) continue;
      await this.propose({ ...s, scopeId: id, source: { kind: "seed" } });
    }
  }

  private write(p: MemoryProposalInput): MemoryEntry {
    return this.store.putMemory({ scope: p.scope, scopeId: p.scopeId, key: p.key, value: p.value });
  }
}

export function scopeId(ref: ScopeRef, scope: Scope): string | undefined {
  return scope === "org" ? ref.orgId : scope === "group" ? ref.groupId : ref.userId;
}

function actorOf(input: MemoryProposalInput): string {
  const s = input.source;
  return s.kind === "model" ? `model:${s.operation}` : s.kind === "human" ? `human:${s.userId}` : "seed";
}
