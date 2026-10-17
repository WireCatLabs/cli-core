# Conventions

**The rules every WireCat CLI follows are the [WireCat CLI standards handbook](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/README.md)** in cli-base: commands,
output, MCP, permissions, architecture, tests, documents and releases. When this page disagrees with it, the
handbook wins. What binds only the messenger CLIs — tg, max and wa — is [`STANDARD.md`](STANDARD.md).

The [architecture map](ARCHITECTURE.md#responsibility-and-dependency-boundaries) applies the handbook's layers here.

**How tg and max are released and checked live is [`RELEASING.md`](RELEASING.md)**: the steps
their `release` and `test-live` skills share.

**The code rules are the handbook's too**: the linter decides formatting ([toolchain](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/toolchain.md)), sparse
comments that say *why* ([style](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/style.md)), core code takes its environment as arguments
([architecture](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md)), one-shot means the process exits ([lifecycle](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md)), no credential
or message in a log ([security](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md)). Stricter here: a test must not prepare what a
first run lacks.

**Documents state the current facts.** A fact that changed is rewritten — no "Correction" marks, no
strikethrough, no "as of <date>" trail; git keeps what the text said before. A plan or handoff whose
work is merged is deleted, a done backlog item is deleted, and a link to a deleted page becomes plain
text or points at what replaced it. The changelog is the one place that keeps history.

What differs here:

- **English everywhere.** The README, these pages and the changelog are English; max-cli's newer
  documents are Russian.
- **No provider adapter.** max-cli's "wire names below the adapter" rule becomes stricter:
  vendor clients and vendor adapters stay outside Core, and `biome.json` refuses their imports.
  Persistence and CLI/MCP adapters implement shared contracts inside Core.
- **The changelog** has these headings, each at most once per version: `Added`,
  `Changed — may break callers`, `Fixed`, `Security`, `Removed`. The top section is
  `## Unreleased`; a release PR renames it `## <version> — DD.MM.YYYY`. No backlog or decision ids.
  An entry says what changed for a caller, why when it is not obvious, and what to do when it
  breaks something. `pnpm docs:check` checks the shape.
- **No `docs_ai/` in this repository.** It is gitignored; a plan for open work that others need is
  committed in `docs/dev/` and deleted when its work is merged. Open work is [`BACKLOG.md`](BACKLOG.md).
- **Parallel sessions.** Work in a worktree, rebase on `origin/main` before pushing, and take a store
  migration number first ([`COORDINATION.md`](COORDINATION.md#store-migrations)).

A link from one repository to another is a GitHub URL. A relative path into a sibling checkout
resolves on one machine and nowhere else, and `pnpm docs:check` refuses it.
