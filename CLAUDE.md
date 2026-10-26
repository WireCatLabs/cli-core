# cli-core — working rules

The messenger-neutral half of tg-cli and max-cli, published as `@wirecat/cli-core`. Start with
the one page that covers what you are about to touch:

- [`docs/dev/ARCHITECTURE.md`](docs/dev/ARCHITECTURE.md) — the modules, the store and its migrations,
  the command skeleton, who consumes it.
- [`docs/dev/CONVENTIONS.md`](docs/dev/CONVENTIONS.md) — max-cli's conventions, and what differs here.
- [`docs/dev/TESTING.md`](docs/dev/TESTING.md) — the sandbox, the coverage floor, no real waits.
- [`docs/dev/BACKLOG.md`](docs/dev/BACKLOG.md) — open work; [`docs/dev/COORDINATION.md`](docs/dev/COORDINATION.md) — migration numbers and releases across sessions.

Security audits of this repository follow the shared
[security method](https://github.com/WireCatLabs/cli-testing/tree/main/docs/security) in cli-testing;
vulnerabilities are reported as the [security policy](SECURITY.md) says.

## The constraints that shape everything

1. **Nothing here knows a messenger.** No provider library, no adapter; `biome.json` refuses them.
2. **The store is the owner's system of record.** Migrations are forward-only and cannot be undone.
   No test and no branch build may open the real file (`~/.local/share/WireCat/wirecat.db`) — `MESSAGING_STORE` points elsewhere.
3. **Other sessions work here at the same time.** Work in a worktree off `origin/main`, rebase before
   pushing, and take a migration number in [COORDINATION.md](docs/dev/COORDINATION.md#store-migrations) before writing it.
4. **A change reaches tg-cli and max-cli only through a release.** Both pin an exact version.
5. **Release when a consumer needs the merged code, at any time** ([WC-REL-8](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/releases.md#wc-rel-8--any-package-may-release-at-any-time)) —
   [README, "How often, and what may break"](docs/REFERENCE.md#how-often-and-what-may-break).
   `bin/release` publishes the next free version through GitHub; a change that may break a
   caller goes under "Changed — may break callers" in the changelog.

## Comments

Sparse, and only *why*. No comment restating the line, no banners, no narrating the change.

## Documents

They state the current facts only: rewrite a changed fact, delete a finished plan or done backlog
item; the changelog keeps history ([`CONVENTIONS.md`](docs/dev/CONVENTIONS.md)).

## Deletions

Never delete or clean up mid-task. Append a line to `CLEANUP.md` at the root — the path, why, the
date — and do the removals in one batch after the owner confirms. Never kill a process by name — find the PID, confirm it is yours, kill that PID.

## Committing

Conventional commits. The pre-commit hook checks staged lint and secrets; no other local checks are required by default.

A branch off `main`, in a worktree, and a pull request. A user-visible change gets a line under
`## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md). `bin/release` publishes; when the version is
already taken it moves to the next free one and renames the changelog heading with it.

## Development check budget

Local commits check only staged lint and secrets. There is no pre-push check.
Every pull request runs three checks. The fast standards job (`standards.yml`) checks config integrity,
lint, Markdown, `ci:quick` (the typecheck and the command lint) and the new commits for secrets.
The pull request validation (`pr.yml`) runs the full Linux validation, `ci.yml`: lint, typecheck, the tests
on four runners with the coverage floor checked on their merged report, build, `docs:check`, the schema and
dist checks, Bun, old Node, the SQLite restart and parity, which builds tg-cli, max-cli, whatsapp-cli and
cli-template against the branch. The security checks (`security.yml`) run CodeQL, zizmor and gitleaks; CodeQL
analyses python, c-cpp and java-kotlin only when a file of theirs changes.
A pull request that changes only `CHANGELOG.md` and the version against a `main` already proven green (bin/release's
fold and version pull requests) runs only `docs:check` and the changelog shape test, and reports the other required
checks as passed ([`docs/dev/TESTING.md`](docs/dev/TESTING.md)). The same `ci.yml` runs again in full on each merge
to `main` (no publishing).
Browser and platform suites run for releases, explicit manual validation, and monthly nonpublishing validation. See the
[shared policy](https://github.com/WireCatLabs/community/blob/main/standards/README.md#ci-and-hooks).
