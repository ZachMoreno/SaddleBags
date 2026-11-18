import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Harness, Lifecycle, Memory, SqliteStore, runEvals, type EvalReport, type Store } from "@saddlebags/core";
import { providersFromEnv } from "@saddlebags/providers";
import type { Bag, ModelProvider } from "@saddlebags/sdk";
import { importBag, type SaddlebagsConfig, type StoreConfig } from "./config.js";

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
 * Everything a server or CLI command needs: the store, the loaded bags (one
 * Harness each) and the release lifecycle.
 */
export class Runtime {
  readonly lifecycle: Lifecycle;
  readonly memory: Memory;
  private harnesses = new Map<string, Harness>();

  private constructor(
    readonly config: SaddlebagsConfig,
    readonly store: Store,
    readonly providers: ModelProvider[],
    bags: Bag[],
  ) {
    this.lifecycle = new Lifecycle(store);
    this.memory = new Memory(store);
    for (const bag of bags) {
      if (this.harnesses.has(bag.name)) throw new Error(`Bag "${bag.name}" is listed twice`);
      this.harnesses.set(
        bag.name,
        new Harness({ bag, providers, store, selectorModel: config.selectorModel }),
      );
    }
  }

  static async create(config: SaddlebagsConfig, root: string, opts: { store?: Store } = {}): Promise<Runtime> {
    const store = opts.store ?? (await openStore(config.store, root));
    const providers = config.providers === undefined || config.providers === "env" ? providersFromEnv() : config.providers;
    const bags = await Promise.all(config.bags.map((b) => (typeof b === "string" ? importBag(b, root) : b)));
    return new Runtime(config, store, providers, bags);
  }

  get bags(): Bag[] {
    return [...this.harnesses.values()].map((h) => h.bag);
  }

  harness(bagName: string): Harness {
    const h = this.harnesses.get(bagName);
    if (!h) throw new RuntimeError(`Bag "${bagName}" is not in the config`, 404);
    return h;
  }

  /**
   * Find the bag serving an operation and check it may be served on the
   * requested channel. M2 serves the one installed version of each bag.
   */
  async resolveOperation(operation: string, opts: { bag?: string; channel?: ServeChannel } = {}): Promise<Harness> {
    const candidates = [...this.harnesses.values()].filter(
      (h) => (!opts.bag || h.bag.name === opts.bag) && h.bag.routes.some((r) => r.operation === operation),
    );
    if (candidates.length === 0) {
      throw new RuntimeError(`No bag${opts.bag ? ` "${opts.bag}"` : ""} serves operation "${operation}"`, 404);
    }
    if (candidates.length > 1) {
      throw new RuntimeError(
        `Operation "${operation}" is served by ${candidates.map((h) => h.bag.name).join(", ")}; pass "bag"`,
        400,
      );
    }
    const h = candidates[0]!;
    const channel = await this.lifecycle.channelOf(h.bag.name, h.bag.version);
    const wanted = opts.channel ?? "latest";
    if (channel !== wanted) {
      throw new RuntimeError(
        `${h.bag.name}@${h.bag.version} is ${channel ? `on channel "${channel}"` : "not installed"}, ` +
          `not "${wanted}". ` +
          (channel ? "Promote it, or request the rc channel." : `Run \`saddlebags install ${h.bag.name}\`.`),
        409,
      );
    }
    return h;
  }

  /** Run a bag's evals with the configured providers as judges, and store the run. */
  async evaluate(bagName: string): Promise<EvalReport> {
    const report = await runEvals(this.harness(bagName), { judges: this.providers });
    await this.store.putEvalRun(report);
    await this.store.audit({
      actor: "cli",
      action: "bag.eval",
      subject: `${report.bag}@${report.version}`,
      detail: { passRate: report.passRate },
    });
    return report;
  }

  close(): Promise<void> {
    return this.store.close();
  }
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
