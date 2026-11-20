// A tiny stdio MCP server for tests: reports the token it was given via env.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake-stdio", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "whoami", description: "Report the token", inputSchema: { type: "object", properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: `token=${process.env.FAKE_TOKEN ?? "none"}` }],
}));
await server.connect(new StdioServerTransport());
