# Error reasons

Every error a WireCat CLI built on cli-core prints carries a `reason` beside its `code`:

```json
{"error":{"code":"not_found","reason":"item.not-found","message":"…"}}
```

The `code` is one of the few classes every WireCat CLI shares, the
[error codes](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md). The `reason` says which
failure it was, so a script or an agent can act on it without reading the message. This page lists every reason
cli-core raises, as `CORE_REASONS` exports them. A CLI adds its own on top of these (`failureContext`).

## What may change

The reasons are part of cli-core's contract, under the same semver as its stable exports:

- **A new reason** can come in any release. Handle a reason you do not know by its `code`.
- **A message** may be reworded in any release. Match on the `reason`, never on the message.
- **Removing or renaming a reason, or moving it to another code,** breaks callers. It is listed in the changelog
  under "Changed — may break callers" or "Removed", and from 1.0.0 on it needs a major release.
- **The detail keys** a reason lists are the ones its error may carry under `details`. A key may be added in any
  release.

The table is generated from `src/errors/reasons.ts` with `pnpm reasons:docs`, and `pnpm docs:check` fails when the
two disagree. Neither drops a reason this page lists until a fragment in `changes/` names it under one of those two
headings.

## All reasons

<!-- reasons: generated -->

| Reason | Code | Meaning | Details |
|---|---|---|---|
| `access.denied` | `permission_error` | the provider refused this account access to the item |  |
| `account-remove.account-shared` | `conflict` | another profile reads the same account, whose copy the store shares |  |
| `account-remove.account-unknown` | `conflict` | which account another profile holds could not be read, so --delete-data waits |  |
| `account-remove.busy` | `conflict` | a serve or a sync runs for this profile; stop it first |  |
| `account-remove.folder-outside` | `configuration_error` | the tool named a folder of its own outside the home folder |  |
| `account-remove.no-choice` | `validation_error` | account remove needs --keep-data or --delete-data, one of them |  |
| `account-remove.path-outside` | `configuration_error` | the tool named a path outside its own folders |  |
| `account-remove.unconfirmed` | `confirmation_required` | removing an account asks first; add --yes |  |
| `account-remove.unknown-profile` | `not_found` | no profile by this name on this computer |  |
| `account-rename.bot` | `conflict` | the profile is also a bot profile, which keeps its name |  |
| `account-rename.busy` | `conflict` | a serve, a background service, a schedule or a sync uses this profile |  |
| `account-rename.config` | `configuration_error` | the config file cannot be read |  |
| `account-rename.moved-run` | `permission_error` | a run with moved folders never renames a profile |  |
| `account-rename.taken` | `conflict` | the new name, or a file or keyring entry under it, already exists |  |
| `account-rename.unconfirmed` | `confirmation_required` | renaming a profile asks first; add --yes |  |
| `account-rename.unpaired` | `configuration_error` | the tool named different paths for the old and new name |  |
| `agent.cost-unknown` | `validation_error` | the agent reports no cost, so a cost cap cannot stop it |  |
| `agent.refused` | `permission_error` | the schedule changed since it was saved, or starts no agent a schedule may run |  |
| `agent.unrestricted` | `permission_error` | nothing holds this agent to the CLI's commands, so no schedule starts it |  |
| `ai.images-not-allowed` | `permission_error` | the AI model may not read pictures; models ai set --allow-remote |  |
| `ai.key-missing` | `configuration_error` | no API key is stored for the AI model's address |  |
| `ai.not-set` | `configuration_error` | no AI model is chosen; models ai set chooses one |  |
| `ai.ok` | `invalid_response` | models ai check: the model answered (a result, never raised) |  |
| `ai.owner-only` | `permission_error` | only the owner chooses, unsets, checks or removes the AI model and its key, or revokes its consent |  |
| `ai.setting-invalid` | `configuration_error` | the ai section or the model given is not one WireCat can use |  |
| `api.disabled` | `configuration_error` | the provider's API is turned off for this OAuth project |  |
| `api.unknown-method` | `validation_error` | the provider has no method by this name |  |
| `busy.feed` | `validation_error` | a feed calendar has no busy times to ask; read its events with events list |  |
| `busy.no-calendars` | `validation_error` | no calendar syncs and no person was named, so there is nobody to ask |  |
| `busy.offline` | `permission_error` | calendars busy asks the provider; --offline was given |  |
| `busy.unanswered` | `provider_error` | the provider gave no busy times for a calendar or person that was asked |  |
| `calendar.ambiguous` | `validation_error` | two or more calendars have this name; name one by its id |  |
| `calendar.no-upcoming` | `not_found` | no upcoming meeting with other attendees is stored for this account |  |
| `calendar.read-only` | `permission_error` | the calendar takes no new events from this account |  |
| `calendar.sync-incomplete` | `not_found` | a synced calendar's sync never finished or is mid-round |  |
| `calendar.unsynced` | `not_found` | the calendar account has no synced calendar in the store |  |
| `catalog.cycle` | `invalid_response` | local folder ancestry contains a cycle |  |
| `catalog.depth-invalid` | `validation_error` | tree depth must be between 0 and 50 |  |
| `catalog.not-found` | `not_found` | the file or folder is not in the local catalog; run catalog import or sync |  |
| `catalog.tree-limit` | `validation_error` | the tree is over 10000 entries; name a smaller folder or lower --depth |  |
| `catalog.unavailable` | `configuration_error` | the store has no shared catalog for this account |  |
| `chat-sending.ask` | `confirmation_required` | models chats is ask: pass --yes, or the owner sets it to allowed | `emails`, `threads`, `tokens`, `host`, `model`, `estimated_cost_usd` |
| `chat-sending.denied` | `permission_error` | models chats is denied: chat text never goes to a model off this computer, even with --yes |  |
| `chat-sending.owner-only` | `permission_error` | only the owner makes models chats less strict, not an agent |  |
| `chat.not-read` | `not_found` | a chat shared with this person is not held whole in the store |  |
| `config.unrepairable` | `configuration_error` | the settings file's damage has more than one reading; nothing was changed, so it is fixed by hand |  |
| `content.already-published` | `validation_error` | a published post cannot be scheduled; unpublish it first |  |
| `content.conflict` | `validation_error` | the post changed at the source since the last sync; sync, then write again |  |
| `content.empty` | `validation_error` | a write names no field to set |  |
| `content.get-unsupported` | `configuration_error` | the source cannot read one post, author or term by its id |  |
| `content.lossy-body` | `validation_error` | the post's text holds blocks or embeds Markdown does not keep; --replace-body |  |
| `content.schedule-past` | `validation_error` | a post is scheduled for a time to come, not one that passed |  |
| `content.unlisted-held` | `validation_error` | a content id list would mark too much deleted, the sign-in read only part, or the site moved; nothing was |  |
| `content.write-unsupported` | `validation_error` | the source does not take this write, such as a deletion past the trash |  |
| `context.read-budget` | `validation_error` | the selected context reads exceed their text or request allowance |  |
| `contract.field` | `validation_error` | a field of the contract is not valid |  |
| `contract.ref` | `validation_error` | the reference names no contract, or no deal for it |  |
| `contract.unacknowledged-override` | `configuration_error` | a shared command contract changed without an explicit override |  |
| `crm.activities-failed` | `validation_error` | the activities and tasks could not be read; the deals and leads were synced |  |
| `crm.activities-unlisted-held` | `validation_error` | a full list would mark most activities deleted; held until --rescan |  |
| `crm.activity-field` | `validation_error` | a comment's or task's field is not valid, or the kind does not take it |  |
| `crm.amount-unkept` | `validation_error` | a CRM deal's amount is in a currency or with decimals the store cannot hold: the deal is kept without it |  |
| `crm.client-reads-admin-only` | `permission_error` | a raw api call that reads contacts or companies is the CRM administrator's |  |
| `crm.email-ambiguous` | `validation_error` | a CRM contact's email belongs to more than one person; the owner decides |  |
| `crm.file-exists` | `conflict` | the --dir folder already holds a file of that name, which a download never overwrites |  |
| `crm.file-too-large` | `validation_error` | the file is larger than the download may take; --max-size raises it up to 2048 MB |  |
| `crm.file-unavailable` | `provider_error` | the CRM did not give the file; its link is never shown |  |
| `crm.files-denied` | `permission_error` | the profile's files.download level stops downloading files |  |
| `crm.files-disk-full` | `validation_error` | the account's files folder is at its files.max_total_mb even after dropping |  |
| `crm.files-limit-range` | `validation_error` | a files setting takes a whole number within its range; it is never clamped |  |
| `crm.foreign-contacts-spent` | `permission_error` | the day's reads of records that are not yours (contacts, companies, other people's files) are spent |  |
| `crm.item-invalid` | `validation_error` | a CRM item has a field the store refuses, such as a status it does not know |  |
| `crm.narrowing-held` | `validation_error` | the default scope mine would mark most of a kind's stored rows deleted; none is, until the owner sets the scope |  |
| `crm.not-reported` | `validation_error` | the CRM did not list users or departments; what they would say is unknown, nothing withdrawn |  |
| `crm.own-unknown` | `validation_error` | no own company of the CRM account is stored, so its users are no one's employees yet |  |
| `crm.owner-unknown` | `validation_error` | owner: names no CRM user: me without a known sign-in user, or not a user id |  |
| `crm.pending-dropped` | `validation_error` | relationships waited too long for an end that never came; they were dropped |  |
| `crm.pipeline-required` | `validation_error` | the CRM has more than one pipeline of the kind; the command names one |  |
| `crm.record-ambiguous` | `validation_error` | more than one contact or company has that name; name one by its id |  |
| `crm.record-field` | `validation_error` | a contact's or company's field is not valid |  |
| `crm.reference-unknown` | `validation_error` | a CRM row names a contact, company or user the store does not hold; that link was not made |  |
| `crm.scope-missing` | `permission_error` | the CRM sign-in lacks a scope one kind of a record's files needs |  |
| `crm.self-from-sync` | `validation_error` | only a sync records whose CRM copy it is; config unset hands the copy to the next sync |  |
| `crm.stage-history-failed` | `validation_error` | the CRM's stage history could not be read; stage tasks wait for the next sync |  |
| `crm.stage-unknown` | `validation_error` | a CRM item stands in a stage the store does not hold; it was not kept |  |
| `crm.unassigned-dropped` | `validation_error` | the CRM does not let this sign-in choose a user in unassigned; that user's deals are not copied |  |
| `crm.unlisted-held` | `validation_error` | a list of every id would mark most of a kind deleted, or the sign-in read only part; nothing was |  |
| `crm.write-unsupported` | `validation_error` | the CRM does not take this write, or does not recognise a repeated one |  |
| `db.failed` | `provider_error` | the database server failed the query |  |
| `db.no-database` | `not_found` | the database server has no such database |  |
| `db.no-select` | `permission_error` | the database user may not read the table; grant it SELECT |  |
| `db.no-table` | `not_found` | the database has no such table |  |
| `db.read-only` | `permission_error` | the database refused a write: the connection only reads |  |
| `db.refused` | `authentication_error` | the database server refused the user or password |  |
| `db.timeout` | `timeout` | the database server did not answer in time |  |
| `deal.closed` | `validation_error` | a deleted deal or lead does not move or close |  |
| `deal.copy` | `validation_error` | a CRM's copy changes in the CRM; its next sync brings the change here |  |
| `deal.denied` | `permission_error` | the profile denies listing deals or leads, so none is answered |  |
| `deal.field` | `validation_error` | a field of the deal or lead is not valid |  |
| `deal.not-readable` | `not_found` | the deal or lead is a copy the profile's CRM sign-in may not read |  |
| `deal.out-of-scope` | `not_found` | the deal or lead is a copy from an account outside the accounts asked for |  |
| `deal.ref` | `validation_error` | the reference names no deal or lead |  |
| `deal.stage` | `validation_error` | no stage of that name, or a stage name more than one pipeline has |  |
| `decision.request-invalid` | `validation_error` | a decision request needs its batch, message, owner and distinct known actions |  |
| `decision.token-cancelled` | `permission_error` | another button of the message was pressed, or the feature was turned off |  |
| `decision.token-expired` | `permission_error` | this button is older than 72 hours |  |
| `decision.token-mismatch` | `permission_error` | the press came from another chat, message or user than the button was sent to |  |
| `decision.token-unknown` | `not_found` | no button has this token |  |
| `decision.token-used` | `permission_error` | this button was already pressed |  |
| `doctor.report-exists` | `validation_error` | the report's file exists; a problem report never overwrites a file |  |
| `document.changed` | `validation_error` | the document changed while it was read; nothing was saved |  |
| `document.needs-ocr` | `validation_error` | the PDF has no text layer; a documents sync reads it with OCR (read_scans) |  |
| `document.not-found` | `not_found` | no listed document has that reference |  |
| `document.not-imported` | `not_found` | the document is not imported in this source account |  |
| `document.scan-later` | `validation_error` | OCR stopped at its page limit or a busy model; the next sync goes on |  |
| `document.scan-unread` | `validation_error` | OCR could not read the scan or picture; a sync tries again once the file changes |  |
| `document.scan-unturned` | `configuration_error` | tesseract has no osd data, so a page on its side is read as it lies; install it to read scans again |  |
| `document.version-missing` | `not_found` | the local copy holds no such version of the document |  |
| `documents.other-account` | `configuration_error` | the documents are signed in as another account than the tracker copy of the same provider |  |
| `download.mismatch` | `invalid_response` | the downloaded file has other content than the listing said |  |
| `enrichment.owner-only` | `permission_error` | only the owner turns enrichment on, not an agent |  |
| `event.conference-exists` | `validation_error` | the event has a meeting link already, which its attendees use |  |
| `event.conflict` | `validation_error` | the event changed at the provider since the last sync; sync and try again |  |
| `event.notify-required` | `validation_error` | the event has other attendees; say whether to notify them |  |
| `event.quick-add-ambiguous` | `validation_error` | more than one event could be the one a lost quick add made |  |
| `event.repeat-count` | `validation_error` | a COUNT series is split only with a rule for its new part |  |
| `event.repeat-invalid` | `validation_error` | the repeat rule is outside the RFC 5545 subset the calendars take |  |
| `event.repeat-kind` | `validation_error` | the series' rule holds a date or a time of the kind the event is leaving |  |
| `event.repeat-split` | `validation_error` | the series cannot be split at this occurrence, or was split there already |  |
| `event.text-with-fields` | `validation_error` | --text takes the whole event from its line, so no field option goes with it |  |
| `event.unmovable` | `validation_error` | the provider keeps this kind of event on its calendar |  |
| `evidence-findings.dedicated-review` | `validation_error` | review evidence findings through the dedicated findings command |  |
| `evidence-findings.stale` | `validation_error` | evidence findings changed since they were read; stage a new batch |  |
| `evidence.quote-length` | `validation_error` | a quote from the evidence is empty or over 500 characters |  |
| `evidence.quote-not-found` | `validation_error` | the cited source does not say the quoted words |  |
| `evidence.row-too-large` | `validation_error` | one evidence row is over its size limit |  |
| `export.exists` | `validation_error` | the output file already exists |  |
| `export.too-many` | `validation_error` | the query finds more events than one export writes |  |
| `extraction.invalid-proposals` | `invalid_response` | the model's memory proposals could not be used |  |
| `extraction.text-too-long` | `validation_error` | the text is too long for memory extraction |  |
| `fact.not-accepted` | `validation_error` | only an accepted fact can be revoked |  |
| `fact.owner-written` | `validation_error` | the owner wrote this fact; it was never proposed, so it cannot be revoked |  |
| `fact.payment-retired` | `validation_error` | a payment is a payments row in store.finance, not a fact |  |
| `fact.revoke-correction` | `validation_error` | an accepted correction cannot be revoked; its superseded fact stays |  |
| `feed.address-invalid` | `validation_error` | a feed address is an http, https or webcal URL with no user or password in it |  |
| `feed.duplicate` | `validation_error` | this profile follows a feed at this address already |  |
| `feed.gone` | `not_found` | the feed's server has no feed at this address any more |  |
| `feed.no-address` | `configuration_error` | the feed's address is no longer kept on this computer |  |
| `feed.not-a-feed` | `validation_error` | the calendar is not a feed this profile follows |  |
| `feed.redirect-refused` | `validation_error` | the feed sent the request on to an address that is not https |  |
| `feed.refused` | `provider_error` | the feed's server refused the request |  |
| `feed.timeout` | `timeout` | the feed's server did not answer in time |  |
| `feed.too-large` | `validation_error` | the feed is larger than one sync reads |  |
| `feed.unreachable` | `network_error` | the feed's server could not be reached |  |
| `field.ambiguous` | `validation_error` | more than one custom field has that label; name one by its code |  |
| `field.ambiguous-option` | `validation_error` | more than one option of the list field has that label; name one by its id |  |
| `field.not-filterable` | `validation_error` | the CRM cannot filter a list by that custom field |  |
| `field.unknown` | `validation_error` | no custom field of the kind has that code or label; `fields list` lists them |  |
| `field.unknown-kind` | `validation_error` | fields are listed for deals, leads, people and organizations only |  |
| `field.unknown-option` | `validation_error` | the list field has no option with that id or label |  |
| `file.denied` | `permission_error` | the file cannot be opened: permission denied |  |
| `file.locked` | `validation_error` | another process holds the file's lock |  |
| `file.not-a-file` | `validation_error` | the path names a folder or another thing that is not a file |  |
| `file.not-found` | `not_found` | the file named, or its folder, does not exist |  |
| `file.not-plain-text` | `validation_error` | the file's text is extracted on a read; writing it back would replace the file |  |
| `file.too-large` | `validation_error` | the file is larger than the limit set for this read |  |
| `finance.allocate` | `validation_error` | the invoice or payment cannot take an allocation in its state |  |
| `finance.below-paid` | `validation_error` | the invoice's lines would total less than is paid on it |  |
| `finance.currency` | `validation_error` | the payment and the invoice are in different currencies; nothing is converted |  |
| `finance.field` | `validation_error` | a field of the invoice or payment is not valid |  |
| `finance.line` | `validation_error` | an invoice keeps at least one line: reject or void it instead |  |
| `finance.line-amount` | `validation_error` | an invoice line's amount is not its quantity times its unit price |  |
| `finance.lines` | `validation_error` | the invoice's lines are not valid |  |
| `finance.no-line` | `not_found` | the invoice has no line at that position |  |
| `finance.not-allocated` | `not_found` | the payment is not allocated to that invoice |  |
| `finance.over-invoice` | `validation_error` | the allocation would settle more than the invoice's total |  |
| `finance.over-payment` | `validation_error` | the allocation would use more than the payment's amount |  |
| `finance.over-refund` | `validation_error` | the refunds would take back more than the payment, or than it gave an invoice |  |
| `finance.owner-only` | `permission_error` | only the owner does this with money |  |
| `finance.party` | `validation_error` | a party is a person: or organization: reference |  |
| `finance.ref` | `validation_error` | the reference names no invoice or payment |  |
| `finance.refund` | `validation_error` | a refund goes the other way in the same currency, of a live payment confirmed first, to an invoice it paid |  |
| `finance.refunded` | `validation_error` | a refund of the payment still stands; reject it or take it back first |  |
| `finance.status` | `validation_error` | the invoice's status does not allow this |  |
| `finance.total` | `validation_error` | the invoice's total is not the sum of its lines |  |
| `finance.unallocate` | `validation_error` | a rejected or deleted payment's allocations are not taken back |  |
| `finding.missing-field` | `validation_error` | a finding leaves out a field its kind needs |  |
| `finding.quote-not-found` | `validation_error` | a finding's quote is not in the text it cites, word for word |  |
| `finding.unknown-field` | `validation_error` | a finding has a field its kind does not take |  |
| `folder.not-a-folder` | `validation_error` | what was named is not a folder the account can read |  |
| `folder.not-chosen` | `not_found` | the folder is not among the chosen folders |  |
| `group.outside` | `permission_error` | the process is locked to a group, and this belongs to accounts outside it |  |
| `ics.no-events` | `validation_error` | the file holds no event that can be imported |  |
| `ics.not-icalendar` | `validation_error` | the file is not iCalendar |  |
| `ics.too-large` | `validation_error` | the file is larger than one import reads |  |
| `ics.too-many` | `validation_error` | the file holds more events than one import sends |  |
| `identity-link.dedicated-review` | `validation_error` | an identity link is staged and decided through the people review |  |
| `identity-split.dedicated-review` | `validation_error` | a split of a person is staged and decided through the people review |  |
| `identity.agent-unnamed` | `validation_error` | an agent's link names the agent, and never as the owner |  |
| `identity.common-name` | `validation_error` | more than six people have the name, so it proposes no one |  |
| `identity.held-elsewhere` | `validation_error` | the identity sits on another person than the one named; name that person to take it off them |  |
| `identity.kept-together` | `conflict` | the owner kept these identities together by turning down their split; only the owner splits them |  |
| `identity.merge-conflict` | `conflict` | a row of the renamed identity has no counterpart on the identity it merges into; the pair is left as it was |  |
| `identity.no-merge` | `not_found` | nothing of that person is merged into the other; people show lists the merges |  |
| `identity.none` | `not_found` | the provider shows no accounts on a document |  |
| `identity.not-a-person` | `validation_error` | a bot, a program or an organization is never proposed as a person by name |  |
| `identity.not-shared` | `validation_error` | only a match on a shared mailbox can say the mailbox is a company's |  |
| `identity.nothing-left` | `validation_error` | a split leaves at least one identity with the person |  |
| `identity.owner` | `validation_error` | one side is the owner's person, and only the owner joins anyone to themselves |  |
| `identity.owner-only` | `permission_error` | only the owner undoes a merge, splits a person, confirms or undoes a link, or links an identity to themselves |  |
| `identity.rejected` | `conflict` | the owner rejected linking these people on this evidence; only a new signal or identity proposes them again |  |
| `identity.same` | `validation_error` | the two identities are one person already |  |
| `identity.separated` | `conflict` | the owner separated this identity from that person; only the owner links it again |  |
| `identity.several-persons` | `validation_error` | the identities that leave a person are all of that one person |  |
| `identity.shared-email` | `validation_error` | more than six people share the address, so it proposes no one |  |
| `identity.shared-phone` | `validation_error` | more than six people share the phone number, so it proposes no one |  |
| `identity.stale` | `conflict` | the people a merge or a proposed link names changed since; undo the later merge, or propose the link again |  |
| `index.not-ready` | `validation_error` | the search index is still being built |  |
| `input.closed` | `validation_error` | the input closed before the answer |  |
| `input.empty` | `validation_error` | a hidden prompt got an empty answer three times |  |
| `input.field-conflict` | `validation_error` | the input fields conflict | `fields` |
| `input.field-unsupported` | `validation_error` | the input field is not supported | `fields` |
| `input.incomplete` | `validation_error` | the answers stop before the step that checks them |  |
| `input.required` | `validation_error` | the command needs an answer and cannot ask for one |  |
| `input.too-large` | `validation_error` | the input is over its size limit |  |
| `item.not-found` | `not_found` | the provider has no item by this id, or this account cannot see it |  |
| `listing.source-not-found` | `not_found` | a source: term names no account holding what is listed |  |
| `listing.too-large` | `provider_error` | the listing is over its bound; the checkpoint was kept |  |
| `local-only.owner-only` | `permission_error` | only the owner turns local only off, not an agent |  |
| `local-only.refused` | `permission_error` | local only is on and the address is not on this computer; nothing was sent |  |
| `mail-findings.dedicated-review` | `validation_error` | review mail findings through the dedicated findings command |  |
| `mail-findings.invalid` | `validation_error` | a checked mail findings batch would be refused; details.problems names why, finding by finding |  |
| `mail-findings.key-used` | `validation_error` | the findings batch key was already used for different input |  |
| `mail-findings.not-stored` | `not_found` | a mail finding cites an email the store does not hold |  |
| `mail-findings.partial` | `validation_error` | a cited email is not stored whole yet; cite it once it is |  |
| `mail-findings.stale` | `validation_error` | mail findings cite mail that changed since it was read; stage a new batch |  |
| `mail.attachments-unread` | `provider_unavailable` | the email could not be read again, so its skipped attachments have no text |  |
| `mail.cursor-ahead` | `validation_error` | an acknowledge cursor is past the newest stored email |  |
| `mail.holder-not-yours` | `permission_error` | a run moves only the mark of the holder its schedule names |  |
| `mail.inbox-agent` | `permission_error` | an agent sorts mail itself from review; inbox --offline lists |  |
| `mail.inbox-answer-invalid` | `invalid_response` | the AI model's answer to inbox is not the JSON it asks for |  |
| `mail.no-mark` | `not_found` | the holder has no mark in the mailbox yet; its first review starts it |  |
| `mail.reset-owner-only` | `permission_error` | only the owner moves a holder's mark back |  |
| `mail.search-refused` | `provider_error` | the mail server refused to search a folder |  |
| `mail.source-failed` | `provider_error` | the mail server refused or did not complete a request |  |
| `manifest.invalid` | `configuration_error` | the source manifest does not match its shape or the generated API |  |
| `meeting-findings.dedicated-review` | `validation_error` | review meeting findings through the dedicated findings command |  |
| `meeting-findings.stale` | `validation_error` | meeting findings changed since they were read; stage a new batch |  |
| `meeting-project.stale` | `conflict` | the meeting's project changed meanwhile |  |
| `meeting.not-found` | `not_found` | no meeting row has that event or meeting reference |  |
| `meetings.index-pending` | `not_found` | some stored meetings are not indexed by person yet |  |
| `meetings.server-capped` | `outcome_unknown` | the meetings service may hold more matches than the calls and pages one list asks |  |
| `meetings.server-failed` | `provider_error` | the meetings service could not be read, or what it returned kept |  |
| `meetings.server-offline` | `permission_error` | meetings list and show ask the service; --offline was given |  |
| `meetings.server-rate-limited` | `rate_limited` | the meetings service asked to wait before more requests |  |
| `meetings.server-refused` | `permission_error` | the meetings service refused the request |  |
| `meetings.server-signed-out` | `authentication_error` | the meetings service needs a sign-in |  |
| `meetings.server-unreachable` | `network_error` | the meetings service could not be reached |  |
| `memory.already-superseded` | `validation_error` | the memory was already replaced by another |  |
| `memory.evidence-required` | `validation_error` | a memory needs its evidence |  |
| `memory.scope-required` | `validation_error` | a memory needs its scope |  |
| `mirror.bad-exclusion` | `validation_error` | the exclusion is not a path pattern inside the mirror |  |
| `mirror.local-changed` | `conflict` | the local file changed since the conflict was found; nothing was written |  |
| `mirror.no-conflict` | `not_found` | the path has no recorded conflict; the last sync settled it or never saw one |  |
| `mirror.no-space` | `validation_error` | the sync needs more free space than the local drive has |  |
| `mirror.none` | `not_found` | the profile has no mirrors; add one with mirrors add |  |
| `mirror.not-folder` | `validation_error` | the path to mirror is not a folder |  |
| `mirror.not-found` | `not_found` | no such mirror in this profile; see mirrors list |  |
| `mirror.partial` | `provider_error` | some mirrored files were not synced |  |
| `mirror.remote-changed` | `conflict` | the remote file changed since the listing; the next sync settles it |  |
| `mirror.stopped` | `timeout` | the mirror's run reached its deadline before it was done; run it again with more time |  |
| `mirror.symlink` | `validation_error` | the file is under a symbolic link, which the sync does not follow |  |
| `mirror.too-many-deletions` | `confirmation_required` | the sync would delete more files than the guard allows; check them with --dry-run and allow them explicitly |  |
| `mirror.too-many-replacements` | `confirmation_required` | the sync would replace more files than the guard allows; check them with --dry-run and allow them explicitly |  |
| `mirror.version-not-kept` | `provider_error` | the earlier content could not be kept in the version store, so the sync did not replace it |  |
| `model.address-refused` | `validation_error` | the model address is refused: https, or plain http and Ollama only on this computer |  |
| `model.empty-answer` | `invalid_response` | the model answered nothing; given a picture, it may not read pictures — choose a vision model |  |
| `model.key-rejected` | `invalid_response` | the model provider refused the API key (401 or 403) |  |
| `model.not-downloaded` | `not_found` | the model is not downloaded on this machine |  |
| `model.offline` | `permission_error` | downloading a model needs the network; --offline was requested |  |
| `model.unreachable` | `invalid_response` | the model provider could not be reached over the network |  |
| `money.amount` | `validation_error` | the amount is not a decimal string in the currency's scale |  |
| `money.currency` | `validation_error` | the currency is not one the store keeps money in |  |
| `money.quantity` | `validation_error` | the quantity is not a decimal above 0 |  |
| `name.invalid` | `validation_error` | the name is not valid |  |
| `name.taken` | `validation_error` | the name is already used |  |
| `network.host-undeclared` | `configuration_error` | the request went to a host the CLI does not declare, or not the model address's own; nothing was sent |  |
| `oauth.declined` | `authentication_error` | the provider's consent was declined |  |
| `oauth.expired` | `authentication_error` | the provider refused the saved sign-in; sign in again |  |
| `oauth.failed` | `authentication_error` | the provider returned no offline refresh token |  |
| `oauth.invalid` | `authentication_error` | the saved sign-in cannot be read |  |
| `oauth.invalid-response` | `invalid_response` | the provider's token response could not be used |  |
| `oauth.locked` | `provider_unavailable` | another process holds this sign-in's lock |  |
| `oauth.mismatch` | `authentication_error` | the pasted sign-in result belongs to another sign-in |  |
| `oauth.moved-rotating` | `authentication_error` | a run with moved folders cannot refresh a sign-in whose refresh token rotates |  |
| `oauth.no-response` | `outcome_unknown` | the token request did not finish |  |
| `oauth.not-saved` | `configuration_error` | the sign-in cannot be saved or read where it is kept |  |
| `oauth.revoke-failed` | `outcome_unknown` | the provider did not confirm the revoke |  |
| `oauth.scope-missing` | `permission_error` | the sign-in lacks a permission this command needs |  |
| `oauth.timeout` | `timeout` | the sign-in was not finished in time |  |
| `oauth.unavailable` | `provider_unavailable` | the provider's token endpoint is unavailable |  |
| `office.array-formula` | `validation_error` | the cell is part of an array formula; change it in Excel |  |
| `office.bookmark` | `validation_error` | the paragraph holds a bookmark a cross-reference may point at |  |
| `office.duplicate-edit` | `validation_error` | the same cell or paragraph is changed twice in one call |  |
| `office.file-exists` | `conflict` | a file is there already; create never replaces one, update changes it |  |
| `office.formula-cell` | `validation_error` | the cell holds a formula; --replace writes the value over it |  |
| `office.implicit-cells` | `validation_error` | the row has cells without addresses, so a cell cannot be added |  |
| `office.implicit-rows` | `validation_error` | the sheet has rows without numbers, so a row cannot be added |  |
| `office.invalid-cell` | `validation_error` | a cell is not an address like B7 |  |
| `office.invalid-sheet-name` | `validation_error` | a new sheet's name is empty, too long, repeated or holds a character Excel refuses |  |
| `office.invalid-value` | `validation_error` | a value cannot be written: an infinite number, a cell text too long, an unknown style |  |
| `office.last-paragraph` | `validation_error` | the delete would leave the document or a table cell without a paragraph |  |
| `office.no-paragraph` | `validation_error` | the document has no paragraph at that index |  |
| `office.no-sheet` | `validation_error` | the workbook has no such sheet, or several when none is named |  |
| `office.rich-value` | `validation_error` | the cell holds a picture or a linked data type, which the editor does not replace |  |
| `office.section-break` | `validation_error` | the paragraph ends a section; deleting it would merge two sections |  |
| `office.shared-formula` | `validation_error` | the cell holds a formula other cells share; replacing it would break theirs |  |
| `office.table-header` | `validation_error` | the cell is a table's header or total, whose part repeats the text; change it in Excel |  |
| `office.tracked-change` | `validation_error` | the paragraph holds a tracked change |  |
| `office.unsafe-paragraph` | `validation_error` | the paragraph cannot be edited safely; documents show gives the reason |  |
| `office.wrong-format` | `validation_error` | the file is not the Office format the command edits, or its parts cannot be read |  |
| `offline.refused` | `permission_error` | this command needs the provider; --offline was given |  |
| `order.currency` | `validation_error` | the product is priced in another currency than the order |  |
| `order.duplicate` | `validation_error` | the shop's order with this number is already stored; change its status instead |  |
| `order.field` | `validation_error` | a field of the order is not valid |  |
| `order.line` | `validation_error` | an order keeps at least one line: reject or cancel it instead |  |
| `order.line-amount` | `validation_error` | an order line's amount is not its quantity times its unit price |  |
| `order.lines` | `validation_error` | the order's lines are not valid |  |
| `order.no-line` | `not_found` | the order has no line at that position |  |
| `order.not-found` | `not_found` | no stored order of that shop has that number |  |
| `order.owner-only` | `permission_error` | only the owner changes a confirmed order's lines |  |
| `order.proposed` | `validation_error` | the shop's order with this number already waits for the owner in a findings batch |  |
| `order.ref` | `validation_error` | the reference names no order, or a shop's number names more than one |  |
| `order.source-url` | `validation_error` | an order's source URL is not an http or https address |  |
| `order.status` | `validation_error` | a rejected or deleted order's status does not change |  |
| `order.total` | `validation_error` | an order with lines names its currency and totals their sum |  |
| `organization.ambiguous` | `validation_error` | more than one organization matches; name the one meant as a reference |  |
| `organization.erase-blocked` | `validation_error` | an invoice, order, subscription or a row the organization wrote still names it; change those first, nothing was deleted |  |
| `organization.not-found` | `not_found` | no stored organization has that id |  |
| `organization.own` | `validation_error` | the organization is one of your own companies and is never deleted |  |
| `organization.unnamed` | `validation_error` | a free mailbox names no company; name the organization or the company |  |
| `output.choose-fields` | `validation_error` | at a terminal, --json names the fields it prints |  |
| `output.conflict` | `validation_error` | two output switches ask for different output |  |
| `output.one-object` | `validation_error` | a report is one JSON object; --jsonl streams lists only |  |
| `output.unknown-field` | `validation_error` | the answer has no field by that name |  |
| `period.ambiguous` | `validation_error` | the period can be read more than one way |  |
| `person.erase-blocked` | `validation_error` | an invoice, order, subscription or a row the person wrote still names them; change those first, nothing was deleted |  |
| `person.from-required` | `validation_error` | say whom the identity leaves: --from person:<uid>, or person:me for the owner |  |
| `person.no-doubt` | `not_found` | nothing about that person is in doubt; people links check lists who is |  |
| `person.no-identity` | `validation_error` | a person with no identity is not test data; there is nothing to hide |  |
| `person.no-owner` | `not_found` | no person is marked as the owner in the store |  |
| `person.owner` | `validation_error` | the owner's own person is not test data, and is never deleted |  |
| `person.unknown` | `not_found` | the store has no person by that reference; people list gives person:<uid> |  |
| `picture-reading.agent-missing` | `validation_error` | choose the agent that reads: --agent claude or --agent codex |  |
| `picture-reading.failed` | `invalid_response` | the coding agent failed or answered nothing |  |
| `picture-reading.not-a-picture` | `validation_error` | the file is not a PNG, JPEG or WebP picture |  |
| `picture-reading.off` | `permission_error` | picture reading is never; models picture-reading set request |  |
| `picture-reading.owner-only` | `permission_error` | only the owner turns picture reading on, not an agent |  |
| `picture-reading.timeout` | `timeout` | the coding agent gave no answer in time |  |
| `picture-reading.unavailable` | `configuration_error` | the chosen coding agent is not installed |  |
| `picture-reading.unavailable-file` | `not_found` | the picture could not be fetched, or is over the size limit |  |
| `pipeline.ambiguous` | `validation_error` | more than one pipeline has that name; name it by its pipeline: reference |  |
| `pipeline.duplicate` | `validation_error` | a pipeline of that name and kind is already stored |  |
| `pipeline.field` | `validation_error` | a pipeline needs a name and at least one stage, each named once |  |
| `pipeline.not-found` | `not_found` | no stored pipeline has that name or reference |  |
| `press.owner-hand-only` | `permission_error` | this button decides something for the owner; only a hand presses it |  |
| `product.duplicate` | `validation_error` | a product with that code is already stored for that supplier |  |
| `product.field` | `validation_error` | a field of the product is not valid |  |
| `product.ref` | `validation_error` | the reference names no product |  |
| `profile.account-taken` | `conflict` | another profile here already uses this provider account |  |
| `profile.busy` | `provider_unavailable` | another sync or write holds this profile's local copy |  |
| `profile.locked` | `permission_error` | a profile lock pins this process to its own account |  |
| `profile.missing` | `validation_error` | no profile named, and none is picked for the owner; details.profiles lists the ones here |  |
| `profile.not-synced` | `not_found` | the profile has no local copy yet; sync it first |  |
| `profile.other-account` | `conflict` | this profile's copy was synced from another provider account |  |
| `profile.reserved` | `validation_error` | the profile name is a folder every CRM account shares; pick another |  |
| `profile.unknown` | `not_found` | no profile by this name on this computer; details.profiles lists the ones here |  |
| `profile.wrong-account` | `authentication_error` | the signed-in source account does not match this profile |  |
| `proposal.decider-required` | `validation_error` | a decision names who decides: the owner or an agent with a reason |  |
| `proposal.ids` | `validation_error` | the proposal ids cannot be read |  |
| `proposal.own` | `permission_error` | an agent never decides its own proposal |  |
| `proposal.owner-only` | `permission_error` | only the owner decides this proposal |  |
| `proposal.reason-required` | `validation_error` | an agent deciding for the owner, or proposing a link, gives a reason |  |
| `proposal.unknown-kind` | `not_found` | no registered proposal kind holds this id |  |
| `proposal.wrong-state` | `validation_error` | the proposal is not in a state that allows this |  |
| `proposals.agent-decisions-off` | `permission_error` | agent decisions are turned off; the owner decides |  |
| `provider.failed` | `provider_error` | a read from the provider failed |  |
| `provider.usage-limit` | `rate_limited` | the account's usage limit at the provider is reached; wait, do not retry |  |
| `push.too-many-files` | `validation_error` | the folder holds more files than one push takes |  |
| `push.unreadable` | `validation_error` | the folder to push could not be read |  |
| `query.aborted` | `validation_error` | the search was stopped before it finished |  |
| `query.bad-value` | `validation_error` | a term's value is not the kind its field takes, such as an id or a number |  |
| `query.bare-word` | `validation_error` | a word in the query has no field | `span`, `alternative`, `guide`, `word` |
| `query.conflict` | `validation_error` | two parts of the query contradict each other |  |
| `query.empty-window` | `validation_error` | the time window ends before it starts, so no row can fall in it |  |
| `query.invalid-ast` | `validation_error` | the query tree is not valid | `span`, `alternative`, `guide` |
| `query.invalid-context` | `validation_error` | the context size is out of range |  |
| `query.invalid-date` | `validation_error` | a date in the query cannot be read | `span`, `alternative`, `guide` |
| `query.invalid-duration` | `validation_error` | a duration in the query cannot be read |  |
| `query.invalid-escape` | `validation_error` | an escape in the query is not valid | `span`, `alternative`, `guide` |
| `query.invalid-limit` | `validation_error` | the limit is out of range |  |
| `query.invalid-number` | `validation_error` | a number in the query cannot be read | `span`, `alternative`, `guide` |
| `query.invalid-reference` | `validation_error` | a reference in the query is not valid |  |
| `query.invalid-regex` | `validation_error` | a regular expression in the query is not valid | `span`, `alternative`, `guide` |
| `query.invalid-scope` | `validation_error` | the query selects no account |  |
| `query.invalid-size` | `validation_error` | a size in the query cannot be read |  |
| `query.invalid-syntax` | `validation_error` | the query cannot be parsed | `span`, `alternative`, `guide` |
| `query.invalid-tag` | `validation_error` | a tag in the query is not valid |  |
| `query.invalid-timezone` | `validation_error` | the time zone is not known | `span`, `alternative`, `guide` |
| `query.invalid-topic` | `validation_error` | a topic in the query is not valid |  |
| `query.legacy-date-field` | `validation_error` | after: and before: are written date>= and date< |  |
| `query.missing-value` | `validation_error` | a field in the query has no value | `span`, `alternative`, `guide` |
| `query.no-match` | `not_found` | no person or chat in the store fits a name in the query |  |
| `query.short-text` | `validation_error` | a search by part of a name or a title needs three characters or more |  |
| `query.time-limit` | `timeout` | the search took longer than its time limit; the query itself is valid |  |
| `query.too-large` | `validation_error` | the query is over one of its limits | `span`, `alternative`, `guide` |
| `query.topic-scope` | `validation_error` | a topic needs its chat in the query |  |
| `query.unclosed-literal` | `validation_error` | a quote or bracket in the query is not closed | `span`, `alternative`, `guide` |
| `query.unknown-field` | `validation_error` | a field in the query is not known | `span`, `alternative`, `guide`, `fields` |
| `query.unknown-value` | `validation_error` | a value in the query is not known | `span`, `alternative`, `guide` |
| `query.unsupported-field` | `validation_error` | this list cannot filter by that field | `span`, `alternative`, `guide`, `supported` |
| `query.unsupported-operator` | `validation_error` | this field does not take that operator | `span`, `alternative`, `guide` |
| `query.unsupported-placement` | `validation_error` | this field works only as a required term | `span`, `alternative`, `guide` |
| `query.unsupported-regex` | `validation_error` | that regular expression is not supported | `span`, `alternative`, `guide` |
| `query.unsupported-regex-flags` | `validation_error` | regular expression flags are not supported | `span`, `alternative`, `guide` |
| `query.unsupported-version` | `validation_error` | the query version is not supported | `span`, `alternative`, `guide` |
| `ranking.invalid` | `validation_error` | the ranking is not valid |  |
| `reactions.broadcast` | `permission_error` | a channel does not show who reacted to its posts |  |
| `reactions.list-hidden` | `permission_error` | the chat does not let its members see who reacted |  |
| `read-only.output-outside` | `permission_error` | a read-only process writes files only inside its working folder |  |
| `record.ambiguous` | `validation_error` | the record's identifiers point at more than one entity; the owner says which |  |
| `record.chat` | `validation_error` | the chat an SMS names is not an imported one: a sync owns it |  |
| `record.entity` | `validation_error` | the entity or proposal the record stands for was refused |  |
| `record.identifier` | `validation_error` | a free-mail domain names no organization: anyone has an address there |  |
| `record.invalid` | `validation_error` | a field of the record is not the kind the entity needs |  |
| `record.map-owner-only` | `permission_error` | only the owner says which entity a source record is |  |
| `record.map-type` | `validation_error` | a record maps only to an entity of its own type |  |
| `record.mapped` | `validation_error` | the record already stands for another entity |  |
| `record.moved` | `validation_error` | an SMS stays in its thread: delete it and send it again under a new external_id |  |
| `record.not-found` | `validation_error` | the store holds no such record to delete |  |
| `record.over-payment` | `validation_error` | the record's settles amounts add up to more than the payment |  |
| `record.phone-region` | `validation_error` | a phone without + is read only in the envelope's phone_region; kept as data |  |
| `record.provider-not-imported` | `validation_error` | SMS and calls are imported only under an import-only provider, such as phone |  |
| `record.reference-not-found` | `validation_error` | a reference in the record's fields is not in the store |  |
| `record.relation-ambiguous` | `validation_error` | the record names more than one target for a role that takes one |  |
| `record.separated` | `validation_error` | the owner told the one entity these identifiers match apart from them |  |
| `record.stale-revision` | `validation_error` | the store holds a newer revision of the record |  |
| `ref.malformed` | `validation_error` | the reference has a known kind but not its shape |  |
| `ref.unknown-kind` | `validation_error` | the text names no kind of reference |  |
| `ref.wrong-account` | `validation_error` | the reference belongs to another account than this profile's |  |
| `ref.wrong-kind` | `validation_error` | the reference names another kind of thing than the argument takes |  |
| `ref.wrong-provider` | `validation_error` | the reference belongs to another messenger; open it with that CLI |  |
| `relationship.engagement-ends` | `validation_error` | only a person's member-of a project takes an engagement level |  |
| `relationship.engagement-unknown` | `validation_error` | the engagement level is not none, low, medium or high |  |
| `relationship.exists` | `validation_error` | a confirmed relationship already links them |  |
| `relationship.invalid` | `validation_error` | a reported relationship joins ends or takes a role the registry refuses |  |
| `relationship.reference-unknown` | `validation_error` | a reported relationship names something the store does not hold |  |
| `relationship.role-built-in` | `validation_error` | a built-in role stays on its list |  |
| `relationship.role-exists` | `validation_error` | the role list holds that role already |  |
| `relationship.role-in-use` | `validation_error` | relationships still hold that role; change them first (details.count) |  |
| `relationship.role-unknown` | `validation_error` | the role is not one the relationship takes; the message lists them |  |
| `remind.hook-failed` | `configuration_error` | the reminder program failed for some events; the next run retries them |  |
| `remind.running` | `validation_error` | another events remind is running; this run did nothing |  |
| `remind.window` | `validation_error` | --due-within is outside 1m to 1d |  |
| `schedule.outside-folder` | `permission_error` | schedule exec runs only a schedule file in the tool's own schedules folder |  |
| `search-harder.owner-only` | `permission_error` | only the owner allows search all --harder, not an agent |  |
| `search.all-denied` | `permission_error` | the profile denies every kind search all would read |  |
| `search.kind` | `validation_error` | the saved search belongs to another kind of search: messages or meetings |  |
| `search.no-calendars` | `validation_error` | no calendar of this profile syncs yet, so the provider has nothing to search |  |
| `search.offline` | `permission_error` | search --backend server asks the provider; --offline was given |  |
| `search.one-backend` | `validation_error` | search answers from one backend at a time: archive or server |  |
| `search.server-capped` | `outcome_unknown` | the server found more than one search reads, or a branch was not sent |  |
| `search.server-failed` | `provider_unavailable` | the server did not answer a search |  |
| `search.server-no-criteria` | `validation_error` | the query has nothing the server can search, so only the store is read |  |
| `search.server-not-allowed` | `permission_error` | the profile does not allow messages.server-search |  |
| `search.server-options` | `validation_error` | search --backend server takes neither --exact, --cursor nor --newest |  |
| `search.server-partial` | `outcome_unknown` | a message the server found was stored without its attachments; the next sync reads it whole |  |
| `search.server-rate-limited` | `rate_limited` | the server refused a search as too many requests |  |
| `search.server-timeout` | `timeout` | the server did not answer within --server-time |  |
| `search.server-unsupported` | `provider_error` | this source's server cannot search |  |
| `selection.changed` | `validation_error` | the stored selection changed meanwhile |  |
| `selection.invalid` | `validation_error` | the selection is not valid |  |
| `selection.out-of-scope` | `permission_error` | the selection reaches outside what this profile may read |  |
| `serve.outdated` | `configuration_error` | the store or the installed version is newer than this serve; it stopped so its unit starts the installed one |  |
| `session.duplicate` | `conflict` | another profile here already signs in to this account as this user |  |
| `session.missing` | `authentication_error` | this profile is not signed in: no saved sign-in or API token |  |
| `session.unreadable` | `configuration_error` | the profile's stored secrets cannot be read; sign in again |  |
| `sftp.auth-missing` | `configuration_error` | an SFTP connection needs a password or a private key |  |
| `sftp.closed` | `validation_error` | the SFTP connection was closed before the operation |  |
| `sftp.file-changed` | `validation_error` | the file changed on the server while a stream read it; read it again |  |
| `sftp.host-key-mismatch` | `authentication_error` | the SFTP server's host key is not the pinned one |  |
| `sftp.host-key-missing` | `configuration_error` | no host key is pinned for the SFTP server |  |
| `sftp.key-invalid` | `configuration_error` | the SFTP private key or its passphrase cannot be read |  |
| `sftp.library-missing` | `configuration_error` | SFTP needs the ssh2 package in the CLI's dependencies |  |
| `sftp.timeout` | `timeout` | the SFTP server did not answer in time |  |
| `sftp.too-large` | `validation_error` | the file is larger than the read's byte limit |  |
| `sign-in.client-file-invalid` | `configuration_error` | the file is not a Desktop app OAuth client JSON |  |
| `sign-in.client-file-open` | `configuration_error` | other users of this computer can read the client file |  |
| `sign-in.client-rejected` | `configuration_error` | the provider rejected the OAuth client |  |
| `sign-in.secret-without-id` | `configuration_error` | an OAuth client secret is set without its client id |  |
| `source-review.dedicated-review` | `validation_error` | decide a source review through the review of memories and facts |  |
| `source-review.evidence-required` | `validation_error` | a challenge cites 1–20 references that contradict it |  |
| `source-review.not-holding` | `validation_error` | the memory or fact no longer holds, so there is nothing to challenge |  |
| `source-review.reason-required` | `validation_error` | a challenge says why in 1–2000 characters |  |
| `source-review.suggestion-length` | `validation_error` | a suggestion with a challenge takes 1–2000 characters |  |
| `source.changes-too-many` | `invalid_response` | more changed since one sync than a round reads, and the provider does not list changes oldest first |  |
| `source.deletions-unchecked` | `permission_error` | the provider refused its deletions; sync --rescan finds them |  |
| `source.engine-missing` | `configuration_error` | reading this source needs a reader package that is not installed |  |
| `source.needs-sign-in` | `authentication_error` | the page asks for a sign-in; add a private Google document with drive documents add <url> --profiles <names\|all> |  |
| `source.no-account` | `invalid_response` | the provider's answer does not name the signed-in account |  |
| `source.no-id` | `invalid_response` | a row of the provider's answer has no id where the source manifest says |  |
| `source.no-text` | `validation_error` | the source holds no text to keep |  |
| `source.token-invalid` | `validation_error` | the change token is not one this source gave |  |
| `source.too-large` | `validation_error` | the source is larger than one read takes |  |
| `source.unreadable` | `validation_error` | the reader could not read the source |  |
| `source.unsupported` | `validation_error` | no reader takes this kind of source |  |
| `source.url-redirects` | `provider_error` | the page sent the request on too many times |  |
| `source.url-refused` | `validation_error` | the link is not an http or https page on the public internet |  |
| `source.url-status` | `provider_error` | the page's server answered with an error status |  |
| `source.url-timeout` | `timeout` | the page did not arrive in time |  |
| `source.url-unreachable` | `network_error` | the page's server could not be found or reached |  |
| `spreadsheet.unreadable` | `validation_error` | the workbook could not be read |  |
| `sql.bad-identifier` | `validation_error` | a table or column name is not a plain identifier |  |
| `sql.library-missing` | `configuration_error` | this database needs the mysql2 or pg package in the CLI |  |
| `ssh.forward-failed` | `network_error` | the SSH server could not reach the address behind it |  |
| `ssh.forward-refused` | `permission_error` | the SSH server does not allow forwarding to that address |  |
| `stage.answer-invalid` | `validation_error` | the agent's answer to stages suggest is not the JSON stage map it asks for |  |
| `stage.base-field` | `validation_error` | a base stage needs a name its set has once and a position within the set |  |
| `stage.base-in-use` | `validation_error` | the owner's own deals or leads stand or stood in that base stage |  |
| `stage.base-outcome` | `validation_error` | a base set keeps at least one stage of each outcome: open, won and lost |  |
| `stage.choice-required` | `validation_error` | more than one stage of the row's pipeline maps to that base stage; move to one of the candidates |  |
| `stage.model-agent` | `permission_error` | an agent's run does not send stages to the AI model; it answers the task itself with --dry-run and --text-file |  |
| `stage.model-answer-invalid` | `invalid_response` | the AI model's answer to stages suggest is not the stage map |  |
| `stage.not-found` | `not_found` | no stored stage has that reference or name |  |
| `stage.owner-only` | `permission_error` | only the owner confirms mappings and edits a base set, not an agent |  |
| `stage.ref` | `validation_error` | a stage is named by its stage:<id> reference |  |
| `stage.unmapped` | `validation_error` | no stage of the row's pipeline maps to that base stage; map one first |  |
| `state.invalid` | `configuration_error` | the saved sync state is unreadable or invalid; it is kept, not reset |  |
| `state.unreadable` | `configuration_error` | a sync state file cannot be read; move it away and sync again |  |
| `stemmer.invalid` | `validation_error` | the stemmer is not valid for that script |  |
| `stemmer.newer` | `validation_error` | the stems were built by a newer tool |  |
| `stemmer.unknown` | `validation_error` | the store asks for stemmers this tool does not know |  |
| `store.changed-during-recovery` | `validation_error` | the store was written to during the recovery, so it was left as it was |  |
| `store.damaged` | `configuration_error` | the store file is damaged; store recover says what is lost and recovers it |  |
| `store.dry-run` | `conflict` | a dry run of an import holds the store; the read or write waits for it to end |  |
| `store.file-damaged` | `validation_error` | the named store file is damaged or not a database |  |
| `store.foreign-keys` | `configuration_error` | a migration would break references between rows, so it was not run; the store is whole |  |
| `store.in-use` | `validation_error` | a process or a scheduled timer has the store open; stop it, then recover the store |  |
| `store.journal-replaced` | `conflict` | another program deleted or replaced the store's journal file while it was open; store recover says what to do |  |
| `store.not-writable` | `permission_error` | the message store cannot be written from this process |  |
| `store.recovering` | `validation_error` | another recovery of the store is running; wait for it to finish |  |
| `store.recovery-failed` | `validation_error` | the recovered store did not pass its check, so the store was left as it was |  |
| `store.refused` | `validation_error` | the local store refused the document text |  |
| `store.rows-break-checks` | `configuration_error` | the store holds rows the new schema refuses, so it was not migrated; the rows are named |  |
| `store.rows-lost` | `configuration_error` | a migration would change how many rows a table holds, so it was not run; the tables and counts are named |  |
| `store.sqlite3-missing` | `configuration_error` | recovering the store needs the sqlite3 program, 3.43 or newer, with its .recover command |  |
| `store.unknown-columns` | `configuration_error` | a migration would drop columns this store has and this build does not know; nothing was changed |  |
| `store.unopenable` | `configuration_error` | the store file cannot be opened at its path; details.path names it |  |
| `store.unreadable` | `configuration_error` | the store file's header or schema is damaged, so it cannot be recovered |  |
| `store.vector-extension-failed` | `configuration_error` | the sqlite-vec extension did not load; reinstall the CLI |  |
| `store.vector-extension-missing` | `configuration_error` | the install has no sqlite-vec extension for this platform; reinstall the CLI |  |
| `store.vector-invalid` | `validation_error` | a vector to store had a non-finite value |  |
| `subscription.field` | `validation_error` | a field of the subscription is not valid |  |
| `subscription.interval` | `validation_error` | an interval is a count and a unit, such as 1-month |  |
| `subscription.no-price` | `not_found` | no stored subscription price has that id |  |
| `subscription.price` | `validation_error` | a price is never changed: reject it and add a new one, after its subscription |  |
| `subscription.ref` | `validation_error` | the reference names no subscription, product or contract for it |  |
| `sync.failed` | `provider_error` | the sync failed; the answer comes from what the store already holds |  |
| `sync.partial` | `provider_error` | some sources did not sync; the next sync retries them |  |
| `tag-review.over-budget` | `validation_error` | the tag review is over its budget |  |
| `tag-review.required` | `validation_error` | the tag needs the owner's review first |  |
| `tag-review.stale` | `configuration_error` | the tag review changed meanwhile |  |
| `tag.invalid` | `validation_error` | the tag is not valid |  |
| `task.already-read` | `validation_error` | the message was already read for tasks: a read again only updates and closes tasks unless --open-new |  |
| `task.category-unknown` | `validation_error` | the category is not in the task category list |  |
| `task.certainty-required` | `validation_error` | an agent closes a task with its certainty, 0 to 1 |  |
| `task.claimed` | `validation_error` | someone else holds the task |  |
| `task.closed` | `validation_error` | the task is already closed |  |
| `task.column` | `validation_error` | the task beside which it moves is in another column than the status asked for |  |
| `task.dependency-cycle` | `validation_error` | the task would depend on itself |  |
| `task.duplicate-candidates` | `validation_error` | open tasks may be the same job: attach to one, or add it as new |  |
| `task.external-id` | `validation_error` | an external id is <service>:<id>, such as avito:4512345678 |  |
| `task.is-subtask` | `validation_error` | a subtask moves to another project alone only when it is detached from its parent in the same write |  |
| `task.merged` | `validation_error` | the task was merged into another; use that one |  |
| `task.no-close-suggestion` | `validation_error` | the task has no agent's close waiting on the owner |  |
| `task.not-merged` | `validation_error` | the task was not merged into another |  |
| `task.pair-decided` | `permission_error` | the owner already decided the pair; an agent does not change it |  |
| `task.source-url` | `validation_error` | a task's source URL is not an http or https address |  |
| `task.stale` | `conflict` | the task changed since it was read; read it again |  |
| `template.check-failed` | `validation_error` | the template failed its check and was not saved; the message says why |  |
| `template.no-editor` | `validation_error` | no editor is set: set VISUAL or EDITOR, or pass the template with --file |  |
| `template.no-history` | `validation_error` | the template has no earlier body to put back |  |
| `template.no-renderer` | `validation_error` | nothing renders that template key yet, so a template for it cannot be checked |  |
| `template.owner-only` | `permission_error` | only the owner changes a message template, not an agent |  |
| `template.unknown-key` | `validation_error` | there is no message template by that key |  |
| `template.unknown-language` | `validation_error` | cli-core ships no template in that language, so one would never be used |  |
| `topic.owner-only` | `permission_error` | only the owner may use this topic |  |
| `tracker.field` | `validation_error` | a field of an issue or a comment the tracker's write does not take as given |  |
| `tracker.kind-unread` | `permission_error` | the sign-in cannot read this kind of the tracker; the copy has none of it |  |
| `tracker.no-record` | `invalid_response` | the tracker answered a write with no record and no error; sync and look |  |
| `tracker.reference` | `validation_error` | a team, state, label, project or user no single row of the copy has by that name |  |
| `tracker.team-required` | `validation_error` | a new issue needs its team: name one, or sync a copy that holds one |  |
| `tracker.unlisted-held` | `validation_error` | a tracker's id list would mark too much deleted, or the sign-in read only part; nothing was |  |
| `tracker.write-unsupported` | `validation_error` | the tracker does not take this write, or does not recognise a repeated one |  |
| `transaction.field` | `validation_error` | a field of the transaction is not valid |  |
| `transaction.no-split` | `not_found` | the transaction has no split at that position |  |
| `transaction.payment` | `validation_error` | the payment is not the same money: currency, direction and amount differ |  |
| `transaction.ref` | `validation_error` | the reference names no transaction or wallet |  |
| `transaction.split` | `validation_error` | the splits come to more than the transaction, or name no category |  |
| `transcription.no-key` | `authentication_error` | no OpenAI key is set for transcription |  |
| `transcription.quota-exhausted` | `permission_error` | the transcription provider account has no credit or limit left |  |
| `transcription.too-large` | `validation_error` | the audio is over the transcription provider's size limit |  |
| `upgrade.install-failed` | `provider_error` | the installer failed; the old version stays |  |
| `upload.mismatch` | `conflict` | the uploaded file reads back with other content; the local file changed meanwhile |  |
| `upload.replace-interrupted` | `conflict` | another file took the path during a replace; the new content is kept |  |
| `usage.unknown-command` | `validation_error` | no command by this name; the CLI's help lists them |  |
| `usage.unknown-option` | `validation_error` | the command takes no option by this name; its help lists them |  |
| `verify.no-id` | `provider_error` | the answer to the sign-in check holds no account id where auth.verify says |  |
| `vocabulary.alias-conflict` | `configuration_error` | two vocabulary entries claim one alias |  |
| `vocabulary.consolidation-over-budget` | `validation_error` | the selected tag dependencies exceed the preview budget | `table` |
| `vocabulary.over-byte-budget` | `validation_error` | the vocabulary is over its size budget |  |
| `vocabulary.over-entry-budget` | `validation_error` | the vocabulary has too many entries |  |
| `vocabulary.stale` | `configuration_error` | the vocabulary changed meanwhile |  |
| `wallet.field` | `validation_error` | a field of the wallet is not valid |  |
| `wallet.number` | `validation_error` | a wallet keeps only the last 4 characters of a number |  |
| `wallet.ref` | `validation_error` | the reference names no wallet |  |

<!-- reasons: end -->
