import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definePlugin, reject, pass } from "@saddlebags/sdk";
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

const plugin = definePlugin({
  name: "test-plugin",
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
    const h = new Harness({ plugin, providers: [p] });
    const { output, trace } = await h.run("echo", "hello", { scope });
    expect(output).toBe("hi");
    expect(p.calls[0]!.system).toContain("[always] Be brief.");
    expect(trace.fired).toEqual([{ ruleId: "always", reason: "always" }]);
    expect(trace.scope).toBe("acme/brand/u1");
  });

  it("gates rules with code predicates", async () => {
    const p = new MockProvider("mock", () => '{"n": 1}');
    const h = new Harness({ plugin, providers: [p] });
    const small = await h.run("typed", { big: false }, { scope });
    const big = await h.run("typed", { big: true }, { scope });
    expect(small.trace.fired.map((f) => f.ruleId)).not.toContain("only-typed");
    expect(big.trace.fired.map((f) => f.ruleId)).toContain("only-typed");
  });

  it("retries on enforce rejection, feeding back the reason, then fails loudly", async () => {
    const p = new MockProvider("mock", (_r, i) => (i === 0 ? '{"n": -1}' : '{"n": 5}'));
    const h = new Harness({ plugin, providers: [p] });
    const ok = await h.run<{ n: number }>("typed", {}, { scope });
    expect(ok.output.n).toBe(5);
    expect(p.calls[1]!.messages.at(-1)!.content).toContain("[positive] n must be > 0");

    const bad = new Harness({ plugin, providers: [new MockProvider("mock", () => '{"n": 0}')] });
    await expect(bad.run("typed", {}, { scope })).rejects.toBeInstanceOf(HarnessError);
    expect((await bad.store.listTraces({ operation: "typed" }))[0]!.ok).toBe(false);
  });

  it("treats schema failures as rejections", async () => {
    const p = new MockProvider("mock", (_r, i) => (i === 0 ? "not json" : '```json\n{"n": 2}\n```'));
    const h = new Harness({ plugin, providers: [p] });
    const { trace } = await h.run("typed", {}, { scope });
    expect(trace.attempts[0]!.rejections[0]!.ruleId).toBe("schema");
  });

  it("requires a selector for model-decided rules and batches them in one call", async () => {
    const modelPlugin = definePlugin({
      ...plugin,
      rules: [
        { id: "a", condition: { kind: "model", description: "A" }, directive: { kind: "prose", text: "A!" } },
        { id: "b", condition: { kind: "model", description: "B" }, directive: { kind: "prose", text: "B!" } },
      ],
    });
    await expect(
      new Harness({ plugin: modelPlugin, providers: [new MockProvider("mock", () => "x")] }).run("echo", "", { scope }),
    ).rejects.toThrow(/no rule selector/);

    const p = new MockProvider("mock", (req) =>
      req.system.startsWith("You decide") ? '{"ruleIds": ["b", "zzz"]}' : "ok",
    );
    const h = new Harness({ plugin: modelPlugin, providers: [p], selectorModel: "mock:sel" });
    const { trace } = await h.run("echo", "", { scope });
    expect(trace.fired).toEqual([{ ruleId: "b", reason: "selector" }]);
    expect(p.calls.filter((c) => c.model === "sel")).toHaveLength(1);
  });

  it("only accepts prose overlays from the Admin", () => {
    const providers = [new MockProvider("mock", () => "")];
    expect(
      () =>
        new Harness({
          plugin,
          providers,
          overlays: [{ id: "x", condition: { kind: "always" }, directive: { kind: "enforce", check: () => pass() } }],
        }),
    ).toThrow(/only prose/);
  });
});

describe("Harness tool loop", () => {
  const toolPlugin = definePlugin({
    name: "tool-plugin",
    version: "1.0.0",
    tools: [
      {
        name: "add",
        description: "Add two numbers",
        input: z.object({ a: z.number(), b: z.number() }),
        run: ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
      },
      { name: "secret", description: "Not offered", input: z.object({}), run: () => "s3cret" },
      {
        name: "boom",
        description: "Throws",
        input: z.object({}),
        run: () => {
          throw new Error("kaboom");
        },
      },
    ],
    routes: [
      {
        operation: "calc",
        model: "mock:m",
        output: z.object({ answer: z.number() }),
        tools: ["add", "boom"],
        maxToolTurns: 3,
      },
    ],
    rules: [
      {
        id: "no-negatives",
        condition: { kind: "always" },
        directive: {
          kind: "enforce-tool",
          tool: "add",
          check: (args) => ((args as { a: number }).a < 0 ? reject("negative a") : pass()),
        },
      },
      {
        id: "double-b",
        condition: { kind: "always" },
        directive: {
          kind: "enforce-tool",
          tool: "add",
          check: (args) => {
            const a = args as { a: number; b: number };
            return a.b === 100 ? { action: "transform", value: { ...a, b: 200 } } : pass();
          },
        },
      },
    ],
  });

  it("offers only the route's tools, runs calls, and feeds results back", async () => {
    const p = new MockProvider("mock", (_req, i) =>
      i === 0
        ? { toolCalls: [{ id: "c1", name: "add", args: { a: 2, b: 3 } }] }
        : '{"answer": 5}',
    );
    const h = new Harness({ plugin: toolPlugin, providers: [p] });
    const { output, trace } = await h.run<{ answer: number }>("calc", "2+3?", { scope });

    expect(output.answer).toBe(5);
    expect(p.calls[0]!.tools!.map((t) => t.name)).toEqual(["add", "boom"]);
    expect(p.calls[0]!.tools![0]!.inputSchema).toMatchObject({ type: "object" });
    const second = p.calls[1]!.messages;
    expect(second[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "c1", name: "add" }] });
    expect(second[2]).toEqual({ role: "tool", results: [{ callId: "c1", name: "add", content: '{"sum":5}', isError: false }] });
    expect(trace.attempts[0]!.toolCalls).toEqual([{ id: "c1", name: "add", args: { a: 2, b: 3 }, result: { sum: 5 } }]);
  });

  it("returns blocks, bad args, unoffered tools and thrown errors to the model as errors", async () => {
    const p = new MockProvider("mock", (_req, i) =>
      i === 0
        ? {
            toolCalls: [
              { id: "c1", name: "add", args: { a: -1, b: 1 } },
              { id: "c2", name: "add", args: { a: "x" } },
              { id: "c3", name: "secret", args: {} },
              { id: "c4", name: "boom", args: {} },
            ],
          }
        : '{"answer": 0}',
    );
    const h = new Harness({ plugin: toolPlugin, providers: [p] });
    const { trace } = await h.run("calc", "", { scope });
    const [blocked, invalid, unoffered, thrown] = trace.attempts[0]!.toolCalls!;

    expect(blocked).toMatchObject({ blockedBy: "no-negatives", error: expect.stringContaining("negative a") });
    expect(invalid!.error).toMatch(/Invalid arguments/);
    expect(unoffered!.error).toMatch(/not available/);
    expect(thrown!.error).toBe("kaboom");
    const results = (p.calls[1]!.messages[2] as { results: Array<{ isError: boolean }> }).results;
    expect(results.every((r) => r.isError)).toBe(true);
  });

  it("applies enforce-tool transforms before running and records the executed args", async () => {
    const p = new MockProvider("mock", (_req, i) =>
      i === 0 ? { toolCalls: [{ id: "c1", name: "add", args: { a: 1, b: 100 } }] } : '{"answer": 201}',
    );
    const { trace } = await new Harness({ plugin: toolPlugin, providers: [p] }).run("calc", "", { scope });
    expect(trace.attempts[0]!.toolCalls![0]).toMatchObject({ args: { a: 1, b: 200 }, result: { sum: 201 } });
  });

  it("fails loudly when the model exceeds maxToolTurns", async () => {
    const p = new MockProvider("mock", () => ({ toolCalls: [{ id: "c", name: "add", args: { a: 1, b: 1 } }] }));
    const h = new Harness({ plugin: toolPlugin, providers: [p] });
    await expect(h.run("calc", "", { scope })).rejects.toThrow(/exceeded 3 tool turns/);
    expect(p.calls).toHaveLength(4);
    expect((await h.store.listTraces({ operation: "calc" }))[0]!.ok).toBe(false);
  });

  it("rejects routes that offer unknown tools", async () => {
    const bad = definePlugin({ ...toolPlugin, routes: [{ operation: "x", model: "mock:m", tools: ["nope"] }] });
    await expect(
      new Harness({ plugin: bad, providers: [new MockProvider("mock", () => "")] }).run("x", "", { scope }),
    ).rejects.toThrow(/unknown tool "nope"/);
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
    expect(await store.listProposals("pending")).toHaveLength(1);

    await mem.propose({ scope: "group", scopeId: "brand", key: "x", value: "nope!", source: model });
    expect(await store.listProposals("rejected")).toHaveLength(1);

    await mem.propose({ scope: "user", scopeId: "u1", key: "tone", value: "casual", source: model });
    await mem.resolve(org.proposal.id, true, "reviewer");

    const loaded = await mem.load(scope);
    expect(loaded.find((m) => m.key === "tone")?.value).toBe("casual");
    expect((await store.listAudit()).map((a) => a.action)).toContain("memory.approve");
  });

  it("defaults unspecified scopes to review", () => {
    expect(new Memory(new SqliteStore()).policyFor("org")).toBe("review");
  });
});

describe("Lifecycle", () => {
  const report = (version: string, passes: boolean[]): EvalReport => ({
    plugin: "b",
    version,
    passRate: passes.filter(Boolean).length / passes.length,
    cases: passes.map((pass, i) => ({ caseId: `c${i}`, pass, graders: [] })),
  });

  it("blocks promotion on regressions and promotes otherwise", async () => {
    const store = new SqliteStore();
    const lc = new Lifecycle(store);
    await lc.installRc("b", "1.0.0", "ci");
    expect((await lc.promote("b", report("1.0.0", [true, true]), "ci")).ok).toBe(true);
    expect(await lc.latest("b")).toBe("1.0.0");

    await lc.installRc("b", "1.1.0", "ci");
    const gate = await lc.promote("b", report("1.1.0", [true, false]), "ci", {
      baseline: report("1.0.0", [true, true]),
      minPassRate: 0.5,
    });
    expect(gate.ok).toBe(false);
    expect(gate.regressions).toEqual(["c1"]);
    expect(await lc.latest("b")).toBe("1.0.0");
  });

  it("promotes from stored eval runs against the current latest", async () => {
    const store = new SqliteStore();
    const lc = new Lifecycle(store);
    expect((await lc.promoteFromStore("b", "1.0.0", "ci")).reasons[0]).toMatch(/No eval run/);

    await store.putEvalRun(report("1.0.0", [true, true]));
    expect((await lc.promoteFromStore("b", "1.0.0", "ci")).ok).toBe(true);

    await store.putEvalRun(report("1.1.0", [true, false]));
    const blocked = await lc.promoteFromStore("b", "1.1.0", "ci", { minPassRate: 0.5 });
    expect(blocked.regressions).toEqual(["c1"]);

    await store.putEvalRun(report("1.1.0", [true, true]));
    expect((await lc.promoteFromStore("b", "1.1.0", "ci")).ok).toBe(true);
    expect(await lc.latest("b")).toBe("1.1.0");
    expect(await lc.channelOf("b", "1.0.0")).toBe("unpublished");
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
