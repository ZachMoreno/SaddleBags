import { type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * A fake "GitHub" MCP server over real streamable HTTP, built with the
 * official SDK. Its tool description can be changed to simulate drift, and it
 * records the bearer token each call used.
 */
export async function fakeGithub(opts: { token?: string } = {}) {
  const state = {
    description: "Search issues in a repository",
    schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } as Record<string, unknown>,
    authSeen: [] as string[],
    calls: [] as unknown[],
  };

  const handle = async (req: Request): Promise<Response> => {
    const auth = req.headers.get("authorization") ?? "";
    state.authSeen.push(auth);
    if (opts.token && !auth.startsWith("Bearer ")) return new Response("unauthorized", { status: 401 });

    const server = new Server({ name: "fake-github", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "search_issues", description: state.description, inputSchema: state.schema as { type: "object" } },
        { name: "delete_repo", description: "Delete a repository", inputSchema: { type: "object", properties: {} } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      state.calls.push({ auth, args: r.params.arguments });
      const q = (r.params.arguments as { q?: string })?.q ?? "";
      return { content: [{ type: "text", text: `found 1 for ${q}` }], structuredContent: { hits: [q] } };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  };

  const node = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: handle, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = node.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    close: () => new Promise<void>((r) => node.close(() => r())),
  };
}
