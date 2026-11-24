# Plan: who sent it and how it reached you

Status: draft for review. Nothing here is built. It answers the RFC in
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

## The model: three answers instead of one kind

Each sender (a person in the store) gets three answers, each from its own signals.

| Field | Values | Meaning |
|---|---|---|
| `sender` | `human` · `bot` · `organization` | Who writes. `bot`: a program writes (no-reply, alerts, 2FA codes, a messenger bot). `organization`: a shared mailbox people answer (`info@`, `support@`). |
| `reach` | `direct` · `group` · `broadcast` | How their messages reached the owner, the widest the owner gets most. `direct`: to the owner, or a small group. `group`: a large chat or a discussion list where everyone can write. `broadcast`: one sender to many readers who cannot answer in place: a newsletter, a channel, marketing mail. |
| `tie` | yes · no | The owner knows them: the ties `person-ties.ts` already works out. |

Data quality is not a kind. These become marks on the row: `owner`, `incomplete` (no name, or a deleted account),
`test`.

Why `bot` and not `automated`: a bot is a program. A newsletter author is usually a human who writes to many people.
So "newsletter" is a `reach`, not a `sender`. Both cases now have a place: a 2FA code is `bot` + `direct`, a
newsletter is `human` (or `bot`) + `broadcast`.

### What the screen shows

| Tab | Who | Filters inside |
|---|---|---|
| **People** | `human`, reach `direct` or `group` | Known (tie) · Not known (no tie, today's Strangers) |
| **Subscriptions** | reach `broadcast`, any sender | Newsletters · Channels · Marketing |
| **Bots** | `bot`, reach `direct` | Alerts and codes · Receipts · Messenger bots |
| **Organizations** | the `organizations` table | Its people, shared mailboxes and bots, grouped under it |

`incomplete` rows are a filter on every tab ("Show incomplete"), off by default. Today's `kind` stays as a value
worked out from the three fields, so memo and Desktop keep working until they move.

## How a sender is sorted

Only local, deterministic rules. The owner's choice always wins and applies to the sender's whole history, past
and future, the way a mail client's "always put this sender in…" does.

Signals, strongest first:

1. **The owner chose.** A kind the owner set by hand.
2. **The platform says so.** Telegram `user.bot`, `user.support`, `user.deleted`
   ([constructor/user](https://core.telegram.org/constructor/user)); Slack `is_bot`, `profile.bot_id`
   ([user object](https://docs.slack.dev/reference/objects/user-object)); Discord `bot`, `system`
   ([user](https://docs.discord.com/developers/resources/user)). Stored today as `identities.bot`.
3. **The owner wrote to them.** Mail from any of the owner's addresses
   ([#3321](https://github.com/WireCatLabs/cli-core/issues/3321)), a one-to-one chat the owner wrote in. This makes
   a `tie` and `direct` reach, and stops `bot` from header guesses (not from the platform flag).
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

A `bot` or `organization` sender joins the organization of its registrable domain, worked out with the
[Public Suffix List](https://publicsuffix.org/list/) (`mail.bank.example` and `bank.example` are one domain). This
is automatic and never goes to merge review. Three exceptions:

- **Free mail** (`gmail.com`, `outlook.com`; today's `FREE_MAIL`): never an organization.
- **Sending platforms** (newsletter hosts and mail services that send for many customers): group by `List-Id`, or by
  display name within the platform, never by the platform's domain. Otherwise every newsletter on one host becomes
  one sender.
- **`human` senders** at a company domain are linked to the organization as members (`member-of`), not merged.

### Domain lists

A domain list can also give an organization its purpose: bank, shop, airline, news, government. This becomes a
`category` on the organization, and a filter on the Bots and Organizations tabs.

Only lists downloaded whole and matched on the owner's computer qualify. A lookup per sender (a DNS blocklist, a
category API) tells a third party who writes to the owner. Checked on 2026-11-24:

| Source | Gives | Licence | Use |
|---|---|---|---|
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Database_download) | Banks, airlines, companies, media, government with their official website ([P856](https://www.wikidata.org/wiki/Property:P856)): about 4,000 banks and 2,800 airlines with a website | CC0 | Extract `domain → category` from the dump at release; only the preferred website with no end date |
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

A domain names the organization, not the sender. A person at `bank.example` is a `human` member of the bank, not a
bot. Mail sent through a sending platform never takes the platform's category. So the domain is the last signal,
after the headers and the address, and it is matched on both the `From` domain and the DKIM signing domain.

## Out of scope

- **AI classification.** Sorting by a model is planned as a separate command with its own plan. This plan keeps the
  rules local and deterministic, so they work without a model and give the AI command a clean start.
- **Usage data.** No telemetry, by decision.

## Order of work

1. The four bugs: #3319, #3320, #3321, #3322.
2. Store: `sender`, `reach` and the marks on `persons`, worked out like `kind` today (lazily, cleared by triggers).
   `kind` stays, worked out from them. A migration number from [COORDINATION.md](../COORDINATION.md).
3. Mail sync reads `Auto-Submitted`, `List-Unsubscribe-Post` and `Feedback-ID` (today
   [`mail/headers.ts`](../../../src/mail/headers.ts) reads `LIST-ID`, `LIST-UNSUBSCRIBE`, `PRECEDENCE`) and records
   where the owner was on each message.
4. Organizations from domains, with the three exceptions above, then their `category` from the domain lists.
5. The owner's choice: a command that sets a sender's kind for its whole history.
6. memo: `people list` filters `sender:`, `reach:`, `tie:`.
7. Desktop: four tabs and their filters; this closes
   [desktop#319](https://github.com/WireCatLabs/wirecat-desktop/issues/319) (bot filter) and touches
   [desktop#320](https://github.com/WireCatLabs/wirecat-desktop/issues/320) (filters). The public page
   `content/docs/desktop/contacts.mdx` in cli-docs and its RU and ES copies change with it.

## Open questions

1. **Tab names.** People / Subscriptions / Bots / Organizations (RU: Люди / Подписки / Боты / Организации). Are four
   tabs right, or should Bots sit inside Organizations?
2. **Reach of a mixed sender.** Someone who writes to the owner directly and also sends a newsletter: one sender with
   reach `direct`, or two senders split by address?
3. **Discussion lists.** A mailing list where people answer each other: are its members People (reach `group`) or
   one Subscription?
4. **Where the domain lists live.** Built into the package at release (no network at run time), or downloaded once by
   a `models`-style command the owner runs?
