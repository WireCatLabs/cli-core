# Domain and mail-category sources for WireCat

Checked 2026-11-25. Labels follow the product rules:

- **observed**: read on the official page or in real output on that date;
- **interpretation**: our reading of what it means for WireCat;
- **hypothesis**: from memory or a blog, not checked.

"Not checked" means the official page failed or gave no answer.

## Short answers

- **Q1 (FIND-1).** Only a few downloadable sources say *what kind* of organization a domain is:
  - Wikidata (CC0);
  - UT1 (CC BY-SA, about 100 categories, including `bank`, `shopping`, `press`, `webmail`, `social_networks`);
  - NSI (brand to Wikidata);
  - GLEIF BIC→LEI (banks);
  - FDIC (US banks);
  - Hagezi and StevenBlack (social, gambling only);
  - free-mail lists.

  Spam and abuse lists only add a "risky" flag. The best of them either forbid commercial use (Stop Forum Spam) or need a per-user key (abuse.ch, Spamhaus files). No public list exists for Gmail or Yahoo bulk senders, ESP sending domains or BIMI domains. We would have to build those ourselves at build time.
- **Q2 (FIND-2).** Card networks classify the *merchant* (MCC). Aggregators classify each *transaction* (Plaid: 16 primary / 104 detailed categories). The same split fits mail:
  - **sector** per sender, from the lists above;
  - **message type** per message, from headers and markup that are already in the message. Examples: `Auto-Submitted`, `List-Id`, `List-Unsubscribe-Post`, `Feedback-ID`, schema.org JSON-LD, `text/calendar`, `multipart/report`.

  The proposed taxonomy is in [Q2](#q2-card-payments-and-mail-categories).
- **Q3 (FIND-3).** Use a hybrid:
  - bundle a small permissive core: Wikidata, PSL, free-mail;
  - ship a versioned **data pack** for share-alike and large sets, downloaded by a command, with a checksum and per-source licences;
  - lists that forbid redistribution are fetched by the user's own command straight from upstream.

## Q1. Catalogue of domain sources

### Rule that decides most rows: build-time vs. runtime (FIND-4)

- **Runtime, on the owner's machine:**
  - whole-file downloads only;
  - **never** a per-sender query (DNSBL, enrichment API, Safe Browsing `hashes.search`), because even a hash prefix tells the provider who writes to the owner.
- **Build time, in WireCat's own pipeline (interpretation):** an API call about a *fixed public domain set* leaks nothing about the owner. Examples are the Tranco top 1M, every Wikidata org, and every BIMI record in the top 1M. This is how we fill the gaps where no public list exists (ESP, BIMI, bulk senders), as long as the source's terms allow the use.

### Column legend

- **Whole?** The source can be downloaded whole, so it is privacy-OK at runtime.
- **Comm.** Commercial use: yes / no / unclear.
- **SA** Share-alike or copyleft. A bundle that merges this data inherits the obligation.
- **Redist.** We may ship the data inside our package or pack.

### A. Company and organization registries (sector signal)

| Source | Gives | Size | Licence | Comm. | SA | Redist. | Updates | Whole? | Category granularity | Link |
|---|---|---|---|---|---|---|---|---|---|---|
| **Wikidata** (P856 website, P452 industry, P31 instance of, P1278 LEI, P2627 BIC) | org → website, industry, type, LEI/BIC | our extract 25,639 domains; full dump is tens of GB (hypothesis) | CC0 (observed) | yes | no | yes | continuous; weekly dumps | yes (dumps, SPARQL at build time) | free-form classes; needs our own mapping to sectors | [licensing](https://www.wikidata.org/wiki/Wikidata:Licensing) |
| **GLEIF LEI** (Level 1/2) | legal entities, legal form, address | about 2.5M+ LEIs (hypothesis) | CC0 for Access Service data (observed) | not stated on page; CC0 implies yes | no | yes | daily (hypothesis) | yes (golden copy) | none; **no website field** (observed: mapping page lists no domain mapping) | [terms](https://www.gleif.org/en/meta/lei-data-terms-of-use) |
| **GLEIF BIC→LEI mapping** | which LEIs are banks / financial institutions (they hold a SWIFT BIC) | not checked | free of charge, licence not named on page (observed) | unclear | no | unclear | monthly (hypothesis) | yes | "has a BIC" = financial | [mappings](https://www.gleif.org/en/lei-data/lei-mapping) |
| **OpenCorporates** | ~200M companies from registries (hypothesis) | — | ODbL; attribution link required; non-share-alike licence is paid (observed) | only paid, or free for "Permitted Users" (journalists, NGOs, academics) | **yes** | only under ODbL | quarterly/monthly bulk (search summary, not checked) | bulk only by contract; scraping forbidden (observed) | industry codes from some registries; websites rarely present (hypothesis) | [terms](https://opencorporates.com/terms-of-use-2/) |
| **Crunchbase Open Data Map** | company → homepage, category | — | — | — | — | — | — | **not checked**: the ODM docs page returns 404; hypothesis: discontinued | — | [old URL, 404](https://data.crunchbase.com/docs/open-data-map) |
| **name-suggestion-index (NSI)** | brands, operators, transit, flags for OSM, each with `brand:wikidata` and an OSM tag (e.g. `amenity=bank`, `shop=*`) | not stated | BSD-3 repo licence (observed) | yes | no | yes | frequent releases (hypothesis) | yes (git) | OSM tags: bank, fuel, fast food, supermarket… Join to Wikidata P856 for the domain | [repo](https://github.com/osmlab/name-suggestion-index) |
| **FDIC BankFind** | all US FDIC-insured banks with `WEBADDR` | 4,204 active institutions (observed: API `totals.count`, index built 2026-11-24) | US government data; no licence on page (hypothesis: public domain) | likely yes | no | likely yes | index rebuilt daily (observed timestamp) | yes (API pages; no key needed) | bank | [API docs](https://api.fdic.gov/banks/docs) |
| **SWIFT BIC directory (SWIFTRef)** | all BICs, some with addresses | — | paid subscription (hypothesis) | paid | — | no | monthly (hypothesis) | paid only | bank | not checked |
| **Central-bank / EBA / ECB registers** | licensed credit institutions per country | — | varies | varies | — | varies | — | mostly yes (CSV) | bank, payment, e-money institution | not checked. Hypothesis: few carry websites, so the join goes via name→Wikidata |
| **DMOZ / Curlie** | human directory: site → category tree | DMOZ last dump 2017; content.rdf ~1.2 GB (forum, opinion) | DMOZ: CC BY 3.0 per the Internet Archive label; **conflicting claims** (hypothesis) | unclear | no | unclear | frozen (DMOZ); Curlie gives no dump (not checked) | archive copy only | deep topic tree, but stale since 2017 | [archive copy](https://archive.org/details/dmoz-rdf-20150327) |
| **Common Crawl web graph** | host- and domain-level graphs and ranks | not on page; stats on [graph stats](https://commoncrawl.github.io/cc-webgraph-statistics/) | Common Crawl ToU (not checked) | likely yes (hypothesis) | no | — | rolling 3-month releases, newest cc-main-2026-aug-sep-oct (observed) | yes | **none**: popularity only | [web graphs](https://commoncrawl.org/web-graphs) |
| **Tranco** | top 1M registrable domains | 1M | no own licence; inputs include Cloudflare Radar **CC BY-NC 4.0** and CrUX CC BY-SA (observed) | unclear (NC input) | partly | unclear | daily (observed) | yes (`/top-1m.csv.zip`) | none: popularity only. Use it as the build-time domain set and as a "big site" prior | [site](https://tranco-list.eu/) |
| **DuckDuckGo Tracker Radar** | third-party domain → owner entity, categories | not stated | **CC BY-NC-SA 4.0** (observed) | **no** (contact DDG) | yes | no | not stated | yes | entity (owner company) + tracker categories | [repo](https://github.com/duckduckgo/tracker-radar) |
| **Disconnect tracking lists** | services.json (category → company → domains), entities.json | not stated | **CC BY-NC-SA 4.0** (observed) | **no** (licence by email) | yes | no | not stated | yes | Advertising, Analytics, Social, Content… An "Email" category exists (hypothesis: ESP tracking domains) | [repo](https://github.com/disconnectme/disconnect-tracking-protection) |

### B. Category blocklists (some carry sector)

**Subdomain trap (RISK-1).** Ad and tracker lists name hostnames, such as `click.mail.brand.com`. If we cut these down to the registrable domain with the PSL, a real brand gets tagged "ads". So:

- match exact hostnames only;
- collapse to the domain only for lists that are domain-wide by design (UT1 `bank`, NSI);
- use tracker and ad lists on **links and pixels in the body**, as a marketing signal, not on the sender.

| Source | Gives | Size | Licence | Comm. | SA | Redist. | Updates | Whole? | Granularity | Link |
|---|---|---|---|---|---|---|---|---|---|---|
| **UT1 (Univ. Toulouse Capitole)** | ~100 categories of domains/URLs | e.g. bank 6,646 · shopping 36,971 · press 4,645 · financial 473 · social_networks 716 · webmail 413. All categories sum to about 5.8M (observed on the GitHub mirror; the official site returned HTTP 503, so the counts may mix domains and URLs) | **CC BY-SA 4.0** (observed, mirror) | yes | **yes** | yes, under BY-SA | daily (mirror syncs daily) | yes (tar.gz, rsync, git mirror) | **best sector granularity among free lists** | [official](https://dsi.ut-capitole.fr/blacklists/index_en.php) (503 on 2026-11-25) · [mirror](https://github.com/olbat/ut1-blacklists) |
| **Shallalist** | — | — | — | — | — | — | dead | — | — | forum posts only (opinion): users point to UT1 as the replacement. [Netgate forum](https://forum.netgate.com/post/1039094) |
| **Hagezi** | ads/trackers (Light…Ultimate), TIF threat feed, categories | Ultimate 289,080 · TIF 968,880 · Social 8,336 · Gambling 697,917 · NSFW 81,400 · Fake 10,331 · URL shortener 9,580 · Dynamic DNS 1,496 · NRD 2.4–3.0M per 7-day band (observed) | **GPL-3.0** (observed) | yes | **yes** (licence must travel with it) | yes, with licence | daily 11:00 UTC; mirror every 4–8 h (observed) | yes | social, gambling, NSFW, fake, shortener, DDNS, newly registered | [repo](https://github.com/hagezi/dns-blocklists) |
| **StevenBlack hosts** | adware+malware base; extensions | base 81,676 · social 3,808 · gambling 6,744 · porn 76,811 · fakenews 2,187 (observed) | MIT repo, but **upstreams include CC BY-NC-SA and "non-commercial with attribution"** (observed) | **unclear** for the merged files | partly | risky | no fixed schedule (observed) | yes | social, gambling, porn, fakenews | [repo](https://github.com/StevenBlack/hosts) |
| **OISD** | big (ads, phishing, malware, tracking), nsfw | not on page | **no licence stated** (observed): treat as all rights reserved | unclear | — | **no** | hourly-ish (observed "updated N min ago") | yes | ads/malware vs. NSFW | [site](https://oisd.nl/) |
| **The Blocklist Project** | 18 lists: abuse, ads, crypto, drugs, facebook, fraud, gambling, malware, phishing, piracy, porn, ransomware, redirect, scam, tiktok, torrent, tracking, twitter | not on page | Unlicense (observed) | yes | no | yes | **archived 2026-10-27, read-only** (observed) | yes | coarse vice / threat categories | [repo](https://github.com/blocklistproject/Lists) |
| **1Hosts** | Lite / Xtra ad and tracker lists | not on page | MPL-2.0 (observed) | yes | file-level | yes | frequent (observed for DNS resellers) | yes | none (ads/trackers) | [repo](https://github.com/badmojr/1Hosts) |
| **Firebog** | curated index of other lists (suspicious, advertising, tracking, malicious, other) | — | none stated; each list has its own terms (observed) | per list | per list | per list | — | yes | index only | [site](https://firebog.net/) |

### C. Spam and abuse lists: these say "bad", not "what kind"

They add a risk flag only and never set a sector. When they conflict with section A or B, sector comes from A/B and risk comes from C. A bank domain on a phishing list most likely means a look-alike host; check the exact hostname first.

| Source | Gives | Size | Licence / terms | Comm. | Whole download? | Updates | Privacy-OK at runtime | Link |
|---|---|---|---|---|---|---|---|---|
| **Spamhaus DROP / ASN-DROP** | hijacked IP ranges and ASNs (**IPs, not domains**) | not checked | free "regardless of size or business type"; credit Spamhaus and keep the © text (observed) | yes | yes (JSON) | re-evaluated daily; fetch at most hourly (observed) | yes | [DROP](https://www.spamhaus.org/blocklists/do-not-route-or-peer/) |
| **Spamhaus DBL** (domains) | spam/phish/malware domains | — | free DNS queries only for "low-volume, non-commercial"; commercial = annual subscription (observed) | paid | DNS query only for free use; rsync files are a paid product (observed: no free tier for rsync) | real-time | **no** for the DNS query; yes only via paid rsync | [DBL](https://www.spamhaus.org/blocklists/domain-blocklist/) · [data access](https://www.spamhaus.com/data-access/) |
| **abuse.ch URLhaus / ThreatFox** | malware URLs; hostfile of domains (Tranco top 1M excluded) | not checked | auth key per user; free for not-for-profit; commercial "may require a paid subscription" via Spamhaus (observed) | paid | yes, with key | CSV every 5 min (observed) | yes, but each user needs their own key | [terms](https://abuse.ch/terms-of-use/) · [API](https://urlhaus.abuse.ch/api/) |
| **abuse.ch Feodo Tracker, SSL Blacklist** | botnet C2 IPs, bad TLS certificates | — | **CC0** (observed) | yes | yes | frequent | yes | [terms](https://abuse.ch/terms-of-use/) |
| **PhishTank (Cisco)** | verified phishing URLs | not checked | Cisco EULA, not summarised on page (observed) | unclear | yes (JSON/CSV/XML, gz) | hourly (observed) | yes | [developer info](https://phishtank.org/developer_info.php) |
| **OpenPhish Community** | phishing URLs ("limited") | not stated | ToU acceptance required; commercial use not stated (observed) | unclear | yes (text) | every 12 h (observed) | yes | [feeds](https://openphish.com/phishing_feeds.html) |
| **Stop Forum Spam** | toxic domains (exact and partial), spammer domains CSV, IPs | not checked | "Your use of this data and supporting software is **non-commercial**" (observed, legal page) | **no** | yes; 2–3 downloads per IP per day (observed) | daily (observed) | yes | [downloads](https://www.stopforumspam.com/downloads) |
| **Hagezi TIF** | threat-intel domains | 968,880 (observed) | GPL-3.0 | yes | yes | daily | yes | see section B |
| **Google Safe Browsing v5** | malware/phishing hash lists, "Global Cache" of likely-safe sites | — | **non-commercial only**; Web Risk API for commercial use (observed) | no | hash lists yes; `hashes.search` sends a 4-byte prefix (observed) | — | local list mode only | [reference](https://developers.google.com/safe-browsing/reference) |

### D. Mail-specific lists

| Need | Public list? | What exists | Our option |
|---|---|---|---|
| ESP / sending-platform domains and IPs | **No official list found** (gap) | ESPs publish their own SPF includes and DKIM domains (hypothesis) | A hand-made table of about 50 ESPs (SendGrid, Mailchimp/Mandrill, SES, Postmark, Mailgun, Braze, Iterable, Klaviyo…), matched on the DKIM `d=`, the Return-Path domain or the `Received` host **of the message itself**, so no lookup is needed. Their presence = "sent by a platform", and a hint toward bulk. |
| Gmail / Yahoo bulk senders | **No**: neither page has or references a list (observed) | rules only: ≥5,000/day to Gmail, SPF+DKIM+DMARC, one-click unsubscribe, spam rate <0.3% ([Gmail](https://support.google.com/a/answer/81126), [Yahoo](https://senders.yahooinc.com/best-practices/)) | Detect *compliance* in the message: `List-Unsubscribe-Post: List-Unsubscribe=One-Click` means a marketing/subscribed stream (observed requirement). |
| BIMI domains | **No public list** (the BIMI Group page names none; observed) | BIMI is a DNS TXT record at `default._bimi.<domain>`; VMC/CMC certificates go to CT logs (hypothesis) | Build time: query BIMI for the Tranco top 1M (public set, no owner data) → "verified brand with logo". Runtime: read the `BIMI-Location` / `BIMI-Indicator` header if the receiving server added it. |
| Free-mail providers | yes | **Kikobeats/free-email-domains**: 30,000+ free and disposable domains, MIT, rebuilt daily, includes the HubSpot list (observed). **UT1 `webmail`** 413. Thunderbird ISPDB: provider configs for big ISPs (licence not stated, observed) | Bundle Kikobeats (MIT). It already overlaps with disposable-email-domains. |
| Disposable | yes (already used) | disposable-email-domains | keep |

### E. Bank-specific recipe (IDEA-1)

1. **US:** FDIC `WEBADDR` (4,204 active banks, observed) → registrable domain via PSL.
2. **World:**
   - take the GLEIF BIC→LEI mapping (free);
   - join to Wikidata on P1278 (LEI) or P2627 (BIC);
   - read P856 (website).

   Every LEI with a BIC is a financial institution. Wikidata supplies the domain where it has one.
3. **Gap fill:** UT1 `bank` (6,646, BY-SA). It goes in the data pack because of share-alike.
4. **SWIFT's own directory** is paid (hypothesis, not checked), so skip it.

### Which sources to take (interpretation)

| Priority | Source | Why | Where |
|---|---|---|---|
| 1 | Wikidata (extend: P452 industry, P31 type, LEI/BIC joins) | CC0, already in use | bundle |
| 1 | Kikobeats free-email-domains | MIT, fills "person on free-mail vs. org" | bundle |
| 1 | NSI → Wikidata join | BSD, adds OSM sector tags to brands | bundle |
| 1 | FDIC + GLEIF BIC→LEI | banks, free | bundle (small) |
| 2 | UT1 (bank, shopping, press, webmail, social_networks, financial + others) | best free sector lists | data pack (BY-SA) |
| 2 | Hagezi social / gambling / NSFW / TIF | daily, GPL | data pack (GPL text included) |
| 2 | Spamhaus DROP, abuse.ch Feodo/SSLBL | free, whole files | data pack |
| 3 | abuse.ch URLhaus/ThreatFox, PhishTank, OpenPhish | need key / unclear terms | user command fetches upstream directly |
| ✗ | Stop Forum Spam, DDG Tracker Radar, Disconnect, Safe Browsing, Cloudflare Radar | non-commercial | skip unless WireCat stays non-commercial |
| ✗ | Spamhaus DBL, any DNSBL, enrichment APIs | per-sender lookup | never at runtime |
| ✗ | OISD | no licence | skip |
| ✗ | Blocklist Project | archived 2026-10-27 | skip, or freeze a copy (Unlicense) |
| ✗ | OpenCorporates | ODbL plus paid bulk, few websites | skip |

## Q2. Card payments and mail categories

### How finance does it

| System | Classifies | Granularity | Notes |
|---|---|---|---|
| **MCC** (ISO 18245, assigned by card networks) | the **merchant**, once, at onboarding | 4-digit codes, several hundred (hypothesis; the ISO page returned 403) | Coarse and often wrong for marketplaces (hypothesis). Analogue for us: **sector per sender domain**. |
| **Plaid Personal Finance Category** | each **transaction** | 16 primary / 104 detailed (observed, [CSV](https://plaid.com/documents/transactions-personal-finance-category-taxonomy.csv)) | primaries: INCOME, TRANSFER_IN/OUT, LOAN_PAYMENTS, BANK_FEES, ENTERTAINMENT, FOOD_AND_DRINK, GENERAL_MERCHANDISE, HOME_IMPROVEMENT, MEDICAL, PERSONAL_CARE, GENERAL_SERVICES, GOVERNMENT_AND_NON_PROFIT, TRANSPORTATION, TRAVEL, RENT_AND_UTILITIES |
| **Ntropy** | each transaction: entities with roles (counterparty, intermediary), category per account-holder type and direction | category sets per holder type (observed, [docs](https://docs.ntropy.com/enrichment/introduction)) | Matches names against its own entity database. **Lesson:** separate the *intermediary* (Stripe, PayPal) from the *counterparty*. In mail this is ESP vs. brand. |
| **Tink, TrueLayer** | similar merchant + category enrichment | — | not checked 2026-11-25 |

**What carries over (interpretation):**

- Use two axes:
  - **sector**: who the sender is, slow-changing, from lists;
  - **message type**: what this mail is, from the message itself.
- Mark the intermediary. A mail signed by `sendgrid.net` but from `brand.com` belongs to `brand.com`; the ESP is the "intermediary".
- Every enrichment API is a per-item network call, so **taxonomy inspiration only**. We cannot use any of them.

### Signals that already sit in the message (all local)

| Signal | Source | What it says |
|---|---|---|
| `Auto-Submitted: auto-generated` / `auto-replied` | [RFC 3834](https://www.rfc-editor.org/rfc/rfc3834) (observed) | machine-sent / automatic reply; `no` or absent = maybe human |
| `List-Id` | RFC 2919 (hypothesis: not re-read) | mailing list or newsletter stream |
| `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` | RFC 2369 / 8058; required by Gmail and Yahoo for marketing and subscribed mail (observed) | marketing/subscribed. Its absence *weakly* points to transactional mail. |
| `Feedback-ID: a:b:c:SenderId` | Gmail Postmaster FBL (observed, [doc](https://support.google.com/a/answer/6254652)) | bulk stream from a large sender/ESP; the fields often name the campaign or type |
| `Precedence: bulk / list / junk` | legacy (hypothesis) | bulk |
| schema.org JSON-LD / microdata `@type` | [Gmail markup](https://developers.google.com/workspace/gmail/markup/overview) (observed: highlights for bus, car rental, flight, event, order, parcel delivery, hotel, invoice, restaurant, train) | exact type: FlightReservation, Order, ParcelDelivery, Invoice, EventReservation… |
| `text/calendar` part (METHOD REQUEST/CANCEL) | iCalendar | invite |
| `multipart/report` (delivery-status, disposition-notification) | RFC 3462/3464 (hypothesis) | bounce / read receipt |
| `In-Reply-To` / `References` to a message the owner sent; owner wrote to this address before | local history | conversation with a person |
| From local-part (`receipts@`, `noreply@`, `security@`, `news@`) | Gmail asks senders to keep one From address per category (observed) | type hint |
| Body: one-time codes, "sign-in", "password reset", amounts with currency, tracking numbers | local regex/model | security, bill, shipping |
| Tracker/ad hosts in links and pixels (Hagezi, 1Hosts) | section B | marketing |

**Gmail's own split** (observed, [help](https://support.google.com/mail/answer/3094499)):

- Primary;
- Social (social networks);
- Promotions (sales, discounts);
- Updates (receipts, alerts, statements, reminders);
- Forums (communities, mailing lists).

This is coarse but well known to users. Map our types onto it so a user can compare.

### Proposed message-type taxonomy (IDEA-2)

Per message. Evaluate in this order; the first match wins. Sector is a separate field.

| # | Type | Gmail tab | Strongest local signals |
|---|---|---|---|
| 1 | `bounce` / `auto_reply` | Updates | `multipart/report`; `Auto-Submitted: auto-replied`; MAILER-DAEMON |
| 2 | `security` (OTP, sign-in alert, password reset, 2FA) | Updates | short code in the body; local-part `security`/`no-reply`; sector bank/social/any; no List-Unsubscribe |
| 3 | `calendar` (invite, update, cancel) | Primary | `text/calendar` part |
| 4 | `travel` (flight, train, bus, hotel, car) | Updates | schema.org *Reservation; sector airline/travel |
| 5 | `event_ticket` | Updates | EventReservation |
| 6 | `order` (confirmation, receipt) | Updates | schema.org Order; amount + order number; sector shop |
| 7 | `shipping` | Updates | ParcelDelivery; tracking number; sector delivery |
| 8 | `bill` (invoice, statement, payment due, payment made) | Updates | schema.org Invoice; amount + due date; sector bank/telecom/utility/government |
| 9 | `account_notice` (terms change, service notice, account activity) | Updates | `Auto-Submitted: auto-generated`; no List-Unsubscribe-Post |
| 10 | `social_notification` | Social | sector social; `List-Unsubscribe` |
| 11 | `forum_list` | Forums | `List-Id` + `List-Post` (discussion list), many distinct human From addresses |
| 12 | `newsletter` | Promotions/Updates | `List-Id` / `List-Unsubscribe-Post`; sector news; long article body |
| 13 | `promotion` | Promotions | `List-Unsubscribe-Post`; `Feedback-ID`; ESP DKIM; tracker pixels; price/discount words |
| 14 | `system_alert` (monitoring, CI, cron) | Updates | `Auto-Submitted: auto-generated`; From a tool domain (GitHub, Sentry…) |
| 15 | `personal` | Primary | person sender (not bot/org), reply chain, owner wrote before |
| 16 | `other` | — | fallback |

**Sector** (per sender, MCC-like):

- keep the current 9 sectors: airline, bank, financial, telecom, social, shop, delivery, news, government;
- add, from UT1/NSI/Wikidata: `travel` (hotel, booking), `health`, `education`, `utility`, `insurance`, `software_saas`, `gaming_gambling`, `adult`, `freemail`.

IAB Content Taxonomy 3.0 is the richer option if we ever need topics (observed that 3.0 exists; the repo names CC BY 3.0 for OpenRTB, and the taxonomy licence is unclear, [repo](https://github.com/InteractiveAdvertisingBureau/Taxonomies)). Google product taxonomy is for products in an order, not senders ([page](https://support.google.com/merchants/answer/6324436); licence not stated). Neither is needed for v1 (interpretation).

## Q3. Distribution

### How others do it

| Who | Model | Fact |
|---|---|---|
| **tldts** (PSL) | compiled into the npm package; updates = new npm release | v7.5.6, 3,022,070 bytes unpacked (observed, `npm view`). README mentions no runtime download (observed). |
| **Google Safe Browsing v5** | local hashed lists, updated in the background by `hashLists.batchGet`. Unknown URLs: query a 4-byte prefix, optionally via an Oblivious HTTP relay | (observed, [reference](https://developers.google.com/safe-browsing/reference)) |
| **Pi-hole / AdGuard / uBlock Origin** | ship list *URLs*; the client fetches upstream on a schedule | (hypothesis: from how Firebog lists are consumed) |
| **Hagezi** | many mirrors (GitHub, GitLab, Codeberg, own build mirror) | (observed) |
| **ML models in WireCat** | downloaded once by a command | (owner's brief) |

### Recommendation (IDEA-3)

1. **Bundle, under ~1 MB gz:**
   - Wikidata orgs (CC0);
   - PSL;
   - disposable + free-mail (MIT);
   - NSI join, FDIC, BIC→LEI.

   This works offline on first run and needs no licence text beyond a NOTICE file.
2. **Data pack** (`wirecat data update` or similar):
   - **what:** one versioned archive on WireCat's own release asset (GitHub Releases), with a sha256 and a `SOURCES.md` that gives the licence, attribution and date per source;
   - **contents:** UT1 (BY-SA), Hagezi categories (GPL-3), Spamhaus DROP, abuse.ch CC0 feeds;
   - **why:** share-alike data stays a separate "database" with its own licence, instead of mixing into the MIT/CC0 core (interpretation; not legal advice);
   - **updates:** data ships without an npm release, which fits the push-less CI rule.
3. **Upstream-direct fetch** for sources we may not redistribute, or that need the user's own key: abuse.ch URLhaus/ThreatFox, PhishTank, OpenPhish. The command downloads the whole file from the source. The source sees only "this IP downloaded the list", never a sender.
4. The privacy line holds for all three: whole files only, matching on the owner's machine.

## Open gaps

- **RISK-2:** ESP, BIMI and bulk-sender lists do not exist publicly. They need our own build-time harvest. Effort is not estimated.
- **RISK-3:** licence status is unclear for PhishTank, OpenPhish, the GLEIF mapping files and the DMOZ archive. Read the terms before shipping any of them.
- **NEED-a:** will WireCat ever charge money? If yes, every NC source (Stop Forum Spam, Disconnect, DDG Tracker Radar, Safe Browsing, the StevenBlack extensions) is out now. If no, they become options.
- Not checked: Tink and TrueLayer categories, ISO 18245 (403), Cloudflare Radar categories (403), the official UT1 site (503), the Crunchbase ODM (404), Curlie dump status.
