# Conventions

What is shared with the sibling CLIs is written once, in max-cli's
[`CONVENTIONS.md`](https://github.com/WireCatLabs/max-cli/blob/main/docs/dev/CONVENTIONS.md): Biome decides
formatting, strict TypeScript with no `any`, comments only for *why*, core takes its environment as
arguments, one-shot means one-shot, never log a credential, documents state current facts. The
MAX-specific rules there (wire names, protocol sources, Russian documents) do not apply here. This
page adds only what differs.

## Code

**`src/` is the package.** Every `.ts` file under it is compiled into `dist/` and published, so a
helper only tests need does not go there — [`test/`](../../test/sandbox.ts) is for that. A new entry
point is a new `exports` entry in `package.json`, and [`scripts/smoke.ts`](../../scripts/smoke.ts)
gets a line that runs it under Bun.

**A default is a convenience, never the only path.** Every function that touches the machine takes
the thing it touches as a parameter; the real clock, keyring or `process.env` is only the default
([`ARCHITECTURE.md`](ARCHITECTURE.md#the-two-lines-this-package-does-not-cross)).

**Four repositories upgrade from this one.** A changed signature or a changed behaviour lands in
all of them at their next bump, so it goes under `Changed — may break callers` with what each caller
has to do.

## Documents

English, like everything already here. `README.md` is the user page: current facts only, no
correction marks, no dates of measurement, no backlog or decision ids. `docs/dev/` is for whoever
works on the code and states current facts too: a claim that turns out wrong is rewritten with no
mark, and git keeps the old text. A finished plan is deleted.

## The changelog

`CHANGELOG.md`, newest first. The top section is `## Unreleased` while work is merged; a release
dates it as `## <version> — DD.MM.YYYY`. Headings, each at most once per version: `Added`,
`Changed — may break callers`, `Fixed`, `Security`, `Removed`.

Every entry answers, in this order: **what changed, as a caller sees it** — the bold lead, a whole
sentence; **why**, unless it is obvious; **what to watch for** — who is affected and what to do. No
backlog or decision ids, no internal names a caller cannot see. `pnpm docs:check` checks the shape.
