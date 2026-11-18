import { z } from "zod";
import type {
  Bag,
  ChatMessage,
  EnforceResult,
  ModelProvider,
  ModelRoute,
  OperationContext,
  Rule,
  ScopeRef,
  StepRecord,
} from "@saddlebags/sdk";
import { extractJson } from "./json.js";
import { Memory } from "./memory.js";
import { assertOverlayRule, selectRules, type FiredRule, type RuleSelector } from "./rules.js";
import { SqliteStore, type Store, type TraceRecord } from "./store.js";

export interface HarnessOptions {
  bag: Bag;
  providers: ModelProvider[];
  store?: Store;
  /** Model used to decide model-decided conditions, e.g. "anthropic:claude-haiku-5-5". */
  selectorModel?: `${string}:${string}`;
  /** Prose rules authored in the Stable, layered on top of the bag. */
  overlays?: Rule[];
}

export interface RunOptions {
  scope: ScopeRef;
  history?: StepRecord[];
  meta?: Record<string, unknown>;
}

export interface RunResult<O = unknown> {
  output: O;
  trace: TraceRecord;
}

export class HarnessError extends Error {
  constructor(
    message: string,
    public trace: TraceRecord,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

type Rejection = { ruleId: string; reason: string };

export class Harness {
  readonly bag: Bag;
  readonly store: Store;
  readonly memory: Memory;
  private providers: Map<string, ModelProvider>;
  private rules: Rule<any, any>[];
  private selector?: RuleSelector;

  constructor(opts: HarnessOptions) {
    this.bag = opts.bag;
    this.store = opts.store ?? new SqliteStore();
    this.memory = new Memory(this.store, opts.bag.memory);
    this.providers = new Map(opts.providers.map((p) => [p.id, p]));
    for (const r of opts.overlays ?? []) assertOverlayRule(r);
    this.rules = [...(opts.bag.rules ?? []), ...(opts.overlays ?? [])];
    if (opts.selectorModel) this.selector = this.modelSelector(opts.selectorModel);
  }

  route(operation: string): ModelRoute {
    const route = this.bag.routes.find((r) => r.operation === operation);
    if (!route) throw new Error(`Bag ${this.bag.name} has no route for operation "${operation}"`);
    return route;
  }

  async run<O = unknown>(operation: string, input: unknown, opts: RunOptions): Promise<RunResult<O>> {
    const route = this.route(operation);
    const { provider, model } = this.resolveModel(route.model);
    const ctx: OperationContext = {
      operation,
      input,
      scope: opts.scope,
      memory: this.memory.load(opts.scope),
      history: opts.history ?? [],
      meta: opts.meta ?? {},
    };

    const fired = await selectRules(this.rules, ctx, this.selector);
    const system = assembleSystem(route, fired, ctx);
    const jsonSchema = route.output ? (z.toJSONSchema(route.output) as Record<string, unknown>) : undefined;
    const messages: ChatMessage[] = [{ role: "user", content: render(input) }];
    const attempts: TraceRecord["attempts"] = [];
    const maxAttempts = route.maxAttempts ?? 3;

    for (let i = 0; i < maxAttempts; i++) {
      const res = await provider.generate({
        model,
        system,
        messages,
        jsonSchema,
        maxTokens: route.maxTokens,
        temperature: route.temperature,
      });
      const { output, rejections } = await this.check(route, res.text, fired, ctx);
      attempts.push({ output, rejections });

      if (rejections.length === 0) {
        const trace = this.saveTrace(operation, route.model, opts.scope, fired, attempts, true);
        return { output: output as O, trace };
      }
      messages.push(
        { role: "assistant", content: res.text },
        {
          role: "user",
          content:
            "Your previous answer was rejected:\n" +
            rejections.map((r) => `- [${r.ruleId}] ${r.reason}`).join("\n") +
            "\nRevise and answer again.",
        },
      );
    }

    const trace = this.saveTrace(operation, route.model, opts.scope, fired, attempts, false);
    throw new HarnessError(`Operation "${operation}" failed enforcement after ${maxAttempts} attempts`, trace);
  }

  /** Run a bag tool, applying any tool-call enforce directives first. */
  async callTool(name: string, args: unknown, ctx: OperationContext): Promise<unknown> {
    const tool = this.bag.tools?.find((t) => t.name === name);
    if (!tool) throw new Error(`Bag ${this.bag.name} has no tool "${name}"`);
    let parsed = tool.input.parse(args);
    const fired = await selectRules(this.rules, ctx, this.selector);
    for (const { rule } of fired) {
      const d = rule.directive;
      if (d.kind !== "enforce-tool" || d.tool !== name) continue;
      const r = await d.check(parsed, ctx);
      if (r.action === "reject") throw new Error(`Tool "${name}" blocked by [${rule.id}]: ${r.reason}`);
      if (r.action === "transform") parsed = tool.input.parse(r.value);
    }
    return tool.run(parsed, ctx);
  }

  private async check(route: ModelRoute, text: string, fired: FiredRule[], ctx: OperationContext) {
    const rejections: Rejection[] = [];
    let output: unknown = text;

    if (route.output) {
      try {
        const parsed = route.output.safeParse(extractJson(text));
        if (!parsed.success) {
          rejections.push({ ruleId: "schema", reason: z.prettifyError(parsed.error) });
          return { output: undefined, rejections };
        }
        output = parsed.data;
      } catch (e) {
        rejections.push({ ruleId: "schema", reason: (e as Error).message });
        return { output: undefined, rejections };
      }
    }

    for (const { rule } of fired) {
      const d = rule.directive;
      if (d.kind !== "enforce") continue;
      const r: EnforceResult = await d.check(output, ctx);
      if (r.action === "transform") output = r.value;
      else if (r.action === "reject") rejections.push({ ruleId: rule.id, reason: r.reason });
    }
    return { output, rejections };
  }

  private resolveModel(ref: string): { provider: ModelProvider; model: string } {
    const i = ref.indexOf(":");
    const providerId = ref.slice(0, i);
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`No provider "${providerId}" registered (needed for ${ref})`);
    return { provider, model: ref.slice(i + 1) };
  }

  private modelSelector(ref: `${string}:${string}`): RuleSelector {
    return async (candidates, ctx) => {
      const { provider, model } = this.resolveModel(ref);
      const schema = z.object({ ruleIds: z.array(z.string()) });
      const res = await provider.generate({
        model,
        system:
          "You decide which rules apply to a task. Return JSON {\"ruleIds\": [...]} listing only the " +
          "IDs of rules whose description matches the task. Return an empty list if none apply.",
        messages: [
          {
            role: "user",
            content:
              `Operation: ${ctx.operation}\nInput:\n${render(ctx.input)}\n\nRules:\n` +
              candidates.map((c) => `- ${c.id}: ${c.description}`).join("\n"),
          },
        ],
        jsonSchema: z.toJSONSchema(schema) as Record<string, unknown>,
        temperature: 0,
      });
      const known = new Set(candidates.map((c) => c.id));
      return schema.parse(extractJson(res.text)).ruleIds.filter((id) => known.has(id));
    };
  }

  private saveTrace(
    operation: string,
    model: string,
    scope: ScopeRef,
    fired: FiredRule[],
    attempts: TraceRecord["attempts"],
    ok: boolean,
  ): TraceRecord {
    return this.store.putTrace({
      operation,
      bag: this.bag.name,
      bagVersion: this.bag.version,
      scope: [scope.orgId, scope.groupId, scope.userId].filter(Boolean).join("/"),
      model,
      fired: fired.map((f) => ({ ruleId: f.rule.id, reason: f.reason })),
      attempts,
      ok,
    });
  }
}

export function assembleSystem(route: ModelRoute, fired: FiredRule[], ctx: OperationContext): string {
  const parts: string[] = [];
  if (route.system) parts.push(route.system);

  const prose = fired.filter((f) => f.rule.directive.kind === "prose");
  if (prose.length) {
    parts.push(
      "# Rules\n" +
        prose
          .map((f) => `- [${f.rule.id}] ${f.rule.directive.kind === "prose" ? f.rule.directive.text : ""}`)
          .join("\n"),
    );
  }
  if (ctx.memory.length) {
    parts.push("# Memory\n" + ctx.memory.map((m) => `- (${m.scope}) ${m.key}: ${m.value}`).join("\n"));
  }
  if (route.output) {
    parts.push(
      "# Output\nRespond with only a JSON value matching this JSON Schema:\n" +
        JSON.stringify(z.toJSONSchema(route.output)),
    );
  }
  return parts.join("\n\n");
}

function render(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}
