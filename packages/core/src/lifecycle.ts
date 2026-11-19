import type { Store } from "./store/types.js";
import { evalGate, type EvalReport, type GateResult } from "./evals.js";

/**
 * Release lifecycle for installed bags: rc → latest (gated by evals) → unpublished.
 * Mirrors npm dist-tags; this tracks what the runtime actually serves.
 */
export class Lifecycle {
  constructor(private store: Store) {}

  async installRc(bag: string, version: string, actor: string): Promise<void> {
    await this.store.setInstall(bag, version, "rc");
    await this.store.audit({ actor, action: "bag.install.rc", subject: `${bag}@${version}` });
  }

  /** Promote an RC to latest if its eval report clears the gate against the current latest. */
  async promote(
    bag: string,
    candidate: EvalReport,
    actor: string,
    opts: { baseline?: EvalReport; minPassRate?: number } = {},
  ): Promise<GateResult> {
    const gate = evalGate(candidate, opts.baseline, opts.minPassRate);
    const subject = `${bag}@${candidate.version}`;
    await this.store.audit({ actor, action: gate.ok ? "bag.promote" : "bag.promote.blocked", subject, detail: gate });
    if (!gate.ok) return gate;

    for (const i of await this.store.listInstalls(bag)) {
      if (i.channel === "latest" && i.version !== candidate.version) {
        await this.store.setInstall(bag, i.version, "unpublished");
      }
    }
    await this.store.setInstall(bag, candidate.version, "latest");
    return gate;
  }

  /**
   * Promote using stored eval runs: the candidate is the latest run for
   * `version`, and the baseline is the latest run for the current `latest`.
   */
  async promoteFromStore(
    bag: string,
    version: string,
    actor: string,
    opts: { minPassRate?: number } = {},
  ): Promise<GateResult> {
    const candidate = await this.store.latestEvalRun(bag, version);
    if (!candidate) {
      return { ok: false, regressions: [], reasons: [`No eval run for ${bag}@${version}. Run evals first.`] };
    }
    const current = await this.latest(bag);
    const baseline = current && current !== version ? await this.store.latestEvalRun(bag, current) : undefined;
    return this.promote(bag, candidate.report, actor, { baseline: baseline?.report, minPassRate: opts.minPassRate });
  }

  async unpublish(bag: string, version: string, actor: string): Promise<void> {
    await this.store.setInstall(bag, version, "unpublished");
    await this.store.audit({ actor, action: "bag.unpublish", subject: `${bag}@${version}` });
  }

  async latest(bag: string): Promise<string | undefined> {
    return (await this.store.listInstalls(bag)).find((i) => i.channel === "latest")?.version;
  }

  async channelOf(bag: string, version: string): Promise<string | undefined> {
    return (await this.store.listInstalls(bag)).find((i) => i.version === version)?.channel;
  }
}
