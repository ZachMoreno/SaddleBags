import type { Plugin, OperationContext, Scope } from "@saddlebags/sdk";
import type { TraceNote } from "./store/types.js";

/**
 * A tool from outside the plugin, such as one served by a 3rd-party MCP server.
 * The harness runs it through the same path as a plugin tool: route allowlist,
 * argument validation, enforce-tool directives, errors back to the model.
 */
export interface ExternalTool {
  /** The name used in plugin code and rules: `<server>.<tool>`. */
  name: string;
  server: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The connection used, as `<scope>:<scopeId>`, for the trace. */
  connection: string;
  /** Validate arguments against `inputSchema`; return an error message or undefined. */
  validate(args: unknown): string | undefined;
  call(args: unknown): Promise<{ content: string; isError?: boolean; structured?: unknown }>;
}

export interface ExternalToolSet {
  tools: ExternalTool[];
  /** Tools left out of this run's offer (not connected, drifted, missing), and why. */
  notes: TraceNote[];
}

/** Resolves a route's MCP tools for one run. Implemented by @saddlebags/mcp. */
export interface ExternalToolResolver {
  /**
   * @param names the route's MCP tool names (`<server>.<tool>`)
   * @throws McpNotConnectedError if a required server has no connection for the caller's scope
   */
  resolve(plugin: Plugin, names: string[], ctx: OperationContext): Promise<ExternalToolSet>;
}

/** A required MCP server can't supply tools for this run. The operation fails before calling the model. */
export class McpResolveError extends Error {
  constructor(
    public server: string,
    message: string,
  ) {
    super(message);
    this.name = "McpResolveError";
  }
}

export class McpNotConnectedError extends McpResolveError {
  constructor(
    server: string,
    public scopes: Array<{ scope: Scope; scopeId: string }>,
  ) {
    const where = scopes.map((s) => `${s.scope}:${s.scopeId}`).join(", ") || "any allowed scope";
    super(server, `MCP server "${server}" is not connected for ${where}`);
    this.name = "McpNotConnectedError";
  }
}

/** The server is connected but couldn't be reached or listed. */
export class McpUnavailableError extends McpResolveError {
  constructor(server: string, cause: unknown) {
    super(server, `MCP server "${server}" is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "McpUnavailableError";
  }
}

/** Model-facing name for an MCP tool: providers don't allow dots. */
export function modelToolName(name: string): string {
  return name.replace(".", "__");
}

/** True for route tool names that refer to MCP tools (`<server>.<tool>`). */
export function isMcpToolName(name: string): boolean {
  return name.includes(".");
}
