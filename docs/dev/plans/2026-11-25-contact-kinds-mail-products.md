# How mail products screen and sort mail, and what WireCat can copy

Checked 2026-11-25. Research only, no code changed.

**Short answer.** Most products save the user's correction **per sender**. Several also let you move **one message** without
touching the sender (HEY, Outlook, Proton), and a few add a **domain** level (HEY, SaneBox, Spark, Tuta, Fastmail). Only
SaneBox documents a full order of priority (subject beats domain, domain can override address). Open source has one
small piece of code worth porting: Zero's 82-line header classifier, which sorts each message on its own (MIT). The
owner's model fits what the market does:

- each message gets its own category;
- rules exist at the address level and at the domain level;
- tabs are saved filters.

The one thing to add is a guard for free-mail domains, so that nobody writes a rule for all of `gmail.com`.

How each fact is labelled:

- **doc**: the vendor's own help page, fetched today.
- **code**: source code read today, linked with a permalink.
- **search summary**: a search engine result that I did not open. Treat it as unverified.
- **opinion**: a review, a blog post or a competitor's claim.

---

## 1. Products

### 1.1 Summary table

| Product | Categories | Scope of the automatic sort | User correction applies to | First-contact screen | ML or rules |
|---|---|---|---|---|---|
| HEY | Imbox, The Feed, Paper Trail (+ Set Aside, Reply Later as per-email piles) | Per sender (contact), set by the user | Sender, domain (only Imbox / screen-out), or one email | Yes, The Screener, mandatory | User decisions only |
| Gmail | Primary, Social, Promotions, Updates, Forums; views: Manage subscriptions, Purchases | Per message | One message (drag); sender via filter | No | ML (undocumented) |
| Apple Mail (iOS 18.2+) | Primary, Transactions, Updates, Promotions | Per message, grouped by sender in a digest | Sender ("Categorize Sender") | No | ML (Apple Intelligence) |
| Outlook Focused Inbox | Focused, Other | Per message | One message or sender ("Always move") | No | ML |
| Superhuman | Split Inbox sections; Auto Labels Marketing, Pitch, Social, News + custom | Per message (labels) | Custom labels: rewrite the prompt | No | AI (LLM) |
| Shortwave | Splits; labels (Newsletters, Promotions, Travel…) | Per message (AI filters) or per sender (auto-apply) | Sender (auto-apply rule); drag thread between splits | No | AI + sender rules |
| Spark | Gatekeeper, Priority, People, Notifications, Newsletters | Per sender for corrections; auto method undocumented | Sender ("change category") | Yes, Gatekeeper (paid): address or domain | Undocumented |
| Fastmail | Folders by rules; Masked Email per recipient address | Per message (rule match) | Rule from message; block address or domain | No | Rules |
| Proton | Views → Mailing lists (Active / Unsubscribed) | Per sender list, detected from headers | Sender: move to folder, "apply to future messages" | No | Header "signals" |
| Notion Mail | AI auto labels (shut down 2026-09-22) | Per message | One message (add/remove label trains it) | No | AI |
| Yahoo | Tabs Primary, Offers, Social, Newsletters; Views: Subscriptions, Shopping, Receipts, Travel… | Per message | Not documented | No | Undocumented |
| SaneBox | Inbox, @SaneLater, @SaneNews, custom folders | Per sender (people); sender + subject (services) | Sender (move = train), domain filter, subject filter | Partly (@SaneBlackHole, unknown senders to later) | Rules + history scoring |
| Clean Email | Screener, Smart Folders, Auto Clean rules | Per sender (name + address) | Sender; allow-list by address/domain/keyword | Yes, Screener (off by default) | Rules |
| Unroll.me / Leave Me Alone | List of subscriptions | Per sender | Keep / unsubscribe / roll up | No | Header + body link |
| Tuta | Folders by inbox rules | Per message (rule) | Rule on sender address or domain (regex allowed) | No | Rules |

### 1.2 Product notes

**HEY** (doc)

- **Screener.** A first-time sender waits in The Screener. "Yes" sends them to the Imbox. The arrow next to "Yes" picks
  The Feed or Paper Trail instead. "No" screens them out, and the sender is not told.
- **Who skips the Screener.** Contacts added before the first email skip it. So does anyone who puts your Speakeasy code
  in the subject.
- **Screener History** lets you undo a decision. When you screen someone back in, you see their mail from the last 90
  days. Source: [The Screener](https://help.hey.com/article/722-the-screener).
- **Domain level.** The `@domain` button on a contact sets the whole domain to one of three options: screen in to the
  Imbox, screen out, or screen individually. Large free-mail domains cannot be screened out ("such as @gmail.com"). A
  whole domain cannot be sent to The Feed: "You can't automatically send an entire domain's emails to The Feed."
  Sources: [The Screener](https://help.hey.com/article/722-the-screener), [The Feed](https://help.hey.com/article/761-the-feed).
- **Two correction scopes.** "Delivering to" on a contact moves existing and future mail. "Move to The Feed / Paper
  Trail" on one email moves only that email: "future emails from the sender still go where they normally do". Source:
  [Paper Trail](https://help.hey.com/article/787-paper-trail).
- **Set Aside and Reply Later** are piles of single emails, not sender settings. Sources:
  [Focus & Reply](https://help.hey.com/article/764-focus-and-reply), [Set Aside](https://hey.com/features/set-aside/).
- A spam filter runs before the Screener. Source: [Screener feature page](https://www.hey.com/features/the-screener/).

**Gmail**

- **Tabs** (doc): Primary ("people you know"), Social, Promotions, Updates ("automated confirmations, notifications,
  statements"), Forums ("online groups, discussion boards, mailing lists"). Dragging a message to another tab teaches
  Gmail. A filter can send a sender to a category. Source: [Gmail categories](https://support.google.com/mail/answer/3055016?hl=en).
- **Unverified.** People widely report a prompt after a drag, "Do this for future messages from …?". The help page
  does not mention it, and I did not confirm it.
- **Manage subscriptions** (doc, 2025-07-08): senders ranked by how often they write, with counts for the last few
  weeks. One click sends an unsubscribe request for you. Source: [Google blog](https://blog.google/products/gmail/new-manage-subscriptions-unsubscribe/).
- **Purchases view and Promotions sorted by "most relevant"** (search summary of the Google blog, 2025-09-11):
  deliveries and purchase mail are collected in one view, plus a "Top deals for you" card. Source:
  [Google blog](https://blog.google/products/gmail/one-stop-purchase-tracking-in-gmail/).
- **Why `List-Unsubscribe` is a reliable signal** (doc): since 2024, anyone who sends more than 5,000 messages a day to
  Gmail must add one-click unsubscribe to marketing and subscribed mail (`List-Unsubscribe` +
  `List-Unsubscribe-Post`, RFC 2369 / RFC 8058). They must also pass DMARC, with the From domain aligned with SPF or
  DKIM. Transactional mail is not named in the rule. Source: [Email sender guidelines](https://support.google.com/a/answer/81126?hl=en).
- **Structured data in receipts** (doc): Gmail reads schema.org `Order` markup (JSON-LD or microdata) with
  `merchant`, `orderNumber`, `price` and `acceptedOffer`. This is a deterministic marker of a receipt. Source:
  [Order markup](https://developers.google.com/workspace/gmail/markup/reference/order).

**Apple Mail** (doc: the iCloud guide. The iPhone steps are a search summary from CNET and TechRadar.)

- Primary: "personal messages, direct communications and time-sensitive information". Transactions: receipts and
  shipping. Updates: news, newsletters and social. Promotions.
- Time-sensitive mail from the other categories also shows in Primary. So one message can appear in two places, which
  supports "tabs are views".
- Messages in Transactions, Updates and Promotions open as a **digest by sender**.
- "Categorize Sender": "Your choice applies to all current and future messages from the sender."
- "Reset Manual Categorization" undoes all manual changes.
- Source: [Use categories](https://support.apple.com/en-ca/guide/icloud/mmafbebd3108/icloud).
- On iPhone the feature needs iOS 18.2 and Apple Intelligence (search summary). Apple's guide does not say whether the
  sorting runs on the device.

**Outlook Focused Inbox** (doc)

- Learns from "emails and contacts you interact with" and "filters out noisy sources like automatically generated or
  bulk email".
- "Move to Focused/Other" moves one message. "Always move to Focused/Other" moves the sender's future mail.
- Source: [Focused Inbox](https://support.microsoft.com/en-us/office/focused-inbox-for-outlook-f445ad7f-02f4-4294-a82e-71d8964e3978).

**Superhuman** (search summary. The help centre returned HTTP 403.)

- Built-in Auto Labels: Marketing, Pitch, Social, News. Custom labels are written as AI prompts (Business plan).
- Split Inbox sections are built from labels or from search queries, such as the sender domain.
- At launch, a wrong custom label could only be fixed by writing a new prompt
  ([TechCrunch, 2025-02-19](https://techcrunch.com/2025/02/19/superhuman-introduces-ai-powered-categorization-to-reduce-spammy-emails-in-your-inbox), news).

**Shortwave** (doc)

- Labels can be "automatically applied or removed on a per-sender basis". AI filters apply labels from a description
  in plain language, with ready-made filters for Travel, Finance and Purchases.
- Splits are built from labels, senders or search queries. You can drag a thread between splits.
- Source: [Bundles and splits](https://www.shortwave.com/docs/guides/bundles/).

**Spark**

- **Smart Inbox cards** (doc): People, Notifications, Newsletters, plus Priority and Seen. Changing a sender's category
  "sort[s] all future emails from this sender". The help page does not say how Spark picks the category in the first
  place. Source: [Customize your inbox](https://sparkmailapp.com/help/manage-your-inbox/customize-your-inbox).
- **Gatekeeper** (doc, paid): a new sender is "somebody with a new email address". You accept or block. Blocking is
  silent. You can choose "Block All <domain>". Three modes: screen before the Inbox, screen inside the Inbox, or off.
  You can accept or block everyone in the list at once. Source:
  [Accept or block new senders](https://sparkmailapp.com/help/set-up-focus/accept-or-block-new-senders).

**Fastmail** (doc)

- Rules match From, To/Cc/Bcc, Subject or Body. "Add rule from message…" fills in the conditions from the message.
- You can block an address or a whole domain (the mail goes to Trash).
- Address actions run before rules: you can act on everything sent to one of your addresses.
- Source: [Filters & Rules](https://www.fastmail.help/hc/en-us/articles/1500000278122).
- Masked Email gives each service its own address. The address the mail was **sent to** then tells you which service
  sent it (search summary of Fastmail's Masked Email help).

**Proton** (doc)

- Views → Mailing lists, with an Active tab and an Unsubscribed tab. Proton finds newsletters from "multiple signals —
  like email headers" and admits that "regular emails can be misclassified".
- Each sender shows unread count and how much mail came in the last 30 days. You can sort by least read or by most
  frequent.
- Actions: unsubscribe and then trash or archive the old mail, or move to a folder with "apply to future messages".
- **The view moves nothing**: mail stays where it is. It is a view over the data.
- To report a wrong entry, you send Proton the message headers.
- Source: [Mail newsletters view](https://proton.me/support/mail-newsletters-view).

**Notion Mail** (search summary of the Notion help page): auto labels from AI prompts, with "Show in inbox" or
"Filter from inbox". Adding or removing a label on one email trains the AI. **The product shut down on 2026-09-22.**
Notion said many users now handle mail through agents. Source:
[Notion Mail is going away](https://www.notion.com/help/notion-mail-inbox-is-going-away-what-to-do-next).

**Yahoo** (doc)

- Inbox categories: Primary, Offers, Social, Newsletters, with All. Source: [Inbox categories](https://help.yahoo.com/kb/SLN36712.html),
  search summary.
- Views: Subscriptions ("active or unsubscribed subscriptions"), Shopping, Receipts, Travel, plus Contacts, Photos and
  Documents. Source: [Views](https://help.yahoo.com/kb/new-mail-for-desktop/navigate-emails-views-yahoo-desktop-sln36325.html).
- I found no documented way to move a sender from one tab to another.

**SaneBox** (doc). This is the clearest public model of scopes and priority.

- **People.** SaneBox sorts mail from individuals by your history with them. Mail from services is sorted by **sender
  and subject**. So one shop's newsletters can go to @SaneNews while its shipping notices go to @SaneLater.
- **No message bodies.** SaneBox does not download message bodies: it uses only the sender and the subject. Source:
  [How SaneBox determines trainings](https://www.sanebox.com/help/186-how-does-sanebox-determine-trainings).
- **Domain filters** match the domain exactly. A "match sub-domains" box is optional. An "Override training" box
  decides whether the domain rule beats the training you gave one address at that domain.
- **Priority.** "The subject filter will override the domain filter."
- **Replies** stay in the Inbox by default, even when a domain filter matches. Source:
  [Can I filter by domain](https://www.sanebox.com/help/121-can-i-filter-by-domain).

**Clean Email** (doc)

- **Screener** (off by default). A new sender is one that "has never sent a message to your address before". Allow sends
  them to the Inbox, Read Later or a folder. Block or Pause sends them to Trash.
- **Three kinds screened separately.** It screens mailing lists, automated messages and messages from people, and you
  can let any one kind through without screening.
- An allow-list lets addresses, domains or keywords skip the screen.
- A sender is identified by "the combination of name and email address".
- Source: [Screener](https://clean.email/help/tools/screener).

**Unroll.me** (opinion, from reviews and competitors): it scans for subscriptions and offers unsubscribe and a daily
"rollup". In 2017 its parent company Slice sold anonymised receipt data
([The Intercept](https://theintercept.com/2017/04/24/stop-using-unroll-me-right-now-it-sold-your-data-to-uber/)).
This is the privacy argument for a local tool.

**Leave Me Alone** (doc): reads `List-Unsubscribe` first and falls back to a link in the body. It prefers an RFC 8058
POST. Source: [Effective unsubscribe methods](https://help.leavemealone.com/en/for-mailing-list-owners/how-to-provide-effective-unsubscribe-methods).
The product is closed source.

**Tuta** (search summary of the Tuta blog and support): inbox rules match a sender address, a domain, a subject or a
header, and accept JavaScript regular expressions. "Reapply inbox rules" runs them over old mail. Tuta has no automatic
categories.

---

## 2. Open source

| Project | Licence | Categorization in the code | Reuse |
|---|---|---|---|
| **Zero** (Mail-0/Zero) | MIT (root [LICENSE](https://github.com/Mail-0/Zero/blob/4b642dfd9890a1fdcb1b98a177fe74ca3142c445/LICENSE), no other licence found) | Deterministic header classifier per message (personal / promotions / updates) | **Yes**, port with the copyright notice |
| **Inbox Zero** | AGPL-3.0; `apps/web/ee/` has a commercial licence | Categories per sender by an LLM; cold-email guard; learned FROM/SUBJECT patterns | **Ideas only.** Copying the code would make WireCat AGPL |
| **Mailspring** | GPL-3.0 | Rules (from/to/subject/body); a "Newsletters" view = `listUnsubscribe` present | Ideas only |
| **rspamd** | Apache-2.0 | Scored detection of mailing lists; known senders (owner replied) | Yes, with the NOTICE |
| **SpamAssassin** | Apache-2.0 | `__VIA_ML` mailing-list rule; free-mail domain list; TxRep address and domain reputation | Yes (rules, lists), with the NOTICE |
| **Thunderbird** | MPL-2.0 | Local Bayesian junk filter trained per user; address-book senders are exempt | File-level reuse under MPL. **I did not read the code.** |
| Nylas | Closed (API) | Not checked | — |

### 2.1 Zero: per-message header classifier (code)

[`apps/server/src/lib/imap/categorize.ts`](https://github.com/Mail-0/Zero/blob/4b642dfd9890a1fdcb1b98a177fe74ca3142c445/apps/server/src/lib/imap/categorize.ts#L19-L82)
is 82 lines. It reads these headers: `From`, `To`, `Cc`, `List-Id`, `List-Unsubscribe`, `Precedence`,
`Auto-Submitted`, `Feedback-ID`, `X-Auto-Response-Suppress` and `X-Campaign` (L19-20).

- **Two regular expressions on the local part** (the part of the address before `@`):
  - automated senders: `no-reply`, `notifications`, `billing`, `receipts`, `orders`, `support`… (L23-24);
  - marketing senders: `news`, `promo`, `deals`, `hello`, `team`, `info`… (L27-28).
- **Order of the checks** (L52-82):
  1. A known contact with no `List-Unsubscribe` and no bulk header → personal.
  2. `Precedence: list` with no campaign marker → updates. This is a discussion list.
  3. `List-Unsubscribe` or `Precedence: bulk` → promotions. The exception is an automated sender with no campaign
     marker, which gets updates. This keeps receipts out of Promotions.
  4. `List-Id`, `Auto-Submitted` or an automated local part → updates.
  5. An ESP campaign header → promotions. An ESP is an email service provider such as Mailchimp or SendGrid. The code
     comment says: "A marketing-looking address alone (info@, hello@) is often a real person".
  6. Anything else → personal.
- **Known contact = "the owner wrote to them".** When the sync reads the Sent folder, it saves every recipient as a
  contact ([`imap-store.ts` L500-525](https://github.com/Mail-0/Zero/blob/4b642dfd9890a1fdcb1b98a177fe74ca3142c445/apps/server/src/lib/imap/imap-store.ts#L500-L525)).
  The same function also stores a `bulk` flag on each message.
- **User beats AI.** A thread category has a source, `ai` or `user`, and "A user's choice is never overwritten by the
  AI" ([L560-566](https://github.com/Mail-0/Zero/blob/4b642dfd9890a1fdcb1b98a177fe74ca3142c445/apps/server/src/lib/imap/imap-store.ts#L560-L566)).

This is very close to what WireCat needs for `reach` and `tie`, and it makes no network calls.

### 2.2 Inbox Zero (code, AGPL-3.0)

- **Categories are per sender**: Other, Newsletter, Marketing, Receipt, Notification. Thirteen more categories are
  commented out
  ([`utils/categories.ts` L1-48](https://github.com/elie222/inbox-zero/blob/122474b7d3197822e951d56f43d1b5f14141c335/apps/web/utils/categories.ts#L1-L48)).
- **How a sender is sorted.** An LLM reads the subjects and snippets of the sender's last 3 threads. If the model does
  not answer, the sender gets "Other"
  ([`categorize/senders/categorize.ts` L17-75](https://github.com/elie222/inbox-zero/blob/122474b7d3197822e951d56f43d1b5f14141c335/apps/web/utils/categorize/senders/categorize.ts#L17-L75)).
- **Cold-email guard.** It runs deterministic checks before the AI, in this order:
  1. an application sender on the allow-list;
  2. a sender from the owner's own organization;
  3. a learned pattern, where a user exclusion wins;
  4. the owner has already written to them, which beats an old "cold" mark;
  5. any earlier contact.

  Only after that does the AI run
  ([`cold-email/is-cold-email.ts` L54-161](https://github.com/elie222/inbox-zero/blob/122474b7d3197822e951d56f43d1b5f14141c335/apps/web/utils/cold-email/is-cold-email.ts#L54-L161)).
- **Learned patterns are the correction model.** A `GroupItem` has a type (`FROM` / `SUBJECT` / `BODY`), a value
  ("@gmail.com", "matt@gmail.com" or "Receipt from") and an `exclude` flag
  ([`schema.prisma` L1091-1103](https://github.com/elie222/inbox-zero/blob/122474b7d3197822e951d56f43d1b5f14141c335/apps/web/prisma/schema.prisma#L1091-L1103)).
- **Matching rules**
  ([`group/find-matching-group.ts` L59-140](https://github.com/elie222/inbox-zero/blob/122474b7d3197822e951d56f43d1b5f14141c335/apps/web/utils/group/find-matching-group.ts#L59-L140)):
  - an address or domain must match on a boundary, so `ann@acme.com` does not match `joann@acme.com`;
  - a subject matches with the numbers removed;
  - a user-made pattern beats a learned one, the newest wins, and an exclusion wins a tie.

  When a learned pattern matches, the AI call is skipped.
- **The keyword detectors are thin.** `isNewsletterSender` checks whether the sender contains "newsletter" or one of
  three hosts (substack, beehiiv, ghost)
  ([`find-newsletters.ts`](https://github.com/elie222/inbox-zero/blob/122474b7d3197822e951d56f43d1b5f14141c335/apps/web/utils/ai/group/find-newsletters.ts#L1-L8)).
  The receipt detector is a short list of senders and subjects
  ([`find-receipts.ts`](https://github.com/elie222/inbox-zero/blob/122474b7d3197822e951d56f43d1b5f14141c335/apps/web/utils/ai/group/find-receipts.ts#L1-L60)).
  Neither is worth copying.

### 2.3 Mailspring (code, GPL-3.0)

- Rule conditions: from, to, cc, bcc, any recipient, reply-to, attachment, subject, body
  ([`mail-rules-templates.ts` L5-105](https://github.com/Foundry376/Mailspring/blob/7a8ab27168960f967c3b572b014edea6db729655/app/src/mail-rules-templates.ts#L5-L105)).
- The new "Newsletters" starter view is a query: `listUnsubscribe` present, direction received.
- It groups the result by sender **name**, because "one brand sends from several addresses (LinkedIn)"
  ([`starters/newsletters/View.jsx` L20-28](https://github.com/Foundry376/Mailspring/blob/7a8ab27168960f967c3b572b014edea6db729655/app/internal_packages/views/starters/newsletters/View.jsx#L20-L28)).

### 2.4 rspamd (code, Apache-2.0)

- **`MAILLIST`.** Fingerprints for ezmlm, Mailman, Google Groups and CommuniGate. There is also a generic score:
  `List-Id` 0.75, `Precedence: list|bulk` 0.25, other `List-*` headers 0.125 each, and +0.25 when both Subscribe and
  Unsubscribe are present
  ([`maillist.lua` L153-200](https://github.com/rspamd/rspamd/blob/21d3ad96e527d0f839eef782a9b7858ac7f0b4b4/src/plugins/lua/maillist.lua#L153-L200)).
- **`known_senders`.** Marks `KNOWN_SENDER` / `UNKNOWN_SENDER`. It keeps a set of "verified senders" that the user has
  replied to, with optional hashing for privacy
  ([`known_senders.lua` L36-48](https://github.com/rspamd/rspamd/blob/21d3ad96e527d0f839eef782a9b7858ac7f0b4b4/src/plugins/lua/known_senders.lua#L36-L48)).
- **Single-header symbols:**
  - `HAS_LIST_UNSUB` ([`headers.lua` L959](https://github.com/rspamd/rspamd/blob/21d3ad96e527d0f839eef782a9b7858ac7f0b4b4/rules/regexp/headers.lua#L959));
  - `PRECEDENCE_BULK` ([`upstream_spam_filters.lua` L21](https://github.com/rspamd/rspamd/blob/21d3ad96e527d0f839eef782a9b7858ac7f0b4b4/rules/regexp/upstream_spam_filters.lua#L21));
  - the `Auto-Submitted` check ([`headers_checks.lua` L267](https://github.com/rspamd/rspamd/blob/21d3ad96e527d0f839eef782a9b7858ac7f0b4b4/rules/headers_checks.lua#L267)).

### 2.5 SpamAssassin (code, Apache-2.0)

- **`__VIA_ML`** fires on any one of these: `Precedence` list or bulk, `List-Id`, `List-Post`, `Mailing-List`, or a
  Return-Path of the form `*-request|-bounces|-admin|-owner@`
  ([`20_head_tests.cf` L427-433](https://github.com/apache/spamassassin/blob/be3c2988cc347770adff89072c30573fa242012c/rules/20_head_tests.cf#L427-L433)).
- **Free-mail list.** 480 `freemail_domains` lines (gmail, outlook, yandex, mail.ru…) in
  [`20_freemail_domains.cf`](https://github.com/apache/spamassassin/blob/be3c2988cc347770adff89072c30573fa242012c/rules/20_freemail_domains.cf).
  This is the list that makes domain-level rules safe.
- **TxRep** keeps a separate weighted reputation for each level: the address with its IP, the address alone, the
  **domain**, the IP and the HELO name. A skip list holds domains it should not track
  ([`TxRep.pm` ~L705-780](https://github.com/apache/spamassassin/blob/be3c2988cc347770adff89072c30573fa242012c/lib/Mail/SpamAssassin/Plugin/TxRep.pm#L705-L780)).
  It is an old precedent for keeping address and domain apart.

### 2.6 Thunderbird (doc + file link, code not read)

- The adaptive junk filter is a Bayesian classifier (a word-statistics model), trained per user and on the user's own
  machine:
  [`mailnews/extensions/bayesian-spam-filter/`](https://searchfox.org/comm-central/source/mailnews/extensions/bayesian-spam-filter).
- Senders in a chosen address book are never marked as junk automatically (search summary of the
  [Mozilla support article](https://support.mozilla.org/kb/thunderbird-and-junk-spam-messages)). A Bugzilla report says
  the junk filter runs before the user's filters
  ([bug 543024](https://bugzilla.mozilla.org/show_bug.cgi?id=543024)).
- This belongs to the later AI feature (local machine learning), not to the deterministic rules.

### 2.7 Other detectors

- **schema.org markup** in the HTML: `Order`, and Gmail's other types such as `ParcelDelivery`. This gives a certain
  "receipt" or "delivery" label when it is present. See the Gmail markup docs above.
- **Public Suffix List** (MPL-2.0, [publicsuffix.org](https://publicsuffix.org/)). It turns `mail.shop.co.uk` into
  `shop.co.uk`, which WireCat needs for the domain level. This is my suggestion: none of the products above names it.
- **Not checked:** Nylas (its sorting is a closed paid API), and other open newsletter or receipt detectors on GitHub.

---

## 3. Findings

- **FIND-1 · Corrections are per sender by default. A one-message scope is the second most common.** HEY, Outlook,
  Proton and Shortwave offer both. Apple and Spark offer only the sender. No product rewrites a category for a single
  message without asking which scope the user wants. Outlook's "Move" and "Always move" make the scope a visible choice.
- **FIND-2 · The domain level exists, but it is limited.** HEY allows only screen in or screen out for a domain, never
  The Feed. Spark and Fastmail use the domain level only to block. SaneBox has a full domain rule with "override" and
  "sub-domains" options.
- **FIND-3 · Free-mail domains break domain rules.** HEY refuses to screen out `@gmail.com`. A domain level needs a
  free-mail guard.
- **FIND-4 · "Known" is computed locally everywhere.** Zero: the owner wrote to them. rspamd: the owner replied. HEY:
  in the contacts. Inbox Zero: the owner sent to them, or the sender is from the same organization. Clean Email: they
  wrote before. None of these needs a network call.
- **FIND-5 · Subscription views are built from headers and are views, not folders.** Gmail, Proton, Yahoo and
  Mailspring all do this. Proton says it outright: "The view doesn't move anything."
- **FIND-6 · One sender can send mixed mail.** SaneBox sorts services by sender **and** subject. Apple shows Primary
  items in two places. This supports the owner's point that a category belongs to the message, apart from its sender.
- **FIND-7 · The big products use ML; the deterministic ones are smaller or open.** ML: Gmail, Apple, Outlook,
  Superhuman, Shortwave, Notion. Deterministic: Zero, SaneBox for subjects and domains, Proton's header signals, rspamd,
  SpamAssassin.

---

## 4. Recommendations for WireCat

The owner's model is: each message gets its own category, rules exist at two levels (address and domain), and tabs are
filtered views. The ideas below fit that model, most useful first.

### IDEA-1 · Classify each message from its headers

- **The idea.** A header classifier runs on each message during sync, after Zero's design. It returns `kind`:
  - `person`: a direct message from a human;
  - `list`: a discussion list;
  - `bulk`: marketing or a newsletter;
  - `automated`: notifications, receipts, alerts.

  The same pass gives `reach`:
  - direct: the owner is in `To`;
  - group: Cc or several people;
  - broadcast: `List-*`, `Precedence: bulk`, or the owner is not among the recipients.
- **Who does it.** Zero ([`categorize.ts`](https://github.com/Mail-0/Zero/blob/4b642dfd9890a1fdcb1b98a177fe74ca3142c445/apps/server/src/lib/imap/categorize.ts#L52-L82)),
  rspamd `MAILLIST`, SpamAssassin `__VIA_ML`. Gmail and Proton use the same headers, but their code is closed.
- **Why it fits a local-first tool.** It uses only headers. It makes no network calls and costs nothing to run. Gmail's
  rule since 2024 makes `List-Unsubscribe` present on almost all bulk mail.
- **Cost.** Small. About 100 lines plus fixture tests. The code is MIT, so it can be ported with the notice. Add
  rspamd's ezmlm and Mailman fingerprints for discussion lists.

### IDEA-2 · Store the message's category apart from the sender's, and derive the sender's from its messages

- **The idea.** `message.category` comes from IDEA-1 plus any override. `sender.profile` is a summary of that sender's
  messages, for example "92 % bulk, 8 % automated".
- A tab is a query on the message category. Example: Subscriptions = `kind=bulk` and not overridden.
- A sender with mixed mail (newsletter plus receipts) then shows in two tabs, and the receipts are not lost.
- **Who does it.** Apple (Primary items also show in their category), SaneBox (sender + subject for services), HEY (move
  one email without changing the sender), Proton (a view that moves nothing).
- **Why it fits a local-first tool.** The whole mailbox is local, so a summary per sender is a cheap SQL query.
- **Cost.** Medium. A schema change: a category column on each message, and a sender summary built from it.

### IDEA-3 · Two-level rules with a fixed order of priority and a free-mail guard

- **The idea.** A rule has a key and an action. The key is the address or the registrable domain (via the Public
  Suffix List). Rules are checked in this order:

  | # | Level | Example | Wins over |
  |---|---|---|---|
  | 1 | One message | "this email is a receipt" | everything |
  | 2 | List-Id or subject pattern (optional) | `List-Id: <news.shop>`; "Your order #…" | address, domain |
  | 3 | Address | `orders@shop.com` → automated | domain |
  | 4 | Domain | `shop.com` → organization "Shop" | header classifier |
  | 5 | Header classifier (IDEA-1) | — | default |

- Within one level, a user rule beats a learned rule. The newest rule wins. "Exclude" wins a tie (Inbox Zero).
- A domain rule may set "override address rules", as in SaneBox.
- **Free-mail guard.** Domain rules are refused for domains on SpamAssassin's `freemail_domains` list. For those, the
  UI offers the address rule instead (HEY).
- **Who does it.** SaneBox (subject beats domain, override, sub-domains), HEY `@domain`, Spark "Block All <domain>",
  Tuta, Fastmail, Inbox Zero `GroupItem`, SpamAssassin TxRep (address and domain reputation).
- **Why it fits a local-first tool.** The rules are plain local data. The free-mail list and the Public Suffix List are
  static files shipped with the app.
- **Cost.** Small to medium. Two files under Apache-2.0 and MPL-2.0, one rules table, and boundary-safe matching. Use
  Inbox Zero's fix as the model: anchored matching, so `ann@` does not match `joann@`.

### IDEA-4 · Every correction asks for its scope

- **The idea.** When the owner moves or re-labels a message, the choice is **this message / everything from this
  address / everything from this domain** (and "this list" when `List-Id` is present). It also offers "Apply to past
  messages".
- The owner can "Reset manual sorting" for a sender, a domain or everything.
- **Who does it.** Outlook ("Move" vs "Always move"), HEY (one email vs "Delivering to"), Apple ("Categorize Sender" and
  "Reset Manual Categorization"), Proton ("Apply to future messages"), Tuta ("Reapply inbox rules").
- **Why it fits a local-first tool.** Applying a rule to past mail is a local re-scan, with no cost to any service.
- **Cost.** Small for the CLI flags (`--scope message|address|domain|list`). Medium for the Desktop UI.

### IDEA-5 · A local screener for first-time senders, limited to people

- **The idea.** Rules for who gets screened:
  - **Known** means any of: the owner has sent mail to this address (Zero, rspamd), the address is in contacts, or the
    domain is the owner's own (Inbox Zero).
  - Only `kind=person` messages from unknown addresses go to the screener by default. Bulk and automated mail goes to
    its tabs, as Clean Email's separate settings for each kind allow.
  - A decision is saved per address. It is saved per domain only when the domain is not free mail.
  - "Screened-out" hides the sender, deletes nothing and tells nobody.
  - Screener history can undo a decision, and screening someone back in shows their old mail (HEY shows 90 days).
- This gives WireCat's `tie` field a user-confirmed value on top of the computed one.
- **Who does it.** HEY Screener, Spark Gatekeeper (address or domain, accept or block in bulk, three modes), Clean Email
  Screener.
- **Why it fits a local-first tool.** It needs only the local Sent folder and contacts. Nothing is bounced or reported
  to the sender. WireCat holds a copy of the mail and does not deliver it, so "screen out" is a filter on a view.
- **Cost.** Medium. A screener state per address and per domain, a queue view, and an action to accept or block
  everyone at once.

### IDEA-6 · A Subscriptions view grouped by list, with counts

- **The idea.** Group `kind=bulk` and `kind=list` messages by `List-Id`, falling back to the sender. Show:
  - messages in the last 30 days;
  - the share of them that was read;
  - the date of the last message;
  - whether the sender offers one-click unsubscribe.

  Sort by frequency or by "least read".
- **Who does it.** Gmail Manage subscriptions, Proton Mailing lists (unread count and last 30 days), Yahoo
  Subscriptions, Mailspring Newsletters view (grouped by brand name).
- **Why it fits a local-first tool.** It is a query over local data. Unsubscribing is the only network action. The
  owner starts it, and it goes to the sender's own `List-Unsubscribe` address, never to a WireCat server.
- **Cost.** Small for the view. Unsubscribing (RFC 8058 POST or mailto) is a separate, later step that needs explicit
  confirmation.

### IDEA-7 · Deterministic markers for transactions

- **The idea.** Mark `automated` messages as `transaction` when any of these is true:
  - the HTML contains schema.org `Order` or `ParcelDelivery` markup;
  - the local part is `receipt@`, `billing@`, `orders@`, `invoice@` and the like;
  - the subject matches an order or invoice pattern, with the numbers removed.
- **Who does it.** Gmail Purchases and order markup, Apple Transactions, Yahoo Receipts. Inbox Zero has small lists,
  shown here only for the idea.
- **Why it fits a local-first tool.** It needs no lookup. The markup is in the message itself.
- **Cost.** Small. Accuracy is partial without ML. Note it as a candidate for the AI feature.

### IDEA-8 · Organization = registrable domain, checked by DKIM, ignoring the ESP

- **The idea.** Group senders into an organization by the registrable domain of `From`, and only when DKIM `d=` or SPF
  agrees with it (the same alignment Gmail asks bulk senders for). Never use the `Return-Path` domain of an ESP
  (sendgrid.net, mcsv.net) as the organization.
- **Who does it.** Gmail's sender rules (alignment). rspamd and SpamAssassin read the same headers.
- **Why it fits a local-first tool.** `Authentication-Results` and `DKIM-Signature` are already in the stored headers,
  so no DNS lookup is needed.
- **Cost.** Small. Uses the Public Suffix List from IDEA-3.

### IDEA-9 (for the later AI feature) · Learn patterns and promote them to rules

- **The idea.** When the AI, or the owner's repeated moves, sort a sender the same way several times, propose a saved
  address or subject rule. Inbox Zero does this with a 0.9 threshold
  ([`recurring-pattern.ts` L12-13](https://github.com/elie222/inbox-zero/blob/122474b7d3197822e951d56f43d1b5f14141c335/apps/web/utils/decision-model/recurring-pattern.ts#L12-L13)).
  After that, the deterministic path handles the sender, and the AI never overrides a user rule (Zero).
- A local Bayesian model trained per user (Thunderbird) is another option that keeps all data on the machine.
- **Cost.** It belongs to the AI feature. The rule table from IDEA-3 is the place where its results land.

### How this maps to WireCat's current plan

| WireCat today | Suggested change |
|---|---|
| Entities: people, bots, organizations | Keep them. Derive the entity type from the message summary (IDEA-2) plus rules (IDEA-3), not from one guess per sender |
| `reach` per sender | Compute it **per message** (IDEA-1). The sender's value is the most common one |
| `tie` per sender | Computed from local Sent and contacts, then confirmed by the screener (IDEA-5) |
| Tabs: People, Subscriptions, Bots, Organizations | Saved queries over the message category. People = `kind=person`; Subscriptions = `bulk`/`list`; Bots = `automated`; Organizations = grouped by domain (IDEA-8) |
