# SaddleBags

**WordPress for domain-specific agent harnesses.**

A general-purpose model is the horse. **Bags** are what you pack onto it for a
particular job: rules, tools, per-operation model routes, memory schemas and
evals. Bags are versioned npm packages you can install, evaluate as release
candidates, promote and unpublish. The **Stable** is where your whole team,
engineers and domain experts alike, manages them.

SaddleBags is built on one idea from
*Where Uncertainty Lives: Trade-offs from Building a Domain-Specific Harness*:
every operation carries uncertainty, and the design question is **what**
resolves it (code or model), **when** (pre-baked or live) and **who** can
change it. SaddleBags makes each of those placements explicit.

> Status: early. M1 (core + SDK) is done; M2 (server, CLI, Postgres) is in review. See [SPEC.md](./SPEC.md).

## Rules = condition + directive

```ts
import { defineRule, pass, reject } from "@saddlebags/sdk";

// Code decides *when*; prose says *what*. Anyone can read it, engineers own it.
defineRule({
  id: "long-form-pacing",
  condition: { kind: "code", when: (ctx) => ctx.input.classification.targetSeconds > 60 },
  directive: { kind: "prose", text: "Keep pacing tight; cut any shot longer than four seconds." },
  authoredBy: "engineer",
  editableIn: "code",
});

// A selector model decides *when*: a probabilistic condition. Editable in the Stable.
defineRule({
  id: "kids-audience",
  condition: { kind: "model", description: "The brief's audience includes children under 13." },
  directive: { kind: "prose", text: "Use simple words and no calls to purchase." },
  authoredBy: "domain-expert",
  editableIn: "stable",
});

// Code enforces: reject, and the runtime retries with the reason fed back.
defineRule({
  id: "duration-fits",
  condition: { kind: "always" },
  directive: {
    kind: "enforce",
    check: (script, ctx) => (fits(script, ctx) ? pass() : reject("Shots exceed target by >10%")),
  },
});
```

| Condition | Decides by | Deterministic |
|-----------|-----------|---------------|
| `always` | loaded every time | ✓ |
| `model` | a selector model reads the description | ✗ |
| `code` | a TypeScript predicate | ✓ |

| Directive | Effect |
|-----------|--------|
| `prose` | guides the model (shapes behavior, no guarantee) |
| `enforce` | checks the output: pass / transform / reject → retry |
| `enforce-tool` | checks a tool call's arguments: pass / transform / block |

## Running an operation

```ts
import { Harness } from "@saddlebags/core";
import { AnthropicProvider, OpenAIProvider, GoogleProvider } from "@saddlebags/providers";
import videoBag from "@saddlebags/bag-video-brief-to-script";

const harness = new Harness({
  bag: videoBag,
  providers: [new AnthropicProvider(), new OpenAIProvider(), new GoogleProvider()],
  selectorModel: "anthropic:claude-opus-5-5",
});

const { output, trace } = await harness.run("script.write", { brief, classification }, {
  scope: { orgId: "acme", groupId: "brand-team", userId: "dana" },
});

trace.fired;    // [{ ruleId: "long-form-pacing", reason: "predicate" }, ...]
trace.attempts; // every attempt: tool calls, results and enforce rejections
```

Routes choose which bag tools their model may call. The runtime runs the tool
loop: it validates arguments, applies `enforce-tool` rules (transform or
block), runs the tool and feeds results back until the model answers. Failed
calls go back to the model as errors instead of crashing the operation.

## Packages

| Package | What | License |
|---------|------|---------|
| [`@saddlebags/sdk`](packages/sdk) | Bag authoring types and `define*` helpers | MIT |
| [`@saddlebags/core`](packages/core) | Runtime: rules, context, enforcement, memory, SQLite store, evals, lifecycle | AGPL-3.0 |
| [`@saddlebags/providers`](packages/providers) | Anthropic, OpenAI and Google adapters | AGPL-3.0 |
| [`@saddlebags/artifacts-s3`](packages/artifacts-s3) | S3-compatible artifact library | AGPL-3.0 |
| [`bags/video-brief-to-script`](bags/video-brief-to-script) | Reference bag | MIT |
| [`@saddlebags/store-postgres`](packages/store-postgres) | Postgres store (Drizzle) | AGPL-3.0 |
| [`@saddlebags/server`](apps/server) | HTTP runtime + `saddlebags` CLI; MCP server endpoint *(M3)* | AGPL-3.0 |
| `packages/mcp` | MCP client + server adapters *(M3)* | AGPL-3.0 |
| [`apps/stable`](apps/stable) | Web admin *(M4)* | AGPL-3.0 |

## Develop

```sh
pnpm install && pnpm build && pnpm test
```

Requires Node ≥ 22.13.

## License

The core is [AGPL-3.0-only](./LICENSE), so hosted forks stay open. The SDK and
bags are MIT, so the bags you write can be under any license, including a
proprietary one.
