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
- **Limits.** `max` new messages a run, newest first (200; no limit when budgeted); `maxBodyChars` (`MAX_BODY_CHARS`); attachment text up to
  `MAX_ATTACHMENT_CHARS` (200,000); a run stops between batches of 50 on `signal`, after saving its resume point.
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
  spends the budget on its own retries through the `canRetry` it was given.
- **`retryAttachments`.** Reads again, by provider id through `find`, only the stored mail whose attachment a missing
  reader left unread (`RETRYABLE_ATTACHMENTS`). It lists nothing and moves no resume point.
- **`index(store, key)`.** Runs after the save; what it answers is `result.indexed`. The engine embeds nothing itself:
  memo passes its embedding here.
- **`ages`.** Domain registration dates known so far, for a rule that asks for a sender score.

## Sync state

All under the account, in `store.sync` (`syncState`, `setSyncState`):

| Key | Holds |
|---|---|
| `mail_resume:<folder>` | a `ResumePoint`: the folder's UIDVALIDITY, the UID ranges done, from when its mail is located (`located`), the hash of the rules they were decided under, the widest full listing and its time, and the widest window ever listed. A later run lists only the UIDs not done, while the point's full listing is under a day old (`FULL_PASS_MS`) and the window is at least `resumeFrom` (5,000) UIDs; a new UIDVALIDITY, other rules or `rescan` list everything again |
| `mail_resume:mbox` | a `MboxPoint`: the file's size and modification time, and whether every message was read |
| `mail_folder_scope` | the mode and folders of the last run; a change skips deletions once |
| `mail_coverage` | the folders, window and whether the last run was complete |
| `mail_sender_scores` | when `scoreSenders` last ran, its version (`SCORE_VERSION`) and the senders it ranks lower |

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
