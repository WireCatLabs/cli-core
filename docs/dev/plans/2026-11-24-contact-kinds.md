# Plan: who sent it and how it reached you

Status: draft for review. Steps 1 to 5 are built, step 3 in a first form (below); the rest is not. It answers the RFC in
[#3314](https://github.com/WireCatLabs/cli-core/issues/3314) and replaces its proposal.

## The problem

Every person in the store gets one kind: `person`, `organization`, `automated`, `stranger`, `unsorted` (and `test`)
([`domain/person-kinds.ts`](../../../src/domain/person-kinds.ts), rules in `kindOf` in
[`store/sqlite/people-list.ts`](../../../src/store/sqlite/people-list.ts)). WireCat Desktop shows one tab per kind.

One kind answers three different questions at once:

1. **Who sent it?** A person, a program, or a company's shared mailbox.
2. **How did it reach you?** Written to you, written in a group you are in, or sent to a list of subscribers.
3. **Do you know them?** You wrote to them, met them, keep them in your phone book.

Because one answer has to win, the wrong one often does. What users see:

- **Service mail under Strangers.** A bank's statements or a service's alerts from an address like
  `noreply-12345@bank.example` or `alerts@service.example`. The no-reply check needs the whole local part to be a
  no-reply word, so these pass as people with no tie.
- **The owner and close contacts under Strangers.** The owner's second address is not known as the owner. Mail sent
  from an alias, and all mail of an IMAP account, is not seen as sent by the owner, so the people the owner writes to
  get no tie.
- **Newsletters in merge review.** A newsletter that sends from `author+topic1@newsletter.example`,
  `author+topic2@…` becomes one person per address. They share a name and a domain, so the name-match scan proposes
  every pair as "may be the same person".
- **A tab of dead rows.** Unsorted holds deleted accounts and rows with no name, which the owner can do nothing with.

The four bugs have their own issues and are fixed before this plan:
[#3319](https://github.com/WireCatLabs/cli-core/issues/3319) (no-reply by any part of the address),
[#3320](https://github.com/WireCatLabs/cli-core/issues/3320) (no bots or automated senders in name matches),
[#3321](https://github.com/WireCatLabs/cli-core/issues/3321) (the owner's aliases),
[#3322](https://github.com/WireCatLabs/cli-core/issues/3322) (IMAP Sent folder).

## The model: bots apart from people, then two answers

**Who writes is an entity, not a field.** An identity (an address, a messenger account) belongs to one of three:

| Entity | Table | What it is |
|---|---|---|
| Person | `persons` (as today) | A human. |
| Bot | `bots` (new) | A program: no-reply and alert addresses, 2FA codes, receipts, a messenger bot, a company's marketing mail. |
| Organization | `organizations` (as today) | A company. Its shared mailboxes (`info@`, `support@`) and its bots belong to it. |

Why a separate entity: as long as a bot is a person with a mark, every list, every merge scan and every tie check
has to remember to skip it, and each one that forgets is a bug (#3320 was one). A bot in its own table cannot be
proposed as "the same person", cannot be a task's assignee and never counts as someone the owner knows.

A bot has a name, its identities and an optional organization. It has no ties, no tasks and no merge review: two
bots of one organization are grouped under it, not merged.

**Built so far (#3339, store version 74, and #3356, store version 75).** A bot is its own entity with the ref
`sender-bot:<id>` (`bot:` already names AI agents in the store; open question 7). It holds its identities in
`sender_bot_identities`, so an identity belongs to one person or one bot. It has a name, identities and an optional
organization (the domain rule of #3347 files it there), no ties, tasks or merge review, and never appears in
`people.list`, its counts, similar people or ties. Messages and mail still point at the identity. The person row a
bot emptied stays hidden, so a move back gives its uid back. `people.listBots` and `people.showBot` read bots;
`moveToBot` and `moveToPerson` move a person, a bot or one identity with its whole history, logged in
`sender_bot_moves`, and the owner's choice wins. `minCompatible` stays 73: triggers keep cli-core 1.0.0 builds from
linking a bot's identity to a person. Not built: memo `bots` commands, the Desktop view, a bot sender's `ref` in mail
fields, and mention, tracker and author lookups for bot identities.

**Moving between entities.** A rule can be wrong, so an identity can move from a person to a bot and back. Its
messages stay where they are (they point at the identity), the move is logged, and the owner's choice always wins
over the rules.

**Two answers on every person and bot:**

| Field | Values | Meaning |
|---|---|---|
| `reach` | `direct` · `group` · `broadcast` | How their messages reached the owner, the widest the owner gets most. `direct`: to the owner, or a small group. `group`: a large chat or a discussion list where everyone can write. `broadcast`: one sender to many readers who cannot answer in place: a newsletter, a channel, marketing mail. |
| `tie` | yes · no | The owner knows them: the ties `person-ties.ts` already works out. Always no for a bot. |

`reach` also weighs search: a `direct` hit ranks above a `broadcast` one in `search all`, and `broadcast` mail never
feeds `tie`. For that it is worked out per message, not only per sender (review on #3323).

Data quality is not a kind. These become marks on the row: `owner`, `incomplete` (no name, or a deleted account),
`test`.

**A sender who only sends a newsletter is a bot**, even when a human writes it (owner, 2026-11-25, replacing the
earlier ruling that it stays a person; review on #3323). Once there is a direct exchange (the owner writes to that
address, or a 1-to-1 mail arrives), the identity moves to a person and only its newsletter mails keep reach
`broadcast`. A company's newsletter sent through a mailing service is a bot.

### What the screen shows

A tab is a filtered view, not a table (owner, 2026-11-25). How rows are stored never decides what a tab may show:
Subscriptions can list any mail under any filter. A mail gets its own category, apart from its sender, so one shop's
receipts and promotions land in different places. Rules and the owner's corrections work on two levels, the address
and the domain: a person rarely writes from a newsletter address, but may write from the same domain.

Contacts has three tabs and answers "who is this" (owner, 2026-11-25, NEED-118 B, from the review on #3323). Each
sender appears once:

| Tab | Who | Filters inside |
|---|---|---|
| **People** | persons | Known (tie) · Not known (no tie, today's Strangers) · reach `group` |
| **Bots** | bots | Alerts and codes · Receipts · Newsletters · Marketing · Messenger bots |
| **Organizations** | the `organizations` table | Its people, shared mailboxes and bots, grouped under it |

**Subscriptions is a view beside mail, not a Contacts tab.** It answers "what is sent to me and what do I leave":
mail and channels with reach `broadcast`, grouped by list (`List-Id`, else the sender), with the count of mails, the
newest one and the unsubscribe action, as HEY's Feed does. A shop is one bot in Contacts, under its organization, and
its promotions show in Subscriptions. It is built from the per-mail types and reach of #3358
(`store.mail.mailSenders`), with no table of its own.

`incomplete` rows are a filter on every tab ("Show incomplete"), off by default. Today's `kind` stays on
`people.list` while memo and Desktop move: a bot is listed as `automated`, worked out from the new tables.

## How a sender is sorted

Only local, deterministic rules. The owner's choice always wins and applies to the sender's whole history, past
and future, the way a mail client's "always put this sender in…" does.

Signals, strongest first:

The signals decide the entity (person, bot or an organization's shared mailbox) and the reach.

1. **The owner chose.** "This is a person" or "this is a bot", set by hand.
2. **The platform says so.** Telegram `user.bot`, `user.support`, `user.deleted`
   ([constructor/user](https://core.telegram.org/constructor/user)); Slack `is_bot`, `profile.bot_id`
   ([user object](https://docs.slack.dev/reference/objects/user-object)); Discord `bot`, `system`
   ([user](https://docs.discord.com/developers/resources/user)). Stored today as `identities.bot`.
3. **The owner wrote to them.** Mail from any of the owner's addresses
   ([#3321](https://github.com/WireCatLabs/cli-core/issues/3321)), a one-to-one chat the owner wrote in. This makes
   a `tie` and `direct` reach, and keeps the identity a person against header guesses (not against the platform
   flag).
4. **Mail headers that mark a program.** `Auto-Submitted` other than `no`
   ([RFC 3834](https://www.rfc-editor.org/rfc/rfc3834)), an empty return path, `MAILER-DAEMON` → `bot`.
5. **Mail headers that mark a list.** `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
   ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058); Gmail requires it from senders of more than 5,000 mails a
   day, [Google](https://support.google.com/a/answer/81126)), `List-Unsubscribe`
   ([RFC 2369](https://www.rfc-editor.org/rfc/rfc2369)), `Feedback-ID`
   ([Google](https://support.google.com/mail/answer/6254652)) → `broadcast`. `List-Id`
   ([RFC 2919](https://www.rfc-editor.org/rfc/rfc2919)) with replies from many senders → `group`, with one sender →
   `broadcast`.
6. **Where the owner is on the message.** The owner's address in no `To` or `Cc` (Bcc, undisclosed recipients, a
   list) → not `direct`. In `To` with few others → `direct`.
7. **The chat type.** A Telegram channel (`broadcast` flag,
   [constructor/channel](https://core.telegram.org/constructor/channel)) → `broadcast`. A group of more than
   `SMALL_GROUP_MEMBERS` → `group`.
8. **The address.** No-reply words in any part of the local part
   ([#3319](https://github.com/WireCatLabs/cli-core/issues/3319)) → `bot`. Role words (`info`, `support`, `billing`)
   → `organization`.
9. **The name.** Legal forms and company words (today's `isCompanyName`) → `organization`. Notification words
   (today's `isAutomatedName`) → `bot`.
10. **The domain.** See the next section.

**Header trust.** The sender sets every header. A header counts only when the receiving server's
`Authentication-Results` shows a DKIM signature that passed and covers it. A missing header proves nothing.

### Grouping under an organization

A bot or a shared mailbox joins the organization of its registrable domain, worked out with the
[Public Suffix List](https://publicsuffix.org/list/) (`mail.bank.example` and `bank.example` are one domain). This
is automatic and never goes to merge review. Three exceptions:

- **Free mail** (`gmail.com`, `outlook.com`; today's `FREE_MAIL`): never an organization.
- **Sending platforms** (newsletter hosts and mail services that send for many customers): group by `List-Id`, or by
  display name within the platform, never by the platform's domain. Otherwise every newsletter on one host becomes
  one sender.
- **People** at a company domain are linked to the organization as members (`member-of`), not merged.

### Domain lists

A domain list can also give an organization its purpose: bank, shop, airline, news, government. This becomes a
`sector` on the organization (`category` already means client, supplier or partner), and a filter on the Bots and
Organizations tabs.

Only lists downloaded whole and matched on the owner's computer qualify. A lookup per sender (a DNS blocklist, a
category API) tells a third party who writes to the owner. Checked on 2026-11-24:

| Source | Gives | Licence | Use |
|---|---|---|---|
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Database_download) | Banks, airlines, companies, media, government with their official website ([P856](https://www.wikidata.org/wiki/Property:P856)): about 4,000 banks and 2,800 airlines with a website | CC0 | Extract `domain → category` from the dump at release; the best-ranked home page (bare domain or `www`) with no end date |
| [UT1 lists](https://github.com/olbat/ut1-blacklists) | `bank`, `financial`, `shopping`, `press`, `social_networks`, `webmail` domain lists | CC BY-SA 4.0 | Ship as a separate file with credit, never merged into our data, so share-alike stays on that file |
| [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) | Throwaway mail domains | CC0 | With `FREE_MAIL`: never an organization |
| [Public Suffix List](https://publicsuffix.org/list/) | Registrable domains | MPL 2.0 | Grouping under an organization |
| Our own table | Sending platforms and newsletter hosts | ours | Checked against each vendor's docs; no curated list exists |

Not used:

- **Cloudflare domain categories, Cisco Umbrella, Klazify:** lookups per domain, and Cloudflare Radar data is
  non-commercial ([CC BY-NC](https://developers.cloudflare.com/radar/)).
- **Spamhaus, SURBL, URIBL:** they mark spam, not banks or shops, and their free use excludes commercial products
  ([Spamhaus terms](https://www.spamhaus.org/organization/dnsblusage/), [SURBL policy](https://www.surbl.org/usage-policy)).
- **Tranco and other top-site lists:** popularity, not purpose.

A domain names the organization, not the sender. A person at `bank.example` is a member of the bank, not a
bot. Mail sent through a sending platform never takes the platform's category. So the domain is the last signal,
after the headers and the address, and it is matched on both the `From` domain and the DKIM signing domain.

### Mail categories

Every mail gets a type of its own; the sender gets a sector. A card payment works the same way: the shop's merchant
code says what the shop is, the bank's category says what the payment was. Research:
[mail products](2026-11-25-contact-kinds-mail-products.md), [domain sources](2026-11-25-contact-kinds-domain-sources.md).

- **Type, per mail**, first match wins: bounce or auto-reply, security (codes, sign-in alerts), calendar, travel,
  ticket, order, shipping, bill, account notice, social notification, discussion list, newsletter, promotion, system
  alert, personal, other. Signals are already in the mail: `Auto-Submitted`, `List-Id`, `List-Unsubscribe-Post`,
  `Feedback-ID`, schema.org markup (Order, ParcelDelivery, FlightReservation, Invoice), a calendar or report part,
  and whether the owner wrote to the sender. Zero's header classifier (MIT, 82 lines) is the model to port.
- **The sender's view is a summary of its mails.** A shop that sends receipts and promotions appears under Bots and
  under Subscriptions; `reach` is worked out per mail too.
- **Rules in a fixed order:** one mail, then a list or a subject pattern, then the address, then the domain, then the
  header classifier. The owner's rule beats a rule's guess; within a level the newest wins. A domain rule on a free-mail
  domain (`gmail.com`) is allowed, since the owner sometimes needs it (owner, 2026-11-25), but it is never made by
  accident: a correction of one mail or address never widens to a free-mail domain on its own, the domain scope is
  not offered first for such a domain, and setting it shows how many addresses and mails it touches before it
  applies. HEY refuses such rules outright.
- **A correction asks its scope:** this mail, this address, this domain or this list, and whether to apply it to past
  mail (Outlook's "Move" and "Always move").
- **Built in #3358 (store version 76):** every email has `mailType`, `reach` and `typeSignal`, cleared by triggers;
  since 2026-11-27 each save types its mail and mail sync types what an upgrade left untyped; `store.mail.emails({ types, reaches })` filters and `store.mail.mailSenders` sums a sender's
  mail by type and reach. Two changes to the order above: `system_alert` before `account_notice`, and an automated
  address with a plain unsubscribe link is `account_notice`, not `promotion`. Not yet stored by mail sync: schema.org
  markup (no HTML kept), `Auto-Submitted: auto-replied`, `List-Post`, the calendar method.
- **Built in #3366 (store version 77):** `store.mail.sorting` with `add` (dry run and a `confirm` code, required for
  a free-mail domain, owner only there), `rules`, `scopes`, `remove`, `undo` and `reset`; a rule sets a mail type,
  moves a sender to a bot or a person through `moveToBot`/`moveToPerson`, or files it under an organization; a typed
  mail says `typeSignal: "rule:<id>"`. Follow-up: the owner's rules win across levels, and a removed rule puts senders
  back with their earlier author (#3369).
- **Built in #3372:** `type:` and `reach:` fields in mail search (`memo search mail 'type:order OR type:bill'`).
- **Built in #3379:** `store.mail.subscriptions` groups mail by list (`List-Id`, else the sender) with its count, last
  mail and unsubscribe targets, kept only under a passed DKIM signature of the `From` domain. No store version: the
  targets live in the stored headers. `people.listBots({ sends })` filters bots by what they send (`BOT_SENDS`).
- **Screening first-time senders**, as HEY does, only for people the owner has never written to. Later step.

The domain lists above grow from the catalogue: UT1 (about 100 categories), the OpenStreetMap brand index, FDIC
banks, the GLEIF bank codes joined to Wikidata, a free-mail list. Spam lists say "bad", never a sector, and many are
non-commercial or work only as a lookup per sender, which this plan rules out. Distribution: a small core in the
package, a versioned data pack from a WireCat release fetched by a command for larger and share-alike lists, so data
updates without a package release. Decided by the owner, open questions 4 and 6. Built in #3359 and
#3362: `domain-lists update [--commercial-only]` fetches the pack from the `domain-lists` GitHub release (first pack
2026-11-25: UT1 sectors and webmail, UT1 malware hosts, FDIC banks; Stop Forum Spam fetched from its source, since it
may not be redistributed), published weekly by `.github/workflows/domain-lists.yml`. Webmail domains never make an
organization. Nothing reads the bad lists yet; no source yet for travel, health, education, utility, insurance or
software.

## Out of scope

- **AI classification.** Sorting by a model is planned as a separate command with its own plan. This plan keeps the
  rules local and deterministic, so they work without a model and give the AI command a clean start.
- **Usage data.** No telemetry, by decision.

## Order of work

1. The four bugs: #3319, #3320, #3321, #3322 (#3319, #3320, #3322 merged; #3321 waits on mail-cli).
2. Signals with no store change: mail sync reads `Auto-Submitted`, `List-Unsubscribe-Post` and `Feedback-ID` into the
   stored headers (today [`mail/headers.ts`](../../../src/mail/headers.ts) reads `LIST-ID`, `LIST-UNSUBSCRIBE`,
   `PRECEDENCE`), trusted only under a passed DKIM signature of the `From` domain; `reach` is worked out from
   `email_recipients` for the page a list returns. Strong program signals already feed today's `automated`. Built
   in #3334.
3. Store: the `bots` table, `identities` pointing at a person or a bot, the move log, and `reach` and the marks kept
   like `kind` today (lazily, cleared by triggers). Identities that today make a person `automated` move to bots.
   Built in #3339 (store version 74) and split fully in #3356 (store version 75).
4. The owner's choice: move an identity to a person or a bot, for its whole history. Built in #3339 as
   `PeopleStore.moveToBot` and `moveToPerson`; memo has no command for it yet.
5. Organizations from domains, with the three exceptions above (built in #3347: `From` domain only, no `List-Id`
   grouping yet), then their sector from the domain lists (built in #3350 from Wikidata only, as `sector` in the
   organization's metadata: `category` already means client, supplier or partner; UT1 came later in the data pack of
   #3359; DKIM signing domain not matched yet). #3349 made the throwaway-domain check one prebuilt set.
6. memo: `bots list`, and `people list` filters `reach:`, `tie:`. `bots list` and `bots show` built in memo#899
   (memo 0.154.0). `memo mail subscriptions list` and `bots list type:<sends>` wait in memo#902 for a cli-core release.
   #3370 made a newsletter-only sender a bot, a human author too.
7. Desktop: three Contacts tabs and a Subscriptions view beside mail, with their filters; this closes
   [desktop#319](https://github.com/WireCatLabs/wirecat-desktop/issues/319) (bot filter) and touches
   [desktop#320](https://github.com/WireCatLabs/wirecat-desktop/issues/320) (filters). The public page
   `content/docs/desktop/contacts.mdx` in cli-docs and its RU and ES copies change with it. The three tabs are built
   in desktop#482, read through memo. The Subscriptions view waits for memo#902.

## Open questions

1. ~~Tab names.~~ Decided (owner, 2026-11-25, NEED-118 B): Contacts has People, Bots and Organizations
   (RU: Люди / Боты / Организации); Subscriptions (Подписки) is a view beside mail.
2. **Reach of a mixed sender.** Someone who writes to the owner directly and also sends a newsletter: one sender with
   reach `direct`, or two senders split by address? Answer (owner, 2026-11-25): one person, `reach` per mail. A person
   rarely writes from a newsletter address, so rules work by address first and by domain second.
3. **Discussion lists.** A mailing list where people answer each other: are its members People (reach `group`) or
   one Subscription? Until answered: a `List-Id` with three or more distinct senders is `group`.
4. **Where the domain lists live.** Built into the package at release (no network at run time), or downloaded once by
   a `models`-style command the owner runs? Answer (owner, 2026-11-25): both. A small permissive core stays in the
   package (Wikidata sectors, the Public Suffix List, free-mail and throwaway-mail lists). Larger, often updated and
   share-alike lists (UT1, spam lists) ship as a versioned data pack on a WireCat GitHub release, fetched and updated
   by a command, with a checksum and a licence per source.
5. ~~The full split of bots.~~ Decided (owner, 2026-11-25): a bot is its own entity with its own table and `bot:`
   reference; the person-anchored form of #3339 is replaced.
6. **Paid product.** Will WireCat ever be sold? If so, non-commercial lists (Stop Forum Spam, DuckDuckGo Tracker
   Radar, abuse.ch for commercial use) are out now. Answer (owner, 2026-11-25): WireCat stays free and paid services
   are built around it, so non-commercial lists may be used by WireCat but never by a paid service. Each such list is
   marked in the data pack, and its own terms are checked for how they define commercial use.
7. ~~A bot's ref.~~ Decided (owner, 2026-11-25): `bot:<id>`. The AI agents' ref that holds `bot:` today is renamed
   (to `agent:`), and `sender-bot:` stays readable as an alias. Built in #3374, not merged: older builds read the
   renamed agent rows wrongly, so it needs a store version every tool must reach first, and when it ships is the
   owner's call.
