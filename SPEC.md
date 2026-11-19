# SaddleBags — v1 Specification

> WordPress for domain-specific agent harnesses.

Status: **draft v0.1**, written from the founding interview (2026-11-18).
Grounded in the essay *Where Uncertainty Lives: Trade-offs from Building a
Domain-Specific Harness* (Zachariah Moreno, Oct 2026).

---

## 1. Thesis

A harness is the layer of **models, tools, rules, memory and context**
between a general-purpose model and a product that has to work every time.
Every operation in it carries uncertainty, and the design question is
where that uncertainty is resolved:

| Axis | Question | Options |
|------|----------|---------|
| **What** | Code or model? | deterministic function ↔ probabilistic model call |
| **When** | Build time or in front of the user? | pre-baked artifact ↔ live generation |
| **Who** | Who can change it? | engineers (code) ↔ anyone who writes clearly (prose) |

SaddleBags makes those placements **explicit, versioned, and editable by
the right people**. The levers stay the same in every harness. The *bags*
are what make one harness domain-specific.

### The metaphor

- **The horse** is the general-purpose model.
- **A bag** is what you pack onto it for a particular journey: rules, tools,
  model routes, memory schemas, and evals.
- **Bags are portable.** They are versioned npm packages you can install,
  share, promote and unpublish, much as WordPress plugins are.
- **The Stable** is the web admin where a mixed team manages its bags.

## 2. Audience

**Mixed teams from day one.**

- **Engineers** write code predicates, enforcement directives, tools and
  model routes using the TypeScript SDK.
- **Domain experts** (producers, brand leads, editors) write prose rules,
  curate memory and review memory proposals in the Stable, without writing
  code.

Every lever records **who can change it**. This is part of the data model,
not left to convention.

## 3. Product shape

Following the WordPress.org / WordPress.com split:

| Surface | What it is | License |
|---------|------------|---------|
| `@saddlebags/sdk` | Types and `define*` helpers for authoring bags | **MIT** |
| `@saddlebags/core` | The runtime: rule resolution, context assembly, enforcement, memory, store | **AGPL-3.0** |
| `@saddlebags/providers` | Multi-provider model adapters | **AGPL-3.0** |
| `@saddlebags/artifacts-s3` | S3-compatible artifact library adapter | **AGPL-3.0** |
| `apps/server` | Self-hosted HTTP runtime API | **AGPL-3.0** |
| `apps/stable` | Self-hosted web admin | **AGPL-3.0** |
| Hosted Stable | Managed hosting/ops of the above | service |

The SDK is MIT so that third-party bags, including proprietary ones, can use
any license. AGPL covers the server so that hosted forks stay open.

## 4. Concepts

### 4.1 Bag

A bag is an npm package whose default export is `defineBag({...})` and whose
`package.json` carries a `"saddlebags"` manifest field. A v1 bag can contain:

- **Rules**: a condition and a directive (§4.2)
- **Tools**: typed callable functions (zod input schema)
- **Model routes**: a model choice per *operation*, with a **pinned model
  version**, provider, params and an optional typed output schema (the
  essay's "type-safe decision model")
- **Memory schemas**: scopes, per-scope write policies, and seed memories
- **Evals**: golden cases with graders (§4.6)

Everything in a bag is **versioned, evaluable, promotable as a release
candidate, and (un)publishable** (§4.7).

### 4.2 Rules = condition + directive

**Conditions** decide *when* a rule applies. v1 ships three of the essay's
four kinds:

| Kind | How it decides | Deterministic? | Who writes it |
|------|----------------|----------------|---------------|
| `always` | Loaded on every applicable operation | yes | anyone |
| `model` | A selector model reads the rule's description and chooses | **no** | anyone |
| `code` | A TS predicate over the operation context | yes | engineers |

*Deterministic match / DSL* (globs, JSON predicates) is **deliberately out of
v1**. See §8.

**Directives** say *what* happens once a rule applies:

| Kind | Effect | Guarantee |
|------|--------|-----------|
| `prose` | Injected into the model's context | guides, does not guarantee |
| `enforce` | A code function on the output: `pass`, `transform(value)`, `reject(reason)` | enforces |
| `enforce-tool` | A code function on a named tool call's arguments before it runs: `pass`, `transform`, `reject` (blocks the call) | enforces |

On `reject`, the runtime retries the operation and feeds the rejection reason
back to the model, up to `maxAttempts`. After that the operation fails
loudly.

Every rule carries `authoredBy: "engineer" | "domain-expert"` and an
`editableIn: "code" | "stable"` marker, so the Stable knows which rules a
non-engineer may change.

### 4.3 Operations and the per-operation model choice

An **operation** is a named step, such as `brief.classify` or
`script.write`. Each operation has a model route. A typical bag uses a
small, fast model for typed decisions and a frontier model for writing.
Model versions are pinned, and changing one is a bag change that goes
through evals (§4.6).

### 4.3.1 Tool loop

A route lists the bag tools its model may call (`tools: ["footage_search"]`);
by default it offers none. Within each attempt the runtime loops:

1. Call the model with the route's tools.
2. If it asks for tools, run each call in order: validate the arguments
   against the tool's zod schema, apply `enforce-tool` directives (which can
   transform the arguments or block the call), then run the tool.
3. Send the results back and repeat until the model gives a final answer.
   Then the output checks run (schema, then `enforce`).

The loop never throws on a failed tool call. Unknown or unoffered tools,
invalid arguments, blocked calls and thrown errors all go back to the model
as error results, so it can recover. More than `maxToolTurns` (default 8)
tool turns in one attempt fails the operation.

Every call is recorded in the trace with the arguments as executed, its
result or error, and which rule blocked it, if any. Provider adapters
replay assistant turns verbatim (Anthropic thinking blocks, Gemini thought
signatures), as multi-turn tool use requires.

### 4.4 Memory

- Scopes are **org → group → user**, matching the host's data model.
  Narrower scopes override broader ones when context is assembled.
- **The write policy is set per scope:**
  - `auto`: model-proposed writes persist immediately
  - `review`: writes queue as proposals until a human approves them in the
    Stable
  - `code`: a policy function decides (approve / reject / escalate to review)
- Every write, proposal, approval and rejection goes to the audit log.

This addresses the essay's warning that one bad model write to memory
shapes every session after it.

### 4.5 Context

For each operation, the runtime assembles:

1. the route's base system prompt
2. the prose directives of every rule that fired, each labelled with its
   rule ID
3. the applicable memory, merged across scopes
4. the operation input

It records a **trace** of which rules fired and **why** (always, predicate
true, or selector model chose it), plus attempts, enforcement results and
the model actually used.

### 4.6 Evals (v1: golden cases + graders)

Each bag ships eval cases: `{ operation, input, graders[] }`. Graders are
either:

- **code**: an assertion function over the output, or
- **judge**: a prose rubric scored by a model route.

`saddlebags eval <bag>@<version>` runs a candidate against a baseline (the
currently published version) and reports pass rates and regressions.

**Planned after v1:** replaying recorded production traffic against an RC,
with diffs for human review in the Stable.

### 4.7 Release lifecycle

Bags use npm, with dist-tags as channels:

```
draft (local) ──publish──▶ rc ──eval gate──▶ latest (published)
                                   │
                                   └── unpublish / deprecate
```

- An **RC** (`npm dist-tag rc`) can be installed into a Stable "staging" lane.
- **Promotion** to `latest` requires a passing eval run against the
  baseline. That covers both bag changes and model-route changes.
- **Unpublish** removes the bag from the Stable's active set, and the trace
  history keeps the version it ran.

Prose rules edited in the Stable are stored as **overlays** on an
installed bag version. They are versioned and evaluable in the same way,
so non-engineers get the same RC → eval → promote flow without touching npm.

### 4.8 Artifact library (pre-baked ↔ live)

The library is a content-addressed artifact store for any operation's
output, with `pending → approved | rejected` states. It is the essay's "turn
probabilistic output into a deterministic artifact" mechanism.

- Interface: `ArtifactStore` (put / get / list / setStatus)
- Default: local filesystem (zero-config)
- v1 adapter: **S3-compatible** (AWS S3, Cloudflare R2, MinIO, Backblaze B2,
  etc.)

Automatic promotion of live outputs into the library is **not in v1** (§8).

### 4.9 Storage

- **SQLite** by default (`node:sqlite`, so there are no native deps). This is
  the 5-minute install.
- **Postgres** opt-in for teams and production (`@saddlebags/store-postgres`),
  behind the same async `Store` interface. A `schema` option keeps the tables
  and migration journal together, so several installs can share a database.
- **Both are Drizzle-backed.** One `DrizzleStore` holds the query logic, and
  each dialect supplies its own table definitions with identical column names.
  SQLite runs Drizzle's `sqlite-proxy` driver over `node:sqlite`. Postgres uses
  `postgres-js` in production and PGlite for in-process tests. Migrations are
  generated by drizzle-kit and shipped with each package.
- **One contract, every store.** `@saddlebags/core/testing` exports a Store
  contract suite. SQLite, PGlite and a real Postgres server (in CI) all run it,
  which keeps the two schemas from drifting apart.
- The store holds installed bags and channels, memory, memory proposals,
  traces, eval runs and the audit log (Stable overlays arrive in M4).

### 4.10 Providers

v1 is **multi-provider from day one**. Adapters for **Anthropic, OpenAI and
Google** sit behind one `ModelProvider` interface, and routes reference
`provider:model`. Video-model adapters arrive with the rendering bag.

### 4.11 MCP (milestone 3)

SaddleBags speaks the Model Context Protocol in both directions.

- **3rd-party MCP:** the harness is an MCP *client*. Tools from external MCP
  servers become tools a route can offer its model.
- **1st-party MCP:** the harness is an MCP *server*. Selected bag operations
  become MCP tools that any MCP client (Claude Code, Claude Desktop, Cursor,
  other agents) can call, with the bag's rules, memory and enforcement applied.

Through the essay's lens, an external MCP server is a lever whose behavior
someone else controls. Its tool descriptions are prose you didn't write, and
its definitions can change without a line of your code changing. The design
below puts each of those uncertainties somewhere visible.

#### 4.11.1 3rd-party: bags declare, the Stable connects

**Who** (the essay's third axis) is split deliberately:

| Step | Who | Where |
|------|-----|-------|
| Declare that a bag needs a server, and how to reach it | engineers | bag code |
| Choose which of its tools a route may call | engineers | bag code (route `tools`) |
| Connect the server and supply credentials | admins | Stable (CLI/API until M4) |

A bag declares its servers:

```ts
defineBag({
  // ...
  mcp: {
    servers: [
      {
        name: "github",
        description: "Look up issues referenced in a brief",
        transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
        auth: "oauth",                       // "oauth" | "token" | "none"
        connectAt: ["org", "user"],          // scopes allowed to hold a connection
      },
      {
        name: "ffprobe",
        transport: { kind: "stdio", command: "npx", args: ["-y", "@acme/ffprobe-mcp"] },
        auth: "none",
        optional: true,                      // operation still runs if not connected
      },
    ],
  },
  routes: [
    { operation: "script.write", /* ... */ tools: ["footage_search", "github.search_issues"] },
  ],
});
```

- **Naming.** MCP tools are named `<server>.<tool>` in bag code. Model-facing
  names use `<server>__<tool>`, because providers restrict tool-name
  characters.
- **Same rules as bag tools.** An MCP tool goes through exactly the same
  path as a bag tool (§4.3.1). The route must list it explicitly, so there
  are no wildcards. Its arguments are validated against its advertised JSON
  Schema, `enforce-tool` directives can transform or block the call, and
  errors go back to the model. The trace records the call with the server
  name and the connection's scope.
- **Connections are scoped like memory.** A connection can be held at any
  scope the declaration allows in `connectAt`. At runtime the **narrowest
  connection wins**: a user's own GitHub OAuth beats the org's service token.
  The trace records which connection was used.
- **Not connected.** If a required server has no connection for the
  caller's scope, the operation fails before calling the model, with an
  error that names the server and scope. If the server is `optional`, its
  tools are left out of that run's offer, and the trace notes the omission.
- **Credentials** (OAuth tokens and refresh tokens, API tokens) are stored
  encrypted in the `Store`. They are never placed in context and never
  written to traces.

#### 4.11.2 Transports: HTTP and stdio, everywhere

- **Streamable HTTP** for remote servers.
- **stdio** for local servers, in **all deployments, including hosted**.
  The command always comes from the bag declaration, which engineers own.
  The Stable can supply env and credentials but never the command.
- On self-hosted installs, stdio servers run as child processes of the
  server, restricted to an operator-configured command allowlist.
- On the **hosted Stable**, stdio servers must run in a per-org sandbox with
  no shared filesystem, network egress limited to declared hosts, and CPU,
  memory and time limits. This is a hard requirement for M5 (hosted).

#### 4.11.3 Pinning and drift

An external server changing its tools is like a model update you didn't
make (essay: "pin model versions where you can, and rerun evals when you
can't"). SaddleBags pins them:

1. **Pin on promote.** When a bag version is promoted, the runtime records a
   snapshot of each declared server's `tools/list`: every tool's name,
   description and input-schema hash. The snapshot is stored with the install.
2. **Detect at runtime.** Each run compares the live definitions of the tools
   it offers against the pin. A **description change counts as drift**,
   because descriptions are prose that steers the model.
3. **Withhold drifted tools.** A tool that drifted (changed or removed) is
   withheld from the offer as if not connected. The trace records the drift,
   and the Stable flags the bag as needing a re-pin.
4. **Re-pin through evals.** A re-pin runs the bag's evals against the live
   definitions. If they pass the gate (§4.7), the new snapshot is promoted,
   following the same RC → promote flow as a bag change.

#### 4.11.4 1st-party: the harness as an MCP server

- **Endpoint:** `apps/server` serves streamable HTTP at `/mcp`.
- **Opt-in per operation.** A route is exposed only if it sets
  `mcp: { expose: true }`. Only `latest` bag versions are served, so RCs and
  unpublished versions never are.
- **Typed in and out.** An exposed route must declare an `input` zod schema.
  Its `output` schema, if any, becomes the MCP tool's `outputSchema`, and
  results are returned as `structuredContent`.
- **Tool name:** `<bag>__<operation>`, with dots replaced by underscores. For
  example, `video_brief_to_script__script_write`.
- **Auth: scoped API tokens.** Admins mint bearer tokens bound to an
  org/group/user scope (CLI in M3, Stable in M4). The token's scope becomes
  the run's `ScopeRef`, so memory, connections and rules resolve per caller.
  Traces record the caller as `mcp:<tokenId>`. OAuth for MCP clients is
  planned later.
- **Errors:** a `HarnessError` comes back as an `isError` result carrying
  the reasons for the final rejection and the trace ID.

#### 4.11.5 Out of scope for M3

- Output guards on MCP tool results (injection filters, size caps). MCP
  results are treated the same as bag-tool results for now (§10).
- MCP resources, prompts, sampling and elicitation, in either direction.
- Exposing the Stable itself, or memory, over MCP.
- Wildcard tool allowlists (`github.*`).

### 4.12 Server and CLI (milestone 2)

`@saddlebags/server` holds the HTTP runtime (Hono) and the `saddlebags` CLI.

**Config.** A project has a `saddlebags.config.ts` (`defineConfig`) listing its
bag packages, the store, the providers (`"env"` by default) and the selector
model. Node imports the TypeScript config directly. Bags resolve from the
*project's* `node_modules`, not the server's.

**Serving.** M2 serves the one installed version of each bag. An operation
runs only if that version is on `latest`, or on `rc` when the request asks for
`channel: "rc"`. Running a `latest` and an `rc` version side by side (npm
aliases) is future work.

**HTTP API**

| Route | Purpose |
|-------|---------|
| `GET /health` | Loaded bags and their channels (no auth) |
| `POST /operations/:name` | `{ input, scope, bag?, channel?, history?, meta? }` → `{ output, traceId }`; `422` with the rejections and trace ID when enforcement fails |
| `GET /traces`, `GET /traces/:id` | What fired, why, and every attempt |
| `GET /memory/proposals`, `POST /memory/proposals/:id/{approve,reject}` | Memory review |
| `GET /bags`, `POST /bags/:name/{evals,promote,unpublish}` | Releases (URL-encode scoped names) |

**Auth.** With `SADDLEBAGS_TOKEN` set, every route except `/health` requires
`Authorization: Bearer <token>`. Without it, the server refuses to bind
anything but localhost. Scoped tokens arrive with M3 (§4.11.4).

**CLI**

| Command | Does |
|---------|------|
| `init` | Write a starter `saddlebags.config.ts` |
| `migrate` | Create or upgrade the store's tables |
| `install <pkg> [--org id] [--no-npm]` | Install with the project's package manager, register the version as `rc`, optionally seed starter memory |
| `eval <bag>` | Run the bag's evals and record the run (exit 1 below the minimum pass rate) |
| `promote <bag>` | Promote the installed version to `latest` if its latest eval run clears the gate against the current `latest` |
| `unpublish <bag> <version>` | Stop serving a version |
| `status`, `traces`, `memory proposals/approve/reject` | Inspect and review |
| `serve [--port] [--host]` | Start the HTTP API (default `127.0.0.1:4848`) |

## 5. Reference bag: `video-brief-to-script`

This bag proves the platform in the essay's domain, without rendering:

| Operation | Model | Notes |
|-----------|-------|-------|
| `brief.classify` | small/fast, typed output | `{ format, audience, targetSeconds, aspect }` |
| `script.write` | frontier | shot list + VO |

Rules demonstrating each placement:

- **always + prose**: house style
- **code + prose**: `if targetSeconds > 60` → "keep pacing tight; cut any shot
  longer than four seconds." This is the essay's example verbatim.
- **model + prose**: "when the brief targets children…"
- **always + enforce**: the sum of shot durations must be within ±10% of
  `targetSeconds` (reject → retry)
- **always + enforce**: aspect ratio must be one of the allowed set
  (transform to normalize)

Evals: golden briefs, with code graders for structure and duration and a
judge grader for tone.

## 6. Repository layout

```
packages/sdk            MIT    authoring types + define* helpers
packages/core           AGPL   runtime, rule engine, memory, store, evals
packages/providers      AGPL   anthropic / openai / google adapters
packages/artifacts-s3   AGPL   S3-compatible ArtifactStore
packages/store-postgres AGPL   Postgres Store (Drizzle)            (milestone 2)
bags/video-brief-to-script     reference bag
packages/mcp            AGPL   MCP client + server adapters        (milestone 3)
apps/server             AGPL   HTTP runtime API + /mcp endpoint    (milestones 2–3)
apps/stable             AGPL   web admin                           (milestone 4)
```

Tooling: pnpm workspaces, Turborepo, Vitest, TypeScript (ESM, strict),
Node ≥ 22.

## 7. Milestones

1. **M1 — Core + SDK**: rule engine (always/model/code × prose/enforce/enforce-tool),
   tool loop,
   context assembly, traces, memory with per-scope policy, SQLite store, eval
   runner, provider adapters, fs + S3 artifact stores, reference bag.
2. **M2 — Server + CLI** (§4.12): HTTP API (`POST /operations/:name`), `saddlebags`
   CLI (`install`, `eval`, `promote`, `unpublish`), Postgres store.
3. **M3 — MCP** (§4.11): `packages/mcp` with an MCP client (bag-declared
   servers, HTTP + stdio transports, scoped connections, pinning and drift
   detection) and an MCP server (`/mcp` on `apps/server`, opt-in operations,
   scoped API tokens). Connections and tokens are managed through the CLI
   and API until the Stable lands.
4. **M4 — Stable**: web admin for prose overlays, memory curation, proposal
   review, trace explorer, RC → promote flow, MCP connections (OAuth flows),
   API tokens and drift/re-pin.
5. **M5 — Hosted Stable**: managed offering, including sandboxed stdio MCP
   servers (§4.11.2).

## 8. Explicitly out of v1

- Deterministic-match / DSL conditions (globs, JSON predicates). The Rule
  of Least Power trade-off is acknowledged; v1 bets on prose for
  non-engineers and code for engineers.
- Hardening assistance (suggesting prose → predicate, live → library
  promotions).
- Production replay evals.
- Video rendering and video-model adapters.
- A custom bag registry (npm is the registry).

## 9. Decision log (founding interview)

| # | Question | Decision |
|---|----------|----------|
| 1 | What is it? | A harness framework, "WordPress for domain-specific agent harnesses" |
| 2 | Language | TypeScript |
| 3 | Day-one audience | Mixed teams (engineers + domain experts) |
| 4 | Name | Bags = what the model carries **and** portable, installable bundles |
| 5 | Shape | Self-hosted app + SDK, **plus** a hosted, managed admin |
| 6 | Bag contents | Rules, tools, model routes, memory schemas + seeds, evals; all versioned, RC-promotable, (un)publishable |
| 7 | Storage | SQLite default, Postgres opt-in |
| 8 | Hardening support | Not in v1 |
| 9 | Condition kinds | Always, model-decided, code |
| 10 | Directives | Prose + code enforce |
| 11 | Evals | Golden cases + graders in v1; production replay planned |
| 12 | Distribution | npm packages (dist-tags as channels) |
| 13 | License | AGPL-3.0 core, MIT SDK |
| 14 | Memory writes | Policy per scope (auto / review / code) |
| 15 | Providers | Multi-provider from day one |
| 16 | First bag | Video brief → script |
| 17 | Library | In v1, with S3-compatible storage adapters |
| 18 | Tooling | pnpm + Turborepo + Vitest |
| 19 | Admin name | **Stable** |

### MCP interview (2026-11-18)

| # | Question | Decision |
|---|----------|----------|
| 20 | What "1st-party MCP" means | The harness as an MCP server: bag operations exposed as MCP tools |
| 21 | Who connects 3rd-party servers | Bags declare, the Stable connects |
| 22 | Rules on MCP tools | Same as bag tools: route allowlist + `enforce-tool` |
| 23 | Placement | New M3; Stable moves to M4, hosted to M5 |
| 24 | Client transports | Streamable HTTP and stdio, everywhere (sandboxed when hosted) |
| 25 | Connection credentials | Per scope, like memory; the narrowest connection wins |
| 26 | Tool drift | Pin on promote, detect at runtime, withhold drifted tools, re-pin via evals |
| 27 | 1st-party exposure + auth | Opt-in operations; Stable-minted API tokens bound to a scope |

## 10. Open questions

- Should overlays be allowed to *disable* engineer-authored rules, or only
  add and edit prose?
- How should the selector model batch model-decided conditions: one call
  per operation (cheap) or one per rule (precise)? v1 uses one call per
  operation.
- How should orgs, groups and users map onto host-app identity (an auth
  adapter)?
- What are the eval gate thresholds: absolute pass rate, or no regressions
  vs. baseline? v1 uses no regressions plus a configurable minimum.
- **MCP:** 3rd-party tool results are untrusted input that goes straight back
  to the model. Should output guards (injection filters, size caps) become a
  directive kind, e.g. `enforce-tool-result`?
- **MCP:** which sandbox technology for hosted stdio servers (gVisor,
  Firecracker, containers per org)?
- **MCP:** should drift withhold a tool whose only change is its description,
  or allow it with a warning? M3 withholds it.
