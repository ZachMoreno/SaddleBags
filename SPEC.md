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
- **Postgres** opt-in for teams and production, behind the same `Store`
  interface.
- The store holds installed bags and channels, Stable overlays, memory,
  memory proposals, traces, eval runs and the audit log.

### 4.10 Providers

v1 is **multi-provider from day one**. Adapters for **Anthropic, OpenAI and
Google** sit behind one `ModelProvider` interface, and routes reference
`provider:model`. Video-model adapters arrive with the rendering bag.

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
bags/video-brief-to-script     reference bag
apps/server             AGPL   HTTP runtime API        (milestone 2)
apps/stable             AGPL   web admin               (milestone 3)
```

Tooling: pnpm workspaces, Turborepo, Vitest, TypeScript (ESM, strict),
Node ≥ 22.

## 7. Milestones

1. **M1 — Core + SDK**: rule engine (always/model/code × prose/enforce),
   context assembly, traces, memory with per-scope policy, SQLite store, eval
   runner, provider adapters, fs + S3 artifact stores, reference bag.
2. **M2 — Server + CLI**: HTTP API (`POST /operations/:name`), `saddlebags`
   CLI (`install`, `eval`, `promote`, `unpublish`), Postgres store.
3. **M3 — Stable**: web admin for prose overlays, memory curation, proposal
   review, trace explorer, RC → promote flow.
4. **M4 — Hosted Stable**: managed offering.

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
