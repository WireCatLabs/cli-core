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
4. **A change reaches the CLIs only through a release.** Each pins an exact version
   ([`scripts/parity/downstream.json`](scripts/parity/downstream.json) lists them).
5. **Merge when green, release in batches** ([COORDINATION.md, "Releases"](docs/dev/COORDINATION.md#releases)).
   Squash merge your green pull request yourself and comment `merged #NNN` on
   [issue #849](https://github.com/WireCatLabs/cli-core/issues/849); never release only for your own pull request.
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

A branch off `main`, in a worktree, and a pull request. A user-visible change gets a changelog fragment: a new file
`changes/<branch>.md` (lower case, `/` as `-`) with one or more of the changelog's `###` headings and the entries
under them, written as they will read in [`CHANGELOG.md`](CHANGELOG.md), with links relative to `changes/`
(`../docs/…`). Only `bin/release` edits `CHANGELOG.md`, on its `release/*` branches: the `standards` check fails any
other pull request that changes it, because a hand edit made the release pull request conflict and `bin/release` then
waited forever. `pnpm docs:check` checks the fragments, and a breaking title (`feat!:`) fails the changelog
guard without one. `bin/release` collects them into the version's section, grouped by heading, and deletes them in
the release pull request; when the version is already taken it moves to the next free one and renames the changelog
heading with it.

```md
### Fixed

- **`store recover run` names what it could not check.** Why it matters and what a caller does about it.
```

## Development check budget

Local commits check only staged lint and secrets. There is no pre-push check.
Every pull request runs three checks. The fast standards job (`standards.yml`) checks that only a `release/*` branch edits
`CHANGELOG.md`, config integrity, lint, Markdown, `ci:quick` (the typecheck and the command lint) and the new commits for secrets.
The pull request validation (`pr.yml`) runs the full Linux validation, `ci.yml`: lint, typecheck, the tests
on two runners with the coverage floor checked on their merged report, build, `docs:check`, the schema and
dist checks, Bun, old Node, the SQLite restart and parity, which builds cli-template and every CLI in
`scripts/parity/downstream.json` against the branch, checking the manifests and wording of tg, max and wa on the
same builds. The security checks (`security.yml`) run CodeQL, zizmor and gitleaks; CodeQL
analyses python, c-cpp and java-kotlin only when a file of theirs changes.
A pull request that changes only `CHANGELOG.md`, the `changes/` fragments and the version against a `main` already
proven green (bin/release's fold and version pull requests) runs only `docs:check` and the changelog shape tests,
and reports the other required checks as passed ([`docs/dev/TESTING.md`](docs/dev/TESTING.md)). The same `ci.yml`
runs again on a merge to `main` (no publishing), unless the squash commit has the tree of its pull request's head and
that head passed every required check on the `main` it landed on (`main.yml`, `scripts/release-reuse.sh`).
Browser and platform suites run for releases, explicit manual validation, and monthly nonpublishing validation. See the
[shared policy](https://github.com/WireCatLabs/community/blob/main/standards/README.md#ci-and-hooks).
