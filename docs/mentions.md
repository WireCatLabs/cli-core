# Mentions: phones, addresses, links, documents and names in your messages

The store reads every message it keeps and notes what is written in it: phone numbers, e-mail addresses, links,
Google documents and the names of people you know. Each one is a **mention**. A mention says where it was
written and what it is in a single form, so `+7 900 000-00-01` and `89000000001` are one number.

Questions it answers:

- Where did anyone send this phone number?
- Every link to one site, `docs.google.com` and `drive.google.com` together.
- Which messages talk about Ольга, also when she is written «Ольге» or «Ольгу»?
- Which chats mention this document?

Everything stays on your computer. Mentions are found by rules, not by a model, and nothing is sent anywhere.
The examples use `tg`; `max` has the same commands.

## Find a value

Search messages by a mention:

```sh
tg work search messages phone:"8 900 000-00-01"     # any spelling: +7…, 8…, with spaces or dashes
tg work search messages email:"ana@example.com"     # quoted: @ is an operator in the query language
tg work search messages domain:google.com           # docs.google.com, drive.google.com, google.com
tg work search messages url:"https://example.com/a" # the link without utm_*, fbclid and the #part
tg work search messages mentions:"person:12"        # messages that mention person 12 by name, phone or address
```

`mentions:` also takes `organization:<id>` and `document:<id>`. It finds only mentions somebody linked (see
below). A phone or a link in a file's text or in a voice note's transcript finds the message the file came with.

The fields work with the rest of the [query language](search/query-language.md):
`domain:google.com AND date>=2026-09-01`.

## Numbers from other countries

A number written with `+` or `00` is read as international, from any country. A number without them has no country
written in it, so the store reads it in the countries you name, the first that fits:

```sh
tg work config set phone_countries es,ru   # store-wide: every profile, tg and MAX
tg work mentions rebuild phone             # read the numbers already stored again
```

With `es,ru`, `612 345 678` and `612345678` are `+34 612 345 678`, and `8 900 000-00-01` is still Russian. The
countries are most of Europe, the US and Canada, Russia and its neighbours; `config set` lists them when one is not
known. Without the setting only Russian numbers are read without `+`, as before.

- Digits in groups, or after a word such as `tel`, `móvil`, `Handy` or `téléphone`, may be any number of the country.
- Digits alone count only when they are a mobile number: bare landline-shaped digits are more often an order or an
  account number.
- Digits after `pedido`, `factura`, `nº`, `DNI`, `IBAN`, `Rechnung` and similar words are never a phone.

A number you confirmed before setting the countries stays confirmed after the rebuild, now with its country code.
`phone:` finds it written either way.

## List and look at mentions

```sh
tg work mentions list kind:phone
tg work mentions list domain:google.com status:found
tg work mentions list value:"8 900 000-00-01"
tg work mentions show 12
```

`list` shows the newest first: the id, when the message was sent, the kind, the value, its status and the
message. `show` adds the text around it, how many other places hold the same value and, for a name, the people
it may be.

Kinds: `phone`, `email`, `url`, `document`, `person-name`. Statuses:

| status | meaning |
| --- | --- |
| `found` | the rules found it; nobody has said what it is |
| `linked` | it is known what it names: a person, an organization, a stored document |
| `dismissed` | not a real mention, or not worth keeping |

## Say what a mention is

```sh
tg work mentions confirm 12 person:7          # this number is person 7's
tg work mentions confirm 12 organization:3    # this number is the company's
tg work mentions confirm 15                   # a document link: the stored document
tg work mentions confirm 31 person:7          # this «Ольга» is person 7
tg work mentions reject 12                    # not a phone: an order number
```

- **A phone, an address, a document is decided once for its value.** Confirm one mention of a number and every
  place the number is written follows, now and in messages that arrive later. Reject one and the value is
  dismissed everywhere.
- **A name is decided where it is written.** «Ольга» in two chats can be two people, so a name is confirmed or
  rejected one mention at a time.
- **A link has nothing to be linked to yet.** Reject it if it is not worth keeping.
- A document is confirmed only when it is in the store; sync it from Drive first.

The store records who decided. When an agent's terminal runs the command (`AI_AGENT` or `CLAUDECODE` is set), the
decision is the agent's; `--as-owner` records it as yours.

Some mentions are linked without you:

- a phone or an address that already belongs to someone in your contacts;
- a Google document that is in the store;
- a name, when exactly one person with that name wrote in that chat.

## Names

Names are looked for only for people you have met in a messenger or a meeting, or whose phone you confirmed:
their name, their accounts' names and their aliases. A name in Latin letters is also looked for in Cyrillic:
«Valery» finds «Валерию». People known only from e-mail are left out; most of them are companies and mailing
lists.

A name is a word that starts with a capital letter and has at least four letters. Short words such as «Или»
and «Ира» are skipped: in Russian they are more often ordinary words than names. Two names of one person in a
row are one full name: «Аркадию Смирнову».

## Read what is already stored

New messages get their mentions as they are saved. Messages saved before mentions existed are read once:

```sh
tg work mentions rebuild               # every message, file text and voice note
tg work mentions rebuild person-name   # names only: after you added a person or an alias
```

A rebuild keeps every decision: a linked or dismissed value stays so. It prints its progress and can be run
again at any time.

## Review what is new

`messages sync` says how many mentions it found that nobody has decided yet, and names the command that lists them:

```sh
tg work mentions list --new
```

`--new` shows the undecided mentions found since the last `--new` run, the first time every one. The next run starts
after them, but only when this one showed them all: with `--limit` cutting the list, it stays where it was. The point
is kept per profile, for you and an agent alike, so ask your agent to go through them with you:

> Go through the new mentions in my Telegram. Suggest who each phone is, and confirm only what I agree with.

## Privacy

Phone numbers are kept in the store in the clear, as they are in the messages themselves. They never go to a
log, an error message or a run record. Nothing is fetched from an outside service.

## Not yet

- Mentions in notes, Drive documents and mail.
- Links resolved to a stored chat or document, and a list of sites by number of links.
- Names of people the store does not know, and addresses.
- Linking every «Ольга» of one chat in one step.
