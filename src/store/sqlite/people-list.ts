import { CliError } from "@wirecat/cli-base"
import { isNoReplyAddress, isRoleAddress } from "../../domain/addresses.js"
import { displayName, isReadable, nameKey } from "../../domain/display-names.js"
import { spellings, variantKey } from "../../domain/name-variants.js"
import {
  isAutomatedName,
  isCompanyName,
  type KindSignal,
  PERSON_KINDS,
  type PersonKind,
} from "../../domain/person-kinds.js"
import { type CacheDatabase, isQueryOnly, type SqlValue } from "../driver.js"
import { fold } from "../normalize.js"
import { mergedAwaySql } from "./merged-persons.js"
import { ALWAYS_SHOWN, type ShownBecause, shownReasons } from "./person-ties.js"
import { mergedAssignees } from "./task-board.js"
import { read, writeBatch } from "./transaction.js"

export const PEOPLE_SORTS = ["interactions", "recent", "name", "tasks"] as const
export type PeopleSort = (typeof PEOPLE_SORTS)[number]

export interface PeopleListOptions {
  /** Part of a name or username, at least 3 characters. */
  query?: string
  /** One kind, `person` by default, or `all`. */
  kind?: PersonKind | "all"
  /**
   * The owner first, then `interactions`: most messages and mail from them; `recent`: newest contact; `name`; `tasks`:
   * how many tasks name them. Equal rows by name.
   */
  sort?: PeopleSort
  limit: number
  offset?: number
}

export interface ListedPerson {
  person: string
  /** As stored; `displayName` is what to show. */
  name: string | null
  displayName: string | null
  kind: PersonKind
  /** What decided the kind: the ties for a `person`, else the signal. */
  kindSignals: (ShownBecause | KindSignal)[]
  owner: boolean
  tasks: number
  /** The one to show beside the name: the phone, else the email, else `@username`. */
  contact: string | null
  username: string | null
  /** Where `username` comes from, `telegram` or `max`, so `@name` is shown as that messenger's. */
  usernameSource: string | null
  phone: string | null
  email: string | null
  /** Messages and mail this person sent, every account together. */
  messagesFrom: number
  /** The newest of their messages, their mail and their one-to-one chat's last message, as ISO time. */
  lastContact: string | null
  /** Why they are shown; empty for someone hidden by default. */
  ties: ShownBecause[]
}

export interface PeopleList {
  items: ListedPerson[]
  hasMore: boolean
  /** The people of the kind asked over every page. */
  total: number
  /** How many of each kind match the query. */
  counts: Record<PersonKind, number>
}

export interface SimilarPerson extends ListedPerson {
  /** The same name once case, quotes, punctuation and word order are set aside: maybe the same person. */
  sameName: boolean
}

const MIN_QUERY = 3

const ftsPhrase = (text: string) => `"${text.replaceAll('"', '""')}"`

const matching = (query: string | undefined): { sql: string; params: SqlValue[] } => {
  if (query === undefined) return { sql: "", params: [] }
  const text = query.trim()
  if (text.length < MIN_QUERY)
    throw new CliError("validation_error", `a people search takes at least ${MIN_QUERY} characters, got "${query}"`)
  const forms = [...new Set([text, ...spellings(text)])]
  const like = (form: string) => `%${form.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  return {
    sql:
      " AND (p.id IN (SELECT l.person_id FROM identity_links l WHERE l.identity_id IN " +
      "(SELECT rowid FROM identities_fts WHERE identities_fts MATCH ?)) OR " +
      forms.map(() => "p.name LIKE ? ESCAPE '\\'").join(" OR ") +
      ")",
    params: [forms.map(ftsPhrase).join(" OR "), ...forms.map(like)],
  }
}

const TASK_COUNTS =
  "WITH merged AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS now FROM json_each(?)) " +
  "SELECT coalesce(m.now, a.assignee_id) AS person, count(DISTINCT t.id) AS n FROM task_assignments a " +
  "JOIN tasks t ON t.id = a.task_id AND t.deleted_at IS NULL LEFT JOIN merged m ON m.id = a.assignee_id " +
  "WHERE a.assignee_type = 'person' GROUP BY 1"

/** The people a query covers: everyone, or the ones in its one JSON parameter. */
type Scope = readonly number[] | "all"

const IN_SCOPE = (scope: Scope, column: string) =>
  scope === "all" ? "1" : `${column} IN (SELECT value FROM json_each(?))`
const scopeParams = (scope: Scope): SqlValue[] => (scope === "all" ? [] : [JSON.stringify(scope)])
const SCOPED_IDENTITIES = (scope: Scope) =>
  `SELECT identity_id FROM identity_links WHERE ${IN_SCOPE(scope, "person_id")}`

/** Counted over `messages_by_sender_identity_id` alone: no message row is read. */
const MESSAGE_COUNTS = (scope: Scope) =>
  "SELECT l.person_id AS person, sum(x.n) AS n FROM (SELECT sender_identity_id AS identity, count(*) AS n FROM " +
  `messages WHERE sender_identity_id ${scope === "all" ? "IS NOT NULL" : `IN (${SCOPED_IDENTITIES(scope)})`} ` +
  "GROUP BY 1) x JOIN identity_links l ON l.identity_id = x.identity GROUP BY 1"

const MAIL_COUNTS = (scope: Scope) =>
  "SELECT l.person_id AS person, count(*) AS n, sum(EXISTS (SELECT 1 FROM email_mailboxes m " +
  "JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.email_id = e.id AND b.kind = 'bulk')) AS bulk " +
  "FROM emails e JOIN identity_links l ON l.identity_id = e.from_identity_id " +
  `WHERE e.outgoing IS NOT 1 AND e.deleted_at IS NULL AND ${IN_SCOPE(scope, "l.person_id")} GROUP BY 1`

const IDENTITIES = (scope: Scope) =>
  "SELECT l.person_id AS person, i.id, i.provider, i.external_id, i.name, i.username, i.phone, i.email, i.bot " +
  `FROM identity_links l JOIN identities i ON i.id = l.identity_id WHERE ${IN_SCOPE(scope, "l.person_id")} ORDER BY i.id`

/** Few identities have these; one pass each beats a lookup per identity. */
const NEVER_REPLIED = "SELECT identity_id FROM account_identities WHERE mail_signals LIKE '%bulk_never_replied%'"
const OWNED = "SELECT identity_id FROM organization_identities"

const LAST_CONTACTS = (identities: string) =>
  `SELECT l.person_id AS person, max(t) AS at FROM (` +
  `SELECT sender_identity_id AS identity, max(sent_at) AS t FROM messages WHERE sender_identity_id IN (${identities}) ` +
  "AND deleted_at IS NULL GROUP BY 1 UNION ALL " +
  `SELECT from_identity_id, max(coalesce(sent_at, received_at)) FROM emails WHERE from_identity_id IN (${identities}) ` +
  "AND deleted_at IS NULL GROUP BY 1 UNION ALL " +
  `SELECT identity_id, max(last_messaged_at) FROM account_identities WHERE identity_id IN (${identities}) GROUP BY 1` +
  ") x JOIN identity_links l ON l.identity_id = x.identity GROUP BY 1"

/** Everything a person's kind and row are made from, gathered once for every person. */
interface Facts {
  name: string | null
  username: string | null
  usernameSource: string | null
  phone: string | null
  email: string | null
  emails: string[]
  bot: boolean
  neverReplied: boolean
  organization: boolean
}

const factsOf = (database: CacheDatabase, scope: Scope): Map<number, Facts> => {
  const facts = new Map<number, Facts>()
  const text = (value: unknown) => (value == null || value === "" ? null : String(value))
  const ids = (sql: string) =>
    new Set(
      database
        .prepare(sql)
        .all()
        .map((row) => Number(row.identity_id)),
    )
  const neverReplied = ids(NEVER_REPLIED)
  const owned = ids(OWNED)
  for (const row of database.prepare(IDENTITIES(scope)).all(...scopeParams(scope))) {
    const person = Number(row.person)
    const one = facts.get(person) ?? {
      name: null,
      username: null,
      usernameSource: null,
      phone: null,
      email: null,
      emails: [],
      bot: false,
      neverReplied: false,
      organization: false,
    }
    const email = text(row.email) ?? (row.provider === "email" ? text(row.external_id) : null)
    if (one.name === null && isReadable(displayName(text(row.name)))) one.name = text(row.name)
    if (one.username === null && text(row.username) !== null) {
      one.username = text(row.username)
      one.usernameSource = String(row.provider)
    }
    one.phone ??= text(row.phone) ?? (row.provider === "phone" ? text(row.external_id) : null)
    one.email ??= email
    if (email !== null) one.emails.push(email)
    one.bot ||= Number(row.bot) === 1
    one.neverReplied ||= neverReplied.has(Number(row.id))
    one.organization ||= owned.has(Number(row.id))
    facts.set(person, one)
  }
  return facts
}

const countsOf = (database: CacheDatabase, sql: string, ...params: SqlValue[]): Map<number, number> =>
  new Map(
    database
      .prepare(sql)
      .all(...params)
      .map((row) => [Number(row.person), Number(row.n)]),
  )

const lastContacts = (database: CacheDatabase, scope: Scope): Map<number, number> =>
  new Map(
    database
      .prepare(LAST_CONTACTS(SCOPED_IDENTITIES(scope)))
      .all(...scopeParams(scope), ...scopeParams(scope), ...scopeParams(scope))
      .filter((row) => row.at != null)
      .map((row) => [Number(row.person), Number(row.at)]),
  )

interface Candidate {
  id: number
  name: string | null
  owner: boolean
}

interface Classified extends Omit<ListedPerson, "lastContact"> {
  id: number
  /** Worked out once: a collator over 50,000 names takes most of a list's time. */
  nameOrder: string
}

/** One misfiled letter is no newsletter. */
const BULK_MIN = 3

/** The first rule that holds; the list's contract in the people-clients-digests plan names the same order. */
const kindOf = (
  shown: string | null,
  facts: Facts | undefined,
  ties: ShownBecause[],
  mail: { n: number; bulk: number } | undefined,
): { kind: PersonKind; signals: (ShownBecause | KindSignal)[] } => {
  const always = ties.filter((tie) => (ALWAYS_SHOWN as readonly string[]).includes(tie))
  if (always.length > 0) return { kind: "person", signals: ties }
  const emails = facts?.emails ?? []
  const automated: KindSignal[] = [
    ...(facts?.bot ? (["bot"] as const) : []),
    ...(emails.some(isNoReplyAddress) ? (["no-reply"] as const) : []),
    ...(mail !== undefined && mail.n >= BULK_MIN && mail.bulk * 2 > mail.n ? (["bulk-mail"] as const) : []),
    ...(facts?.neverReplied ? (["bulk-never-replied"] as const) : []),
    ...(isAutomatedName(shown) ? (["automated-name"] as const) : []),
  ]
  if (automated.length > 0) return { kind: "automated", signals: automated }
  const organization: KindSignal[] = [
    ...(facts?.organization ? (["organization"] as const) : []),
    ...(emails.length > 0 && emails.every(isRoleAddress) ? (["role-address"] as const) : []),
    ...(isCompanyName(shown) ? (["company-name"] as const) : []),
  ]
  if (organization.length > 0) return { kind: "organization", signals: organization }
  if (!isReadable(shown)) return { kind: "unsorted", signals: ["no-name"] }
  if (ties.length === 0) return { kind: "stranger", signals: ["no-tie"] }
  return { kind: "person", signals: ties }
}

/** Each person with their kind, contact and counts; the last contact is added for the page alone. */
const classified = (
  database: CacheDatabase,
  people: readonly Candidate[],
  scope: Scope,
  reasons = shownReasons(database, scope === "all" ? undefined : scope),
): Classified[] => {
  const facts = factsOf(database, scope)
  const tasks = countsOf(database, TASK_COUNTS, mergedAssignees(database))
  const messages = countsOf(database, MESSAGE_COUNTS(scope), ...scopeParams(scope))
  const mail = new Map(
    database
      .prepare(MAIL_COUNTS(scope))
      .all(...scopeParams(scope))
      .map((row) => [Number(row.person), { n: Number(row.n), bulk: Number(row.bulk) }]),
  )
  return people.map(({ id, name, owner }) => {
    const own = facts.get(id)
    const contact = { username: own?.username ?? null, phone: own?.phone ?? null, email: own?.email ?? null }
    const shown = displayName(name, { ...contact, name: own?.name ?? null })
    const ties = reasons.get(id) ?? []
    const { kind, signals } = kindOf(shown, own, ties, mail.get(id))
    return {
      id,
      nameOrder: nameOrderOf(shown),
      person: `person:${id}`,
      name,
      displayName: shown,
      kind,
      kindSignals: signals,
      owner,
      tasks: tasks.get(id) ?? 0,
      contact:
        contact.phone ?? contact.email ?? (contact.username === null ? null : `@${contact.username.replace(/^@/, "")}`),
      ...contact,
      usernameSource: own?.usernameSource ?? null,
      messagesFrom: (messages.get(id) ?? 0) + (mail.get(id)?.n ?? 0),
      ties,
    }
  })
}

const withLastContact = (
  database: CacheDatabase,
  people: Classified[],
  known?: Map<number, number>,
): ListedPerson[] => {
  const at =
    known ??
    lastContacts(
      database,
      people.map(({ id }) => id),
    )
  return people.map(({ id, nameOrder: _, ...person }) => {
    const time = at.get(id)
    return { ...person, lastContact: time === undefined ? null : new Date(time).toISOString() }
  })
}

/** Sorted as read, case and accents aside; a name with nothing to read goes last. */
const nameOrderOf = (shown: string | null) => `${isReadable(shown) ? 0 : 1}${fold(shown ?? "")}`

const byName = (a: Classified, b: Classified) =>
  a.nameOrder < b.nameOrder ? -1 : a.nameOrder > b.nameOrder ? 1 : a.id - b.id

/**
 * Bump when what decides a kind, a name's order or a count changes in code (the word lists, `BULK_MIN`, the ties):
 * every stored one is worked out again on the next list.
 */
const KIND_RULES = "2"
const RULES_KEY = "people.kind_rules"
/** Past this many people to work out, one pass over everyone beats a lookup per person. */
const WHOLE_PASS = 20_000
/** About 0.7 s of work on 113,000 people: well inside another writer's 5 s wait for the lock. */
const UNDER_LOCK = 5_000
const TRIES = 3

const dataVersion = (database: CacheDatabase): number =>
  Number(Object.values(database.prepare("PRAGMA data_version").get() ?? {})[0])

const rulesOf = (database: CacheDatabase): string | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(RULES_KEY)
  return row === undefined ? undefined : String(row.value)
}

const candidateOf = (row: Record<string, unknown>): Candidate => ({
  id: Number(row.id),
  name: row.name == null ? null : String(row.name),
  owner: Number(row.owner) === 1,
})

/** Stored for a person a merge emptied, so a list leaves them out without asking each person. */
const MERGED = "merged"

interface Worked extends Omit<Classified, "kind"> {
  kind: PersonKind | typeof MERGED
  lastContact: number | undefined
}

/** The people whose stored kind is not current, worked out; `undefined` when there are none. */
const workOut = (database: CacheDatabase, all: boolean, most?: number): Worked[] | undefined => {
  const rows = database
    .prepare(
      `SELECT id, name, owner, ${mergedAwaySql("p")} AS merged FROM persons p` +
        `${all ? "" : " WHERE kind IS NULL"}${most === undefined ? "" : ` LIMIT ${most + 1}`}`,
    )
    .all()
  if (rows.length === 0 && !all) return undefined
  if (most !== undefined && rows.length > most) return undefined
  const merged = new Set(rows.filter((row) => Number(row.merged) === 1).map((row) => Number(row.id)))
  const stale = rows.map(candidateOf)
  const scope: Scope = all || stale.length > WHOLE_PASS ? "all" : stale.map(({ id }) => id)
  const contacts = lastContacts(database, scope)
  return classified(database, stale, scope).map((person) => ({
    ...person,
    kind: merged.has(person.id) ? MERGED : person.kind,
    lastContact: contacts.get(person.id),
  }))
}

const keep = (database: CacheDatabase, worked: Worked[]): void => {
  const row = database.prepare(
    "UPDATE persons SET kind = ?, name_order = ?, messages_from = ?, task_count = ?, last_contact = ? WHERE id = ?",
  )
  for (const person of worked)
    row.run(person.kind, person.nameOrder, person.messagesFrom, person.tasks, person.lastContact ?? null, person.id)
  database
    .prepare(
      "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
    )
    .run(RULES_KEY, KIND_RULES, Date.now())
}

/**
 * Works out and keeps the kind, name order and counts of every person whose stored ones the triggers cleared.
 * A few, as a sync leaves, are worked out under the write lock. Everyone, after an upgrade, would hold the lock for
 * seconds: that pass runs outside it and is kept only when no other process wrote meanwhile, else it runs again.
 * Answers whether every stored one is current.
 */
const storeKinds = (database: CacheDatabase): boolean => {
  if (isQueryOnly(database))
    return (
      rulesOf(database) === KIND_RULES &&
      database.prepare("SELECT 1 FROM persons WHERE kind IS NULL LIMIT 1").get() === undefined
    )
  if (
    rulesOf(database) === KIND_RULES &&
    database.prepare("SELECT 1 FROM persons WHERE kind IS NULL LIMIT 1").get() === undefined
  )
    return true
  const few = writeBatch(database, () => {
    if (rulesOf(database) !== KIND_RULES) return false
    const worked = workOut(database, false, UNDER_LOCK)
    if (worked !== undefined) keep(database, worked)
    return (
      worked !== undefined || database.prepare("SELECT 1 FROM persons WHERE kind IS NULL LIMIT 1").get() === undefined
    )
  })
  if (few) return true
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const before = dataVersion(database)
    const worked = read(database, () => workOut(database, rulesOf(database) !== KIND_RULES))
    if (worked === undefined) return true
    const kept = writeBatch(database, () => {
      if (dataVersion(database) !== before) return false
      keep(database, worked)
      return true
    })
    if (kept) return true
  }
  return false
}

const STORED_ORDER: Record<PeopleSort, string> = {
  interactions: "p.messages_from DESC, ",
  tasks: "p.task_count DESC, ",
  recent: "coalesce(p.last_contact, 0) DESC, ",
  name: "",
}

const noCounts = (): Record<PersonKind, number> =>
  Object.fromEntries(PERSON_KINDS.map((one) => [one, 0])) as Record<PersonKind, number>

const storedCounts = (database: CacheDatabase, filter: { sql: string; params: SqlValue[] }) => {
  const counts = noCounts()
  for (const row of database
    .prepare(`SELECT p.kind, count(*) AS n FROM persons p WHERE p.kind <> '${MERGED}'${filter.sql} GROUP BY 1`)
    .all(...filter.params))
    if ((PERSON_KINDS as readonly unknown[]).includes(row.kind)) counts[row.kind as PersonKind] = Number(row.n)
  return counts
}

const checked = (options: PeopleListOptions) => {
  const { kind = "person", sort = "interactions" } = options
  if (kind !== "all" && !PERSON_KINDS.includes(kind))
    throw new CliError("validation_error", `a person's kind is one of ${PERSON_KINDS.join(", ")} or all, got "${kind}"`)
  if (!PEOPLE_SORTS.includes(sort))
    throw new CliError("validation_error", `people sort by ${PEOPLE_SORTS.join(", ")}, got "${sort}"`)
  return { kind, sort, filter: matching(options.query) }
}

/** How many people of each kind match the query, every kind at once. */
export const countPeople = (database: CacheDatabase, query?: string): Record<PersonKind, number> => {
  const filter = matching(query)
  return storeKinds(database) ? storedCounts(database, filter) : listInMemory(database, { limit: 0, query }).counts
}

/** People of one kind, the owner first, in the order asked; `counts` says how many each kind holds. */
export const listPeople = (database: CacheDatabase, options: PeopleListOptions): PeopleList => {
  const { kind, sort, filter } = checked(options)
  if (!storeKinds(database)) return listInMemory(database, options)
  const { limit, offset = 0 } = options
  return read(database, () => {
    const counts = storedCounts(database, filter)
    const total = kind === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[kind]
    const rows = database
      .prepare(
        `SELECT p.id, p.name, p.owner, p.last_contact FROM persons p WHERE p.kind ${kind === "all" ? "<>" : "="} ?` +
          `${filter.sql} ORDER BY p.owner DESC, ${STORED_ORDER[sort]}p.name_order, p.id LIMIT ? OFFSET ?`,
      )
      .all(kind === "all" ? MERGED : kind, ...filter.params, limit, offset)
    const page = rows.map(candidateOf)
    const contacts = new Map(
      rows.filter((row) => row.last_contact != null).map((row) => [Number(row.id), Number(row.last_contact)]),
    )
    return {
      items: withLastContact(
        database,
        classified(
          database,
          page,
          page.map(({ id }) => id),
        ),
        contacts,
      ),
      hasMore: total > offset + limit,
      total,
      counts,
    }
  })
}

/** The list worked out for every person on the call, for a read-only store whose stored kinds are not current. */
const listInMemory = (database: CacheDatabase, options: PeopleListOptions): PeopleList => {
  const { kind, sort, filter } = checked(options)
  const { limit, offset = 0 } = options
  const candidates = database
    .prepare(`SELECT p.id, p.name, p.owner FROM persons p WHERE NOT ${mergedAwaySql("p")}${filter.sql}`)
    .all(...filter.params)
    .map(candidateOf)
  // A search reads only the people it found; a whole list reads everyone once rather than per person.
  const everyone = classified(
    database,
    candidates,
    options.query === undefined ? "all" : candidates.map(({ id }) => id),
  )
  const counts = noCounts()
  for (const person of everyone) counts[person.kind] += 1
  const chosen = kind === "all" ? everyone : everyone.filter((person) => person.kind === kind)
  // The newest contact of every person reads every message; only this order needs it.
  const recent = sort === "recent" ? lastContacts(database, "all") : undefined
  const order: (a: Classified, b: Classified) => number =
    sort === "name"
      ? byName
      : sort === "tasks"
        ? (a, b) => b.tasks - a.tasks || byName(a, b)
        : sort === "recent"
          ? (a, b) => (recent?.get(b.id) ?? 0) - (recent?.get(a.id) ?? 0) || byName(a, b)
          : (a, b) => b.messagesFrom - a.messagesFrom || byName(a, b)
  const sorted = chosen.sort((a, b) => Number(b.owner) - Number(a.owner) || order(a, b))
  return {
    items: withLastContact(database, sorted.slice(offset, offset + limit), recent),
    hasMore: sorted.length > offset + limit,
    total: sorted.length,
    counts,
  }
}

const words = (key: string | null): string[] => (key === null ? [] : key.split(" "))

/**
 * Every typed word starts a word of the name, in any order: «iv pet» finds Petrov Ivan. Script and spelling aside,
 * so «Светлана» finds Svetlana (BUG-678).
 */
const startsEach = (typed: string[], name: string | null) => {
  const own = words(variantKey(name))
  return typed.every((word) => own.some((one) => one.startsWith(word)))
}

/**
 * People whose name, or a name of one of their identities, has a word starting with each typed word, for a form
 * that adds a person: the same name first (maybe a duplicate), then those with a tie to the owner, then by name.
 */
export const similarPeople = (database: CacheDatabase, typed: string, limit: number): SimilarPerson[] => {
  const key = variantKey(typed)
  const wanted = words(key)
  const longest = words(nameKey(typed)).reduce((a, b) => (b.length > a.length ? b : a), "")
  if (longest === "") return []
  const named = new Map<number, string[]>()
  const note = (person: number, name: unknown) => {
    if (typeof name === "string") named.set(person, [...(named.get(person) ?? []), name])
  }
  // A person added by hand has no identity to search; there are few, and SQLite folds only ASCII case.
  for (const row of database
    .prepare(
      "SELECT p.id, p.name FROM persons p WHERE p.name IS NOT NULL " +
        `AND NOT EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = p.id) AND NOT ${mergedAwaySql("p")}`,
    )
    .all())
    note(Number(row.id), row.name)
  const identityRows =
    longest.length >= MIN_QUERY
      ? database
          .prepare(
            "SELECT l.person_id AS person, i.name, i.username FROM identities_fts f JOIN identities i ON i.id = f.rowid " +
              "JOIN identity_links l ON l.identity_id = i.id WHERE identities_fts MATCH ?",
          )
          .all(spellings(longest).map(ftsPhrase).join(" OR "))
      : database
          .prepare(
            "SELECT l.person_id AS person, i.name, i.username FROM identities i " +
              "JOIN identity_links l ON l.identity_id = i.id WHERE i.name_folded LIKE ? ESCAPE '\\'",
          )
          .all(`%${fold(longest).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  for (const row of identityRows) {
    note(Number(row.person), row.name)
    note(Number(row.person), row.username)
  }
  const found = [...named]
    .filter(([, names]) => names.some((name) => startsEach(wanted, name)))
    .map(([person, names]) => ({
      person,
      name: names[0] ?? "",
      same: names.some((name) => variantKey(name) === key),
    }))
  if (found.length === 0) return []
  const ties = shownReasons(database)
  const chosen = found
    .sort(
      (a, b) =>
        Number(b.same) - Number(a.same) ||
        Number(ties.has(b.person)) - Number(ties.has(a.person)) ||
        a.name.localeCompare(b.name) ||
        a.person - b.person,
    )
    .slice(0, limit)
  const sameName = new Map(chosen.map(({ person, same }) => [person, same]))
  const people = database
    .prepare("SELECT id, name, owner FROM persons WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify([...sameName.keys()]))
    .map((row) => ({
      id: Number(row.id),
      name: row.name == null ? null : String(row.name),
      owner: Number(row.owner) === 1,
    }))
  const byId = new Map(people.map((person) => [person.id, person]))
  const ordered = [...sameName.keys()].flatMap((id) => byId.get(id) ?? [])
  const rows = classified(database, ordered, [...sameName.keys()], ties)
  const same = rows.map(({ id }) => sameName.get(id) === true)
  return withLastContact(database, rows).map((person, at) => ({ ...person, sameName: same[at] === true }))
}
