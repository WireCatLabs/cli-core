# Mail attachments: a size limit, a switch, and one email read whole

The owner's decision (NEED-223): mail sync reads attachments up to a size limit; the config says whether to read
them and up to what size; no file is kept, only its text goes into the search index; the sync command takes a flag
that overrides the config for one run; the command for one email always reads its attachments, whatever the limit,
and can save a file where the owner asks.

## What happens today

- Mail sync lives here, in `src/mail/sync.ts` (`syncMail`). memo and the `mail` CLI call it.
- A source's `fetchRaw` reads each email whole, attachments included. `readAttachments` (`src/mail/attachments.ts`)
  extracts the text of every attachment, whatever its size, and keeps no file (`localPath: null`). Only the text is
  capped, by `maxAttachmentChars`.
- Nothing lets the owner turn attachment reading off or cap it by size.
- `memo messages show <email>` reads only the store.

## The design

### Policy (cli-core)

`MailAttachmentPolicy = { read: boolean; maxBytes: number }`, default `DEFAULT_ATTACHMENT_POLICY`:
**read on, 10 MB per file** (10 × 1024 × 1024 bytes). 10 MB covers ordinary PDFs, office files and scans, and keeps a
large archive or video out of the text readers.

`MailSyncOptions.attachments` takes it. `readAttachments` takes the policy:

- `read: false`: no attachment is read. Each is stored with its name, MIME type and size, `extraction: "failed"`,
  `extractionError: "not-read"`.
- a file above `maxBytes`: the same, with `extractionError: "too-large"`.
- otherwise as today.

Sync, the completion of partial emails and `--retry-attachments` all pass the policy. Reading one email whole (below)
passes none: no limit.

What the limit does not do: IMAP and Gmail give an email as one piece (`BODY[]`), so a large attachment still crosses
the network with its email; the limit keeps it out of the text readers and the index. Fetching only the text parts of
an email over the limit (IMAP `BODYSTRUCTURE` and `BODY[part]`) is a later step, not part of this change.

### One email read whole (cli-core)

`readEmailWhole({ store, source, account, externalId, folders, loadEngine, maxBodyChars, maxAttachmentChars, now })`
reads one stored email from its source again, as the completion of partial emails does: by its id where the source
can find one (Gmail), otherwise at its newest stored place, trusted only when `identify` gives the stored id. It
extracts every attachment with no size limit, saves the email (so the new text reaches the search index the same way
a sync's does), and answers its attachments with their bytes, so the caller can write a file. Nothing is written to
disk here.

### Where the owner sets it: the mail CLI

The owner syncs mail with `mail <profile> sync` (mail-cli), which calls `syncMail`, and reads one email with
`mail <profile> messages show`, cli-core's shared `mailReadCommands`. memo's own mail import (Himalaya, `memo sync`)
is the older path its docs mark for removal, and memo cannot reach the mail CLI's sign-ins, so memo cannot read most
stored mail again. The settings therefore belong to mail-cli, after a cli-core release and the owner's yes:

- Profile config: `mail.read_attachments` (true or false, default true) and `mail.max_attachment_mb` (a whole number
  of megabytes, at least 1, default 10).
- `mail <profile> sync`: `--attachments` / `--no-attachments` and `--max-attachment-mb <n>` override the config for
  that run.
- `mail <profile> messages show <email>`: when an attachment has no text because of the policy (`too-large`,
  `not-read`), or with `--save-dir <dir>`, it calls `readEmailWhole` with the profile's own source and shows the new
  text. `--save-dir` is owner-only (`writesFileOnlyWith`): it writes each attachment there under a name made safe for a
  file, never over an existing file, and answers each path. Without a network the stored email is shown with a warning.
  `mailReadCommands` then needs a way to open the profile's source.

This change is the cli-core part only.

## What callers see

- Sync's `attachments` log already carries `status` per part; it gains `too-large` and `not-read`.
- A stored attachment's `extraction_error` gains the same two values.
- Once the mail CLI wires it, its `messages show` may read the server: its effect becomes a fetch.
