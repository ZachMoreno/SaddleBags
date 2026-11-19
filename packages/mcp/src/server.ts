import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** A tool served on the 1st-party /mcp endpoint. */
export interface ExposedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  run(args: unknown): Promise<{ text: string; structured?: Record<string, unknown>; isError?: boolean }>;
}

export interface McpHandlerOptions {
  /** Tools for this request (already filtered to what the caller may see). */
  tools: ExposedTool[];
  serverInfo?: { name: string; version: string };
}

/**
 * Handle one streamable-HTTP MCP request, statelessly: a fresh server and
 * transport per request, so the caller's identity (resolved by the host
 * before this call) can't leak between requests. JSON responses, no SSE.
 */
export async function handleMcpRequest(req: Request, opts: McpHandlerOptions): Promise<Response> {
  const server = new Server(opts.serverInfo ?? { name: "saddlebags", version: "0.1.0" }, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
      ...(t.outputSchema && { outputSchema: t.outputSchema as { type: "object"; [k: string]: unknown } }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = opts.tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool "${request.params.name}"` }], isError: true };
    }
    const res = await tool.run(request.params.arguments ?? {});
    return {
      content: [{ type: "text", text: res.text }],
      ...(res.structured && !res.isError && { structuredContent: res.structured }),
      ...(res.isError && { isError: true }),
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
