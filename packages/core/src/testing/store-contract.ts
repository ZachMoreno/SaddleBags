/**
 * The Store contract. Every Store implementation runs this same suite, which
 * keeps SQLite and Postgres from drifting apart.
 *
 *   import { storeContract } from "@saddlebags/core/testing";
 *   storeContract("PostgresStore", () => PostgresStore.pglite());
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvalReport } from "../evals.js";
import type { Store } from "../store/types.js";

export function storeContract(name: string, open: () => Store | Promise<Store>): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await open();
    });
    afterEach(async () => {
      await store.close();
    });

    it("upserts memory by scope + key, keeping the row id", async () => {
      const a = await store.putMemory({ scope: "org", scopeId: "acme", key: "tone", value: "formal" });
      const b = await store.putMemory({ scope: "org", scopeId: "acme", key: "tone", value: "casual" });
      await store.putMemory({ scope: "org", scopeId: "acme", key: "audience", value: "smb" });
      await store.putMemory({ scope: "org", scopeId: "other", key: "tone", value: "loud" });

      expect(b.id).toBe(a.id);
      const rows = await store.listMemory("org", "acme");
      expect(rows.map((r) => [r.key, r.value])).toEqual([
        ["audience", "smb"],
        ["tone", "casual"],
      ]);
    });

    it("stores proposals with their JSON source and filters by status", async () => {
      const p = await store.addProposal(
        { scope: "user", scopeId: "u1", key: "k", value: "v", source: { kind: "model", operation: "op" } },
        "pending",
      );
      await store.addProposal({ scope: "org", scopeId: "o", key: "k2", value: "v2", source: { kind: "seed" } }, "approved");

      expect(await store.getProposal(p.id)).toEqual(p);
      expect(await store.getProposal("missing")).toBeUndefined();
      expect((await store.listProposals("pending")).map((x) => x.id)).toEqual([p.id]);
      await store.setProposalStatus(p.id, "rejected");
      expect((await store.getProposal(p.id))!.status).toBe("rejected");
      expect(await store.listProposals()).toHaveLength(2);
    });

    it("round-trips traces, including nested JSON and booleans, newest last", async () => {
      const base = {
        operation: "op",
        bag: "b",
        bagVersion: "1.0.0",
        scope: "acme/u1",
        model: "mock:m",
        fired: [{ ruleId: "r", reason: "always" }],
        attempts: [{ output: { n: 1 }, rejections: [], toolCalls: [{ id: "c", name: "t", args: { a: 1 }, result: [1, 2] }] }],
      };
      const t1 = await store.putTrace({ ...base, ok: true });
      const t2 = await store.putTrace({ ...base, operation: "other", ok: false });
      const t3 = await store.putTrace({ ...base, ok: false });

      expect(await store.getTrace(t1.id)).toEqual(t1);
      expect(await store.getTrace("missing")).toBeUndefined();
      expect((await store.listTraces()).map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);
      expect((await store.listTraces({ operation: "op" })).map((t) => t.id)).toEqual([t1.id, t3.id]);
      expect((await store.listTraces({ limit: 1 })).map((t) => t.id)).toEqual([t3.id]);
    });

    it("upserts installs by bag + version", async () => {
      await store.setInstall("b", "1.0.0", "rc");
      await store.setInstall("b", "1.0.0", "latest");
      await store.setInstall("c", "2.0.0", "rc");
      expect((await store.listInstalls("b")).map((i) => [i.version, i.channel])).toEqual([["1.0.0", "latest"]]);
      expect(await store.listInstalls()).toHaveLength(2);
    });

    it("returns the latest eval run per bag version", async () => {
      const report = (passRate: number): EvalReport => ({
        bag: "b",
        version: "1.0.0",
        passRate,
        cases: [{ caseId: "c", pass: passRate === 1, graders: [] }],
      });
      await store.putEvalRun(report(0.5));
      const second = await store.putEvalRun(report(1));
      const latest = await store.latestEvalRun("b", "1.0.0");
      expect(latest).toEqual(second);
      expect(latest!.report.cases[0]!.pass).toBe(true);
      expect(await store.latestEvalRun("b", "9.9.9")).toBeUndefined();
    });

    it("appends to the audit log in order", async () => {
      await store.audit({ actor: "a", action: "x", subject: "s", detail: { n: 1 } });
      await store.audit({ actor: "a", action: "y", subject: "s" });
      const log = await store.listAudit();
      expect(log.map((e) => e.action)).toEqual(["x", "y"]);
      expect(log[0]!.detail).toEqual({ n: 1 });
      expect(log[1]).not.toHaveProperty("detail");
    });
  });
}
