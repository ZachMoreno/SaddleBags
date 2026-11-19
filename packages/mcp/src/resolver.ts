import { Ajv, type ValidateFunction } from "ajv";
import {
  McpNotConnectedError,
  McpUnavailableError,
  type ExternalTool,
  type ExternalToolResolver,
  type ExternalToolSet,
  type McpConnection,
  type McpPin,
  type PinnedTool,
  type Store,
  type TraceNote,
} from "@saddlebags/core";
import type { Bag, McpServerDecl, OperationContext } from "@saddlebags/sdk";
import { Connections, candidateScopes, serverDecl } from "./connections.js";
import type { ClientPool, LiveTool } from "./pool.js";
import { hashJson } from "./secrets.js";

/** Snapshot a server's live tools as pinned definitions. */
export function snapshot(tools: LiveTool[]): PinnedTool[] {
  return tools
    .map((t) => ({ name: t.name, description: t.description ?? "", schemaHash: hashJson(t.inputSchema) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a live tool differs from its pin, or undefined if it matches. */
export function driftOf(live: LiveTool, pinned: PinnedTool | undefined): string | undefined {
  if (!pinned) return "not in the pinned definitions";
  const changes: string[] = [];
  if ((live.description ?? "") !== pinned.description) changes.push("description changed");
  if (hashJson(live.inputSchema) !== pinned.schemaHash) changes.push("input schema changed");
  return changes.length ? changes.join(", ") : undefined;
}

export interface ResolverOptions {
  store: Store;
  connections: Connections;
  pool: ClientPool;
  /**
   * Use live definitions even where they drifted from the pin. Only for
   * re-pin eval runs, which test the live definitions before they're pinned.
   */
  ignorePins?: boolean;
}

/**
 * Resolves a route's MCP tools for one run (§4.11): finds the caller's
 * narrowest connection per server, lists the live tools, and withholds any
 * that drifted from the bag version's pin.
 */
export class McpToolResolver implements ExternalToolResolver {
  private ajv = new Ajv({ strict: false, allErrors: true });
  private validators = new Map<string, ValidateFunction>();

  constructor(private opts: ResolverOptions) {}

  withIgnorePins(): McpToolResolver {
    return new McpToolResolver({ ...this.opts, ignorePins: true });
  }

  async resolve(bag: Bag, names: string[], ctx: OperationContext): Promise<ExternalToolSet> {
    const byServer = new Map<string, string[]>();
    for (const n of names) {
      const [server, tool] = n.split(".") as [string, string];
      byServer.set(server, [...(byServer.get(server) ?? []), tool]);
    }
    const pins = new Map((await this.opts.store.listPins(bag.name, bag.version)).map((p) => [p.server, p] as const));

    const tools: ExternalTool[] = [];
    const notes: TraceNote[] = [];
    for (const [server, wanted] of byServer) {
      const decl = serverDecl(bag, server);
      const omit = (detail: string) => wanted.forEach((tool) => notes.push({ kind: "mcp.omitted", server, tool, detail }));

      const conn = await this.opts.connections.resolve(bag, decl, ctx.scope);
      if (!conn) {
        if (!decl.optional) throw new McpNotConnectedError(server, candidateScopes(decl, ctx.scope));
        omit("not connected for this caller's scope (optional server)");
        continue;
      }

      let live: LiveTool[];
      let credential: string | undefined;
      try {
        credential = this.opts.connections.credentialFor(conn);
        live = await this.opts.pool.listTools(conn, decl, credential);
      } catch (e) {
        if (!decl.optional) throw new McpUnavailableError(server, e);
        omit(`unavailable: ${(e as Error).message}`);
        continue;
      }

      const pin = pins.get(server);
      if (!pin && !this.opts.ignorePins) {
        notes.push({ kind: "mcp.unpinned", server, detail: `no pin for ${bag.name}@${bag.version}; using live definitions` });
      }
      for (const name of wanted) {
        const t = live.find((x) => x.name === name);
        if (!t) {
          notes.push({ kind: "mcp.omitted", server, tool: name, detail: "the server doesn't offer this tool" });
          continue;
        }
        const drift = pin && !this.opts.ignorePins ? driftOf(t, pin.tools.find((p) => p.name === name)) : undefined;
        if (drift) {
          notes.push({ kind: "mcp.drift", server, tool: name, detail: `${drift}; withheld until re-pinned` });
          continue;
        }
        tools.push(this.externalTool(decl, conn, credential, t));
      }
    }
    return { tools, notes };
  }

  /**
   * Pin each declared server's live tools for this bag version. Uses any
   * connection for the server, since definitions aren't caller-specific.
   * Returns the servers it couldn't pin, and why.
   */
  async pin(bag: Bag): Promise<{ pinned: McpPin["server"][]; skipped: Array<{ server: string; reason: string }> }> {
    const pinned: string[] = [];
    const skipped: Array<{ server: string; reason: string }> = [];
    for (const decl of bag.mcp?.servers ?? []) {
      const conn = await this.opts.connections.any(bag, decl.name);
      if (!conn) {
        skipped.push({ server: decl.name, reason: "not connected at any scope" });
        continue;
      }
      try {
        const live = await this.opts.pool.listTools(conn, decl, this.opts.connections.credentialFor(conn));
        await this.opts.store.setPin({ bag: bag.name, version: bag.version, server: decl.name, tools: snapshot(live) });
        pinned.push(decl.name);
      } catch (e) {
        skipped.push({ server: decl.name, reason: (e as Error).message });
      }
    }
    return { pinned, skipped };
  }

  /** Compare every declared server's live tools with its pin (for status displays). */
  async drift(bag: Bag): Promise<Array<{ server: string; tool: string; detail: string }>> {
    const out: Array<{ server: string; tool: string; detail: string }> = [];
    const pins = await this.opts.store.listPins(bag.name, bag.version);
    for (const pin of pins) {
      const decl = bag.mcp?.servers.find((s) => s.name === pin.server);
      const conn = decl && (await this.opts.connections.any(bag, pin.server));
      if (!decl || !conn) continue;
      const live = await this.opts.pool.listTools(conn, decl, this.opts.connections.credentialFor(conn));
      for (const p of pin.tools) {
        const t = live.find((x) => x.name === p.name);
        const d = t ? driftOf(t, p) : "removed from the server";
        if (d) out.push({ server: pin.server, tool: p.name, detail: d });
      }
    }
    return out;
  }

  private externalTool(
    decl: McpServerDecl,
    conn: McpConnection,
    credential: string | undefined,
    t: LiveTool,
  ): ExternalTool {
    const validator = this.validator(t.inputSchema);
    return {
      name: `${decl.name}.${t.name}`,
      server: decl.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      connection: `${conn.scope}:${conn.scopeId}`,
      validate: (args) => (validator(args) ? undefined : this.ajv.errorsText(validator.errors, { dataVar: "args" })),
      call: (args) => this.opts.pool.call(conn, decl, credential, t.name, args),
    };
  }

  private validator(schema: Record<string, unknown>): ValidateFunction {
    const key = hashJson(schema);
    let v = this.validators.get(key);
    if (!v) {
      try {
        v = this.ajv.compile(schema);
      } catch {
        // A schema Ajv can't compile still shouldn't block the tool; the server validates too.
        v = Object.assign(() => true, { errors: null }) as unknown as ValidateFunction;
      }
      this.validators.set(key, v);
    }
    return v;
  }
}
