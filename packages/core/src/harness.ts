import { z } from "zod";
import type {
  Bag,
  ChatMessage,
  EnforceResult,
  GenerateResponse,
  ModelProvider,
  ModelRoute,
  OperationContext,
  Rule,
  ScopeRef,
  StepRecord,
  ToolCall,
  ToolResult,
  ToolSpec,
} from "@saddlebags/sdk";
import {
  McpResolveError,
  isMcpToolName,
  modelToolName,
  type ExternalTool,
  type ExternalToolResolver,
} from "./external-tools.js";
import { extractJson } from "./json.js";
import { Memory } from "./memory.js";
import { assertOverlayRule, selectRules, type FiredRule, type RuleSelector } from "./rules.js";
import { SqliteStore } from "./store/sqlite.js";
import type { Store, ToolCallRecord, TraceNote, TraceRecord } from "./store/types.js";

export interface HarnessOptions {
  bag: Bag;
  providers: ModelProvider[];
  store?: Store;
  /** Model used to decide model-decided conditions, e.g. "anthropic:claude-haiku-5-5". */
  selectorModel?: `${string}:${string}`;
  /** Prose rules authored in the Stable, layered on top of the bag. */
  overlays?: Rule[];
  /** Resolves routes' MCP tools (`<server>.<tool>`). Required if any route lists one. */
  mcp?: ExternalToolResolver;
}

export interface RunOptions {
  scope: ScopeRef;
  history?: StepRecord[];
  meta?: Record<string, unknown>;
  /** Who is running it, for the trace: `api`, `cli`, `eval`, `mcp:<tokenId>`. */
  caller?: string;
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

export class ToolBlockedError extends Error {
  constructor(
    public tool: string,
    public ruleId: string,
    reason: string,
  ) {
    super(`Tool "${tool}" blocked by [${ruleId}]: ${reason}`);
    this.name = "ToolBlockedError";
  }
}

/** The operation's input failed the route's `input` schema. Nothing was run. */
export class InputError extends Error {
  constructor(
    public operation: string,
    public issues: string,
  ) {
    super(`Invalid input for "${operation}": ${issues}`);
    this.name = "InputError";
  }
}

type Rejection = { ruleId: string; reason: string };

/** What a model-facing tool name refers to in this run. */
type OfferedTool = { kind: "bag"; name: string } | { kind: "external"; tool: ExternalTool };

/** Everything that identifies a run in its trace. */
interface RunMeta {
  operation: string;
  model: string;
  scope: ScopeRef;
  fired: FiredRule[];
  caller?: string;
  notes: TraceNote[];
}

export class Harness {
  readonly bag: Bag;
  readonly store: Store;
  readonly memory: Memory;
  private providers: Map<string, ModelProvider>;
  private rules: Rule<any, any>[];
  private selector?: RuleSelector;
  private mcp?: ExternalToolResolver;

  constructor(opts: HarnessOptions) {
    this.bag = opts.bag;
    this.store = opts.store ?? new SqliteStore();
    this.memory = new Memory(this.store, opts.bag.memory);
    this.providers = new Map(opts.providers.map((p) => [p.id, p]));
    for (const r of opts.overlays ?? []) assertOverlayRule(r);
    this.rules = [...(opts.bag.rules ?? []), ...(opts.overlays ?? [])];
    if (opts.selectorModel) this.selector = this.modelSelector(opts.selectorModel);
    this.mcp = opts.mcp;
    for (const t of opts.bag.tools ?? []) {
      if (isMcpToolName(t.name)) throw new Error(`Bag tool "${t.name}": names can't contain "." (reserved for MCP tools)`);
    }
  }

  route(operation: string): ModelRoute {
    const route = this.bag.routes.find((r) => r.operation === operation);
    if (!route) throw new Error(`Bag ${this.bag.name} has no route for operation "${operation}"`);
    return route;
  }

  async run<O = unknown>(operation: string, input: unknown, opts: RunOptions): Promise<RunResult<O>> {
    const route = this.route(operation);
    const { provider, model } = this.resolveModel(route.model);
    if (route.input) {
      const parsed = route.input.safeParse(input);
      if (!parsed.success) throw new InputError(operation, z.prettifyError(parsed.error));
      input = parsed.data;
    }
    const ctx: OperationContext = {
      operation,
      input,
      scope: opts.scope,
      memory: await this.memory.load(opts.scope),
      history: opts.history ?? [],
      meta: opts.meta ?? {},
    };

    const fired = await selectRules(this.rules, ctx, this.selector);
    const meta: RunMeta = { operation, model: route.model, scope: opts.scope, fired, caller: opts.caller, notes: [] };
    const attempts: TraceRecord["attempts"] = [];

    let offered: Map<string, OfferedTool>;
    try {
      offered = await this.offerTools(route, ctx, meta.notes);
    } catch (e) {
      if (!(e instanceof McpResolveError)) throw e;
      meta.notes.push({ kind: "mcp.omitted", server: e.server, detail: `${e.message}; the server is required` });
      throw new HarnessError(e.message, await this.saveTrace(meta, attempts, false));
    }

    const system = assembleSystem(route, fired, ctx);
    const jsonSchema = route.output ? (z.toJSONSchema(route.output) as Record<string, unknown>) : undefined;
    const tools = [...offered.entries()].map(([modelName, t]) => this.toolSpec(modelName, t));
    const messages: ChatMessage[] = [{ role: "user", content: render(input) }];
    const maxAttempts = route.maxAttempts ?? 3;
    const maxToolTurns = route.maxToolTurns ?? 8;

    for (let i = 0; i < maxAttempts; i++) {
      const toolCalls: ToolCallRecord[] = [];
      let res!: GenerateResponse;

      // The tool loop: keep going while the model asks for tools.
      for (let turn = 0; ; turn++) {
        res = await provider.generate({
          model,
          system,
          messages,
          jsonSchema,
          tools: tools.length ? tools : undefined,
          maxTokens: route.maxTokens,
          temperature: route.temperature,
        });
        if (!res.toolCalls?.length) break;

        if (turn >= maxToolTurns) {
          attempts.push({ output: undefined, rejections: [], toolCalls });
          const trace = await this.saveTrace(meta, attempts, false);
          throw new HarnessError(`Operation "${operation}" exceeded ${maxToolTurns} tool turns`, trace);
        }

        messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls, raw: res.raw });
        const results: ToolResult[] = [];
        for (const call of res.toolCalls) {
          const record = await this.executeToolCall(call, offered, route, fired, ctx);
          toolCalls.push(record);
          results.push({
            callId: call.id,
            name: call.name,
            content: record.error ?? serialize(record.result),
            isError: record.error !== undefined,
          });
        }
        messages.push({ role: "tool", results });
      }

      const { output, rejections } = await this.check(route, res.text, fired, ctx);
      attempts.push(toolCalls.length ? { output, rejections, toolCalls } : { output, rejections });

      if (rejections.length === 0) {
        const trace = await this.saveTrace(meta, attempts, true);
        return { output: output as O, trace };
      }
      messages.push(
        { role: "assistant", content: res.text, raw: res.raw },
        {
          role: "user",
          content:
            "Your previous answer was rejected:\n" +
            rejections.map((r) => `- [${r.ruleId}] ${r.reason}`).join("\n") +
            "\nRevise and answer again.",
        },
      );
    }

    const trace = await this.saveTrace(meta, attempts, false);
    throw new HarnessError(`Operation "${operation}" failed enforcement after ${maxAttempts} attempts`, trace);
  }

  /** Run a bag tool directly, applying any enforce-tool directives first. */
  async callTool(name: string, args: unknown, ctx: OperationContext): Promise<unknown> {
    const fired = await selectRules(this.rules, ctx, this.selector);
    return this.runTool(name, args, fired, ctx);
  }

  private async runTool(name: string, args: unknown, fired: FiredRule[], ctx: OperationContext) {
    const tool = this.bag.tools?.find((t) => t.name === name);
    if (!tool) throw new Error(`Bag ${this.bag.name} has no tool "${name}"`);
    const parsed = await applyToolRules(name, tool.input.parse(args), fired, ctx, (v) => tool.input.parse(v));
    return { args: parsed, result: await tool.run(parsed, ctx) };
  }

  /** An MCP tool call: validate against its JSON Schema, apply enforce-tool rules, call. */
  private async runExternalTool(tool: ExternalTool, args: unknown, fired: FiredRule[], ctx: OperationContext) {
    const validate = (v: unknown) => {
      const err = tool.validate(v);
      if (err) throw new Error(`Invalid arguments: ${err}`);
      return v;
    };
    const parsed = await applyToolRules(tool.name, validate(args), fired, ctx, validate);
    const res = await tool.call(parsed);
    if (res.isError) throw new Error(res.content || `Tool "${tool.name}" failed`);
    return { args: parsed, result: res.structured ?? res.content };
  }

  /**
   * One model-requested call. Failures (unknown or unoffered tool, bad
   * arguments, a block, a thrown error) go back to the model as error results
   * rather than ending the operation.
   */
  private async executeToolCall(
    call: ToolCall,
    offered: Map<string, OfferedTool>,
    route: ModelRoute,
    fired: FiredRule[],
    ctx: OperationContext,
  ): Promise<ToolCallRecord> {
    const t = offered.get(call.name);
    const record: ToolCallRecord = { id: call.id, name: t?.kind === "external" ? t.tool.name : call.name, args: call.args };
    if (!t) {
      record.error = `Tool "${call.name}" is not available for ${route.operation}`;
      return record;
    }
    if (t.kind === "external") {
      record.server = t.tool.server;
      record.connection = t.tool.connection;
    }
    try {
      const { args, result } =
        t.kind === "bag"
          ? await this.runTool(t.name, call.args, fired, ctx)
          : await this.runExternalTool(t.tool, call.args, fired, ctx);
      record.args = args;
      record.result = result;
    } catch (e) {
      if (e instanceof ToolBlockedError) record.blockedBy = e.ruleId;
      record.error = e instanceof z.ZodError ? `Invalid arguments: ${z.prettifyError(e)}` : (e as Error).message;
    }
    return record;
  }

  /**
   * The tools this run offers, keyed by model-facing name. MCP tools that are
   * optional-and-unconnected or drifted are left out, with a note.
   */
  private async offerTools(route: ModelRoute, ctx: OperationContext, notes: TraceNote[]) {
    const offered = new Map<string, OfferedTool>();
    const names = route.tools ?? [];
    for (const name of names.filter((n) => !isMcpToolName(n))) {
      if (!this.bag.tools?.some((t) => t.name === name)) {
        throw new Error(`Route ${route.operation} offers unknown tool "${name}"`);
      }
      offered.set(name, { kind: "bag", name });
    }

    const mcpNames = names.filter(isMcpToolName);
    if (mcpNames.length === 0) return offered;
    if (!this.mcp) throw new Error(`Route ${route.operation} offers MCP tools but no MCP resolver is configured`);
    const set = await this.mcp.resolve(this.bag, mcpNames, ctx);
    notes.push(...set.notes);
    for (const tool of set.tools) {
      const modelName = modelToolName(tool.name);
      if (offered.has(modelName)) {
        throw new Error(`Route ${route.operation}: MCP tool "${tool.name}" collides with bag tool "${modelName}"`);
      }
      offered.set(modelName, { kind: "external", tool });
    }
    return offered;
  }

  private toolSpec(modelName: string, t: OfferedTool): ToolSpec {
    if (t.kind === "external") {
      return { name: modelName, description: t.tool.description, inputSchema: t.tool.inputSchema };
    }
    const tool = this.bag.tools!.find((x) => x.name === t.name)!;
    return {
      name: modelName,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>,
    };
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

  private saveTrace(meta: RunMeta, attempts: TraceRecord["attempts"], ok: boolean): Promise<TraceRecord> {
    const { scope } = meta;
    return this.store.putTrace({
      operation: meta.operation,
      bag: this.bag.name,
      bagVersion: this.bag.version,
      scope: [scope.orgId, scope.groupId, scope.userId].filter(Boolean).join("/"),
      model: meta.model,
      fired: meta.fired.map((f) => ({ ruleId: f.rule.id, reason: f.reason })),
      attempts,
      ok,
      ...(meta.caller && { caller: meta.caller }),
      ...(meta.notes.length && { notes: meta.notes }),
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

/** Apply enforce-tool directives for `name`: transforms re-validate, rejects block. */
async function applyToolRules(
  name: string,
  args: unknown,
  fired: FiredRule[],
  ctx: OperationContext,
  revalidate: (v: unknown) => unknown,
): Promise<unknown> {
  let current = args;
  for (const { rule } of fired) {
    const d = rule.directive;
    if (d.kind !== "enforce-tool" || d.tool !== name) continue;
    const r = await d.check(current, ctx);
    if (r.action === "reject") throw new ToolBlockedError(name, rule.id, r.reason);
    if (r.action === "transform") current = revalidate(r.value);
  }
  return current;
}

function serialize(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

function render(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}
