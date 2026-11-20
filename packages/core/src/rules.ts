import type { OperationContext, Rule } from "@saddlebags/sdk";

export type FireReason = "always" | "predicate" | "selector";

export interface FiredRule {
  rule: Rule<any, any>;
  reason: FireReason;
}

/** Picks which model-decided rules apply. Returns the chosen rule IDs. */
export type RuleSelector = (
  candidates: Array<{ id: string; description: string }>,
  ctx: OperationContext,
) => Promise<string[]>;

export function rulesFor(rules: Rule<any, any>[], operation: string): Rule<any, any>[] {
  return rules.filter((r) => !r.operations || r.operations.includes(operation));
}

/**
 * Resolve conditions. `always` and `code` are deterministic. All `model`
 * conditions are batched into a single selector call, which makes that
 * part of resolution probabilistic.
 */
export async function selectRules(
  rules: Rule<any, any>[],
  ctx: OperationContext,
  selector?: RuleSelector,
): Promise<FiredRule[]> {
  const fired: FiredRule[] = [];
  const modelDecided: Rule<any, any>[] = [];

  for (const rule of rulesFor(rules, ctx.operation)) {
    const c = rule.condition;
    if (c.kind === "always") fired.push({ rule, reason: "always" });
    else if (c.kind === "code") {
      if (await c.when(ctx)) fired.push({ rule, reason: "predicate" });
    } else modelDecided.push(rule);
  }

  if (modelDecided.length > 0) {
    if (!selector) {
      throw new Error(
        `Rules ${modelDecided.map((r) => r.id).join(", ")} are model-decided but no rule selector is configured`,
      );
    }
    const candidates = modelDecided.map((r) => ({
      id: r.id,
      description: r.condition.kind === "model" ? r.condition.description : "",
    }));
    const chosen = new Set(await selector(candidates, ctx));
    for (const rule of modelDecided) if (chosen.has(rule.id)) fired.push({ rule, reason: "selector" });
  }

  return fired;
}

/** Admin overlays may only add prose rules with non-code conditions. */
export function assertOverlayRule(rule: Rule<any, any>): void {
  if (rule.directive.kind !== "prose") {
    throw new Error(`Overlay rule ${rule.id}: only prose directives can be edited in the Admin`);
  }
  if (rule.condition.kind === "code") {
    throw new Error(`Overlay rule ${rule.id}: code conditions must ship in a plugin`);
  }
}
