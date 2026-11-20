# Contributing to SaddleBags

Start with [SPEC.md](./SPEC.md). Its decision log records what was decided and
why, and §8 lists what is deliberately out of v1. Proposals that reopen a
decision are welcome, but open an issue first.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Node ≥ 22.18 is required: the default store uses the built-in `node:sqlite`,
and `saddlebags.config.ts` is imported with Node's built-in type stripping.

The Store contract runs on SQLite and in-process Postgres (PGlite) by default.
To also run it against a real Postgres server, as CI does:

```sh
SADDLEBAGS_TEST_PG_URL=postgres://user:pass@localhost:5432/db pnpm test
```

After changing a store schema, update **both** dialects
(`packages/core/src/store/schema-sqlite.ts` and
`packages/store-postgres/src/schema.ts`) and run `pnpm db:generate` in each
package.

## Licensing

- `packages/sdk` and `plugins/*` are MIT.
- Everything else is AGPL-3.0-only.

By contributing, you agree your contribution is licensed under the license of
the package you are changing.
