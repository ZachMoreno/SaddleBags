import { z } from "zod";
import type { EvalCase, ModelProvider, ScopeRef } from "@saddlebags/sdk";
import { Harness, HarnessError } from "./harness.js";
import { extractJson } from "./json.js";

export interface GraderResult {
  grader: string;
  pass: boolean;
  reason?: string;
}

export interface CaseResult {
  caseId: string;
  pass: boolean;
  graders: GraderResult[];
  error?: string;
}

export interface EvalReport {
  bag: string;
  version: string;
  passRate: number;
  cases: CaseResult[];
}

export interface EvalOptions {
  scope?: ScopeRef;
  /** Providers for judge graders (defaults to none: judge graders then fail). */
  judges?: ModelProvider[];
  cases?: EvalCase[];
  /** Recorded on each run's trace. Default "eval". */
  caller?: string;
}

/** Run a bag's golden cases against a harness. */
export async function runEvals(harness: Harness, opts: EvalOptions = {}): Promise<EvalReport> {
  const cases = opts.cases ?? harness.bag.evals ?? [];
  const scope = opts.scope ?? { orgId: "eval" };
  const judges = new Map((opts.judges ?? []).map((p) => [p.id, p]));
  const results: CaseResult[] = [];

  for (const c of cases) {
    try {
      const { output } = await harness.run(c.operation, c.input, {
        scope,
        meta: { eval: c.id },
        caller: opts.caller ?? "eval",
      });
      const graders: GraderResult[] = [];
      for (const g of c.graders) {
        if (g.kind === "code") {
          const r = g.assert(output);
          graders.push({ grader: g.name, pass: r === true, reason: typeof r === "string" ? r : undefined });
        } else {
          graders.push(await judge(judges, g.model, g.name, g.rubric, output));
        }
      }
      results.push({ caseId: c.id, pass: graders.every((g) => g.pass), graders });
    } catch (e) {
      const msg = e instanceof HarnessError ? e.message : (e as Error).message;
      results.push({ caseId: c.id, pass: false, graders: [], error: msg });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    bag: harness.bag.name,
    version: harness.bag.version,
    passRate: cases.length ? passed / cases.length : 1,
    cases: results,
  };
}

async function judge(
  judges: Map<string, ModelProvider>,
  ref: string,
  name: string,
  rubric: string,
  output: unknown,
): Promise<GraderResult> {
  const i = ref.indexOf(":");
  const provider = judges.get(ref.slice(0, i));
  if (!provider) return { grader: name, pass: false, reason: `No judge provider for ${ref}` };
  const schema = z.object({ pass: z.boolean(), reason: z.string() });
  const res = await provider.generate({
    model: ref.slice(i + 1),
    system: 'You grade outputs against a rubric. Respond with JSON {"pass": boolean, "reason": string}.',
    messages: [{ role: "user", content: `Rubric:\n${rubric}\n\nOutput:\n${JSON.stringify(output, null, 2)}` }],
    jsonSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    temperature: 0,
  });
  try {
    const v = schema.parse(extractJson(res.text));
    return { grader: name, pass: v.pass, reason: v.reason };
  } catch (e) {
    return { grader: name, pass: false, reason: `Unparseable judge output: ${(e as Error).message}` };
  }
}

export interface GateResult {
  ok: boolean;
  regressions: string[];
  reasons: string[];
}

/**
 * v1 promotion gate: there must be no case that passed on the baseline and
 * fails on the candidate, and the candidate's pass rate must be at least
 * `minPassRate`.
 */
export function evalGate(
  candidate: EvalReport,
  baseline?: EvalReport,
  minPassRate = 1,
): GateResult {
  const reasons: string[] = [];
  const regressions: string[] = [];
  if (baseline) {
    const prior = new Map(baseline.cases.map((c) => [c.caseId, c.pass]));
    for (const c of candidate.cases) if (prior.get(c.caseId) === true && !c.pass) regressions.push(c.caseId);
    if (regressions.length) reasons.push(`Regressed vs ${baseline.version}: ${regressions.join(", ")}`);
  }
  if (candidate.passRate < minPassRate) {
    reasons.push(`Pass rate ${(candidate.passRate * 100).toFixed(0)}% < ${(minPassRate * 100).toFixed(0)}%`);
  }
  return { ok: reasons.length === 0, regressions, reasons };
}
