import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { Lifecycle, Memory, type EvalReport, type Store } from "@saddlebags/core";
import { createApp } from "./app.js";
import { CONFIG_FILES, importBag, loadConfig, type LoadedConfig } from "./config.js";
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
});

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
    const rt = await Runtime.create(cfg.config, cfg.root);
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
      log(`Created ${CONFIG_FILES[0]}. Next: saddlebags install <bag-package>`);
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
    .description("npm-install a bag and register it as a release candidate")
    .option("--no-npm", "skip the package-manager install (already installed)")
    .option("--org <id>", "seed the bag's starter memory for this org")
    .action(async (spec: string, opts: { npm: boolean; org?: string }) => {
      const cfg = await loaded();
      if (opts.npm) {
        const [cmd, ...args] = packageManagerAdd(cfg.root);
        await deps.exec(cmd!, [...args, spec], cfg.root);
      }
      const name = packageName(spec);
      const bag = await importBag(name, cfg.root);
      await withStore(async (store) => {
        await new Lifecycle(store).installRc(bag.name, bag.version, "cli");
        log(`Installed ${bag.name}@${bag.version} as rc.`);
        if (opts.org) {
          await new Memory(store, bag.memory).seed({ orgId: opts.org });
          log(`Seeded starter memory for org "${opts.org}".`);
        }
      });
      if (!cfg.config.bags.includes(name)) log(`Add "${name}" to bags in your saddlebags config to serve it.`);
      log(`Next: saddlebags eval ${bag.name}`);
    });

  program
    .command("eval <bag>")
    .description("run a bag's evals and record the result")
    .action((bagName: string) =>
      withRuntime(async (rt) => {
        const report = await rt.evaluate(bagName);
        printReport(report, log);
        if (report.passRate < (rt.config.minPassRate ?? 1)) setExit(1);
      }),
    );

  program
    .command("promote <bag>")
    .description("promote the installed version to latest if its evals pass the gate")
    .option("--min-pass-rate <rate>", "override the configured minimum pass rate", parseFloat)
    .action((bagName: string, opts: { minPassRate?: number }) =>
      withRuntime(async (rt) => {
        const { version } = rt.harness(bagName).bag;
        const gate = await rt.lifecycle.promoteFromStore(bagName, version, "cli", {
          minPassRate: opts.minPassRate ?? rt.config.minPassRate,
        });
        if (gate.ok) {
          log(`Promoted ${bagName}@${version} to latest.`);
        } else {
          log(`Promotion of ${bagName}@${version} blocked:`);
          for (const r of gate.reasons) log(`  - ${r}`);
          setExit(1);
        }
      }),
    );

  program
    .command("unpublish <bag> <version>")
    .description("stop serving a bag version")
    .action((bagName: string, version: string) =>
      withStore(async (store) => {
        await new Lifecycle(store).unpublish(bagName, version, "cli");
        log(`Unpublished ${bagName}@${version}.`);
      }),
    );

  program
    .command("status")
    .description("show configured bags and their release channels")
    .action(() =>
      withRuntime(async (rt) => {
        for (const bag of rt.bags) {
          const channel = (await rt.lifecycle.channelOf(bag.name, bag.version)) ?? "not installed";
          log(`${bag.name}@${bag.version}  ${channel}  [${bag.routes.map((r) => r.operation).join(", ")}]`);
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
      const rt = await Runtime.create(cfg.config, cfg.root);
      const token = deps.env.SADDLEBAGS_TOKEN;
      let host = opts.host ?? cfg.config.server?.host ?? "127.0.0.1";
      if (!token && host !== "127.0.0.1" && host !== "localhost") {
        deps.error(`SADDLEBAGS_TOKEN is not set; refusing to bind ${host}. Binding 127.0.0.1 instead.`);
        host = "127.0.0.1";
      }
      if (!token) deps.error("Warning: SADDLEBAGS_TOKEN is not set; the API is unauthenticated (localhost only).");
      const port = opts.port ?? cfg.config.server?.port ?? 4848;
      await deps.listen(createApp(rt, { token }).fetch, port, host);
      log(`SaddleBags listening on http://${host}:${port} with ${rt.bags.length} bag(s).`);
    });

  return program;
}

function printReport(report: EvalReport, log: (l: string) => void): void {
  log(`${report.bag}@${report.version}: ${(report.passRate * 100).toFixed(0)}% passed`);
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
  // Bag packages to serve. Install with: saddlebags install <package>
  bags: [],

  // SQLite by default. For Postgres:
  // store: { kind: "postgres", url: process.env.DATABASE_URL! },
  store: { kind: "sqlite", path: ".saddlebags/saddlebags.db" },

  // "env" registers each provider whose API key is set
  // (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).
  providers: "env",

  // Decides model-decided rule conditions.
  selectorModel: "anthropic:claude-opus-5-5",

  server: { port: 4848 },
});
`;
