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

Node ≥ 22.13 is required: the default store uses the built-in `node:sqlite`.

## Licensing

- `packages/sdk` and `bags/*` are MIT.
- Everything else is AGPL-3.0-only.

By contributing, you agree your contribution is licensed under the license of
the package you are changing.
