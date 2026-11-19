import type { McpConnection, Store } from "@saddlebags/core";
import { SCOPES, type Bag, type McpServerDecl, type Scope, type ScopeRef } from "@saddlebags/sdk";
import type { Secrets } from "./secrets.js";

const NAME = /^[A-Za-z0-9_-]+$/;

/** Find a bag's declaration of a server, or throw. */
export function serverDecl(bag: Bag, server: string): McpServerDecl {
  const decl = bag.mcp?.servers.find((s) => s.name === server);
  if (!decl) throw new Error(`Bag ${bag.name} declares no MCP server "${server}"`);
  return decl;
}

/** Check a bag's MCP declarations and that every route's MCP tools name a declared server. */
export function validateBagMcp(bag: Bag): void {
  const names = new Set<string>();
  for (const s of bag.mcp?.servers ?? []) {
    if (!NAME.test(s.name)) throw new Error(`Bag ${bag.name}: MCP server name "${s.name}" must match ${NAME}`);
    if (s.name.includes("__")) throw new Error(`Bag ${bag.name}: MCP server name "${s.name}" can't contain "__"`);
    if (names.has(s.name)) throw new Error(`Bag ${bag.name}: MCP server "${s.name}" is declared twice`);
    names.add(s.name);
    if (s.transport.kind === "stdio" && s.auth !== "none" && !s.transport.tokenEnv) {
      throw new Error(`Bag ${bag.name}: stdio MCP server "${s.name}" needs transport.tokenEnv for auth "${s.auth}"`);
    }
  }
  for (const route of bag.routes) {
    for (const t of route.tools ?? []) {
      if (!t.includes(".")) continue;
      const [server, tool, ...rest] = t.split(".");
      if (!server || !tool || rest.length) {
        throw new Error(`Route ${route.operation}: MCP tool "${t}" must be "<server>.<tool>"`);
      }
      if (!names.has(server)) throw new Error(`Route ${route.operation}: "${t}" names undeclared MCP server "${server}"`);
    }
  }
}

/** Scopes, narrowest first, at which a server may be connected for this caller. */
export function candidateScopes(decl: McpServerDecl, ref: ScopeRef): Array<{ scope: Scope; scopeId: string }> {
  const allowed = new Set(decl.connectAt ?? ["org"]);
  const ids: Record<Scope, string | undefined> = { org: ref.orgId, group: ref.groupId, user: ref.userId };
  return [...SCOPES]
    .reverse()
    .filter((s) => allowed.has(s) && ids[s])
    .map((scope) => ({ scope, scopeId: ids[scope]! }));
}

export function aadFor(c: Pick<McpConnection, "bag" | "server" | "scope" | "scopeId">): string {
  return `saddlebags:mcp:${c.bag}:${c.server}:${c.scope}:${c.scopeId}`;
}

/**
 * Admin-facing management of connections: who connected which bag's server,
 * at which scope, with which (encrypted) credential.
 */
export class Connections {
  constructor(
    private store: Store,
    private secrets?: Secrets,
  ) {}

  async connect(opts: {
    bag: Bag;
    server: string;
    scope: Scope;
    scopeId: string;
    credential?: string;
    by: string;
  }): Promise<McpConnection> {
    const decl = serverDecl(opts.bag, opts.server);
    const allowed = decl.connectAt ?? ["org"];
    if (!allowed.includes(opts.scope)) {
      throw new Error(`MCP server "${opts.server}" can be connected at ${allowed.join(", ")}, not ${opts.scope}`);
    }
    let credential: string | null = null;
    const target = { bag: opts.bag.name, server: opts.server, scope: opts.scope, scopeId: opts.scopeId };
    if (decl.auth === "none") {
      if (opts.credential) throw new Error(`MCP server "${opts.server}" uses auth "none"; don't pass a credential`);
    } else {
      if (!opts.credential) throw new Error(`MCP server "${opts.server}" uses auth "${decl.auth}"; a credential is required`);
      if (!this.secrets) throw new Error("Set SADDLEBAGS_SECRET_KEY to store MCP credentials (openssl rand -hex 32)");
      credential = this.secrets.encrypt(opts.credential, aadFor(target));
    }
    const conn = await this.store.putConnection({ ...target, credential, createdBy: opts.by });
    await this.store.audit({
      actor: opts.by,
      action: "mcp.connect",
      subject: `${opts.bag.name}:${opts.server}@${opts.scope}:${opts.scopeId}`,
    });
    return conn;
  }

  async disconnect(id: string, by: string): Promise<boolean> {
    const conn = (await this.store.listConnections()).find((c) => c.id === id);
    const ok = await this.store.deleteConnection(id);
    if (ok && conn) {
      await this.store.audit({
        actor: by,
        action: "mcp.disconnect",
        subject: `${conn.bag}:${conn.server}@${conn.scope}:${conn.scopeId}`,
      });
    }
    return ok;
  }

  /** The narrowest connection for this caller, if any. */
  async resolve(bag: Bag, decl: McpServerDecl, ref: ScopeRef): Promise<McpConnection | undefined> {
    const conns = await this.store.listConnections({ bag: bag.name, server: decl.name });
    for (const c of candidateScopes(decl, ref)) {
      const hit = conns.find((x) => x.scope === c.scope && x.scopeId === c.scopeId);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Any connection for a server, broadest first (used for pinning, which isn't caller-specific). */
  async any(bag: Bag, server: string): Promise<McpConnection | undefined> {
    const conns = await this.store.listConnections({ bag: bag.name, server });
    const order: Scope[] = ["org", "group", "user"];
    return conns.sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope))[0];
  }

  credentialFor(conn: McpConnection): string | undefined {
    if (conn.credential === null) return undefined;
    if (!this.secrets) throw new Error("SADDLEBAGS_SECRET_KEY is not set; can't decrypt MCP credentials");
    return this.secrets.decrypt(conn.credential, aadFor(conn));
  }
}
