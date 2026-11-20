import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { Lifecycle, Memory, type EvalReport, type Store } from "@saddlebags/core";
import { Secrets } from "@saddlebags/mcp";
import type { Scope, ScopeRef } from "@saddlebags/sdk";
import { createApp } from "./app.js";
import { CONFIG_FILES, importPlugin, loadConfig, type LoadedConfig } from "./config.js";
import { Runtime, openStore } from "./runtime.js";

export interface CliDeps {
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Runs a package-manager command. Swappable for tests. */
  exec: (cmd: string, args: string[], cwd: string) => Promise<void>;
  /** Starts the HTTP server. Swappable for tests. */
  listen: (fetch: (req: Request) => Response | Promise<Response>, port: number, host: string) => Promise<void>;
  /** Reads a secret piped on stdin. Swappable for tests. */
  readStdin: () => Promise<string>;
}

const defaultDeps = (): CliDeps => ({
  cwd: process.cwd(),
  log: (l) => console.log(l),
  error: (l) => console.error(l),
  env: process.env,
  exec: (cmd, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`))));
    }),
  listen: async (fetch, port, hostname) => {
    const { serve } = await import("@hono/node-server");
    await new Promise<void>((resolve) => serve({ fetch, port, hostname }, () => resolve()));
  },
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
});

interface ScopeFlags {
  org?: string;
  group?: string;
  user?: string;
}

/** `--org/--group/--user` as a ScopeRef (org required). */
function scopeRef(f: ScopeFlags): ScopeRef {
  if (!f.org) throw new Error("--org is required");
  return { orgId: f.org, ...(f.group && { groupId: f.group }), ...(f.user && { userId: f.user }) };
}

/** The single scope a connection is held at: exactly one flag. */
function connectionScope(f: ScopeFlags): { scope: Scope; scopeId: string } {
  const given = (["user", "group", "org"] as const).filter((s) => f[s]);
  if (given.length !== 1) throw new Error("Pass exactly one of --org, --group or --user");
  return { scope: given[0]!, scopeId: f[given[0]!]! };
}

const withScopeFlags = (cmd: Command) =>
  cmd.option("--org <id>", "org id").option("--group <id>", "group id").option("--user <id>", "user id");

/** Run the CLI. Resolves to the process exit code. */
export async function run(argv: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  let exitCode = 0;
  const program = buildProgram(deps, (code) => (exitCode = code));
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    deps.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  return exitCode;
}

function buildProgram(deps: CliDeps, setExit: (code: number) => void): Command {
  const { log } = deps;
  const program = new Command("saddlebags")
    .description("Run and release SaddleBags harnesses")
    .option("-c, --config <file>", "path to saddlebags.config.ts")
    .exitOverride()
    .configureOutput({ writeOut: (s) => log(s.trimEnd()), writeErr: (s) => deps.error(s.trimEnd()) });

  const loaded = () => loadConfig(deps.cwd, program.opts<{ config?: string }>().config);
  const withRuntime = async <T>(fn: (rt: Runtime, cfg: LoadedConfig) => Promise<T>): Promise<T> => {
    const cfg = await loaded();
    const rt = await Runtime.create(cfg.config, cfg.root, { secrets: Secrets.fromEnv(deps.env) });
    try {
      return await fn(rt, cfg);
    } finally {
      await rt.close();
    }
  };
  const withStore = async <T>(fn: (store: Store, cfg: LoadedConfig) => Promise<T>): Promise<T> => {
    const cfg = await loaded();
    const store = await openStore(cfg.config.store, cfg.root);
    try {
      return await fn(store, cfg);
    } finally {
      await store.close();
    }
  };

  program
    .command("init")
    .description("create saddlebags.config.ts in the current directory")
    .action(async () => {
      const existing = CONFIG_FILES.find((f) => existsSync(join(deps.cwd, f)));
      if (existing) {
        log(`${existing} already exists.`);
        return;
      }
      await writeFile(join(deps.cwd, CONFIG_FILES[0]!), CONFIG_TEMPLATE);
      log(`Created ${CONFIG_FILES[0]}. Next: saddlebags install <plugin-package>`);
    });

  program
    .command("migrate")
    .description("create or upgrade the configured store's tables")
    .action(() =>
      withStore(async (_store, cfg) => {
        log(`Store is up to date (${cfg.config.store?.kind ?? "sqlite"}).`);
      }),
    );

  program
    .command("install <package>")
    .description("npm-install a plugin and register it as a release candidate")
    .option("--no-npm", "skip the package-manager install (already installed)")
    .option("--org <id>", "seed the plugin's starter memory for this org")
    .action(async (spec: string, opts: { npm: boolean; org?: string }) => {
      const cfg = await loaded();
      if (opts.npm) {
        const [cmd, ...args] = packageManagerAdd(cfg.root);
        await deps.exec(cmd!, [...args, spec], cfg.root);
      }
      const name = packageName(spec);
      const plugin = await importPlugin(name, cfg.root);
      await withStore(async (store) => {
        await new Lifecycle(store).installRc(plugin.name, plugin.version, "cli");
        log(`Installed ${plugin.name}@${plugin.version} as rc.`);
        if (opts.org) {
          await new Memory(store, plugin.memory).seed({ orgId: opts.org });
          log(`Seeded starter memory for org "${opts.org}".`);
        }
      });
      if (!cfg.config.plugins.includes(name)) log(`Add "${name}" to plugins in your saddlebags config to serve it.`);
      log(`Next: saddlebags eval ${plugin.name}`);
    });

  withScopeFlags(
    program.command("eval <plugin>").description("run a plugin's evals and record the result (scope flags override config.evalScope)"),
  ).action((pluginName: string, flags: ScopeFlags) =>
      withRuntime(async (rt) => {
        const report = await rt.evaluate(pluginName, { scope: flags.org ? scopeRef(flags) : undefined });
        printReport(report, log);
        if (report.passRate < (rt.config.minPassRate ?? 1)) setExit(1);
      }),
    );

  program
    .command("promote <plugin>")
    .description("promote the installed version to latest if its evals pass the gate")
    .option("--min-pass-rate <rate>", "override the configured minimum pass rate", parseFloat)
    .action((pluginName: string, opts: { minPassRate?: number }) =>
      withRuntime(async (rt) => {
        const result = await rt.promote(pluginName, { minPassRate: opts.minPassRate });
        if (result.ok) {
          log(`Promoted ${pluginName}@${result.version} to latest.`);
          printPins(result.pins, log);
        } else {
          log(`Promotion of ${pluginName}@${result.version} blocked:`);
          for (const r of result.reasons) log(`  - ${r}`);
          setExit(1);
        }
      }),
    );

  // ─── MCP connections (§4.11.1) ──────────────────────────────────────────
  const mcp = program.command("mcp").description("connect the MCP servers plugins declare, and manage pins");

  withScopeFlags(
    mcp
      .command("connect <plugin> <server>")
      .description("connect a plugin's MCP server at one scope (credential from --token-env or --token-stdin)")
      .option("--token-env <var>", "read the credential from this environment variable")
      .option("--token-stdin", "read the credential from stdin"),
  ).action((pluginName: string, server: string, flags: ScopeFlags & { tokenEnv?: string; tokenStdin?: boolean }) =>
    withRuntime(async (rt) => {
      let credential: string | undefined;
      if (flags.tokenEnv) {
        credential = deps.env[flags.tokenEnv];
        if (!credential) throw new Error(`Environment variable ${flags.tokenEnv} is empty`);
      } else if (flags.tokenStdin) {
        credential = (await deps.readStdin()).trim();
      }
      const conn = await rt.connections.connect({
        plugin: rt.harness(pluginName).plugin,
        server,
        ...connectionScope(flags),
        credential,
        by: "cli",
      });
      log(`Connected ${pluginName}:${server} at ${conn.scope}:${conn.scopeId} (${conn.id}).`);
    }),
  );

  mcp
    .command("connections")
    .description("list connections (credentials are never shown)")
    .option("--plugin <name>", "only this plugin")
    .action((opts: { plugin?: string }) =>
      withStore(async (store) => {
        for (const c of await store.listConnections({ plugin: opts.plugin })) {
          const cred = c.credential ? "credential" : "no credential";
          log(`${c.id}  ${c.plugin}:${c.server}  ${c.scope}:${c.scopeId}  ${cred}  by ${c.createdBy}`);
        }
      }),
    );

  mcp
    .command("disconnect <id>")
    .action((id: string) =>
      withRuntime(async (rt) => {
        if (!(await rt.connections.disconnect(id, "cli"))) throw new Error(`No connection ${id}`);
        log(`Disconnected ${id}.`);
      }),
    );

  mcp
    .command("drift <plugin>")
    .description("compare each pinned MCP server's live tools with the pin")
    .action((pluginName: string) =>
      withRuntime(async (rt) => {
        const drift = await rt.mcp.drift(rt.harness(pluginName).plugin);
        if (!drift.length) return log("No drift.");
        for (const d of drift) log(`${d.server}.${d.tool}: ${d.detail}`);
        log(`Re-pin with: saddlebags mcp repin ${pluginName}`);
        setExit(1);
      }),
    );

  withScopeFlags(
    mcp
      .command("repin <plugin>")
      .description("run evals against live MCP definitions and pin them if the gate passes")
      .option("--min-pass-rate <rate>", "override the configured minimum pass rate", parseFloat),
  ).action((pluginName: string, flags: ScopeFlags & { minPassRate?: number }) =>
    withRuntime(async (rt) => {
      const result = await rt.repin(pluginName, {
        minPassRate: flags.minPassRate,
        scope: flags.org ? scopeRef(flags) : undefined,
      });
      if (result.ok) {
        log(`Re-pinned ${pluginName}@${result.version}.`);
        printPins(result.pins, log);
      } else {
        log(`Re-pin of ${pluginName}@${result.version} blocked:`);
        for (const r of result.reasons) log(`  - ${r}`);
        setExit(1);
      }
    }),
  );

  // ─── API tokens for /mcp (§4.11.4) ──────────────────────────────────────
  const token = program.command("token").description("scoped bearer tokens for the /mcp endpoint");

  withScopeFlags(token.command("create").requiredOption("--name <name>", "what the token is for")).action(
    (flags: ScopeFlags & { name: string }) =>
      withRuntime(async (rt) => {
        const { token: secret, record } = await rt.tokens.create({ name: flags.name, scope: scopeRef(flags), by: "cli" });
        log(`Created token ${record.id} for ${JSON.stringify(record.scope)}. It is shown once:`);
        log(secret);
      }),
  );

  token.command("list").action(() =>
    withRuntime(async (rt) => {
      for (const t of await rt.tokens.list()) {
        const state = t.revokedAt ? `revoked ${t.revokedAt}` : "active";
        log(`${t.id}  ${t.name}  ${JSON.stringify(t.scope)}  ${state}`);
      }
    }),
  );

  token.command("revoke <id>").action((id: string) =>
    withRuntime(async (rt) => {
      if (!(await rt.tokens.revoke(id, "cli"))) throw new Error(`No active token ${id}`);
      log(`Revoked ${id}.`);
    }),
  );

  program
    .command("unpublish <plugin> <version>")
    .description("stop serving a plugin version")
    .action((pluginName: string, version: string) =>
      withStore(async (store) => {
        await new Lifecycle(store).unpublish(pluginName, version, "cli");
        log(`Unpublished ${pluginName}@${version}.`);
      }),
    );

  program
    .command("status")
    .description("show configured plugins and their release channels")
    .action(() =>
      withRuntime(async (rt) => {
        for (const plugin of rt.plugins) {
          const channel = (await rt.lifecycle.channelOf(plugin.name, plugin.version)) ?? "not installed";
          log(`${plugin.name}@${plugin.version}  ${channel}  [${plugin.routes.map((r) => r.operation).join(", ")}]`);
        }
      }),
    );

  program
    .command("traces")
    .description("list recent traces")
    .option("--operation <name>", "only this operation")
    .option("--limit <n>", "how many", (v) => parseInt(v, 10), 20)
    .option("--json", "print full JSON")
    .action((opts: { operation?: string; limit: number; json?: boolean }) =>
      withStore(async (store) => {
        const traces = await store.listTraces({ operation: opts.operation, limit: opts.limit });
        if (opts.json) return log(JSON.stringify(traces, null, 2));
        for (const t of traces) {
          const fired = t.fired.map((f) => f.ruleId).join(",") || "-";
          log(`${t.createdAt}  ${t.ok ? "ok  " : "FAIL"}  ${t.operation}  attempts=${t.attempts.length}  rules=${fired}  ${t.id}`);
        }
      }),
    );

  const memory = program.command("memory").description("review memory proposals");
  memory
    .command("proposals")
    .option("--status <status>", "pending | approved | rejected", "pending")
    .action((opts: { status: "pending" | "approved" | "rejected" }) =>
      withStore(async (store) => {
        for (const p of await store.listProposals(opts.status)) {
          log(`${p.id}  ${p.scope}:${p.scopeId}  ${p.key} = ${JSON.stringify(p.value)}  (${p.source.kind})`);
        }
      }),
    );
  for (const [verb, approve] of [
    ["approve", true],
    ["reject", false],
  ] as const) {
    memory
      .command(`${verb} <id>`)
      .requiredOption("--reviewer <name>", "who is reviewing")
      .action((id: string, opts: { reviewer: string }) =>
        withStore(async (store) => {
          await new Memory(store).resolve(id, approve, opts.reviewer);
          log(`${approve ? "Approved" : "Rejected"} ${id}.`);
        }),
      );
  }

  program
    .command("serve")
    .description("start the HTTP runtime API")
    .option("-p, --port <port>", "port", (v) => parseInt(v, 10))
    .option("--host <host>", "host to bind")
    .action(async (opts: { port?: number; host?: string }) => {
      const cfg = await loaded();
      const rt = await Runtime.create(cfg.config, cfg.root, { secrets: Secrets.fromEnv(deps.env) });
      const token = deps.env.SADDLEBAGS_TOKEN;
      let host = opts.host ?? cfg.config.server?.host ?? "127.0.0.1";
      if (!token && host !== "127.0.0.1" && host !== "localhost") {
        deps.error(`SADDLEBAGS_TOKEN is not set; refusing to bind ${host}. Binding 127.0.0.1 instead.`);
        host = "127.0.0.1";
      }
      if (!token) deps.error("Warning: SADDLEBAGS_TOKEN is not set; the API is unauthenticated (localhost only).");
      const port = opts.port ?? cfg.config.server?.port ?? 4848;
      await deps.listen(createApp(rt, { token }).fetch, port, host);
      log(`SaddleBags listening on http://${host}:${port} with ${rt.plugins.length} plugin(s).`);
    });

  return program;
}

type PinResult = { pinned: string[]; skipped: Array<{ server: string; reason: string }> };

function printPins(pins: PinResult | undefined, log: (l: string) => void): void {
  if (!pins) return;
  if (pins.pinned.length) log(`Pinned MCP tools for: ${pins.pinned.join(", ")}`);
  for (const s of pins.skipped) log(`  Not pinned: ${s.server} (${s.reason})`);
}

function printReport(report: EvalReport, log: (l: string) => void): void {
  log(`${report.plugin}@${report.version}: ${(report.passRate * 100).toFixed(0)}% passed`);
  for (const c of report.cases) {
    log(`  ${c.pass ? "✓" : "✗"} ${c.caseId}${c.error ? `  (${c.error})` : ""}`);
    for (const g of c.graders) if (!g.pass) log(`      ${g.grader}: ${g.reason ?? "failed"}`);
  }
}

/** "@scope/name@1.2.3" → "@scope/name"; "name@rc" → "name". */
export function packageName(spec: string): string {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}

function packageManagerAdd(root: string): string[] {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return ["pnpm", "add"];
  if (existsSync(join(root, "yarn.lock"))) return ["yarn", "add"];
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return ["bun", "add"];
  return ["npm", "install"];
}

const CONFIG_TEMPLATE = `import { defineConfig } from "@saddlebags/server";

export default defineConfig({
  // Plugin packages to serve. Install with: saddlebags install <package>
  plugins: [],

  // SQLite by default. For Postgres:
  // store: { kind: "postgres", url: process.env.DATABASE_URL! },
  store: { kind: "sqlite", path: ".saddlebags/saddlebags.db" },

  // "env" registers each provider whose API key is set
  // (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).
  providers: "env",

  // Decides model-decided rule conditions.
  selectorModel: "anthropic:claude-opus-5-5",

  // The scope evals run as. Plugins that use MCP servers need connections here.
  // evalScope: { orgId: "acme" },

  // Exact commands stdio MCP servers may run. Empty refuses all stdio servers.
  // MCP credentials are encrypted with SADDLEBAGS_SECRET_KEY (openssl rand -hex 32).
  // mcp: { stdioAllowlist: ["npx"] },

  server: { port: 4848 },
});
`;
