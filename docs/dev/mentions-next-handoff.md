# Handoff — mentions: next steps after 0.284–0.291 (2026-10-15)

The trail, optional, grep by id: the cli-private journal `docs_ai/journal/2026-10-13-field-test-followups.md`
(NEED-1122, NEED-1123, NEED-1129, RISK-1229 — real-store totals live there, never here).

## 1. What this is

Mentions are phones, e-mail addresses, links, Google documents and known people's names that cli-core finds by
rule in every stored text and keeps in the `mentions` table, for search (`phone:`, `domain:`, `mentions:`) and
for review (`mentions list|show|confirm|reject|rebuild|domains`). Built so far: message text, files and voice
notes, documents, notes and mail (store version 16); phone numbers of 47 countries by the store-wide setting
`phone_countries`; `mentions list --new` with a review step after `messages sync`; `--all-in-chat` for names;
`t.me` links resolved to chats. What it is and how it works: [MENTIONS.md](MENTIONS.md); the design and the
owner's decisions: [mentions-plan.md](mentions-plan.md); the user's page: [../mentions.md](../mentions.md).
Released: cli-core ≥ 0.284.0, tg 0.60.0 and max 0.54.0 carry it.

## 2. Orient in one call

```sh
{ cd /home/leemour/Projects/AI/cli-messaging && git fetch -q origin
  echo "== plan: phases";            git show origin/main:docs/dev/mentions-plan.md | sed -n '229,256p'
  echo "== MENTIONS: flow, review";  git show origin/main:docs/dev/MENTIONS.md | sed -n '48,80p;119,128p;145,154p'
  echo "== writer: original, sources"; git show origin/main:src/store/sqlite/mention-drain.ts | sed -n '43,72p;108,151p'
  echo "== memo's store reads";      git show origin/main:src/store/sqlite/mention-sources.ts | sed -n '20,58p'
  echo "== service: domains, list";  git show origin/main:src/services/mentions.ts | sed -n '77,125p'
  echo "== versions"; for p in cli-core tg-cli max-cli; do echo "$p $(npm view @wirecat/$p version 2>/dev/null)"; done
  git -C /home/leemour/Projects/AI/cli-docs fetch -q origin
  git -C /home/leemour/Projects/AI/cli-docs show origin/main:tools.json | grep -E '"name"|"docsRef"'
} > ~/.cache/mentions-next-orient.txt 2>&1
```

Then read `~/.cache/mentions-next-orient.txt`. It shows: which phases are built and what is left; how a text is
queued, written and decided; where a value gets its rule decision (`originalOf`) and which texts are read
(`SOURCES`); how a decision spreads (per value, per row, per chat); how `mentions domains` groups links; the
released versions and the versions the site pins.

## 3. Read in this order (only if the orient output is not enough)

1. `src/store/sqlite/mention-sources.ts` — what memo gets: `list`, `show`, `confirm`, `reject` and how mail is
   scoped to named accounts (task 1).
2. `src/cli/messenger/mentions-command.ts` — the messenger command a memo group should read like (options,
   `next` steps, `--all-in-chat`).
3. `src/store/sqlite/mention-drain.ts:156-262` (`writer`) — what is kept, deleted and inserted when a text is read
   again; where mail links are cut to one per site.
4. `/home/leemour/Projects/AI/cli-docs/docs/REVIEWING.md` (section "Review the whole corpus before a release
   update") — only for the site pin in task 2.

## 4. Do

Built (#1310): `store.sourceMentions` (list/show/confirm/reject of document, note and mail mentions; mail only of
the accounts the caller names), `candidates` in `show` from the senders of received mail that carries a phone or
an address (offered, never linked), mail tracking links kept once per letter and site (`url` rule version 2,
totals in cli-testing `performance/search/mentions/`), and the messenger list no longer picking up those rows. The
site page is current (cli-docs#252, MAX pin v0.54.0).

1. **A `mentions` group in memo** (repository `WireCatLabs/cli-memo`, owned by the memo session — agree in
   [#849](https://github.com/WireCatLabs/cli-core/issues/849) first): `memo mentions list --source
   document|note|email [query]`, `show`, `confirm`, `reject` over `store.sourceMentions`. The mail profile names
   the accounts (`memo mail <profile> …` style): never all mailboxes by default. Check: a memo command test per
   source and `--json` of `show` with `candidates`.
2. **Mail link search is built** (`src/store/sqlite/mention-links.ts`): `url:` finds a letter by a whole tracking
   link through its site's row and the body, `link:` by a part of a link
   ([timing](https://github.com/WireCatLabs/cli-testing/blob/main/performance/search/mentions/README.md), fifth run).
   Left open: `link:` reads a whole body, so it can match a part outside a link in a letter that holds a tracking
   link — narrow it only if the owner reports such noise.
3. **After tg and max release on the cli-core with #1310**: on the owner's store, with the released tg only,
   `mentions rebuild url` (shrinks the table; count rows before and after, totals only), then the site pin move
   and on the mentions page: mail links kept per site, `link:` for a part of a link (needs the release with it).
4. **Phase 3, unknown names and places** — only with the owner: it needs a labelled sample of the owner's chats
   to measure precision. Ask before starting.

## 5. What bites

1. **Real data.** Never open `~/.local/share/WireCat/wirecat.db` from a branch build or a test. Measure with
   `MESSAGING_STORE` pointing at a copy (`sqlite3 <real> ".backup '<copy>'"`), delete the copy after. On the real
   store use released `tg`/`max` only, and read counts or masked values, never message text or numbers.
2. **Line caps.** `src/store/store.ts`, `src/store/sqlite/lucene.ts` and `scripts/schema/spec.mjs` sit at their
   `noExcessiveLinesPerFile` limits (biome.json overrides). Do not raise a limit; put code in the table module
   and shorten what you add (one-line notes in the spec).
3. **Commands must exist in test programs.** A `next` step to a command the program lacks is dropped silently:
   add `mentionsCommand(messenger)` to a test's program before asserting a `mentions.*` step.
4. **New option → parity.** Add the option to `parity.json` (row and `options` catalogue, keys sorted), then
   `pnpm parity:render`; the manifest test names what is missing.
5. **Store migrations** take a number through `docs/dev/COORDINATION.md` in a PR merged first; triggers only,
   `minCompatible` stays 1; add `UNDO` in `src/testing/older-store.ts` and a `src/store/version-<n>.test.ts`.
6. **Releases fold `## Unreleased`** into a dated heading; after a rebase check that your changelog entry sits
   under `## Unreleased`, not under a released version.
7. **`chats.username` is almost never filled** (only when a chat's details are read), so `t.me/<name>` links
   resolve mostly through `identities.username` or `t.me/c/<id>`. **Mail headers are mostly not stored**, so a
   `List-Unsubscribe` filter misses nearly all mailing lists.
8. **Phone plans** are generated: change `scripts/phone-plans.ts`, run it, then
   `pnpm exec biome check --write src/domain/phone-plans.generated.ts`; `libphonenumber-js` is a dev dependency
   only and stays one.
9. **cli-docs:** `pnpm docs:check` runs only in the deploy, not in PR checks. Run it before merging, or the
   deploy fails and the site stays on the last good build.

## 6. Do not touch

- tg-cli and max-cli releases — their sessions own them (ask in #849).
- `minCompatible`, and any migration that rebuilds a base table.
- The owner's `phone_countries` (`es,ru`) — the owner set it.
- Other sessions' worktrees `cli-core-wt-*` and the main checkout's uncommitted files.

## 7. Check

```sh
cd <your cli-core worktree> && pnpm install --frozen-lockfile && pnpm typecheck && pnpm exec biome check . \
  && pnpm test && pnpm docs:check && pnpm parity:render && git status --short
```

Passes when typecheck, biome (warnings allowed, no errors), every test and `docs: ok` pass and `parity:render`
leaves no diff. Announce each merge in [#849](https://github.com/WireCatLabs/cli-core/issues/849).
