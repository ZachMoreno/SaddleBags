import type { Store } from "./store.js";
import { evalGate, type EvalReport, type GateResult } from "./evals.js";

/**
 * Release lifecycle for installed bags: rc → latest (gated by evals) → unpublished.
 * Mirrors npm dist-tags; this tracks what the runtime actually serves.
 */
export class Lifecycle {
  constructor(private store: Store) {}

  installRc(bag: string, version: string, actor: string): void {
    this.store.setInstall(bag, version, "rc");
    this.store.audit({ actor, action: "bag.install.rc", subject: `${bag}@${version}` });
  }

  /** Promote an RC to latest if its eval report clears the gate against the current latest. */
  promote(
    bag: string,
    candidate: EvalReport,
    actor: string,
    opts: { baseline?: EvalReport; minPassRate?: number } = {},
  ): GateResult {
    const gate = evalGate(candidate, opts.baseline, opts.minPassRate);
    const subject = `${bag}@${candidate.version}`;
    this.store.audit({ actor, action: gate.ok ? "bag.promote" : "bag.promote.blocked", subject, detail: gate });
    if (!gate.ok) return gate;

    for (const i of this.store.listInstalls(bag)) {
      if (i.channel === "latest") this.store.setInstall(bag, i.version, "unpublished");
    }
    this.store.setInstall(bag, candidate.version, "latest");
    return gate;
  }

  unpublish(bag: string, version: string, actor: string): void {
    this.store.setInstall(bag, version, "unpublished");
    this.store.audit({ actor, action: "bag.unpublish", subject: `${bag}@${version}` });
  }

  latest(bag: string): string | undefined {
    return this.store.listInstalls(bag).find((i) => i.channel === "latest")?.version;
  }
}
