# apps/server — SaddleBags runtime API (milestone 2)

The self-hosted HTTP runtime. Planned surface:

- `POST /operations/:name`: run an operation through the harness (`{ input, scope }` → `{ output, traceId }`)
- `GET /traces`, `GET /traces/:id`: what fired, why, and every attempt
- `GET /memory/proposals`, `POST /memory/proposals/:id/{approve,reject}`
- `POST /bags/:name/:version/{install-rc,promote,unpublish}`

Plus the `saddlebags` CLI (`install`, `eval`, `promote`, `unpublish`) and a Postgres `Store`.

License: AGPL-3.0-only.
