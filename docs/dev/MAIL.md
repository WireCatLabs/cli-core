# Mail

`src/mail/`, exported as `@wirecat/cli-core/mail` and `/mail/testing`. A mail CLI (`mail-cli`) writes its sign-in and
one adapter, a `MailSource`; the sync, the scoring, the owner's rules and the contract kit are shared, as for
[calendars](CALENDARS.md). The mail tables and `store.mail` are described in the [schema](../storage/schema.md); this page
covers what runs over them. Who owns which command is in [TOOL-BOUNDARIES.md](TOOL-BOUNDARIES.md).

The engine was written in memo and moved here as it was, so a mailbox memo imported goes on where it stopped: the same
account, the same ids, the same sync state.

## The port

`MailSource` has the shape of Gmail over IMAP, the first mailbox it served. Where a source has no such thing it leaves
the member out.

| Member | What the adapter does |
|---|---|
| `list(since, folder, { headers?, searched? })` | every message in `folder` received since `since`, all or nothing, since deletions are proved from it; `headers` also reads From, To, Cc and the list fields; `searched` limits it to those UIDs |
| `quick?(since, folder, { searched })`, `identify?(raw, item)` | for a server that gives no message id without reading the message (no OBJECTID, no Gmail extensions): `search` answers `quick: true`, `quick` lists the UIDs of `searched` with flags, date and size only, and `identify` gives the `messageId` and `threadId` that `list` would have given, from the bytes `fetchRaw` returned |
| `fetchRaw(items)` | each item's raw RFC 5322 bytes, in order; a message that cannot be read is an `Error` in its place, never a failed call |
| `search?(since, folder)` | the folder's UIDs in the window and its UIDVALIDITY, without reading a message; absent for a file, which has no UIDs |
| `stamp?()` | a file's size and modification time, so an unchanged file read to the end is not read again |
| `find?(messageIds, folder, { headers? })` | the messages with these provider ids, listed as `list` lists them; a message no longer there is left out. Absent where messages have no provider id |
| `move?`, `present?`, `label?`, `folders?` | moving between folders, which UIDs a folder still holds, putting labels back, and the All Mail and Trash folders under the account's language. Used by cleanup and restore, not by the sync, except `folders` |

An item is a `Listed`: `uid`, `messageId` (the provider's id, the same in every folder and across a UID reset),
`threadId`, `receivedAt`, and when the source knows them `folder`, `labels`, `seen`, `flagged`, `size` and `headers`.
A source with no provider id derives `messageId` from the Message-ID header, and from the folder, UIDVALIDITY and UID
when there is none.

## `syncMail(source, store, options)`

Reads each folder of `options.account` (`mailFolders` gives them: the `folders` it names, `INBOX` for `mode: "imap"`,
else All Mail by its role), saves each new message with `store.mail.saveThread`, and returns a `MailSyncResult`
(`listed`, `saved`, `alreadyStored`, `skipped`, `envelopes`, `deleted`, `complete`, `pass`, `coverage`, and when there
are any `unreadable`, `attachments`, `deletionsSkipped`, `tagsReused`, `tagsSkipped`, `indexed`). Every message is the
account `{ provider: "email", account: <address, lower case> }`.

- **Quick folders.** A folder whose `search` says `quick` is not listed with headers: the sync lists the UID, flags,
  date and size of every message in the window, and reads the raw bytes of the newest `max` not done and not located
  (a budgeted run: `fetchBatch` a round). It takes the id from the Message-ID, so stored mail keeps its id and the same
  message in two folders is one email. Rules and the bulk classification then run on the headers of those bytes; a
  skipped or envelope mail is read once and never stored in full, and is done afterwards.
- **Locations.** For such a folder every stored email keeps where it is, in `email_locations` (folder, UIDVALIDITY,
  UID; two folders, two rows), written in the same transaction as the email. The folder's resume point says from which
  date on that holds (`located`). A folder is quick when its point matches the UIDVALIDITY and the rules and its
  `located` covers the window, or when the store holds none of its mail. Otherwise (mail stored before locations
  existed, a new UIDVALIDITY, other rules, `rescan`, a wider window) it is listed once with headers, which recognises
  stored mail without reading it and records the locations, and the next run is quick. A new UIDVALIDITY drops the
  folder's old locations. A quick run refreshes the flags of every located message the listing shows, and proves
  deletions as a header listing does: located mail in the window (without its first two days) whose UID `search` no
  longer lists leaves that folder, and is deleted when no other location of it is left and the run saw it nowhere. A run
  that read the window in parts (a budget, a retry pass) or whose too large a share would go proves nothing.
- **Rules.** A skip rule keeps a new message out; an envelope rule records its sender, date, size and labels and never
  its text; both come from `account.rules`, decided by `decide` over the facts of the listing (`factsOf`, which also
  works out a sender score when a rule asks).
- **Deletions.** Stored mail the listing no longer holds is marked deleted, in the window without its first two days
  (IMAP's SINCE counts whole days) and only when the run listed everything. `tooManyGone` refuses 5 or more and over a
  fifth of what is stored, and a snapshot source (`mode: "mbox"`) never proves one.
- **Refused SEARCH.** `search`, `query` and `present` throw a `CliError` with reason `mail.search-refused`
  (`SEARCH_REFUSED`) when the server answers SEARCH with NO or BAD. The sync leaves that folder unread and keeps
  reading the others; the run is partial (`refusedFolders`), proves no deletion, changes no membership of the refused
  folder, moves none of its resume point and leaves `mail_coverage` as the last run set it.
- **Partial emails.** A server search reads a candidate up to `SERVER_BOUNDS.textBytes` (`fetchRaw(items, { bytes })`);
  one cut short is stored with its headers and text, no attachments, and `metadata.partial`. After its rounds a sync
  (unless `completePartial: false`) reads up to 100 of them whole (`completePartial`, `src/mail/partial.ts`): Gmail's by
  id with `find`, elsewhere at a stored location, kept only when `identify` gives the stored id. It saves them as a sync
  would and clears the mark; the result has `partial: { completed, left }`. The mark is a JSON key, not a column: no
  store version, and an older build simply leaves the email partial.
- **Limits.** `max` new messages a run, newest first (200; no limit when budgeted); `maxBodyChars` (`MAX_BODY_CHARS`); attachment text up to
  `MAX_ATTACHMENT_CHARS` (200,000); a run stops between batches of 50 on `signal`, after saving its resume point.
- **Attachments.** `attachments` (`MailAttachmentPolicy`, default `DEFAULT_ATTACHMENT_POLICY`: on, 10 MB a file) says
  whether a sync reads attachments into the index and the largest file it reads. A file the policy leaves is stored
  with its name, type and size, no text, and `extractionError` `not-read` (policy off) or `too-large`; the run's
  `attachments` log says the same. No file is kept either way. The email still arrives whole from the server: the
  limit keeps a large file out of the text readers and the index, not off the network. Sync, partial completion and
  `retryAttachments` follow the policy.
- **One email read whole.** `readEmailWhole({ store, source, address, externalId, folders, … })` reads one stored email
  from its source again, as partial completion does, and every attachment with no size limit. It saves the email as a
  sync would (keeping its mailboxes, flags and rule) and answers each attachment with its bytes; it writes no file and
  runs no `index` step, so the new text gets vectors at the next sync. `mailReadCommands` takes it as `whole`.
- **Transport failures.** A chunk in which every message failed stops the run, after saving its resume point; one
  unreadable message costs only itself and is tried again next run.
- **`budget`.** A `RunBudget` (`runBudgetOf` in a command) makes the run budgeted (WC-LIFE-16): it reads the window in
  rounds, one request of the budget per call to the source (`search`, `list`, `fetchRaw`), `source.listBatch` and
  `source.fetchBatch` messages per call (200 and 50 when the source does not say), saves its resume point after every
  round and stops when the budget says so. The result has `state` (`partial` or `complete`), `stopped`, `remaining`
  (messages of the window not asked for) and `requests`; `max` defaults to no limit. A message the source did not
  return from `list`, or answered with an Error from `fetchRaw`, is asked for once more at the end of the run; if it
  still fails it is in `unreadable` and not in the resume point, so the next run asks again. A pass that read the
  window in parts proves no deletion (`deletionsSkipped` says so), except when one round listed all of it. The source
  spends the budget on its own retries through the `canRetry` it was given. A store another process has locked past its
  5 s busy timeout (memo's scheduled sync does) is waited out: 2 s, 4 s, ... up to 5 times, each a request of the
  budget, and the round is read again; the slices earlier saved stay saved.
- **`retryAttachments`.** Reads again, by provider id through `find`, only the stored mail whose attachment a missing
  reader left unread (`RETRYABLE_ATTACHMENTS`). It lists nothing and moves no resume point.
- **`index(store, key)`.** Runs after the save; what it answers is `result.indexed`. The engine embeds nothing itself:
  memo passes its embedding here.
- **`ages`.** Domain registration dates known so far, for a rule that asks for a sender score.

## Reading the stored mail

`searchMail(store, runAs, { text, mailAccount | accounts, … })` is `search messages` over mail: the shared query
language, with `list:` for a mailing list, and mail from a demoted sender after the rest unless `plainOrder` or
`newest`. `showMail(store, locator, { before, after, full })` is one email and its thread neighbours with the text of
each attachment, cut at `ATTACHMENT_CHARS` unless `full`. memo's `search mail` and `messages show` and mail-cli's
commands call these two, so the answers match.

`@wirecat/cli-core/mail/cli` mounts the commands on a mail CLI: `mailReadCommands({ app, read })` gives `search
messages`, `review`, `messages show` and `conversations list|show`. `read(command, work)` opens the shared store for one run and
names the profile's mailbox; every command reads that mailbox alone and refuses another one's reference. A thread is a
conversation, `chat:email/<address>/<thread>`; `conversations list` filters on `subject`, `emails_count` and
`last_email_at` in SQL (`THREAD_COLUMNS`). The store keeps text, not the RFC 5322 source, so there is no `--raw`.
With `whole(command, store, mailbox, emailId)`, `messages show` becomes a fetch: before it answers it reads again an
email whose attachment a sync's policy left (`too-large`, `not-read`). When that read fails it shows the stored email
with `meta.complete: false` and an issue `mail.attachments-unread` carrying the failure's code.

## Review

`review` is the messengers' `review` over the stored mail (`reviewMail`, `src/mail/review.ts`): a thread is a chat, an
email a message, and the answer has the same items, `meta.complete` and `--new` points (`checkPoints`, one file per
mailbox and reader: the owner, `mcp-review`, `schedule-<name>-review` under `<PREFIX>_SCHEDULED`). It reads the store
only and opens no task. Threads are picked by `store.mail.threadActivity` over `email_threads.last_email_at`, so no
email index is needed; it cuts at `mail_coverage.until`, the start of the last finished sync, so mail a running sync
has not stored yet is not passed. A complete `--new` run moves the mailbox's start to its end and drops the thread
points behind it.

Whose turn a thread is, owed or waiting, is `mailTurn` (`src/mail/owed.ts`), the one rule `review --unanswered`,
`--waiting` and `tasks agenda` over an email account share: owed when the newest email that is not a draft came in and
names the owner in To or Cc; waiting when the owner wrote it. Mail sent to many counts too (the owner's ruling: look
at all mail). Each review item's `email` carries `bulk`, `list_id`, `rule_id` and the sender score instead, and the
query term `bulk:false` leaves out threads whose newest email is bulk, a list's or an envelope (`isBulk`).

## Processing marks

A holder — an agent or a pipeline — keeps how far it processed an account's mail in the shared store, key
`consumer:<holder>` under the account in `sync_cursors` (`src/mail/marks.ts`); purging the account clears it with the
mail. The mark counts by `emails.id`, the store's insert order, so mail stored late with an old date is still after
it. `review --holder <name>` reads up to 200 emails past the mark, and the held ones now whole, and gives a cursor
(`<last id>.<read time>`); it moves nothing. Each email it gives also carries `email.cursor` and
`email.findings_key`, the cursor and key that end the batch at that email, so a reader that shows only part of the
batch acknowledges no email it did not show: it takes the pair of the shown email with the highest cursor id, and
the next read starts after it. Held emails end the batch at the mark with a key of their own,
`<holder>:<mark>-h<highest held id>`, since the run that set the mark holds the plain key. `messages acknowledge --holder <name> --cursor <cursor>` moves the mark
there, never back; it only adds to the holder's own bookkeeping, so a read-only scheduled run may run it
(`destroysNothing`). Only the owner moves a mark back: `messages reset --holder <name>` with `--since-time <time>`
(past every email received since then) or `--last <n>` (past the last n emails the holder was given), and
`--dry-run` to count first (`rewindMark`). It answers how many emails are read whole again, how many bulk ones come
again as excerpts and how many are skipped again. Every reset counts on the mark (`resets`), one that leaves the
mark where it is too, so the holder's next findings key is new. `review --holder` gives the `mail-findings.add` step
only when it gives emails. It is no proposal, so the read-only lock, a scheduled holder and an
agent are refused (`mail.reset-owner-only`). Envelopes and drafts are skipped and counted. Mail sent to many (the bulk mailbox or a List-Id)
goes through `newsletterSorter` (`src/mail/newsletter.ts`): words in the subject and the first lines, in Russian,
English and Spanish, the sender's address and an emoji or unsubscribe link score it as a newsletter, which is skipped
as `newsletter`; an order word in the subject, an order's or a request's number or a reply keeps it. What is kept
comes after the other mail as its subject and first lines (`excerpt_only`), at most 30 a read: the read ends before
the 31st, so the next read gives it. A host sets the words, the score and the limits from its config file through
`MailReads.bulkTriage` (`MAIL_BULK_SETTINGS`, `bulkTriageOf`), and passes the same triage to `mailWaiting` and
`advancePastSkipped`. Measured 2026-11-05 on the owner's last 90 days of bulk mail (10 252 emails, 0.05 ms each): 1 335
left out as newsletters, none of the 442 site lead forms among them; of 200 sampled newsletter verdicts 199 were
newsletters, and the one GitHub reply among them is kept by the reply rule now. A local embedding model (e5-small) found about 430 more newsletters
in 30 days at about 95% precision, for 10 ms an email, 1.2 s to load and 1 GB, and a labelled set to compare with, so
the sorter has no model. The mark itself counts what it passed by the plain verdicts: bulk mail, excerpt or not, adds
to `skipped.bulk`. A partial email is held until it is whole, or skipped after 7 days; one that changed after the read is held once more,
so the holder sees it at least once. A holder with no mark starts from the newest stored email. Reads stop at mail a
running sync stored, which files bulk mail only at its end. `marksOf` lists the marks, for `status`.

## Sync state

All under the account, in `store.sync` (`syncState`, `setSyncState`):

| Key | Holds |
|---|---|
| `mail_resume:<folder>` | a `ResumePoint`: the folder's UIDVALIDITY, the UID ranges done, from when its mail is located (`located`), the hash of the rules they were decided under, the widest full listing and its time, and the widest window ever listed. A later run lists only the UIDs not done, while the point's full listing is under a day old (`FULL_PASS_MS`) and the window is at least `resumeFrom` (5,000) UIDs; a new UIDVALIDITY, other rules or `rescan` list everything again |
| `mail_resume:mbox` | a `MboxPoint`: the file's size and modification time, and whether every message was read |
| `mail_folder_scope` | the mode and folders of the last run; a change skips deletions once |
| `mail_coverage` | the folders, window and whether the last run was complete |
| `mail_sender_scores` | when `scoreSenders` last ran, its version (`SCORE_VERSION`) and the senders it ranks lower |
| `consumer:<holder>` | a holder's processing mark: `throughId`, `throughAt`, `held`, `read`, `skipped` by reason |

Mail sent to many is in the mailbox `memo:bulk` (`BULK`); mail an envelope rule recorded is in a mailbox of kind
`envelope` named by the rule (`envelopeBox`). Neither is a folder, so neither proves a deletion.

## Scoring

`scoreSenders(store, address, ages, now, rules)` scores each sender of the account from the mail the store holds, at
most once a day or when `SCORE_VERSION` changes, and keeps the scores with `store.mail.setSenderScores`, where search
reads them; `demotedSenders(store)` gives those whose mail ranks lower. `ages` is a `DomainAges`: `known()` and
`lookUp(domains)`. How a domain's age is looked up and cached is the caller's.

## Contract kit

```ts
import { CONTRACT_MAIL, fakeMailSource, mailSourceContract, mailSyncContract } from "@wirecat/cli-core/mail/testing"

for (const { name, run } of mailSourceContract(() => makeAdapterOver(CONTRACT_MAIL))) it(name, run)
for (const { name, run } of mailSyncContract(async () => ({ source: makeAdapterOver(CONTRACT_MAIL), store: await openStore(...) })))
  it(name, run)
```

`mailSourceContract` checks ids, the window, `headers`, `search` against `list`, `fetchRaw` in order with an `Error` for
a message it cannot read, `find` and `present`. `mailSyncContract` runs `syncMail` over the adapter and a real store:
each message once under the address's account, and nothing on a rerun. `fakeMailSource(mailbox)` is a Gmail-shaped
mailbox in memory that tests change between runs and make fail (`searchFails`, `headersFail`, `moveFails`,
`unreadable`); `fakeArchiveSource` is a snapshot source, as an mbox file is. cli-core runs the contract over both,
and the sync tests (`src/mail/sync.test.ts`) over the fake.
