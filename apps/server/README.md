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

## Milestone 3: MCP endpoint

`/mcp` (streamable HTTP) will serve every route marked `mcp: { expose: true }`
from `latest` bag versions as an MCP tool. Callers will authenticate with scoped
bearer tokens (`saddlebags token create --org acme --user dana`). See §4.11 of
the spec.

License: AGPL-3.0-only.
