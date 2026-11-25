import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { isPackFreeMailDomain } from "../../domain/domain-lists.js"
import { isFreeMailDomain } from "../../domain/organization-sectors.js"
import { SENDER_BOT_PREFIX } from "../../domain/person-kinds.js"
import { listIdOf } from "../../mail/headers.js"
import { MAIL_TYPES, type MailType } from "../../mail/mail-types.js"
import { FREE_MAIL, isDisposableDomain } from "../../mail/score.js"
import {
  SORT_SCOPES,
  type SortAuthor,
  type SortedMail,
  type SortIndex,
  type SortScope,
  sortIndexOf,
  sortRuleFor,
  sortValueOf,
} from "../../mail/sort-rules.js"
import type { Decider } from "../decisions.js"
import type { CacheDatabase } from "../driver.js"
import { holdAddress } from "./address-organization.js"
import { currentPerson } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { holdingAuthorOf, moveToBot, moveToPerson, putBack } from "./sender-bots.js"
import { LIST_ID } from "./sender-signals.js"
import { read, write } from "./transaction.js"

/** One sorting rule. @experimental */
export interface SortRule {
  id: number
  scope: SortScope
  /** The email's id, the List-Id, the subject pattern, the address or the registrable domain, as kept. */
  value: string
  mailType: MailType | null
  sender: "bot" | "person" | null
  /** `organization:<id>`. */
  organization: string | null
  overAddresses: boolean
  /** `false`: only mail dated from `createdAt` on. */
  past: boolean
  author: SortAuthor
  decidedBy: string | null
  reason: string | null
  createdAt: number
  updatedAt: number
  removedAt: number | null
}

/** A correction as the caller names it: its scope, and whether past mail is sorted too. @experimental */
export interface SortRuleInput {
  scope: SortScope
  /** An email's id, a List-Id, a subject pattern, an address or a domain (kept as its registrable domain). */
  value: string | number
  mailType?: MailType
  /** The owner's only; at `address` or `domain` scope; moves the sender for its whole history. */
  sender?: "bot" | "person"
  /** `organization:<id>`; the owner's only; at `address` or `domain` scope. */
  organization?: string
  /** A domain rule that beats the address rules at its domain. */
  overAddresses?: boolean
  /** `all`: mail already in the store too; `new`: only mail dated from now on. Always named. */
  applyTo: "all" | "new"
  reason?: string
}

/** What a rule would touch, before it is set. @experimental */
export interface SortPreview {
  scope: SortScope
  value: string
  /** The scope in words: "every mail from the domain gmail.com". */
  label: string
  applyTo: "all" | "new"
  /** The domain is a free-mail or throwaway one: the rule needs `confirm`. */
  freeMail: boolean
  /** Distinct sender addresses its scope takes in. */
  addresses: number
  /** Incoming emails its scope takes in. */
  emails: number
  /** Of those, the emails whose type it would set now: a narrower rule or a past one left out. */
  retyped: number
  /** Senders it would move to a bot or a person, or file under the organization. */
  senders: number
  /** Pass to `add` to set a free-mail domain rule; it holds while these counts do. */
  confirm: string | null
}

/** @experimental */
export interface SortAddResult {
  applied: boolean
  preview: SortPreview
  rule?: SortRule
}

/** A scope a correction of one email may take, narrowest first: the domain is never offered first. @experimental */
export interface SortScopeChoice {
  scope: SortScope
  value: string
  label: string
  /** A free-mail or throwaway domain: a rule there needs a dry run and its `confirm`. */
  freeMail: boolean
}

/** @experimental */
export interface SortUndo {
  undid: "add" | "remove"
  rule: SortRule
}

/** @experimental */
export interface MailSorting {
  /** Live rules, newest first; `removed` lists the removed ones instead. */
  rules(options?: { scope?: SortScope; removed?: boolean }): Promise<SortRule[]>
  /** The scopes a correction of this email may take. */
  scopes(email: number): Promise<SortScopeChoice[]>
  /**
   * Sets a rule, or with `dryRun` only says what it would touch. A domain rule on a free-mail or throwaway domain is
   * set only with the `confirm` of a dry run whose counts still hold. A program's rule sets a mail type only.
   */
  add(input: SortRuleInput, by: Decider, options?: { dryRun?: boolean; confirm?: string }): Promise<SortAddResult>
  /** Removes a rule: its mail is typed again without it, and the senders it moved go back. */
  remove(rule: number, by: Decider): Promise<SortRule>
  /** Takes back the owner's newest add or removal not yet undone; `null` when there is none. */
  undo(by: Decider): Promise<SortUndo | null>
  /**
   * The owner's manual sorting of one sender, an address or a `person:` or `sender-bot:` ref, removed: its address
   * rules and its one-mail rules. Domain and list rules stay. Answers the rules removed.
   */
  reset(sender: string, by: Decider): Promise<SortRule[]>
}

const COLUMNS =
  "id, scope, value, mail_type, sender, organization_id, over_addresses, past, author, decided_by, reason, " +
  "created_at, updated_at, removed_at"

const ruleOf = (row: Record<string, unknown>): SortRule => ({
  id: Number(row.id),
  scope: String(row.scope) as SortScope,
  value: String(row.value),
  mailType: row.mail_type == null ? null : (String(row.mail_type) as MailType),
  sender: row.sender == null ? null : (String(row.sender) as "bot" | "person"),
  organization: row.organization_id == null ? null : `organization:${row.organization_id}`,
  overAddresses: Number(row.over_addresses) === 1,
  past: Number(row.past) === 1,
  author: String(row.author) as SortAuthor,
  decidedBy: row.decided_by == null ? null : String(row.decided_by),
  reason: row.reason == null ? null : String(row.reason),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  removedAt: row.removed_at == null ? null : Number(row.removed_at),
})

const liveRules = (database: CacheDatabase): SortRule[] =>
  database.prepare(`SELECT ${COLUMNS} FROM mail_sort_rules WHERE removed_at IS NULL`).all().map(ruleOf)

/** The live rules that set a mail type, filed for `sortRuleFor`. */
export const typeRulesOf = (database: CacheDatabase): SortIndex<SortRule> =>
  sortIndexOf(liveRules(database).filter((rule) => rule.mailType !== null))

/** A free-mail or throwaway domain, whose addresses belong to anyone: a rule there sorts strangers together. */
export const isSharedMailDomain = (domain: string): boolean =>
  FREE_MAIL.has(domain) || isFreeMailDomain(domain) || isPackFreeMailDomain(domain) || isDisposableDomain(domain)

const fail = (message: string, reason: string): never => {
  throw new CliError("validation_error", message, { reason })
}

const labelOf = (scope: SortScope, value: string): string =>
  ({
    mail: `the mail ${value}`,
    list: `every mail of the list ${value}`,
    subject: `every mail whose subject has "${value}"`,
    address: `every mail from ${value}`,
    domain: `every mail from the domain ${value}`,
  })[scope]

const MAIL_ROWS =
  "SELECT e.id, lower(e.from_address) AS address, e.from_identity_id AS identity, e.subject, " +
  `${LIST_ID} AS list, coalesce(e.received_at, e.sent_at) AS at FROM emails e ` +
  "WHERE e.deleted_at IS NULL AND e.outgoing IS NOT 1"

interface MailRow extends SortedMail {
  identity: number | null
}

const mailRowOf = (row: Record<string, unknown>): MailRow => ({
  id: Number(row.id),
  from: typeof row.address === "string" ? row.address : null,
  subject: typeof row.subject === "string" ? row.subject : null,
  list: typeof row.list === "string" ? (listIdOf(row.list) ?? null) : null,
  at: row.at == null ? null : Number(row.at),
  identity: row.identity == null ? null : Number(row.identity),
})

/** The incoming emails a rule's scope takes in, whatever wins over it. */
const inScope = (database: CacheDatabase, scope: SortScope, value: string): MailRow[] => {
  const where = {
    mail: ["e.id = ?", [Number(value)]],
    list: [`${LIST_ID} IS NOT NULL`, []],
    subject: ["e.subject IS NOT NULL", []],
    address: ["lower(e.from_address) = ?", [value]],
    domain: ["(lower(e.from_address) LIKE ? OR lower(e.from_address) LIKE ?)", [`%@${value}`, `%.${value}`]],
  } as const
  const [sql, params] = where[scope]
  const alone = sortIndexOf([{ id: 0, scope, value, author: "owner", overAddresses: false, past: true, createdAt: 0 }])
  return database
    .prepare(`${MAIL_ROWS} AND ${sql}`)
    .all(...params)
    .map(mailRowOf)
    .filter((row) => sortRuleFor(alone, row) !== undefined)
}

const ADDRESS_ONLY = { subject: null, list: null, at: Number.MAX_SAFE_INTEGER }

/** Where an identity sits now: `sender-bot:<id>`, `person:<id>` or `null`. */
const holderOf = (database: CacheDatabase, identity: number): string | null => {
  const bot = database.prepare("SELECT bot_id FROM sender_bot_identities WHERE identity_id = ?").get(identity)
  if (bot !== undefined) return `${SENDER_BOT_PREFIX}${bot.bot_id}`
  const person = database.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(identity)
  return person === undefined ? null : `person:${person.person_id}`
}

/** Where an identity sits now and who put it there, as an effect's `before` keeps it: `sender-bot:4 rules`. */
const heldOf = (database: CacheDatabase, identity: number): string | null => {
  const holder = holderOf(database, identity)
  return holder === null ? null : `${holder} ${holdingAuthorOf(database, identity)}`
}

const holderIn = (held: string | null): string | null => (held === null ? null : (held.split(" ")[0] ?? null))

const isWhere = (holder: string | null, sender: "bot" | "person") =>
  holder?.startsWith(sender === "bot" ? SENDER_BOT_PREFIX : "person:") === true

interface Sender {
  identity: number
  address: string
}

const sendersOf = (database: CacheDatabase, identities?: readonly number[]): Sender[] =>
  database
    .prepare(
      "SELECT DISTINCT e.from_identity_id AS identity, i.external_id AS address FROM emails e " +
        "JOIN identities i ON i.id = e.from_identity_id WHERE i.provider = 'email' AND e.outgoing IS NOT 1 " +
        "AND e.deleted_at IS NULL" +
        (identities === undefined ? "" : " AND e.from_identity_id IN (SELECT value FROM json_each(?))"),
    )
    .all(...(identities === undefined ? [] : [JSON.stringify(identities)]))
    .map((row) => ({ identity: Number(row.identity), address: String(row.address).toLowerCase() }))

const hasEffect = (database: CacheDatabase, rule: number, identity: number, action: string) =>
  database
    .prepare(
      "SELECT 1 FROM mail_sort_effects WHERE rule_id = ? AND identity_id = ? AND action = ? AND undone_at IS NULL",
    )
    .get(rule, identity, action) !== undefined

const recordEffect = (
  database: CacheDatabase,
  effect: { rule: number; identity: number; action: string; before: string | null; after: string | null; at: number },
) =>
  database
    .prepare(
      "INSERT INTO mail_sort_effects (rule_id, identity_id, action, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(effect.rule, effect.identity, effect.action, effect.before, effect.after, effect.at)

const ownerSenderRules = (database: CacheDatabase) => {
  const rules = liveRules(database).filter(
    (rule) => rule.author === "owner" && (rule.scope === "address" || rule.scope === "domain"),
  )
  return {
    sender: sortIndexOf(rules.filter((rule) => rule.sender !== null)),
    organization: sortIndexOf(rules.filter((rule) => rule.organization !== null)),
  }
}

/** Whether any rule moves senders or files them: sync then settles the senders it stored. */
export const hasSenderRules = (database: CacheDatabase): boolean =>
  database
    .prepare(
      "SELECT 1 FROM mail_sort_rules WHERE removed_at IS NULL AND author = 'owner' " +
        "AND (sender IS NOT NULL OR organization_id IS NOT NULL) LIMIT 1",
    )
    .get() !== undefined

/**
 * Each sender the winning rule has not acted on yet moves to a bot or a person through `moveToBot` and `moveToPerson`,
 * or is filed under the rule's organization, and the effect is logged so a removal can put it back. A sender already
 * where the rule says is logged as left. The caller holds the write lock.
 */
export const settleSenders = (context: StoreContext, identities?: readonly number[]): void => {
  const { database } = context
  const rules = ownerSenderRules(database)
  if (rules.sender.size === 0 && rules.organization.size === 0) return
  for (const { identity, address } of sendersOf(database, identities)) {
    const mail = { id: 0, from: address, ...ADDRESS_ONLY }
    const at = context.now()
    const mover = sortRuleFor(rules.sender, mail)
    if (mover?.sender && !hasEffect(database, mover.id, identity, "sender")) {
      const before = heldOf(database, identity)
      if (!isWhere(before, mover.sender)) moveSender(context, address, mover)
      recordEffect(database, {
        rule: mover.id,
        identity,
        action: "sender",
        before,
        after: holderOf(database, identity),
        at,
      })
    }
    const filer = sortRuleFor(rules.organization, mail)
    if (filer?.organization && !hasEffect(database, filer.id, identity, "organization")) {
      const organization = Number(filer.organization.slice("organization:".length))
      const held =
        database
          .prepare("SELECT 1 FROM organization_identities WHERE identity_id = ? AND organization_id = ?")
          .get(identity, organization) !== undefined
      if (!held) holdAddress(context, organization, address, { method: SORT_METHOD, author: "owner" })
      recordEffect(database, {
        rule: filer.id,
        identity,
        action: "organization",
        before: held ? "held" : null,
        after: filer.organization,
        at,
      })
    }
  }
}

const SORT_METHOD = "sort-rule"

const moveSender = (context: StoreContext, address: string, rule: SortRule) => {
  const subject = { provider: "email" as const, id: address }
  const reason = rule.reason ?? `mail sorting rule ${rule.id}`
  if (rule.sender === "person") return void moveToPerson(context, subject, { reason })
  try {
    moveToBot(context, subject, { reason })
  } catch (error) {
    // The owner's own address under a domain rule stays the owner's.
    if (!(error instanceof CliError && error.details?.reason === "sender-bot.owner")) throw error
  }
}

/** Each move takes about 10 ms: 100 per write keeps another writer's 5 s wait for the lock far away. */
const SETTLE_CHUNK = 100

/**
 * A waiting writer polls the lock every 100 ms at most (SQLite's busy handler): back-to-back writes never let it in,
 * and it gives up after 5 s however short each write is. A pause longer than its poll does.
 */
const letOthersIn = () => new Promise((resolve) => setTimeout(resolve, 150))

/** Whether the sender is still where the rule put it: else the owner moved it since, and that stands. */
const stillAfter = (database: CacheDatabase, identity: number, after: string | null): boolean => {
  const now = holderOf(database, identity)
  if (now === after) return true
  return (
    after?.startsWith("person:") === true &&
    now === `person:${currentPerson(database, Number(after.slice("person:".length)))}`
  )
}

/**
 * Puts back what removed rules did to up to `SETTLE_CHUNK` senders, newest effect first, each to its holder and author
 * before the rule, then lets the rules still live settle them. Answers whether more may be left. The caller holds
 * the write lock.
 */
const putBackChunk = (context: StoreContext): boolean => {
  const { database } = context
  const identities = database
    .prepare(
      "SELECT DISTINCT f.identity_id AS identity FROM mail_sort_effects f JOIN mail_sort_rules r ON r.id = f.rule_id " +
        "WHERE r.removed_at IS NOT NULL AND f.undone_at IS NULL ORDER BY f.identity_id LIMIT ?",
    )
    .all(SETTLE_CHUNK)
    .map((row) => Number(row.identity))
  if (identities.length === 0) return false
  const effects = database
    .prepare(
      "SELECT f.id, f.identity_id, f.action, f.before, f.after FROM mail_sort_effects f " +
        "JOIN mail_sort_rules r ON r.id = f.rule_id WHERE r.removed_at IS NOT NULL AND f.undone_at IS NULL " +
        "AND f.identity_id IN (SELECT value FROM json_each(?)) ORDER BY f.id DESC",
    )
    .all(JSON.stringify(identities))
  const at = context.now()
  for (const effect of effects) {
    const identity = Number(effect.identity_id)
    const before = effect.before == null ? null : String(effect.before)
    const after = effect.after == null ? null : String(effect.after)
    const holder = holderIn(before)
    if (effect.action === "sender" && holder !== null && holder !== after && stillAfter(database, identity, after))
      putBack(context, identity, holder, before?.endsWith(" owner") ? "owner" : "rules")
    if (effect.action === "organization" && before === null)
      database
        .prepare("DELETE FROM organization_identities WHERE identity_id = ? AND organization_id = ? AND method = ?")
        .run(identity, Number(String(after).slice("organization:".length)), SORT_METHOD)
    database.prepare("UPDATE mail_sort_effects SET undone_at = ? WHERE id = ?").run(at, Number(effect.id))
  }
  settleSenders(context, identities)
  return identities.length === SETTLE_CHUNK
}

/** Each removed rule's senders put back a write at a time; a stopped run resumes on the next change of rules. */
const putBackInChunks = async (context: StoreContext) => {
  while (write(context.database, () => putBackChunk(context))) await letOthersIn()
}

const clearTypes = (database: CacheDatabase, ids: readonly number[]) =>
  database
    .prepare(
      "UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL " +
        "WHERE mail_type IS NOT NULL AND id IN (SELECT value FROM json_each(?))",
    )
    .run(JSON.stringify(ids))

const clearRuleTypes = (database: CacheDatabase, rule: SortRule) => {
  database
    .prepare(
      "UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL AND type_signal = ?",
    )
    .run(`rule:${rule.id}`)
  if (rule.mailType === null) return
  const index = sortIndexOf([...liveRules(database).filter((one) => one.mailType !== null && one.id !== rule.id), rule])
  clearTypes(
    database,
    inScope(database, rule.scope, rule.value)
      .filter((row) => sortRuleFor(index, row)?.id === rule.id)
      .map((row) => row.id),
  )
}

interface Checked {
  scope: SortScope
  value: string
  mailType: MailType | null
  sender: "bot" | "person" | null
  organization: number | null
  overAddresses: boolean
  past: boolean
  author: SortAuthor
  decidedBy: string | null
  reason: string | null
}

const checked = (database: CacheDatabase, input: SortRuleInput, by: Decider): Checked => {
  if (!(SORT_SCOPES as readonly string[]).includes(input.scope))
    fail(`a rule's scope is one of ${SORT_SCOPES.join(", ")}`, "mail-sort.scope")
  if (input.applyTo !== "all" && input.applyTo !== "new")
    fail("a rule says whether it sorts past mail too: applyTo all or new", "mail-sort.apply-to")
  const value = sortValueOf(input.scope, input.value)
  if (value === undefined) return fail(`${String(input.value)} names no ${input.scope}`, "mail-sort.value")
  if (input.mailType !== undefined && !(MAIL_TYPES as readonly string[]).includes(input.mailType))
    fail(`a mail type is one of ${MAIL_TYPES.join(", ")}`, "mail-sort.mail-type")
  if (input.sender !== undefined && input.sender !== "bot" && input.sender !== "person")
    fail("a sender becomes a bot or a person", "mail-sort.sender")
  if (input.mailType === undefined && input.sender === undefined && input.organization === undefined)
    fail("a rule sets a mail type, a sender or an organization", "mail-sort.no-action")
  const owner = by === "owner"
  const onSender = input.sender !== undefined || input.organization !== undefined
  if (onSender && !owner) fail("only the owner's rule moves or files a sender", "mail-sort.owner-only")
  if (onSender && input.scope !== "address" && input.scope !== "domain")
    fail("a rule moves or files a sender at address or domain scope", "mail-sort.sender-scope")
  if (onSender && input.scope === "address" && input.applyTo === "new")
    fail("a sender moves with its whole history: an address rule that moves one applies to all", "mail-sort.sender-new")
  if (input.overAddresses && input.scope !== "domain")
    fail("only a domain rule can beat the address rules", "mail-sort.over-addresses")
  if (!owner && input.scope === "domain" && isSharedMailDomain(value))
    fail(`only the owner sets a rule on the free-mail domain ${value}`, "mail-sort.free-mail-program")
  const organization =
    input.organization === undefined
      ? null
      : Number(/^organization:([1-9]\d*)$/.exec(input.organization)?.[1] ?? Number.NaN)
  if (
    organization !== null &&
    (Number.isNaN(organization) ||
      database.prepare("SELECT 1 FROM organizations WHERE id = ? AND deleted_at IS NULL").get(organization) ===
        undefined)
  )
    fail(`${input.organization} is no organization in the store`, "mail-sort.organization")
  return {
    scope: input.scope,
    value,
    mailType: input.mailType ?? null,
    sender: input.sender ?? null,
    organization,
    overAddresses: input.overAddresses === true,
    past: input.applyTo === "all",
    author: owner ? "owner" : "program",
    decidedBy: owner ? null : by.bot,
    reason: input.reason ?? (owner ? null : by.reason),
  }
}

const previewOf = (database: CacheDatabase, rule: Checked, at: number): SortPreview => {
  const rows = inScope(database, rule.scope, rule.value)
  const candidate: SortRule = {
    id: -1,
    ...rule,
    organization: rule.organization === null ? null : `organization:${rule.organization}`,
    createdAt: at,
    updatedAt: at,
    removedAt: null,
  }
  const live = liveRules(database)
  const types = sortIndexOf([...live.filter((one) => one.mailType !== null), candidate])
  const retyped = rule.mailType === null ? 0 : rows.filter((row) => sortRuleFor(types, row)?.id === -1).length
  const movers = sortIndexOf([
    ...live.filter(
      (one) =>
        one.author === "owner" &&
        (rule.sender !== null ? one.sender !== null : one.organization !== null) &&
        (one.scope === "address" || one.scope === "domain"),
    ),
    candidate,
  ])
  const senders =
    (rule.sender === null && rule.organization === null) || !rule.past
      ? 0
      : sendersOf(database, [...new Set(rows.flatMap((row) => row.identity ?? []))]).filter(
          ({ identity, address }) =>
            sortRuleFor(movers, { id: 0, from: address, ...ADDRESS_ONLY })?.id === -1 &&
            (rule.sender === null || !isWhere(holderOf(database, identity), rule.sender)),
        ).length
  const addresses = new Set(rows.flatMap((row) => row.from ?? [])).size
  const freeMail = rule.scope === "domain" && isSharedMailDomain(rule.value)
  const counts = { emails: rows.length, addresses, retyped, senders }
  return {
    scope: rule.scope,
    value: rule.value,
    label: labelOf(rule.scope, rule.value),
    applyTo: rule.past ? "all" : "new",
    freeMail,
    ...counts,
    confirm: freeMail
      ? createHash("sha256")
          .update(
            JSON.stringify([rule.scope, rule.value, rule.mailType, rule.sender, rule.organization, rule.past, counts]),
          )
          .digest("hex")
          .slice(0, 16)
      : null,
  }
}

const ruleById = (database: CacheDatabase, id: number): SortRule => {
  const row = database.prepare(`SELECT ${COLUMNS} FROM mail_sort_rules WHERE id = ?`).get(id)
  if (row === undefined)
    throw new CliError("not_found", `no mail sorting rule ${id}`, { reason: "mail-sort.not-found" })
  return ruleOf(row)
}

/** Makes a rule live: its mail is typed again. Answers the senders it names, for `settleInChunks`. */
const applyRule = (context: StoreContext, rule: SortRule): number[] => {
  const { database } = context
  clearRuleTypes(database, rule)
  if (rule.sender === null && rule.organization === null) return []
  const identities = [
    ...new Set(
      inScope(database, rule.scope, rule.value).flatMap((row) => (row.identity === null ? [] : [row.identity])),
    ),
  ]
  if (!rule.past)
    for (const { identity } of sendersOf(database, identities)) {
      const holder = holderOf(database, identity)
      const held = heldOf(database, identity)
      for (const action of [...(rule.sender ? ["sender"] : []), ...(rule.organization ? ["organization"] : [])])
        recordEffect(database, {
          rule: rule.id,
          identity,
          action,
          before: action === "sender" ? held : "held",
          after: action === "sender" ? holder : "held",
          at: context.now(),
        })
    }
  return identities
}

/** Settles senders a write at a time; a sender already settled is skipped, so a stopped run resumes on the next. */
const settleInChunks = async (context: StoreContext, identities: readonly number[]) => {
  for (let at = 0; at < identities.length; at += SETTLE_CHUNK) {
    if (at > 0) await letOthersIn()
    write(context.database, () => settleSenders(context, identities.slice(at, at + SETTLE_CHUNK)))
  }
}

/** A change's time, later than every change before it, so undo takes changes back in order within one millisecond. */
const stampOf = ({ database, now }: StoreContext): number =>
  Math.max(
    now(),
    Number(database.prepare("SELECT coalesce(max(updated_at), 0) + 1 AS at FROM mail_sort_rules").get()?.at),
  )

const takeOut = (context: StoreContext, rule: SortRule, undone: boolean) => {
  const at = stampOf(context)
  context.database
    .prepare("UPDATE mail_sort_rules SET removed_at = ?, updated_at = ?, undone_at = ? WHERE id = ?")
    .run(at, at, undone ? at : null, rule.id)
  const removed = ruleById(context.database, rule.id)
  clearRuleTypes(context.database, removed)
  return removed
}

const ownerOnly = (by: Decider, what: string) => {
  if (by !== "owner") fail(`only the owner ${what}`, "mail-sort.owner-only")
}

const addressesOf = (database: CacheDatabase, sender: string): string[] => {
  if (sender.includes("@") && !sender.includes(":")) return [sender.trim().toLowerCase()]
  const bot = sender.startsWith(SENDER_BOT_PREFIX) ? Number(sender.slice(SENDER_BOT_PREFIX.length)) : undefined
  const person = sender.startsWith("person:") ? Number(sender.slice("person:".length)) : undefined
  if (bot === undefined && person === undefined)
    return fail(`${sender} names no sender: give an address, a person: or a sender-bot: ref`, "mail-sort.sender-ref")
  return database
    .prepare(
      "SELECT lower(i.external_id) AS address FROM identities i WHERE i.provider = 'email' AND i.id IN " +
        (bot === undefined
          ? "(SELECT identity_id FROM identity_links WHERE person_id = ?)"
          : "(SELECT identity_id FROM sender_bot_identities WHERE bot_id = ?)"),
    )
    .all(bot ?? person ?? 0)
    .map((row) => String(row.address))
}

export const mailSortingOver = (context: StoreContext): MailSorting => {
  const { database } = context
  return {
    rules: async (options = {}) =>
      database
        .prepare(
          `SELECT ${COLUMNS} FROM mail_sort_rules WHERE removed_at IS ${options.removed ? "NOT NULL" : "NULL"}` +
            (options.scope === undefined ? "" : " AND scope = ?") +
            " ORDER BY updated_at DESC, id DESC",
        )
        .all(...(options.scope === undefined ? [] : [options.scope]))
        .map(ruleOf),
    scopes: async (email) =>
      read(database, () => {
        const row = database.prepare(`${MAIL_ROWS} AND e.id = ?`).get(email)
        if (row === undefined)
          throw new CliError("not_found", `no incoming email ${email}`, { reason: "mail-sort.email" })
        const mail = mailRowOf(row)
        const domain = mail.from === null ? undefined : sortValueOf("domain", mail.from)
        const choices: Omit<SortScopeChoice, "label" | "freeMail">[] = [
          { scope: "mail", value: String(mail.id) },
          ...(mail.list === null ? [] : [{ scope: "list" as const, value: mail.list }]),
          ...(mail.from === null ? [] : [{ scope: "address" as const, value: mail.from }]),
          ...(domain === undefined ? [] : [{ scope: "domain" as const, value: domain }]),
        ]
        return choices.map((choice) => ({
          ...choice,
          label: labelOf(choice.scope, choice.value),
          freeMail: choice.scope === "domain" && isSharedMailDomain(choice.value),
        }))
      }),
    add: async (input, by, options = {}) => {
      const { identities, ...result } = write(database, () => {
        const rule = checked(database, input, by)
        const at = stampOf(context)
        const preview = previewOf(database, rule, at)
        if (options.dryRun) return { applied: false, preview, identities: [] }
        if (preview.freeMail && options.confirm !== preview.confirm)
          fail(
            `${rule.value} is a free-mail domain: the rule would sort ${preview.addresses} addresses and ` +
              `${preview.emails} emails together. Run it with dryRun first and pass its confirm`,
            "mail-sort.confirm",
          )
        const id = Number(
          database
            .prepare(
              "INSERT INTO mail_sort_rules (scope, value, mail_type, sender, organization_id, over_addresses, past, " +
                "author, decided_by, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              rule.scope,
              rule.value,
              rule.mailType,
              rule.sender,
              rule.organization,
              rule.overAddresses ? 1 : 0,
              rule.past ? 1 : 0,
              rule.author,
              rule.decidedBy,
              rule.reason,
              at,
              at,
            )?.id,
        )
        const made = ruleById(database, id)
        return { applied: true, preview, rule: made, identities: applyRule(context, made) }
      })
      await settleInChunks(context, identities)
      return result
    },
    remove: async (id, by) => {
      const removed = write(database, () => {
        const rule = ruleById(database, id)
        if (by !== "owner" && (rule.author !== "program" || rule.decidedBy !== by.bot))
          fail("a program removes only the rules it made", "mail-sort.owner-only")
        if (rule.removedAt !== null) return rule
        return takeOut(context, rule, false)
      })
      await putBackInChunks(context)
      return removed
    },
    undo: async (by) => {
      const { identities, undone } = write(database, () => {
        ownerOnly(by, "undoes a sorting change")
        const row = database
          .prepare(
            `SELECT ${COLUMNS} FROM mail_sort_rules WHERE author = 'owner' AND undone_at IS NULL ` +
              "ORDER BY updated_at DESC, id DESC LIMIT 1",
          )
          .get()
        if (row === undefined) return { identities: [], undone: null }
        const rule = ruleOf(row)
        if (rule.removedAt === null)
          return { identities: [], undone: { undid: "add" as const, rule: takeOut(context, rule, true) } }
        // Back as it was added: its add is the next change an undo takes back.
        database
          .prepare("UPDATE mail_sort_rules SET removed_at = NULL, updated_at = created_at WHERE id = ?")
          .run(rule.id)
        const back = ruleById(database, rule.id)
        return { identities: applyRule(context, back), undone: { undid: "remove" as const, rule: back } }
      })
      await putBackInChunks(context)
      await settleInChunks(context, identities)
      return undone
    },
    reset: async (sender, by) => {
      const removed = write(database, () => {
        ownerOnly(by, "resets the manual sorting of a sender")
        const addresses = addressesOf(database, sender)
        const mails = database
          .prepare(
            "SELECT id FROM emails WHERE lower(from_address) IN (SELECT value FROM json_each(?)) AND outgoing IS NOT 1",
          )
          .all(JSON.stringify(addresses))
          .map((row) => String(row.id))
        return database
          .prepare(
            `SELECT ${COLUMNS} FROM mail_sort_rules WHERE removed_at IS NULL AND author = 'owner' AND ` +
              "((scope = 'address' AND value IN (SELECT value FROM json_each(?))) OR " +
              "(scope = 'mail' AND value IN (SELECT value FROM json_each(?)))) ORDER BY id DESC",
          )
          .all(JSON.stringify(addresses), JSON.stringify(mails))
          .map((row) => takeOut(context, ruleOf(row), false))
      })
      await putBackInChunks(context)
      return removed
    },
  }
}

/** The senders of mail just saved in these threads, settled by the rules that move or file senders. */
export const settleThreads = (context: StoreContext, threads: readonly number[]): void => {
  if (threads.length === 0 || !hasSenderRules(context.database)) return
  const identities = context.database
    .prepare(
      "SELECT DISTINCT from_identity_id AS identity FROM emails WHERE from_identity_id IS NOT NULL " +
        "AND outgoing IS NOT 1 AND email_thread_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(threads))
    .map((row) => Number(row.identity))
  if (identities.length > 0) settleSenders(context, identities)
}
