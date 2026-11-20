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
        plugin: "b",
        pluginVersion: "1.0.0",
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

    it("upserts installs by plugin + version", async () => {
      await store.setInstall("b", "1.0.0", "rc");
      await store.setInstall("b", "1.0.0", "latest");
      await store.setInstall("c", "2.0.0", "rc");
      expect((await store.listInstalls("b")).map((i) => [i.version, i.channel])).toEqual([["1.0.0", "latest"]]);
      expect(await store.listInstalls()).toHaveLength(2);
    });

    it("returns the latest eval run per plugin version", async () => {
      const report = (passRate: number): EvalReport => ({
        plugin: "b",
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

    it("stores a trace's caller and notes, and omits them when unset", async () => {
      const base = { operation: "op", plugin: "b", pluginVersion: "1", scope: "o", model: "m", fired: [], attempts: [], ok: true };
      const notes = [{ kind: "mcp.drift" as const, server: "gh", tool: "search", detail: "description changed" }];
      const a = await store.putTrace({ ...base, caller: "mcp:tok1", notes });
      const b = await store.putTrace(base);
      expect(await store.getTrace(a.id)).toEqual(a);
      const got = await store.getTrace(b.id);
      expect(got).not.toHaveProperty("caller");
      expect(got).not.toHaveProperty("notes");
    });

    it("upserts MCP connections by plugin + server + scope, filters, and deletes", async () => {
      const a = await store.putConnection({ plugin: "b", server: "gh", scope: "org", scopeId: "acme", credential: "enc1", createdBy: "x" });
      const a2 = await store.putConnection({ plugin: "b", server: "gh", scope: "org", scopeId: "acme", credential: "enc2", createdBy: "y" });
      await store.putConnection({ plugin: "b", server: "gh", scope: "user", scopeId: "u1", credential: null, createdBy: "x" });
      await store.putConnection({ plugin: "b", server: "ff", scope: "org", scopeId: "acme", credential: null, createdBy: "x" });

      expect(a2.id).toBe(a.id);
      expect(a2.credential).toBe("enc2");
      expect((await store.listConnections({ plugin: "b", server: "gh" })).map((c) => [c.scope, c.credential])).toEqual([
        ["org", "enc2"],
        ["user", null],
      ]);
      expect(await store.listConnections()).toHaveLength(3);
      expect(await store.deleteConnection(a.id)).toBe(true);
      expect(await store.deleteConnection(a.id)).toBe(false);
      expect(await store.listConnections({ server: "gh" })).toHaveLength(1);
    });

    it("upserts pins per plugin version and server", async () => {
      const tools = [{ name: "search", description: "Search issues", schemaHash: "h1" }];
      await store.setPin({ plugin: "b", version: "1", server: "gh", tools });
      await store.setPin({ plugin: "b", version: "1", server: "gh", tools: [{ ...tools[0]!, schemaHash: "h2" }] });
      await store.setPin({ plugin: "b", version: "1", server: "ff", tools: [] });
      await store.setPin({ plugin: "b", version: "2", server: "gh", tools });

      const pins = await store.listPins("b", "1");
      expect(pins.map((p) => p.server)).toEqual(["ff", "gh"]);
      expect(pins[1]!.tools[0]!.schemaHash).toBe("h2");
      expect(await store.listPins("b", "9")).toEqual([]);
    });

    it("stores API tokens with optional scope parts, and revokes once", async () => {
      const t = await store.putApiToken({ id: "t1", name: "ci", scope: { orgId: "acme", userId: "u1" }, secretHash: "h" });
      await store.putApiToken({ id: "t2", name: "org", scope: { orgId: "acme" }, secretHash: "h2" });

      expect(await store.getApiToken("t1")).toEqual(t);
      expect((await store.getApiToken("t2"))!.scope).toEqual({ orgId: "acme" });
      expect(await store.getApiToken("nope")).toBeUndefined();
      expect(await store.revokeApiToken("t1")).toBe(true);
      expect(await store.revokeApiToken("t1")).toBe(false);
      expect((await store.getApiToken("t1"))!.revokedAt).toEqual(expect.any(String));
      expect((await store.listApiTokens()).map((x) => x.id)).toEqual(["t1", "t2"]);
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
