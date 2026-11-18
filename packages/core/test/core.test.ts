import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineBag, reject, pass } from "@saddlebags/sdk";
import {
  FsArtifactStore,
  Harness,
  HarnessError,
  Lifecycle,
  Memory,
  MockProvider,
  SqliteStore,
  evalGate,
  extractJson,
  type EvalReport,
} from "../src/index.js";

const bag = defineBag({
  name: "test-bag",
  version: "1.0.0",
  routes: [
    { operation: "echo", model: "mock:m1" },
    { operation: "typed", model: "mock:m1", output: z.object({ n: z.number() }), maxAttempts: 2 },
  ],
  rules: [
    { id: "always", condition: { kind: "always" }, directive: { kind: "prose", text: "Be brief." } },
    {
      id: "only-typed",
      operations: ["typed"],
      condition: { kind: "code", when: (ctx) => (ctx.input as { big?: boolean }).big === true },
      directive: { kind: "prose", text: "Big mode." },
    },
    {
      id: "positive",
      operations: ["typed"],
      condition: { kind: "always" },
      directive: { kind: "enforce", check: (o: { n: number }) => (o.n > 0 ? pass() : reject("n must be > 0")) },
    },
  ],
});

const scope = { orgId: "acme", groupId: "brand", userId: "u1" };

describe("Harness", () => {
  it("injects prose directives and records why rules fired", async () => {
    const p = new MockProvider("mock", () => "hi");
    const h = new Harness({ bag, providers: [p] });
    const { output, trace } = await h.run("echo", "hello", { scope });
    expect(output).toBe("hi");
    expect(p.calls[0]!.system).toContain("[always] Be brief.");
    expect(trace.fired).toEqual([{ ruleId: "always", reason: "always" }]);
    expect(trace.scope).toBe("acme/brand/u1");
  });

  it("gates rules with code predicates", async () => {
    const p = new MockProvider("mock", () => '{"n": 1}');
    const h = new Harness({ bag, providers: [p] });
    const small = await h.run("typed", { big: false }, { scope });
    const big = await h.run("typed", { big: true }, { scope });
    expect(small.trace.fired.map((f) => f.ruleId)).not.toContain("only-typed");
    expect(big.trace.fired.map((f) => f.ruleId)).toContain("only-typed");
  });

  it("retries on enforce rejection, feeding back the reason, then fails loudly", async () => {
    const p = new MockProvider("mock", (_r, i) => (i === 0 ? '{"n": -1}' : '{"n": 5}'));
    const h = new Harness({ bag, providers: [p] });
    const ok = await h.run<{ n: number }>("typed", {}, { scope });
    expect(ok.output.n).toBe(5);
    expect(p.calls[1]!.messages.at(-1)!.content).toContain("[positive] n must be > 0");

    const bad = new Harness({ bag, providers: [new MockProvider("mock", () => '{"n": 0}')] });
    await expect(bad.run("typed", {}, { scope })).rejects.toBeInstanceOf(HarnessError);
    expect(bad.store.listTraces("typed")[0]!.ok).toBe(false);
  });

  it("treats schema failures as rejections", async () => {
    const p = new MockProvider("mock", (_r, i) => (i === 0 ? "not json" : '```json\n{"n": 2}\n```'));
    const h = new Harness({ bag, providers: [p] });
    const { trace } = await h.run("typed", {}, { scope });
    expect(trace.attempts[0]!.rejections[0]!.ruleId).toBe("schema");
  });

  it("requires a selector for model-decided rules and batches them in one call", async () => {
    const modelBag = defineBag({
      ...bag,
      rules: [
        { id: "a", condition: { kind: "model", description: "A" }, directive: { kind: "prose", text: "A!" } },
        { id: "b", condition: { kind: "model", description: "B" }, directive: { kind: "prose", text: "B!" } },
      ],
    });
    await expect(
      new Harness({ bag: modelBag, providers: [new MockProvider("mock", () => "x")] }).run("echo", "", { scope }),
    ).rejects.toThrow(/no rule selector/);

    const p = new MockProvider("mock", (req) =>
      req.system.startsWith("You decide") ? '{"ruleIds": ["b", "zzz"]}' : "ok",
    );
    const h = new Harness({ bag: modelBag, providers: [p], selectorModel: "mock:sel" });
    const { trace } = await h.run("echo", "", { scope });
    expect(trace.fired).toEqual([{ ruleId: "b", reason: "selector" }]);
    expect(p.calls.filter((c) => c.model === "sel")).toHaveLength(1);
  });

  it("only accepts prose overlays from the Stable", () => {
    const providers = [new MockProvider("mock", () => "")];
    expect(
      () =>
        new Harness({
          bag,
          providers,
          overlays: [{ id: "x", condition: { kind: "always" }, directive: { kind: "enforce", check: () => pass() } }],
        }),
    ).toThrow(/only prose/);
  });
});

describe("Memory", () => {
  it("applies the write policy per scope and merges narrower scopes over broader ones", async () => {
    const store = new SqliteStore();
    const mem = new Memory(store, {
      policy: { org: "review", user: "auto", group: { code: (p) => (p.value.includes("!") ? "reject" : "approve") } },
    });
    const model = { kind: "model" as const, operation: "op" };

    const org = await mem.propose({ scope: "org", scopeId: "acme", key: "tone", value: "formal", source: model });
    expect(org.entry).toBeUndefined();
    expect(store.listProposals("pending")).toHaveLength(1);

    await mem.propose({ scope: "group", scopeId: "brand", key: "x", value: "nope!", source: model });
    expect(store.listProposals("rejected")).toHaveLength(1);

    await mem.propose({ scope: "user", scopeId: "u1", key: "tone", value: "casual", source: model });
    mem.resolve(org.proposal.id, true, "reviewer");

    const loaded = mem.load(scope);
    expect(loaded.find((m) => m.key === "tone")?.value).toBe("casual");
    expect(store.listAudit().map((a) => a.action)).toContain("memory.approve");
  });

  it("defaults unspecified scopes to review", () => {
    expect(new Memory(new SqliteStore()).policyFor("org")).toBe("review");
  });
});

describe("Lifecycle", () => {
  const report = (version: string, passes: boolean[]): EvalReport => ({
    bag: "b",
    version,
    passRate: passes.filter(Boolean).length / passes.length,
    cases: passes.map((pass, i) => ({ caseId: `c${i}`, pass, graders: [] })),
  });

  it("blocks promotion on regressions and promotes otherwise", () => {
    const store = new SqliteStore();
    const lc = new Lifecycle(store);
    lc.installRc("b", "1.0.0", "ci");
    expect(lc.promote("b", report("1.0.0", [true, true]), "ci").ok).toBe(true);
    expect(lc.latest("b")).toBe("1.0.0");

    lc.installRc("b", "1.1.0", "ci");
    const gate = lc.promote("b", report("1.1.0", [true, false]), "ci", {
      baseline: report("1.0.0", [true, true]),
      minPassRate: 0.5,
    });
    expect(gate.ok).toBe(false);
    expect(gate.regressions).toEqual(["c1"]);
    expect(lc.latest("b")).toBe("1.0.0");
  });

  it("gates on minimum pass rate", () => {
    expect(evalGate(report("x", [true, false]), undefined, 0.75).ok).toBe(false);
  });
});

describe("FsArtifactStore", () => {
  it("content-addresses artifacts and tracks review status", async () => {
    const store = new FsArtifactStore(await mkdtemp(join(tmpdir(), "sb-")));
    const a = await store.put("clip", { operation: "render", contentType: "text/plain" });
    const b = await store.put("clip", { operation: "render", contentType: "text/plain" });
    expect(a.id).toBe(b.id);
    await store.setStatus(a.id, "approved");
    expect(await store.list({ status: "approved" })).toHaveLength(1);
    expect(new TextDecoder().decode((await store.get(a.id))!.body)).toBe("clip");
  });
});

describe("extractJson", () => {
  it("handles fences and preamble", () => {
    expect(extractJson('Sure:\n{"a":1}')).toEqual({ a: 1 });
  });
});
