# Handoff — mentions: next steps after 0.284–0.288 (2026-10-15)

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
  echo "== MENTIONS: flow, review";  git show origin/main:docs/dev/MENTIONS.md | sed -n '48,75p;114,123p;140,150p'
  echo "== writer: original, sources"; git show origin/main:src/store/sqlite/mention-drain.ts | sed -n '43,72p;108,151p'
  echo "== decide, confirm";         git show origin/main:src/store/sqlite/mentions.ts | sed -n '276,330p'
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

1. `src/store/sqlite/mention-drain.ts:155-260` (`writer`) — what is kept, deleted and inserted when a text is read
   again; the place a sender rule (task 1) or a link filter (task 2) goes.
2. `src/store/sqlite/mentions.ts:164-230` (`SELECT`, `listMentions`) — why `list` and `show` see message sources
   only: the inner join to `messages`.
3. `src/cli/messenger/mentions-command.ts` — the command surface tg and max share.
4. `docs/dev/COORDINATION.md:5-10` — the next free store migration number and how to take it.
5. `/home/leemour/Projects/AI/cli-docs/docs/REVIEWING.md` (section "Review the whole corpus before a release
   update") — only for task 4.

## 4. Do

1. **A phone seen in one sender's mail only is offered as that sender's.** Most mail phones are signatures:
   one value repeated across one sender's letters. Offer, don't link: put the sender's person (through
   `emails.from_identity_id` → `identity_links`) into `mentions show`'s `candidates`, and let `mentions confirm`
   decide. Decision yours: a rule link with author `rules` (fast, but the owner ruled an agent's or a rule's
   phone link final only on an exact match, NEED-1026 in the plan's "Review" section) or a candidate only (the
   plan leans this way). Also yours: whether `mentions list` shows one row per value for such repeats (a
   `--by-value` view) or leaves rows as they are. Check: `pnpm vitest run src/store/mentions.test.ts` with a new
   case — two emails from one sender with one number, `show` names that person first.
2. **Mail links are mostly one-off tracking links.** Decide what to keep: e.g. drop a mail `url` whose query
   string carries a tracking id and whose domain is a known sender of mailing lists, or keep only `domain` for
   such rows. Measure first on a copy of the owner's store (section 5, rule 2) and put totals in cli-testing
   `performance/search/mentions/`. Check: the totals before and after, and `mentions domains` unchanged for the
   top sites.
3. **List and decide mentions of documents, notes and mail in memo.** `list`/`show` join `messages`, so these
   rows are never shown. Add a listing that reads the source by `source_type` (a document's title, a note's
   subject, an email's sender and date) and a `mentions` group in memo (repository `WireCatLabs/cli-memo`, owned
   by the memo session — agree in [#849](https://github.com/WireCatLabs/cli-core/issues/849) first). `store.ts`
   is at its line cap: put the reads in `src/store/sqlite/mentions.ts` and reach them through an existing
   method or a small sub-store, as `store.tasks` is. Check: a store test listing one row of each source type.
4. **The site page.** The orient output shows the site's pins; move whichever is older than its release that
   carries cli-core ≥ 0.285.0 (max 0.54.0, tg 0.60.0) in `cli-docs/tools.json`, then update
   `content/docs/mentions{,.ru,.es}.md`: `phone_countries`, `mentions list --new` and the sync step,
   `--all-in-chat`, `mentions domains`, `t.me` links, mail search fields. A pin move makes every tg and max
   translation stale; update each against the source diff and `pnpm docs:translation accept` them. Check:
   `pnpm sync && pnpm docs:release-notes && pnpm docs:check && pnpm test && pnpm exec next build && pnpm check:links`
   — all pass, `docs:check` reports 0 invalid examples.
5. **Phase 3, unknown names and places** — only with the owner: it needs a labelled sample of the owner's chats
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
