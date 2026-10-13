# Plan — documents linked in a chat

Status: **name and design approved by the owner, 2026-10-13** (option B: the message → document link
is stored). The cli-messaging side (release order step 2) is built; tg-cli, max-cli and drive-cli have not
adopted it yet. The naming is in [STANDARD](STANDARD.md#command-names), rule 1.

## Goal

`tg <profile> chats documents list <chat>` and `max <profile> chats documents list <chat>` list every
Google Docs or Drive link in the chat's stored messages: the document's title, when it was sent, who
sent it, and whether the document is in the store. It replaces a hand-written script.

## Command

```text
chats documents list <chat> [--limit <n>] [--page <n>]
```

- **Reads the local store only.** No messenger request, so it works offline and marks nothing read.
  A chat with no stored messages answers an empty list, with a hint on stderr to run
  `<cli> store fetch <chat>` (`messages sync` once cm#1023 renames it; that pull request renames the hint
  with the others).
- **Options:** `--limit` and `--page` from the catalogue, with their catalogue meanings. Plus the
  global ones (`--json`, `--jsonl`, `--fields`). No new option.
- **One item per link in a message**, newest message first. A message with two links gives two items;
  a document sent three times gives three.
- **Permission key `messages`**, as `attachments list` has: who sent which link, and when, tells as much
  as the message does ([Permissions](STANDARD.md#permissions), rule 2). It only reads, so a `readonly`
  profile runs it and `deny messages` hides it. Over MCP it runs through `<tool>_read`.

## Before creating a command

The five questions of [STANDARD](STANDARD.md#before-creating-a-command):

1. **What the user wants to learn:** which documents people shared in a chat, and which of them the
   store holds. The chat owns it, so the path starts with `chats`.
2. **A new leaf, not an option.** No existing command lists documents; `chats media` and
   `attachments list` list other things (STANDARD rule 1). The parent help gains one line:

   ```text
   $ tg chats --help
     …
     documents   the Google Docs and Drive documents linked in a chat's stored messages
     events      …
     media       …
     members     …
     tracking    …
   $ tg chats documents --help
     list <chat>   every document link in the chat, newest first, and whether the store has it
   ```

3. **Every word exists already:** the resource `chats`, the verb `list`, the argument `<chat>`, the
   options `--limit` and `--page`. `documents` is the glossary's word for a file from Google Drive.
4. **Result and coverage:** the list envelope below. It covers the stored messages only and does not
   report gaps in them; `store gaps` does. Permission `messages`; over MCP, `<tool>_read` with the
   command `chats documents list`.
5. **Nothing moves or is replaced**, except the owner's hand-written script.

## Output

The list envelope from [Output](STANDARD.md#output), rule 1:

```json
{
  "items": [
    {
      "url": "https://docs.google.com/document/d/1AbC…/edit?usp=sharing",
      "documentId": "1AbC…",
      "title": "Q4 plan",
      "inStore": true,
      "locator": "msg:telegram/default/-1001234/5678",
      "sentAt": "2026-10-12T09:41:00.000Z",
      "sender": { "id": "42", "name": "Anna" }
    }
  ],
  "page": 1,
  "limit": 20,
  "hasMore": false
}
```

- `url` — the link as written in the message.
- `documentId` — the Google file id taken from the URL. `null` when the URL carries none
  (`drive.google.com/drive/my-drive`, a shortened link). It is never a store row number.
- `title` — the stored document's title when `inStore`; otherwise `null`. Never fetched from Google.
- `inStore` — a stored link joins this message to a `documents` row that is not deleted and whose front
  matter `fileId` is this item's `documentId`; that is how a message with two links gets each its own answer.
- `locator` — the message, `msg:<provider>/<account>/<chat>/<message>` (glossary, cm#1018).
- `sentAt` — when the message was sent, ISO 8601 UTC.
- `sender` — `{ id, name }` of whoever sent the message, as stored; `id` may be `null`.

The text output is one line per item: time, sender, title or URL, and `in store` or `not in store`.

Over MCP the tool is `<cli>_chats_documents_list` (`chat`, `limit`, `page`), with the same envelope.

## Where the link is stored — no migration

The existing `links` table holds it ([schema](../storage/schema.md#links)):

| Column | Value |
|---|---|
| `from_type`, `from_id` | `message`, the `messages` row |
| `to_type`, `to_id` | `document`, the `documents` row drive saved |
| `kind` | `links-to` — "links to something, as written in it" |
| `source` | `message` — a new origin value: written in a stored message's text |
| `author` | `rule` |
| `confirmed` | 1 |

- No new column, table or index, so no migration and no number in [COORDINATION.md](COORDINATION.md).
- Code changes, not schema: `LINK_ORIGINS` (`src/store/sqlite/notes.ts:16`) gains `message`, and the
  schema document's `links` description widens `links-to` from "a document or note" to "a document,
  note or message", and `source` gains `message`.
- `links` has no unique index. The writer checks for the row before inserting, in one transaction, so
  a rerun adds nothing. A unique index would need a migration; it is avoided on purpose.
- The reader builds items from the message text, not from the link rows. It reads the chat's messages whose
  text holds `google.com` or `forms.gle`; a link the messenger keeps only in the text's formatting (a word
  made a hyperlink) is not in the text and is not found. An edited message that lost
  its link shows nothing, whatever rows remain. A link whose document row is gone reads as
  `inStore: false`; `store check` already reports such pointers (`orphanPointers`,
  `src/store/sqlite/entity-types.ts`).

## Who writes the link

**drive's `sync`, through a cli-messaging store API.** Drive is the one that knows a document is in
the store and its Google file id (front matter `fileId`).

- **One extractor, both sides.** `googleDocumentLinks(text)` in `src/domain/` returns
  `{ url, documentId }` for every Docs, Sheets, Slides, Forms and Drive file URL, in each form:
  `/d/<id>/…`, `/u/<n>/…`, `open?id=<id>`, `file/d/<id>/view`, with any query or fragment. The reader
  and the writer use it, so they agree on what a document link is.
- **Store API:** `store.notes.linkMessages({ documents: [{ reference, fileId }], since? })`, beside
  `saveFileNote` and `replaceFileLinks`, where documents are kept today.
  It finds candidate messages through `messages_fts` (trigram, so a file id matches as a substring),
  keeps those whose `googleDocumentLinks` contains the `fileId`, and inserts the missing `links` rows.
  `since` limits it to messages stored after a time (`messages.created_at`). It answers how many links
  it added.
- **Every `drive sync` runs two passes**, so a link is not missed when the document did not change:
  1. documents saved or changed in this run, against every stored message;
  2. every document drive holds, against messages stored since the last pass — a watermark drive
     keeps in its `state.json` and writes only after the pass completes.

**Before drive ships the pass**, the command still works: every item shows `inStore: false` and
`title: null`, with `documentId` filled.

## Release order

1. This pull request: STANDARD wording and the planned parity rows (`chats documents`,
   `chats documents list`, its `--limit` and `--page`). No code.
2. cli-messaging: the extractor, the store API, the reader service, the command (shared, so both CLIs
   get it), its permission mapping and help. Then a release.
3. tg-cli and max-cli pin that release; their `commands --json` gains the command. The parity rows move
   to `in` in the next cli-messaging release after both have it on `main`.
4. drive-cli, after its switch to the shared store
   ([drive-in-store-plan.md](drive-in-store-plan.md), work item 3): pin the release from step 2 and add the
   two link passes to `sync`.

## Tests

- **Extractor:** every URL form above gives the same `documentId`; a non-Google URL gives nothing; a Google
  Drive URL without an id gives `documentId: null`; two links in one text give two results.
- **Store API:** links a message to a document; a second run adds nothing; `since` skips older messages;
  a message with the id inside other text but no Google URL is not linked.
- **Service and command:** the envelope and its paging (`--page 2`, `hasMore`), newest first;
  `inStore` true with `title`, false with `null`; a link to a deleted document reads `inStore: false`;
  an empty chat gives an empty list and the stderr hint; `--json` stdout carries data only.
- **Permissions:** `keyForCommand(["chats", "documents", "list"])` is `messages`; `deny messages`
  refuses it and hides it from MCP; `readonly` runs it.
- **Parity and contract:** `pnpm parity:check` in both CLIs; `commands --json` lists it with no write
  flag.
- **drive-cli:** sync a fixture document while a stored message links it, then a message stored after
  an unchanged document; both get one link, a rerun none.
- **Live, after the releases:** the owner runs `drive <profile> folders sync`, then
  `tg <profile> chats documents list <chat>` on a chat where documents were shared, and compares it
  with the hand-written script.

## Open question for the owner

- **Q1 · Should the field names follow the existing message outputs?** Messages elsewhere answer
  `timestamp`, `senderId` and `senderName`, and `search all` answers `from: { name, ref }`; this plan
  uses the task's `sentAt` and `sender`. The stored document's reference (`document:<id>`, what
  `drive documents show` takes) is not in the item, because the key for it — `ref` or `reference` — is
  still open (NEED-986 in cm#1018). Recommended: use `timestamp` and `senderId` / `senderName`, and add
  the reference under the key NEED-986 picks, before the command ships.
