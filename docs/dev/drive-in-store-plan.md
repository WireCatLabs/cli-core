# Plan — Google Drive documents in the one store

Status: **approved by the owner, 2026-10-13.** Q1: nothing in drive needs to survive the move; documents are rebuilt from drive's local copies.
Q2: a `search all` hit for a Drive document shows its Google URL and its last Google edit time.
Q3: `DRIVE_STORE` goes; `MESSAGING_STORE` is the only store override.

## Goal

`memo search all <word from a Google Doc>` and `tg search all <word>` return the Google Doc. drive-cli
writes into the one store tg, max and memo share. No second database.

## Current state

Anchors are on `origin/main` of each repository, 2026-10-13.

1. **drive already uses this library's store, in its own file.**
   `drive-cli/src/store.ts:12` calls `openStore({ path: env.DRIVE_STORE ?? <drive state>/drive.db })`.
   The shared file is `storePath()` (`src/store/path.ts:9-10`, exported at `src/store/index.ts:6`).
   drive's README gives the reason for the separate file: connecting Google should not migrate a
   messenger store (`drive-cli/README.md:105-109`).
2. **A Drive document is a `documents` row, reference `document:<id>`.** drive calls
   `store.notes.saveFileNote` (`drive-cli/src/store.ts:57-73`). That inserts into `documents`
   (`src/store/sqlite/notes.ts:401`); the reference is `document:<id>` (`notes.ts:27-28`, `:147`). The
   folder is an `accounts` row of provider `folder`, named `google-drive:<principal>`
   (`drive-cli/src/store.ts:17`, `notes.ts:374`).
   The open glossary PR (cm#1018) says drive keeps documents as `note:` rows, citing
   `drive-cli/src/store.ts:111`. That is wrong. Line 111 is drive's own search reading a hit through
   the shared `Note` type. The glossary's author should correct it.
3. **The Google fields are in front matter.** `source: "google-drive"`, `sourceUrl`, `fileId`, `owners`,
   `lastModifiedBy`, `modifiedAt`, `sourceVersion`, `tabs` (`drive-cli/src/store.ts:63-72`). The title is
   the file name (`:60`), the text is the extracted text (`:61`), the path is `<fileId>.md` (`:59`).
4. **`search all` already reads every folder.** Its notes branch calls `searchNotes` with no folder
   filter (`src/services/search-all.ts:140-147`). memo calls `searchAll` with no filter either
   (`cli-memo/src/search/command.ts:264-277`). The hit carries the reference, the title and the folder
   id, but no Google URL (`search-all.ts:155-163`). drive's own `documents search` adds `sourceUrl` from
   front matter (`drive-cli/src/store.ts:107-119`). The hit's time is the row's `updatedAt`
   (`search-all.ts:160`, `src/services/notes-search.ts:363`): when drive last saved a changed text, not
   when the doc was last edited in Google.
5. **memo leaves folders it does not have in its config alone.** `memo sync` reads only configured
   folders (`cli-memo/src/notes/bound.ts:19-38`), so it never touches drive's documents. But
   `memo folders list` shows such a folder as "not on this computer — memo folders attach"
   (`cli-memo/src/notes/folders-command.ts:99-110`). If the owner attached `google-drive:…` to a disk
   folder, the next `memo sync` would import that disk folder's files into drive's folder, and delete
   the Drive documents missing from disk whenever they are at most 20% of the folder or fewer than 5
   (`cli-memo/src/notes/import.ts:29-30,168-175`).
6. **Text limit.** A file note holds 200 000 characters now (`notes.ts:391`). cm#1017 raises it to
   2 000 000. drive#19 sets `maxTextChars` to 2 000 000 by default, so drive#19 needs a release with
   cm#1017.
7. **Old tools can still write to a newer store.** Only a breaking change raises `minCompatible`
   (`src/store/migrations.ts:18-19`). drive pins 0.253.0 and memo 0.254.0 (`package.json` of each).

## Decision: A — drive writes into the shared store directly

- drive already speaks the store API, so the change is the file it opens, not the code that writes.
- B (memo imports drive.db) keeps two copies. References would differ between the files, drive's
  knowledge commands (tags, notes, facts on a document) would act on the copy `search all` does not
  read, and every `memo sync` would have to re-copy.
- The README's reason for a separate file (point 1) no longer holds: the owner's rule is one store,
  and point 7 says a shared file does not lock drive to the newest version.

**No store migration.** Documents, folders and front matter use existing tables (points 2, 3). No
number is needed in [COORDINATION.md](COORDINATION.md).

## Work

1. **cli-messaging (Q2):** Drive document hits in `search all` and `search notes` gain `url` from
   front matter `sourceUrl` and take their time from front matter `modifiedAt`. The fields are
   [source-everywhere-plan.md](source-everywhere-plan.md), "Fields of a document hit" (its work
   item 1). No schema change. Release it together with cm#1017.
2. **cli-memo:** `memo folders list` shows `google-drive:` folders as drive's, not as "attach me";
   `memo folders attach` refuses them (point 5). Merged in cli-memo#116.
3. **drive-cli, after drive#19 merges:**
   1. `openIndex` opens `storePath(env)`: `openStore({ path: storePath(env), env, command: "drive" })`.
      An explicit path, so drive never runs the old-store cleanup (`src/store/store.ts:790-791`).
   2. `DRIVE_STORE` goes (Q3); tests, smoke and the contract seed set `MESSAGING_STORE`
      (`drive-cli/src/testing.ts:30`, `scripts/smoke.ts:49`, `contracts/previous/seed.mjs:14`).
      Docs that describe `drive.db` and "share a store deliberately" are rewritten
      (`README.md:105-109`, `docs/configuration.md:23,84,126-131`, `docs/security.md:38`, `docs/usage.md:125`).
   3. Record the profile: every sync calls `store.saveProfile("drive", <profile>, { provider: "folder",
      account: <folder external id> })`, so `--source drive:<profile>` and the hit's `account` can
      name it ([source-everywhere-plan.md](source-everywhere-plan.md), "What the drive switch writes").
   4. Move existing data, below.
   5. Pin the cli-messaging release from item 1.

## Existing `drive.db` data

- **Documents are rebuilt, not copied.** Each profile's `state.json` keeps a `reference` per document
  (`drive-cli/src/state.ts:32`). That `document:<id>` is a row number in drive.db; in the shared store
  the same number can name another document, memo's for example. `documents list` and
  `documents show` read these references (`drive-cli/src/program.ts:309-326`). With a cursor saved, a
  sync re-saves only changed files (`drive-cli/src/sync.ts:54`), so unchanged documents would never
  reach the shared store.
- `state.json` gains `store`: the file its references belong to. `openIndex`, which every command
  goes through, compares it with `storePath(env)`. On a mismatch drive re-saves every document from
  its local snapshot (`readSnapshot`, `drive-cli/src/state.ts:86`) and rewrites each `reference`, with
  no Google call. It writes `store` last, so an interrupted rebuild starts over; re-saving is
  idempotent, since a document is keyed by folder and `<fileId>.md`. A missing snapshot falls back to
  `folders sync --rescan` (`drive-cli/src/sync.ts:202-204`).
- **What the owner wrote in drive.db cannot be fetched again**: tags, notes about a document,
  memories, facts, people links (`drive-cli/src/knowledge.ts`). Before the rebuild drive counts these
  rows in drive.db through the store API. If there are none, it goes on. If there are some, it stops
  and names the counts (Q1).
- **drive.db stays on disk** until the owner confirms. Its path goes to `CLEANUP.md` in drive-cli.

## Side effects of one file (accepted, not changed)

- `drive embed` embeds every note in the store, memo's too, because `embedNotes` takes no folder
  (`src/services/notes-search.ts:163`, `drive-cli/src/store.ts:122-125`). In one store that is the
  point; `maxChunks` still bounds a run.
- drive must keep its cli-messaging pin current like memo. An old drive still writes to a newer store
  (point 7); only a major version of this package would stop it.

## Release order

1. cli-messaging: release with cm#1017 and item 1.
2. cli-memo: a release with item 2, pinned to that release. tg and max bump their pins for item 1's `url`.
3. drive-cli: drive#19 bumps to that release (it needs cm#1017), then the item 3 PR, rebased on it.

## Check

- drive test: sync a fixture Google Doc with `MESSAGING_STORE` in the sandbox, then call `searchAll`
  from cli-messaging. Expect one `document` item with a `document:` reference, the doc's title, its `url`,
  provider `drive` and the profile as `account`.
- drive test: a profile whose `state.json` names another store file is rebuilt offline from
  snapshots; references point at the new rows; a rebuild cut off halfway completes on the next run.
- memo test: `folders list` and `folders attach` treat a `google-drive:` folder as drive's.
- After the releases, the owner runs `drive <profile> folders sync`, then
  `memo search all <word from a Google Doc>`. It returns the doc.
