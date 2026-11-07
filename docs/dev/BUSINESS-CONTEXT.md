# Business contexts: person, organization, deal

Three read-only answers that join what the store knows about one canonical entity — its relationships, deals,
projects, money and communications — so memo, Desktop and MCP read the same thing. Code: `src/services/`
(`person-business.ts`, `organization-context.ts`, `deal-context.ts`, shared pieces in `business-context.ts`,
`communications.ts`, `money-context.ts`). Schemas: the shared entities `person_context`, `organization_context`,
`deal_context` and `deal_context.brief` (`src/entities/business-context.ts`). Relationships and standing:
[KNOWLEDGE.md](KNOWLEDGE.md#relationships).

## What every answer shares

- **Standing on each relationship.** A related entity (`Related`) appears once with all its `roles`; each role is
  a `link:` ref (or, for a `relationship` proposal waiting for the owner, its `proposal` id with `standing:
  proposed`), the kind, the role, its `standing` (`confirmed`, `reported`, `ended`, `proposed`), and, when the
  link has them, the reporting `account`, the source's `position`, how it was `derived`, and its dates. The ones
  still usable sort first; ended ones stay listed after them. Read through `knowledge.relations`, so `standingOf`
  is the only rule.
- **Bounded sections.** `{ items, total, hasMore, next }`: the first `limit` (20 by default), `total` the real
  count. A read that fills the store's page (500) sets `hasMore`, and `money.complete` is `false` when a finance read
  did. `next` is the one memo command that lists exactly the rest — `invoices list counterparty:"organization:3"`,
  `tasks list project:ATLA` — and `null` when there is none (rows reached two ways, several projects, stages,
  communications). The `relationships list about:…` words are memo's PR 8 contract.
- **Read scope.** `accounts?: AccountKey[]`, the caller's `--source`/group already resolved. Left out, every
  account in the store is read; never one picked. The scope holds for every row a source account reported: a CRM's
  relationships, its deals and leads (a deal context of a copy outside it is `not_found`, `deal.out-of-scope`) and
  each account's messages, mail and events. A row no account reported — the owner's, an agent's, every invoice,
  payment and order, which have no source account — is always in it. `coverage.accounts` names each account read;
  `coverage.notRead` (`{ source, reason }`, as memo's) names each account outside the scope and each source the
  person or people have nothing to read by: no messenger identity, no mail address, no calendar in scope; and each gap a CRM
  account in scope recorded in its last sync (`crmGapsOf`), such as reporting lines with no department list. A gap is
  named, never filled.
- **Deny levels.** `deniedKinds` (`deal`, `lead`), as the profile's `deals.list` / `leads.list` levels say: no row,
  title, ref or count of a denied kind appears anywhere, a deal context of one is refused (`deal.denied`), and
  `coverage.notRead` says `{ source: "deals", reason: "denied" }`. Relationship sections read through
  `knowledge.listRelations`, which applies the scope and the deny in SQL.
- **Communications.** One-to-one chats, mail with their address and calendar events they are invited to, in the
  accounts read; a group chat is not read, since what another member wrote there is not theirs. Each message, mail
  and event counts once however many of the people it involves. The owner is never one of the people read, even as a
  participant or a member: through him every chat of his would count. A Zoom recording counts only through its
  calendar event.

## Person — `canonicalPersonContext(store, "person:<uid>", options)`

Any canonical person: a CRM contact or user with no messenger, a name the owner added with no identity, someone
seen by several accounts. Every identity is read in every stored account of its provider that saw it, inside the
scope. Returns the sections of `personContext` (`shared`, `last`, `recent`, `mentions`, `events`, `limits`,
`hasMore`, `complete`, `notRead` for chats not held whole), `person` as the canonical record (`uid`, `name`,
`identities`), and:

- `business.organizations` (`member-of`, with each organization's categories), `reportsTo`, `directReports`
  (`reports-to` read backwards), `deals` (deals and leads they are on, with their deal roles), `projects`,
  `categories` (`client` when they are `customer-of` an own organization);
- `coverage`.

`personContext(store, asked, reference)`, the messenger-anchored answer tg, max and wa render, is unchanged.

## Organization — `organizationContext(store, "organization:<id>", options)`

`organization` (with `own`), `categories`, `people` (`member-of` it), `customers` (`customer-of` it), `suppliers`
(it is `customer-of` them: "supplier of"), `partners`, `projects` (its own by `projects.organization_id` and its
deals' projects, `via` saying which), `deals` (open deals and leads it is the client of), `money`, `communications`
(counts only, through its people whose membership is usable), `tasks` (open tasks of its projects), `coverage`.

## Deal or lead — `dealContext(store, "deal:<id>" | "lead:<id>", options)`, `dealBrief(context)`

`deal` (the stored row: its status is the CRM's or the owner's), `stages` (each stage it entered, in order),
`organization` (with categories), `participants` (its `related-to` people with roles and standing), `owner` (the
participant whose usable role is `owner`), `project` (on a CRM copy too: `deals.setProject` writes the store's own
field, which the sync never touches), `money`, `window` (creation to the end of the day it closed,
or `now`), `communications` (what its participants said or met within the window, each `standing: "proposed"`: an
overlap of people, not a link; with `counts`), `tasks` (open tasks of its project), `coverage`. `dealBrief` is the
compact form for a model: names, role lists with one standing each, money totals, counts, the newest stages, gaps.

## Money

Invoices and payments as `store.finance` holds them; orders (organization only) where it is the customer or the
supplier. A rejected row is left out; a proposed one is listed with its `review` and never summed. `totals` sums
confirmed rows per status (payments: direction) and currency; nothing is converted. A payment is never inferred
from an invoice, nor a payment or a contract from a stage named "Won". In a deal, each row says how it was
reached, `linkedBy: ["project", "counterparty"]`, and appears once.

## Categories — `organizationCategories(store, scope)`, `knowledge.organizations(query, { category })`

Derived at read time from usable relationships, never stored (NEED-2377); `knowledge.organizations(query, {
category, accounts })` filters by one in SQL for `organizations list category:<c>`: `client` is `customer-of` an own
organization, `supplier` one an own organization is `customer-of`, `partner` `partner-of` one, `employer` one the
owner's person is `member-of` as `employee`, `contractor` or `founder`. Own organizations are
`organizations.metadata.own`: the owner's mark (`knowledge.setOwnOrganization`, `own_by: "owner"`), which a sync
never changes, else a CRM's own-company flag.

## Testing

`acmeScenario(store)` in `@wirecat/cli-core/crm/testing` builds plan §8's synthetic scenario through the CRM sync
and the store's own calls: Northstar Consulting (own, the CRM portal), Acme Ltd (its client), Alice and Bob
(Acme's CRM contacts), Emma (a portal user, Northstar's sales owner and the deal's), the deal "Acme renewal" with
project Atlas set by the owner on the CRM copy, a Telegram dialog with Alice, a mail from Bob, a Zoom call with the
three, an unpaid invoice and an open task. `crm.put` and `sync()` change it as the CRM would.
