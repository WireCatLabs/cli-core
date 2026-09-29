# cli-core — working rules

The shared layer under max-cli, cli-messaging, tg-cli and brazecli. **A change here reaches four
tools at their next bump**, so read [`docs/dev/ARCHITECTURE.md`](docs/dev/ARCHITECTURE.md) before
touching a signature — it says who imports what and how a release is picked up.

Then the one reference that covers what you are about to do:
[`docs/dev/CONVENTIONS.md`](docs/dev/CONVENTIONS.md) for code, documents and the changelog, and
[`docs/dev/TESTING.md`](docs/dev/TESTING.md) for the checks and the sandbox.

## The constraints that shape everything

1. **In machine mode, stdout carries data and nothing else.** That contract lives here, in
   `streams` and `renderer`, and every CLI above inherits it.
2. **The environment is an argument.** Clock, keyring, `env`, `fetch`, streams — passed in, the
   real one only a default. Nothing here reads `process.env` or the keychain unasked.
3. **No test reaches the owner's keychain or leaves files behind.** `test/sandbox.ts` enforces it
   for every test file; do not weaken it.
4. **Nothing in the root export is HTTP.** HTTP helpers go to `/http`.
5. **Everything under `src/` is published.** Test-only helpers go to `test/`.

## Comments

Sparse, and only *why*. The global rule in `~/.claude/CLAUDE.md` applies.

## Committing

Conventional commits, a branch off `main` in a worktree, a pull request. Before committing:

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check
```

A change a caller can see gets a `CHANGELOG.md` entry under `## Unreleased`. Releasing is
`bin/release` on `main` — [README](README.md#releasing).
