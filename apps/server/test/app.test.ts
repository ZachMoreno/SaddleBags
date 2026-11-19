import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MockProvider, SqliteStore } from "@saddlebags/core";
import { defineBag, pass, reject } from "@saddlebags/sdk";
import { createApp, Runtime } from "../src/index.js";

const bag = defineBag({
  name: "@test/echo-bag",
  version: "1.0.0",
  routes: [
    { operation: "echo", model: "mock:m" },
    { operation: "count", model: "mock:m", output: z.object({ n: z.number() }), maxAttempts: 2 },
  ],
  rules: [
    {
      id: "positive",
      operations: ["count"],
      condition: { kind: "always" },
      directive: { kind: "enforce", check: (o: { n: number }) => (o.n > 0 ? pass() : reject("n must be > 0")) },
    },
  ],
  evals: [{ id: "e1", operation: "echo", input: "hi", graders: [{ kind: "code", name: "nonempty", assert: (o) => !!o }] }],
});

const scope = { orgId: "acme", userId: "u1" };

async function setup(token?: string) {
  const provider = new MockProvider("mock", (req) =>
    req.messages[0]!.role === "user" && req.messages[0]!.content.includes("neg") ? '{"n": -1}' : '{"n": 3}',
  );
  const rt = await Runtime.create({ bags: [bag], providers: [provider] }, "/", { store: new SqliteStore() });
  const app = createApp(rt, { token });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { rt, call };
}

const enc = encodeURIComponent(bag.name);

describe("HTTP API", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("refuses operations of uninstalled bags, serves rc on request, latest after promotion", async () => {
    const run = (channel?: string) => ctx.call("POST", "/operations/echo", { input: "hi", scope, channel });

    let res = await run();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not installed/);

    await ctx.rt.lifecycle.installRc(bag.name, "1.0.0", "test");
    expect((await run()).status).toBe(409);
    res = await run("rc");
    expect(res.status).toBe(200);
    const { output, traceId } = await res.json();
    expect(output).toBe('{"n": 3}');

    const trace = await (await ctx.call("GET", `/traces/${traceId}`)).json();
    expect(trace.operation).toBe("echo");

    expect((await ctx.call("POST", `/bags/${enc}/promote`, {})).status).toBe(409); // no eval run yet
    const report = await (await ctx.call("POST", `/bags/${enc}/evals`)).json();
    expect(report.passRate).toBe(1);
    const promoted = await ctx.call("POST", `/bags/${enc}/promote`, {});
    expect(promoted.status).toBe(200);
    expect((await run()).status).toBe(200);

    expect((await ctx.call("POST", `/bags/${enc}/unpublish`, { version: "1.0.0" })).status).toBe(200);
    expect((await run()).status).toBe(409);
  });

  it("returns 422 with the trace id when enforcement fails", async () => {
    await ctx.rt.lifecycle.installRc(bag.name, "1.0.0", "test");
    const res = await ctx.call("POST", "/operations/count", { input: "neg", scope, channel: "rc" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.rejections[0].ruleId).toBe("positive");
    const trace = await (await ctx.call("GET", `/traces/${body.traceId}`)).json();
    expect(trace.ok).toBe(false);
    expect((await (await ctx.call("GET", "/traces?operation=count")).json())).toHaveLength(1);
  });

  it("validates requests", async () => {
    expect((await ctx.call("POST", "/operations/nope", { input: 1, scope })).status).toBe(404);
    expect((await ctx.call("POST", "/operations/echo", { input: 1 })).status).toBe(400);
    expect((await ctx.call("GET", "/traces/missing")).status).toBe(404);
    expect((await ctx.call("GET", "/memory/proposals?status=bogus")).status).toBe(400);
  });

  it("reviews memory proposals", async () => {
    const { proposal } = await ctx.rt.memory.propose({
      scope: "org",
      scopeId: "acme",
      key: "tone",
      value: "warm",
      source: { kind: "model", operation: "echo" },
    });
    const pending = await (await ctx.call("GET", "/memory/proposals?status=pending")).json();
    expect(pending.map((p: { id: string }) => p.id)).toEqual([proposal.id]);

    const ok = await ctx.call("POST", `/memory/proposals/${proposal.id}/approve`, { reviewer: "dana" });
    expect((await ok.json()).entry.value).toBe("warm");
    expect((await ctx.call("POST", `/memory/proposals/${proposal.id}/reject`, { reviewer: "dana" })).status).toBe(409);
    expect((await ctx.call("POST", "/memory/proposals/missing/approve", { reviewer: "dana" })).status).toBe(404);
    expect((await ctx.rt.memory.load(scope))[0]!.value).toBe("warm");
  });
});

describe("HTTP API auth", () => {
  it("requires the bearer token everywhere except /health", async () => {
    const { call } = await setup("s3cret");
    expect((await call("GET", "/health")).status).toBe(200);
    expect((await call("GET", "/traces")).status).toBe(401);
    expect((await call("GET", "/traces", undefined, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await call("GET", "/traces", undefined, { authorization: "Bearer s3cret" })).status).toBe(200);
  });
});
