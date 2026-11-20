import type { Store } from "./store/types.js";
import { evalGate, type EvalReport, type GateResult } from "./evals.js";

/**
 * Release lifecycle for installed plugins: rc → latest (gated by evals) → unpublished.
 * Mirrors npm dist-tags; this tracks what the runtime actually serves.
 */
export class Lifecycle {
  constructor(private store: Store) {}

  async installRc(plugin: string, version: string, actor: string): Promise<void> {
    await this.store.setInstall(plugin, version, "rc");
    await this.store.audit({ actor, action: "plugin.install.rc", subject: `${plugin}@${version}` });
  }

  /** Promote an RC to latest if its eval report clears the gate against the current latest. */
  async promote(
    plugin: string,
    candidate: EvalReport,
    actor: string,
    opts: { baseline?: EvalReport; minPassRate?: number } = {},
  ): Promise<GateResult> {
    const gate = evalGate(candidate, opts.baseline, opts.minPassRate);
    const subject = `${plugin}@${candidate.version}`;
    await this.store.audit({ actor, action: gate.ok ? "plugin.promote" : "plugin.promote.blocked", subject, detail: gate });
    if (!gate.ok) return gate;

    for (const i of await this.store.listInstalls(plugin)) {
      if (i.channel === "latest" && i.version !== candidate.version) {
        await this.store.setInstall(plugin, i.version, "unpublished");
      }
    }
    await this.store.setInstall(plugin, candidate.version, "latest");
    return gate;
  }

  /**
   * Promote using stored eval runs: the candidate is the latest run for
   * `version`, and the baseline is the latest run for the current `latest`.
   */
  async promoteFromStore(
    plugin: string,
    version: string,
    actor: string,
    opts: { minPassRate?: number } = {},
  ): Promise<GateResult> {
    const candidate = await this.store.latestEvalRun(plugin, version);
    if (!candidate) {
      return { ok: false, regressions: [], reasons: [`No eval run for ${plugin}@${version}. Run evals first.`] };
    }
    const current = await this.latest(plugin);
    const baseline = current && current !== version ? await this.store.latestEvalRun(plugin, current) : undefined;
    return this.promote(plugin, candidate.report, actor, { baseline: baseline?.report, minPassRate: opts.minPassRate });
  }

  async unpublish(plugin: string, version: string, actor: string): Promise<void> {
    await this.store.setInstall(plugin, version, "unpublished");
    await this.store.audit({ actor, action: "plugin.unpublish", subject: `${plugin}@${version}` });
  }

  async latest(plugin: string): Promise<string | undefined> {
    return (await this.store.listInstalls(plugin)).find((i) => i.channel === "latest")?.version;
  }

  async channelOf(plugin: string, version: string): Promise<string | undefined> {
    return (await this.store.listInstalls(plugin)).find((i) => i.version === version)?.channel;
  }
}
