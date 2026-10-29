# Mentions — how they work

What is built today. The user guide is [mentions.md](../mentions.md); the design, the decisions and what comes next
are in the [plan](mentions-plan.md); the columns are in [schema.md](../storage/schema.md#mentions).

A mention is a value found in one place of one stored text, normalized, with a status. It is **derived**: every
row can be found again from the text, except the decision on it, which is carried across rebuilds.

Not to be confused with `messages.mentions`: the people a messenger itself says a message mentions (an `@handle`).
That column comes from the provider; the `mentions` table comes from our rules.

## Where the code is

| file | what |
| --- | --- |
| `src/domain/mentions.ts` | the rules for `phone`, `email`, `url`, `document`; `MENTION_KINDS`, `MENTION_VERSIONS`, `siteOf` |
| `src/domain/phones.ts` | `phone_countries`: the country plans, reading a national number (`nationalPhone`) |
| `scripts/phone-plans.ts` | writes the country table from libphonenumber-js (a dev dependency only) |
| `src/domain/person-names.ts` | `person-name`: the name index, Latin → Cyrillic, matching by stem or written form; unknown names (`findUnknownNames`) |
| `src/domain/first-names.ts` | the first names an unknown name is checked against, and those that are also words |
| `src/domain/places.ts` | `place`: street addresses by their grammar (`findPlaces`) |
| `src/store/sqlite/phone-countries.ts` | the setting in `store_settings`, and `valueMatch` for `phone:` and `value:` |
| `src/store/sqlite/mention-drain.ts` | the writer and the queue drain |
| `src/store/sqlite/mentions.ts` | `rebuildMentions`, list, show, confirm, reject, `newMentions`; `MENTION_QUERY` |
| `src/cli/messenger/mention-points.ts` | where `mentions list --new` stopped, per profile |
| `src/store/sqlite/lucene.ts` | the search fields `phone:` `email:` `domain:` `mentions:`; `url:` and `link:` in `mention-links.ts` |
| `src/services/mentions.ts` | the service the commands call; `domains` groups the account's links by site |
| `src/cli/messenger/mentions-command.ts` | `mentions list|domains|places|show|confirm|reject|rebuild` |
| `src/cli/author.ts` | who decided: the agent from `AI_AGENT`/`CLAUDECODE`, else the owner, `--as-owner` |

## Tables

- `mentions` — one row per kind per place: `(source_type, source_id, source_field, start_offset, kind)` is unique.
  `source_type` is `message`, `attachment`, `document`, `note` or `email`; `source_field` is `text`, `file_text`, `contact` (a shared contact card's phone) or
  `transcript`. Offsets are
  UTF-16, as JavaScript counts them. The written spelling is not copied; it is read back from the source.
- `mention_pending` — texts written or edited since their mentions were found. Triggers on `messages` and
  `attachments` fill it; JavaScript empties it.
- `store_settings.mentionsRebuiltAt` — when a full rebuild last ran. `mentions list` says so while it is null:
  messages stored before mentions existed are not read yet.
- `identities` with `provider` `phone` or `email` — made only when a number or an address gets an owner.
  `identity_links` gives it a person, `organization_identities` an organization.
- `places` — a confirmed street address: `folded` is the mentions' `value`, `address` what was written where it
  was confirmed. A `place` mention whose value is a place starts `linked`.

Store versions: 7 added the tables, 10 the attachment sources, 11 `organization_identities`, 16 documents (`body`),
notes (`body`) and mail (`body_text`, not the subject) as sources, 18 `places`. Those have no chat, so a name in them is never
linked by rule; `mentions list` and `show` read message sources only, and mail search (`search mail` in memo) finds
an email by `phone:`, `email:`, `url:`, `domain:` and `mentions:`. Each migration only
adds; older builds keep reading the store.

## The flow

1. A store write (sync, watch, an edit) changes a message or an attachment's text. A trigger queues it in
   `mention_pending`.
2. In the same transaction, `drainMentions` reads up to 500 queued texts and runs the writer on each.
3. The writer, for one source:
   - keeps the decisions made there by a person or an agent (status not `found`, author not `rules`);
   - deletes the source's rows **of the kinds this build knows**, and only those, so an older build that reads the
     text again does not drop a newer build's kinds;
   - finds the mentions and inserts each with its decision: the kept one, else the rule's own, else the value's
     original (below), else `found`.
4. A deleted message, attachment, document, note or email row takes its mentions and its queue entry with it (a
   trigger); a soft delete of a document, note or email queues it, and the writer finds nothing to keep.
5. `mentions rebuild [kind]` runs the same writer over every message and attachment text, 1,000 per short write
   transaction, with progress. With a kind it redoes that kind only and leaves the queue and `mentionsRebuiltAt`
   alone.

**The original of a value.** A value starts as `dismissed` when it is dismissed anywhere, as `linked` to an
identity when a phone or an address has one with an owner, as `linked` to a document when a document id is a
stored Drive file (`documents.front_matter.fileId`), as `linked` to a chat or a Telegram account when a `t.me`
link names a stored one (`telegramTarget`, `telegramLink`: `t.me/<username>` by `chats.username` then
`identities.username`, `t.me/c/<id>` by the chat id `-100<id>`; invites and sticker links name nothing). All have
the author `rules`. Few chats hold a username yet: it is saved when a chat's details are read.

**Links in mail.** A link in an email with a query string or a long opaque token (24+ of `[A-Za-z0-9_-]`) is a
tracking redirect nearly always: one letter each, hundreds of thousands per mailbox. The writer keeps one row per
letter and origin, with the origin as its value (`oneTrackedLinkPerSite`); offsets point at the first such link, so
`written` shows it as sent. Other texts keep every link. Search reads the letter's text for the rest (below).

**Decisions.** `confirm` and `reject` of a `phone`, `email`, `url` or `document` update every row with that kind
and value. A `person-name` is decided on its own row, and with `--all-in-chat` (`Decider.inChat`) also on every row of the same value in the same chat that is still `found` or decided only by the rules. Rules-authored decisions are not kept across a
rebuild; they are derived again, so a better rule can change them.

## The rules

| kind | how | confidence |
| --- | --- | --- |
| `email` | one pattern, lower-cased; `domain` from the public suffix list ([`psl`](https://github.com/lupomontero/psl)) | 0.95 |
| `url` | `http(s)://…`, or a bare domain with a listed suffix that does not look like code or a file name (`readme.md`, `items.parts[0]`); tracking parameters and the fragment dropped; `domain` from `psl` | 0.95 with a scheme, 0.9 with `www.`, 0.6 bare |
| `document` | a Google Docs, Sheets or Drive link inside a `url`; the value is the file id | 0.95 |
| `phone` | own rules over libphonenumber's numbering plans (`src/domain/phone-plans.generated.ts`, 47 countries): `+`/`00` is international; otherwise read in `phone_countries` (store-wide, default `ru`), grouped or named any valid number, bare only a mobile; dropped as a date, an IP, a sum or an order, invoice, tax or bank number. What fits no country is the digits alone | 0.9 / 0.7 / 0.5 |
| `person-name` | see below | known: 0.9 full name, 0.6 one word; unknown: 0.5 with a second name, 0.4 alone |
| `place` | a street word (ул., проспект, calle, C/, avda., rue, via, rua, ul., Straße, -straat, Street, Ave, Rd…) next to a capitalized name and a house number, before or after it. The span runs on, over the same line and the next lines of a signature when they hold a postcode or a country: flat (`кв.`, `3º B`, `piso`, `Flat`), postcode (GB, US, RU, NL, PL, PT, five digits), city, region and country, and back over `190000, г. …,` before a Russian street. The value is the street and house, then `, <city>` when the span or the part before a Russian street names one (not a region or a country), lower case with the street word in full; `places.address` keeps the whole span. A value with no city links by rule to the one confirmed place on its street; a place confirmed with a street-only key takes the city when `mentions rebuild place` reads its address again (`place-key.ts`, `rekeyPlace`) | 0.7 with a postcode, 0.5 without |

`MENTION_VERSIONS` holds a version per kind. Bump it when a kind's rule changes, so the rows say which rule found
them.

### Names

- **Who is looked for:** persons other than the owner who have a non-e-mail, non-bot identity (met in a
  messenger, a meeting, or a confirmed phone): the person's name, its identities' names, its aliases. E-mail-only
  persons are left out: in a mailbox they are mostly companies and mailing lists. An account's own identity (the
  account's provider and id) is the owner's: `saveAccount` links it, and whoever was linked with it, to the owner
  person (`linkOwnIdentities`); `contacts link <person> me` does it for an identity the account id does not name,
  a Zoom user.
- **Index:** every name word of three or more letters, by its Snowball stem (if the stem has two letters or more)
  and by its lower-case written form. A Latin word is also indexed in a rough Cyrillic spelling
  (`cyrillicOf`: Valery → валерий).
- **Matching:** a capitalized word of four or more letters. It matches by stem, or by its written form with up to
  three end letters cut. The second path exists because Snowball reads a surname's `-ов` as an ending:
  «Иванов» stems to `иван`, «Иванову» to `иванов`.
- **Full names:** two matching words, one space apart, that share a person are one mention of that person.
- **One word alone** counts only as a listed first name, a surname by its ending (Russian, or Latin `-ov`,
  `-sky`…), or a word of an alias the owner gave. A contact named «Smart Agents» is found as «Smart Agents», never
  as «Smart». Polite pronouns (Вы, Ваш, Вашей…) never count, and neither does a name after a saint's word or a
  Russian name in the prepositional case after «в»/«во», as for unknown names.
- **Rule link:** a name is linked to a person by the rules only when exactly one of its people wrote in that chat
  (`messages.sender_identity_id` → `identity_links`). One human can be a separate person per messenger until the
  rows are merged, so a name often fits several.
- `mentions show` returns them as `candidates`.
- **Unknown names** (`findUnknownNames`, after the known ones, so a known name keeps its place): a listed first
  name in any case (a Russian name with its final vowel dropped plus a case ending), a patronymic (`-ович`,
  `-евна`…), and beside them a Russian surname by its ending or a Latin second name. A listed name that is also a
  word (`NAME_WORDS`: Вера, Grace) counts only with a neighbour. They start `found`, with no candidates, and a
  rejected one does not dismiss the same name elsewhere.

## Search

`phone:`, `email:`, `url:` match `(kind, value)` after the same normalization as the rules; `domain:` matches
`domain` through `siteOf`. They skip dismissed rows. `mentions:"person:<id>"` matches linked rows only: a name
linked to that person, or a phone or an address whose identity is theirs; `organization:<id>` goes through
`organization_identities`; `document:<id>` through the target. Another type is `query.invalid-reference`. A
mention in an attachment finds its message. Mail search takes the same fields (store version 16).

`url:` and `link:` compile in `mention-links.ts`. `link:` matches a part of a stored link with `LIKE` (`%`, `_`
escaped), so only ASCII letters ignore case; the value must be quoted, since `?`, `/` and `=` are query syntax.
In mail a tracking link is stored as its origin (`trackedOrigin`), so a letter with a row of that origin is also
matched by its body: `instr` with the link as typed or normalized for `url:`, `LIKE` with the part for `link:`.
That check reads the whole body, so `link:` may find a part outside a link in a letter that has a tracking link.

## Review after a sync

`messages sync` counts the account's `found` mentions newer than the profile's review point and, when there are
any, names them in a note and in the `mentions.review` step (`mentions list --new`). `mentions list --new` lists
`found` mentions with `created_at` after the point and moves the point to the newest one shown, only when the answer
was not cut by `--limit`: rows come in message order, so a cut page could skip one found earlier. The point is a file
per profile (`<state>/mentions/<profile>.json`), one for the owner and an agent alike. `created_at` survives a
rebuild (the writer keeps it per kind and place), so a rebuild does not make old rows new. `serve` writes no answer
per sync and names nothing; its mentions show up on the next `--new`.

## Adding a kind

1. Add it to `MENTION_KINDS` and `MENTION_VERSIONS`, and its rule to `findMentions` (or a module of its own, as
   names are).
2. Decide whether it is decided per value (as a phone) or per row (as a name), in `decide`, and what `confirm`
   links it to.
3. Older builds keep the new kind's rows: the writer deletes only the kinds it knows.
4. Tests: a table of real spellings that must match, and texts that must yield nothing.

## Rules that hold

- No phone digits in a log, an error, a fixture, a test or a document. Tests use reserved fictional numbers.
- No model, and no outside service, by default.
- A migration only adds. Nothing that `mentions rebuild` can find again is copied anywhere else.
- Measurements on real stores go to [cli-testing](https://github.com/WireCatLabs/cli-testing) as totals only.

## Known limits

- Notes, documents and mail are read (store version 16) and listed by `store.sourceMentions` (mail only of the
  accounts the caller names), but memo has no `mentions` command yet; `mentions list` shows message sources only.
- A phone or an address in received mail is offered as its sender's (`candidates` in `show`), never linked by rule:
  most mail numbers are signatures, but a forwarded letter carries someone else's.
- A `url` is confirmed only to the stored Telegram chat or account it names; other links can only be rejected.
- Unknown names need a listed first name or a patronymic: an unlisted foreign name alone is missed. Words under
  four letters are skipped, so «Оля» or «Ира» are missed.
- Addresses need a street word and a house number: «у Казанского собора» or «Calle Mayor» alone are missed.
- Builds 0.264–0.270 delete a text's `person-name` rows when they read the text again; `mentions rebuild
  person-name` with a newer build finds them again.
