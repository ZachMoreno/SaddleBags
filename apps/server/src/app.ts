import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { HarnessError } from "@saddlebags/core";
import { RuntimeError, type Runtime } from "./runtime.js";

export interface AppOptions {
  /** Bearer token required on every route except /health. Unset = no auth (local only). */
  token?: string;
}

const Scope = z.object({
  orgId: z.string().min(1),
  groupId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});

const RunBody = z.object({
  input: z.unknown(),
  scope: Scope,
  bag: z.string().optional(),
  channel: z.enum(["latest", "rc"]).optional(),
  history: z.array(z.object({ operation: z.string(), output: z.unknown() })).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const Review = z.object({ reviewer: z.string().min(1) });
const Promote = z.object({ version: z.string().optional(), minPassRate: z.number().min(0).max(1).optional() });
const Unpublish = z.object({ version: z.string() });

/** The runtime HTTP API. Mount it on any Hono-compatible server. */
export function createApp(runtime: Runtime, opts: AppOptions = {}): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof RuntimeError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: z.flattenError(err) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/health", async (c) =>
    c.json({
      ok: true,
      bags: await Promise.all(
        runtime.bags.map(async (b) => ({
          name: b.name,
          version: b.version,
          channel: (await runtime.lifecycle.channelOf(b.name, b.version)) ?? null,
        })),
      ),
    }),
  );

  if (opts.token) {
    const expected = Buffer.from(`Bearer ${opts.token}`);
    app.use("*", async (c, next) => {
      const got = Buffer.from(c.req.header("authorization") ?? "");
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      await next();
    });
  }

  // ─── Operations ─────────────────────────────────────────────────────────
  app.post("/operations/:name", async (c) => {
    const body = RunBody.parse(await c.req.json());
    const harness = await runtime.resolveOperation(c.req.param("name"), { bag: body.bag, channel: body.channel });
    try {
      const { output, trace } = await harness.run(c.req.param("name"), body.input, {
        scope: body.scope,
        history: body.history,
        meta: body.meta,
      });
      return c.json({ output, traceId: trace.id });
    } catch (e) {
      if (!(e instanceof HarnessError)) throw e;
      const last = e.trace.attempts.at(-1);
      return c.json({ error: e.message, traceId: e.trace.id, rejections: last?.rejections ?? [] }, 422);
    }
  });

  // ─── Traces ─────────────────────────────────────────────────────────────
  app.get("/traces", async (c) => {
    const limit = c.req.query("limit");
    return c.json(
      await runtime.store.listTraces({
        operation: c.req.query("operation"),
        limit: limit ? Math.min(Math.max(Number(limit) || 100, 1), 1000) : undefined,
      }),
    );
  });

  app.get("/traces/:id", async (c) => {
    const trace = await runtime.store.getTrace(c.req.param("id"));
    return trace ? c.json(trace) : c.json({ error: "Not found" }, 404);
  });

  // ─── Memory proposals ───────────────────────────────────────────────────
  app.get("/memory/proposals", async (c) => {
    const status = z.enum(["pending", "approved", "rejected"]).optional().parse(c.req.query("status"));
    return c.json(await runtime.store.listProposals(status));
  });

  const resolveProposal = (approve: boolean) => async (c: Context) => {
    const { reviewer } = Review.parse(await c.req.json());
    const id = c.req.param("id")!;
    const proposal = await runtime.store.getProposal(id);
    if (!proposal) return c.json({ error: `No memory proposal ${id}` }, 404);
    if (proposal.status !== "pending") return c.json({ error: `Proposal ${id} is already ${proposal.status}` }, 409);
    const entry = await runtime.memory.resolve(id, approve, reviewer);
    return c.json({ ok: true, entry: entry ?? null });
  };
  app.post("/memory/proposals/:id/approve", resolveProposal(true));
  app.post("/memory/proposals/:id/reject", resolveProposal(false));

  // ─── Bags & releases ────────────────────────────────────────────────────
  // Bag names are npm names, often scoped: URL-encode them (%40scope%2Fname).
  app.get("/bags", async (c) => c.json(await runtime.store.listInstalls()));

  app.post("/bags/:name/evals", async (c) => {
    const name = c.req.param("name");
    runtime.harness(name);
    return c.json(await runtime.evaluate(name));
  });

  app.post("/bags/:name/promote", async (c) => {
    const name = c.req.param("name");
    const body = Promote.parse(await c.req.json().catch(() => ({})));
    const version = body.version ?? runtime.harness(name).bag.version;
    const gate = await runtime.lifecycle.promoteFromStore(name, version, actor(c), {
      minPassRate: body.minPassRate ?? runtime.config.minPassRate,
    });
    return c.json({ version, ...gate }, gate.ok ? 200 : 409);
  });

  app.post("/bags/:name/unpublish", async (c) => {
    const { version } = Unpublish.parse(await c.req.json());
    await runtime.lifecycle.unpublish(c.req.param("name"), version, actor(c));
    return c.json({ ok: true });
  });

  return app;
}

function actor(c: Context): string {
  return `api:${c.req.header("x-saddlebags-actor") ?? "token"}`;
}
