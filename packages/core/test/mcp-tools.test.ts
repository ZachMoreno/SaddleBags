import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definePlugin, pass, reject, transform, type Plugin, type OperationContext } from "@saddlebags/sdk";
import {
  Harness,
  HarnessError,
  InputError,
  McpNotConnectedError,
  MockProvider,
  type ExternalTool,
  type ExternalToolResolver,
} from "../src/index.js";

const scope = { orgId: "acme", userId: "u1" };

function issueTool(calls: unknown[]): ExternalTool {
  return {
    name: "github.search_issues",
    server: "github",
    description: "Search issues",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    connection: "user:u1",
    validate: (a) => (typeof (a as { q?: unknown })?.q === "string" ? undefined : "q must be a string"),
    call: async (a) => {
      calls.push(a);
      const q = (a as { q: string }).q;
      return q.endsWith("boom") ? { content: "server error", isError: true } : { content: "", structured: { hits: [q] } };
    },
  };
}

function resolver(fn: (names: string[], ctx: OperationContext, plugin: Plugin) => ReturnType<ExternalToolResolver["resolve"]>) {
  const seen: string[][] = [];
  const r: ExternalToolResolver = {
    resolve: (plugin, names, ctx) => {
      seen.push(names);
      return fn(names, ctx, plugin);
    },
  };
  return { r, seen };
}

const plugin = definePlugin({
  name: "mcp-plugin",
  version: "1.0.0",
  tools: [{ name: "local", description: "Local", input: z.object({}), run: () => "local!" }],
  routes: [
    { operation: "ask", model: "mock:m", tools: ["local", "github.search_issues"], input: z.object({ question: z.string() }) },
    { operation: "plain", model: "mock:m" },
  ],
  rules: [
    {
      id: "no-secrets",
      condition: { kind: "always" },
      directive: {
        kind: "enforce-tool",
        tool: "github.search_issues",
        check: (a) => ((a as { q: string }).q.includes("secret") ? reject("no secret searches") : pass()),
      },
    },
    {
      id: "scope-repo",
      condition: { kind: "always" },
      directive: {
        kind: "enforce-tool",
        tool: "github.search_issues",
        check: (a) => {
          const q = (a as { q: string }).q;
          return q.startsWith("repo:") ? pass() : transform({ q: `repo:acme ${q}` });
        },
      },
    },
  ],
});

describe("MCP tools in the harness", () => {
  it("offers MCP tools under model-safe names and runs them through enforce-tool rules", async () => {
    const calls: unknown[] = [];
    const { r, seen } = resolver(async () => ({ tools: [issueTool(calls)], notes: [] }));
    const p = new MockProvider("mock", (_req, i) =>
      i === 0
        ? {
            toolCalls: [
              { id: "c1", name: "github__search_issues", args: { q: "bug" } },
              { id: "c2", name: "github__search_issues", args: { q: "secret keys" } },
              { id: "c3", name: "github__search_issues", args: { q: 1 } },
              { id: "c4", name: "github__search_issues", args: { q: "repo:x boom" } },
            ],
          }
        : "done",
    );
    const h = new Harness({ plugin, providers: [p], mcp: r });
    const { trace } = await h.run("ask", { question: "?" }, { scope, caller: "mcp:tok1" });

    expect(seen).toEqual([["github.search_issues"]]);
    expect(p.calls[0]!.tools!.map((t) => t.name)).toEqual(["local", "github__search_issues"]);
    const [ok, blocked, invalid, failed] = trace.attempts[0]!.toolCalls!;
    expect(ok).toMatchObject({
      name: "github.search_issues",
      args: { q: "repo:acme bug" },
      result: { hits: ["repo:acme bug"] },
      server: "github",
      connection: "user:u1",
    });
    expect(blocked).toMatchObject({ blockedBy: "no-secrets" });
    expect(invalid!.error).toMatch(/Invalid arguments: q must be a string/);
    expect(failed!.error).toBe("server error");
    expect(calls).toEqual([{ q: "repo:acme bug" }, { q: "repo:x boom" }]);
    expect(trace.caller).toBe("mcp:tok1");
  });

  it("records omitted tools as trace notes", async () => {
    const { r } = resolver(async () => ({
      tools: [],
      notes: [{ kind: "mcp.drift", server: "github", tool: "search_issues", detail: "description changed" }],
    }));
    const p = new MockProvider("mock", () => "ok");
    const { trace } = await new Harness({ plugin, providers: [p], mcp: r }).run("ask", { question: "?" }, { scope });
    expect(p.calls[0]!.tools!.map((t) => t.name)).toEqual(["local"]);
    expect(trace.notes).toEqual([{ kind: "mcp.drift", server: "github", tool: "search_issues", detail: "description changed" }]);
  });

  it("fails before calling the model when a required server isn't connected", async () => {
    const { r } = resolver(async () => {
      throw new McpNotConnectedError("github", [{ scope: "org", scopeId: "acme" }]);
    });
    const p = new MockProvider("mock", () => "ok");
    const h = new Harness({ plugin, providers: [p], mcp: r });
    const err = await h.run("ask", { question: "?" }, { scope }).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.message).toMatch(/"github" is not connected for org:acme/);
    expect(err.trace.ok).toBe(false);
    expect(err.trace.notes[0].kind).toBe("mcp.omitted");
    expect(p.calls).toHaveLength(0);
  });

  it("validates the route's input schema before anything runs", async () => {
    const p = new MockProvider("mock", () => "ok");
    const h = new Harness({ plugin, providers: [p], mcp: resolver(async () => ({ tools: [], notes: [] })).r });
    await expect(h.run("ask", { nope: 1 }, { scope })).rejects.toBeInstanceOf(InputError);
    expect(p.calls).toHaveLength(0);
  });

  it("doesn't call the resolver for routes without MCP tools, and requires one for routes with them", async () => {
    const { r, seen } = resolver(async () => ({ tools: [], notes: [] }));
    await new Harness({ plugin, providers: [new MockProvider("mock", () => "ok")], mcp: r }).run("plain", "x", { scope });
    expect(seen).toEqual([]);
    await expect(
      new Harness({ plugin, providers: [new MockProvider("mock", () => "ok")] }).run("ask", { question: "?" }, { scope }),
    ).rejects.toThrow(/no MCP resolver/);
  });

  it("rejects plugin tools whose names contain a dot", () => {
    const bad = definePlugin({ ...plugin, tools: [{ name: "a.b", description: "", input: z.object({}), run: () => 1 }] });
    expect(() => new Harness({ plugin: bad, providers: [] })).toThrow(/can't contain "\."/);
  });
});
