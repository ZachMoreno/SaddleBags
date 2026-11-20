import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  Harness,
  HarnessError,
  InputError,
  Lifecycle,
  Memory,
  SqliteStore,
  evalGate,
  runEvals,
  type EvalReport,
  type GateResult,
  type Store,
} from "@saddlebags/core";
import {
  ApiTokens,
  ClientPool,
  Connections,
  McpToolResolver,
  Secrets,
  validatePluginMcp,
  type ExposedTool,
} from "@saddlebags/mcp";
import { providersFromEnv } from "@saddlebags/providers";
import type { Plugin, ModelProvider, ModelRoute, ScopeRef } from "@saddlebags/sdk";
import { importPlugin, type SaddlebagsConfig, type StoreConfig } from "./config.js";

export type ServeChannel = "latest" | "rc";

export class RuntimeError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

/**
 * Everything a server or CLI command needs: the store, the loaded plugins (one
 * Harness each) and the release lifecycle.
 */
export interface RuntimeOptions {
  store?: Store;
  /** Default: `SADDLEBAGS_SECRET_KEY` from the environment. */
  secrets?: Secrets;
  /** Default: a pool built from `config.mcp`. Tests pass one with an in-memory transport. */
  pool?: ClientPool;
}

/** What `promote` did: the eval gate, and the MCP pins it recorded. */
export interface PromoteResult extends GateResult {
  version: string;
  pins?: { pinned: string[]; skipped: Array<{ server: string; reason: string }> };
}

/**
 * Everything a server or CLI command needs: the store, the loaded plugins (one
 * Harness each), the release lifecycle, and MCP connections and tokens.
 */
export class Runtime {
  readonly lifecycle: Lifecycle;
  readonly memory: Memory;
  readonly connections: Connections;
  readonly tokens: ApiTokens;
  readonly mcp: McpToolResolver;
  private pool: ClientPool;
  private harnesses = new Map<string, Harness>();
  private exposed = new Map<string, { plugin: string; route: ModelRoute }>();

  private constructor(
    readonly config: SaddlebagsConfig,
    readonly store: Store,
    readonly providers: ModelProvider[],
    plugins: Plugin[],
    opts: RuntimeOptions,
  ) {
    this.lifecycle = new Lifecycle(store);
    this.memory = new Memory(store);
    this.connections = new Connections(store, opts.secrets ?? Secrets.fromEnv());
    this.tokens = new ApiTokens(store);
    this.pool =
      opts.pool ??
      new ClientPool({ stdioAllowlist: config.mcp?.stdioAllowlist, toolListTtlMs: config.mcp?.toolListTtlMs });
    this.mcp = new McpToolResolver({ store, connections: this.connections, pool: this.pool });

    for (const plugin of plugins) {
      if (this.harnesses.has(plugin.name)) throw new Error(`Plugin "${plugin.name}" is listed twice`);
      validatePluginMcp(plugin);
      this.harnesses.set(plugin.name, this.makeHarness(plugin, this.mcp));
      for (const route of plugin.routes) {
        if (!route.mcp?.expose) continue;
        const name = mcpToolName(plugin, route);
        const clash = this.exposed.get(name);
        if (clash) throw new Error(`MCP tool name "${name}" is used by ${clash.plugin} and ${plugin.name}; set route.mcp.name`);
        if (!route.input || (z.toJSONSchema(route.input, { io: "input" }) as { type?: string }).type !== "object") {
          throw new Error(`${plugin.name}: route ${route.operation} is exposed over MCP, so it needs an object \`input\` schema`);
        }
        this.exposed.set(name, { plugin: plugin.name, route });
      }
    }
  }

  static async create(config: SaddlebagsConfig, root: string, opts: RuntimeOptions = {}): Promise<Runtime> {
    const store = opts.store ?? (await openStore(config.store, root));
    const providers = config.providers === undefined || config.providers === "env" ? providersFromEnv() : config.providers;
    const plugins = await Promise.all(config.plugins.map((b) => (typeof b === "string" ? importPlugin(b, root) : b)));
    return new Runtime(config, store, providers, plugins, opts);
  }

  private makeHarness(plugin: Plugin, mcp: McpToolResolver): Harness {
    return new Harness({ plugin, providers: this.providers, store: this.store, selectorModel: this.config.selectorModel, mcp });
  }

  get plugins(): Plugin[] {
    return [...this.harnesses.values()].map((h) => h.plugin);
  }

  harness(pluginName: string): Harness {
    const h = this.harnesses.get(pluginName);
    if (!h) throw new RuntimeError(`Plugin "${pluginName}" is not in the config`, 404);
    return h;
  }

  /**
   * Find the plugin serving an operation and check it may be served on the
   * requested channel. M2 serves the one installed version of each plugin.
   */
  async resolveOperation(operation: string, opts: { plugin?: string; channel?: ServeChannel } = {}): Promise<Harness> {
    const candidates = [...this.harnesses.values()].filter(
      (h) => (!opts.plugin || h.plugin.name === opts.plugin) && h.plugin.routes.some((r) => r.operation === operation),
    );
    if (candidates.length === 0) {
      throw new RuntimeError(`No plugin${opts.plugin ? ` "${opts.plugin}"` : ""} serves operation "${operation}"`, 404);
    }
    if (candidates.length > 1) {
      throw new RuntimeError(
        `Operation "${operation}" is served by ${candidates.map((h) => h.plugin.name).join(", ")}; pass "plugin"`,
        400,
      );
    }
    const h = candidates[0]!;
    const channel = await this.lifecycle.channelOf(h.plugin.name, h.plugin.version);
    const wanted = opts.channel ?? "latest";
    if (channel !== wanted) {
      throw new RuntimeError(
        `${h.plugin.name}@${h.plugin.version} is ${channel ? `on channel "${channel}"` : "not installed"}, ` +
          `not "${wanted}". ` +
          (channel ? "Promote it, or request the rc channel." : `Run \`saddlebags install ${h.plugin.name}\`.`),
        409,
      );
    }
    return h;
  }

  /** Run a plugin's evals with the configured providers as judges, and store the run. */
  async evaluate(
    pluginName: string,
    opts: { actor?: string; ignorePins?: boolean; scope?: ScopeRef } = {},
  ): Promise<EvalReport> {
    const h = this.harness(pluginName);
    const harness = opts.ignorePins ? this.makeHarness(h.plugin, this.mcp.withIgnorePins()) : h;
    const report = await runEvals(harness, {
      judges: this.providers,
      scope: opts.scope ?? this.config.evalScope ?? { orgId: "eval" },
    });
    await this.store.putEvalRun(report);
    await this.store.audit({
      actor: opts.actor ?? "cli",
      action: opts.ignorePins ? "plugin.eval.repin" : "plugin.eval",
      subject: `${report.plugin}@${report.version}`,
      detail: { passRate: report.passRate },
    });
    return report;
  }

  /** Promote the installed version if its evals clear the gate, then pin its MCP tools (§4.11.3). */
  async promote(pluginName: string, opts: { actor?: string; minPassRate?: number } = {}): Promise<PromoteResult> {
    const { plugin } = this.harness(pluginName);
    const gate = await this.lifecycle.promoteFromStore(plugin.name, plugin.version, opts.actor ?? "cli", {
      minPassRate: opts.minPassRate ?? this.config.minPassRate,
    });
    if (!gate.ok || !plugin.mcp?.servers.length) return { version: plugin.version, ...gate };
    return { version: plugin.version, ...gate, pins: await this.mcp.pin(plugin) };
  }

  /**
   * Re-pin a plugin's MCP tools after drift: run its evals against the live
   * definitions, and pin them only if the run clears the gate against the
   * previous run for this version.
   */
  async repin(
    pluginName: string,
    opts: { actor?: string; minPassRate?: number; scope?: ScopeRef } = {},
  ): Promise<PromoteResult> {
    const { plugin } = this.harness(pluginName);
    const baseline = await this.store.latestEvalRun(plugin.name, plugin.version);
    const report = await this.evaluate(pluginName, { actor: opts.actor, ignorePins: true, scope: opts.scope });
    const gate = evalGate(report, baseline?.report, opts.minPassRate ?? this.config.minPassRate);
    await this.store.audit({
      actor: opts.actor ?? "cli",
      action: gate.ok ? "mcp.repin" : "mcp.repin.blocked",
      subject: `${plugin.name}@${plugin.version}`,
      detail: gate,
    });
    if (!gate.ok) return { version: plugin.version, ...gate };
    return { version: plugin.version, ...gate, pins: await this.mcp.pin(plugin) };
  }

  /** The operations exposed on /mcp, for a caller, from plugins whose installed version is on latest. */
  async exposedTools(scope: ScopeRef, caller: string): Promise<ExposedTool[]> {
    const tools: ExposedTool[] = [];
    for (const [name, { plugin: pluginName, route }] of this.exposed) {
      const h = this.harness(pluginName);
      if ((await this.lifecycle.channelOf(pluginName, h.plugin.version)) !== "latest") continue;
      const outputSchema = route.output ? (z.toJSONSchema(route.output) as Record<string, unknown>) : undefined;
      tools.push({
        name,
        description: route.mcp?.description ?? route.system ?? `${route.operation} (${pluginName})`,
        inputSchema: z.toJSONSchema(route.input!, { io: "input" }) as Record<string, unknown>,
        ...(outputSchema?.type === "object" && { outputSchema }),
        run: async (args) => {
          try {
            const { output, trace } = await h.run(route.operation, args, { scope, caller });
            const structured =
              output && typeof output === "object" && !Array.isArray(output) && outputSchema?.type === "object"
                ? (output as Record<string, unknown>)
                : undefined;
            const text = typeof output === "string" ? output : JSON.stringify(output);
            return { text, structured, meta: { "saddlebags/traceId": trace.id } };
          } catch (e) {
            if (e instanceof InputError) return { text: e.message, isError: true };
            if (!(e instanceof HarnessError)) throw e;
            const reasons = (e.trace.attempts.at(-1)?.rejections ?? []).map((r) => `- [${r.ruleId}] ${r.reason}`);
            return {
              text: [e.message, ...reasons, `Trace: ${e.trace.id}`].join("\n"),
              isError: true,
              meta: { "saddlebags/traceId": e.trace.id },
            };
          }
        },
      });
    }
    return tools;
  }

  async close(): Promise<void> {
    await this.pool.close();
    await this.store.close();
  }
}

/** `<plugin>__<operation>`, sanitized: scope and non-word characters dropped. */
export function mcpToolName(plugin: Plugin, route: ModelRoute): string {
  if (route.mcp?.name) return route.mcp.name;
  const slug = (s: string) => s.replace(/^@[^/]+\//, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${slug(plugin.name)}__${slug(route.operation)}`;
}

export async function openStore(cfg: StoreConfig | undefined, root: string): Promise<Store> {
  if (cfg?.kind === "postgres") {
    const { PostgresStore } = await import("@saddlebags/store-postgres");
    return PostgresStore.connect(cfg.url, { schema: cfg.schema });
  }
  if (cfg?.path === ":memory:") return new SqliteStore();
  const path = resolve(root, cfg?.path ?? ".saddlebags/saddlebags.db");
  mkdirSync(dirname(path), { recursive: true });
  return new SqliteStore(path);
}
