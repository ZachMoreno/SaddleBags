import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConnection } from "@saddlebags/core";
import type { McpServerDecl } from "@saddlebags/sdk";

export interface LiveTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CallResult {
  content: string;
  isError?: boolean;
  structured?: unknown;
}

/** Opens a transport for a declared server. Swappable for tests. */
export type TransportFactory = (decl: McpServerDecl, credential: string | undefined) => Transport;

export interface PoolOptions {
  /** Exact commands stdio servers may run. Empty: stdio servers are refused. */
  stdioAllowlist?: string[];
  /** How long a server's tool list is reused. Default 60s. */
  toolListTtlMs?: number;
  transportFactory?: TransportFactory;
}

interface Entry {
  client: Client;
  tools?: { at: number; list: LiveTool[] };
}

/**
 * One MCP client per connection, reused across runs. A re-connect (new
 * credential) gets a fresh client, since the key includes when the connection
 * was last written.
 */
export class ClientPool {
  private entries = new Map<string, Promise<Entry>>();
  private ttl: number;

  constructor(private opts: PoolOptions = {}) {
    this.ttl = opts.toolListTtlMs ?? 60_000;
  }

  async listTools(conn: McpConnection, decl: McpServerDecl, credential: string | undefined): Promise<LiveTool[]> {
    const entry = await this.entry(conn, decl, credential);
    if (entry.tools && Date.now() - entry.tools.at < this.ttl) return entry.tools.list;
    const list: LiveTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await entry.client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        list.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> });
      }
      cursor = page.nextCursor;
    } while (cursor);
    entry.tools = { at: Date.now(), list };
    return list;
  }

  async call(
    conn: McpConnection,
    decl: McpServerDecl,
    credential: string | undefined,
    tool: string,
    args: unknown,
  ): Promise<CallResult> {
    const { client } = await this.entry(conn, decl, credential);
    const res = await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> });
    const text = ((res.content as Array<{ type: string; text?: string }> | undefined) ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
      .join("\n");
    return {
      content: text,
      ...(res.isError === true && { isError: true }),
      ...(res.structuredContent !== undefined && { structured: res.structuredContent }),
    };
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(async (e) => (await e).client.close()));
  }

  private entry(conn: McpConnection, decl: McpServerDecl, credential: string | undefined): Promise<Entry> {
    const key = `${conn.id}@${conn.createdAt}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.open(decl, credential).then((client) => ({ client }));
      this.entries.set(key, entry);
      // Don't cache failures: the next run retries.
      entry.catch(() => this.entries.delete(key));
    }
    return entry;
  }

  private async open(decl: McpServerDecl, credential: string | undefined): Promise<Client> {
    const transport = this.opts.transportFactory?.(decl, credential) ?? this.transport(decl, credential);
    const client = new Client({ name: "saddlebags", version: "0.1.0" });
    await client.connect(transport);
    return client;
  }

  private transport(decl: McpServerDecl, credential: string | undefined): Transport {
    const t = decl.transport;
    if (t.kind === "http") {
      return new StreamableHTTPClientTransport(new URL(t.url), {
        requestInit: credential ? { headers: { Authorization: `Bearer ${credential}` } } : undefined,
      });
    }
    const allow = this.opts.stdioAllowlist ?? [];
    if (!allow.includes(t.command)) {
      throw new Error(
        `stdio MCP server "${decl.name}" runs "${t.command}", which isn't on the stdio allowlist (config mcp.stdioAllowlist)`,
      );
    }
    return new StdioClientTransport({
      command: t.command,
      args: t.args,
      env: { ...getDefaultEnvironment(), ...(credential && t.tokenEnv ? { [t.tokenEnv]: credential } : {}) },
      stderr: "inherit",
    });
  }
}
