# @saddlebags/server

The self-hosted SaddleBags runtime: an HTTP API (Hono) and the `saddlebags` CLI.
See §4.12 of the [spec](../../SPEC.md).

## Quickstart

> The packages aren't published to npm yet. This is the intended flow; inside
> this repo, link the workspace packages instead.

```sh
npm install @saddlebags/server
npx saddlebags init                                  # writes saddlebags.config.ts
npx saddlebags install @saddlebags/bag-video-brief-to-script --org acme
# add the bag to `bags` in saddlebags.config.ts, then:
export ANTHROPIC_API_KEY=...
npx saddlebags eval @saddlebags/bag-video-brief-to-script
npx saddlebags promote @saddlebags/bag-video-brief-to-script
SADDLEBAGS_TOKEN=$(openssl rand -hex 24) npx saddlebags serve --host 0.0.0.0
```

```sh
curl -X POST localhost:4848/operations/script.write \
  -H "authorization: Bearer $SADDLEBAGS_TOKEN" -H "content-type: application/json" \
  -d '{"scope":{"orgId":"acme"},"input":{"brief":"30s vertical ad","classification":{"format":"ad","audience":"commuters","targetSeconds":30,"aspect":"9:16"}}}'
```

## Config

```ts
import { defineConfig } from "@saddlebags/server";

export default defineConfig({
  bags: ["@saddlebags/bag-video-brief-to-script"],
  store: { kind: "postgres", url: process.env.DATABASE_URL!, schema: "saddlebags" }, // default: SQLite
  providers: "env",                       // ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
  selectorModel: "anthropic:claude-opus-5-5",
  minPassRate: 1,
  evalScope: { orgId: "acme" },            // the scope evals run as (needs MCP connections, if any)
  mcp: { stdioAllowlist: ["npx"] },        // exact commands stdio MCP servers may run; default none
  server: { port: 4848 },
});
```

## HTTP API

| Route | Purpose |
|-------|---------|
| `GET /health` | Loaded bags and their channels (no auth) |
| `POST /operations/:name` | `{ input, scope, bag?, channel?, history?, meta? }` → `{ output, traceId }`, or `422` with the rejections |
| `GET /traces?operation=&limit=`, `GET /traces/:id` | Traces |
| `GET /memory/proposals?status=`, `POST /memory/proposals/:id/{approve,reject}` | Memory review (`{ reviewer }`) |
| `GET /bags`, `POST /bags/:name/{evals,promote,unpublish}` | Releases; URL-encode scoped names |

With `SADDLEBAGS_TOKEN` set, every route except `/health` needs
`Authorization: Bearer <token>`. Without it, `serve` binds localhost only.

## MCP (§4.11 of the spec)

### Using 3rd-party MCP servers in a bag

A bag declares the servers it needs; routes list the exact tools they offer.

```ts
defineBag({
  mcp: {
    servers: [
      { name: "github", transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
        auth: "token", connectAt: ["org", "user"] },
    ],
  },
  routes: [{ operation: "brief.research", model: "anthropic:claude-opus-5-5", tools: ["github.search_issues"] }],
});
```

An admin connects it, per scope. The narrowest connection wins at runtime.

```sh
export SADDLEBAGS_SECRET_KEY=$(openssl rand -hex 32)   # keep it: it decrypts stored credentials
GITHUB_TOKEN=... npx saddlebags mcp connect @acme/research-bag github --org acme --token-env GITHUB_TOKEN
npx saddlebags eval @acme/research-bag --org acme       # evals need a scope with connections
npx saddlebags promote @acme/research-bag               # also pins the server's tool definitions
npx saddlebags mcp drift @acme/research-bag             # changed tools are withheld until...
npx saddlebags mcp repin @acme/research-bag --org acme  # ...a re-pin passes evals
```

stdio servers only run if their exact command is in `mcp.stdioAllowlist` in
the config.

### Serving your operations over /mcp

Routes opt in with `mcp: { expose: true }` and an object `input` schema. Only
`latest` versions are served. Mint a token bound to a scope, then point any MCP
client at `http://<host>:4848/mcp`:

```sh
npx saddlebags token create --name claude-code --org acme --user dana
claude mcp add --transport http saddlebags http://localhost:4848/mcp \
  --header "Authorization: Bearer sbt_..."
```

The token's scope is the caller's scope for memory, rules and MCP
connections, and traces record the caller as `mcp:<tokenId>`.

License: AGPL-3.0-only.
