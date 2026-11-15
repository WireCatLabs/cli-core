import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import type { CrmOrganization, CrmPerson } from "../domain/crm.js"
import type { AppIdentity } from "../ports/app.js"
import { withFileLockAsync } from "../sends/file-lock.js"
import type { AccountKey } from "../store/types.js"
import type { CrmLiveKind, CrmSource } from "./source.js"

/** The owner's rule (NEED-2487): a user sees at most this many other contacts' or companies' details a UTC day. */
export const DAILY_FOREIGN_CONTACTS = 100

type Live = CrmPerson | CrmOrganization

/** Where the day's count of one CRM user is kept: the CLI's state folder, a file per account and user. */
export const foreignContactsPathFor = (
  app: AppIdentity,
  account: AccountKey,
  env: NodeJS.ProcessEnv = process.env,
  user?: string,
): string =>
  join(
    resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state,
    "crm",
    "foreign-contacts",
    `${[account.provider, account.account, ...(user ? [user] : [])].join("-").replace(/[^\w.-]+/gu, "_")}.json`,
  )

interface Shown {
  day: string
  seen: string[]
}

const shownIn = (file: string, day: string): Shown => {
  try {
    const found = JSON.parse(readFileSync(file, "utf8")) as Partial<Shown>
    return found.day === day && Array.isArray(found.seen) ? { day, seen: found.seen.map(String) } : { day, seen: [] }
  } catch {
    return { day, seen: [] }
  }
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/u
const PHONE = /^\+?[\d\s().-]{7,}$/u
const DATE = /^\d{4}-\d{2}-\d{2}/u
const digits = (text: string) => text.replace(/\D+/gu, "")

/** A metadata value that holds a phone or an e-mail, or one of the record's own, in any of its texts. */
const contactIn = (value: unknown, known: ReadonlySet<string>): boolean => {
  if (Array.isArray(value)) return value.some((one) => contactIn(one, known))
  if (value && typeof value === "object") return Object.values(value).some((one) => contactIn(one, known))
  if (typeof value !== "string" && typeof value !== "number") return false
  const text = String(value).trim()
  return (
    EMAIL.test(text) ||
    (PHONE.test(text) && !DATE.test(text) && digits(text).length >= 7) ||
    known.has(digits(text) || text)
  )
}

const stripped = <T extends Live>(record: T): T => {
  const { phones, emails, email, phone, contactTypes: _types, ...rest } = record as CrmPerson
  const known = new Set(
    [...(phones ?? []), ...(emails ?? []), email, phone]
      .filter((one): one is string => !!one)
      .map((one) => digits(one) || one),
  )
  const metadata = (rest as { metadata?: Record<string, unknown> }).metadata
  if (metadata)
    (rest as { metadata?: Record<string, unknown> }).metadata = Object.fromEntries(
      Object.entries(metadata).filter(([, one]) => !contactIn(one, known)),
    )
  return rest as T
}

export interface ForeignContacts {
  /** Phones and e-mails kept only on the sign-in's own clients; an administrator's list comes back as it was. */
  strip<T extends Live>(kind: CrmLiveKind, records: T[]): Promise<T[]>
  /** Whether the sign-in may see this record whole: its own client, or an administrator's or unlimited CRM's. */
  own(kind: CrmLiveKind, record: Live): Promise<boolean>
  /** One record shown whole: a foreign one spends one of the day's slots, the same one again that day is free. */
  spend(kind: CrmLiveKind, record: Live): Promise<void>
}

/**
 * The shared rule over one source, for anyone but the CRM's administrator. A source without `isAdmin` is not
 * limited. The count is read and written under a file lock, so two runs never both take the day's last slot.
 */
export const foreignContacts = (
  source: CrmSource,
  /** The day's count file; a caller that only strips, such as a write, passes none and spends nothing. */
  file: (() => string | Promise<string>) | undefined,
  options: { now?: () => number; lockWaitMs?: number } = {},
): ForeignContacts => {
  let admin: Promise<boolean> | undefined
  const limited = async () => {
    if (!source.isAdmin) return false
    admin ??= source.isAdmin()
    return !(await admin)
  }
  const own = async (kind: CrmLiveKind, records: readonly Live[]): Promise<Set<string>> => {
    const self = source.self ? String(await source.self()) : undefined
    const mine = new Set(records.filter((one) => self && one.assignee === self).map((one) => one.externalId))
    const rest = records.filter((one) => !mine.has(one.externalId)).map((one) => one.externalId)
    if (rest.length && source.ownClients) for (const id of await source.ownClients(kind, rest)) mine.add(id)
    return mine
  }
  return {
    async strip(kind, records) {
      if (!(await limited()) || records.length === 0) return records
      const mine = await own(kind, records)
      return records.map((one) => (mine.has(one.externalId) ? one : stripped(one)))
    },
    async own(kind, record) {
      return !(await limited()) || (await own(kind, [record])).has(record.externalId)
    },
    async spend(kind, record) {
      if (!(await limited()) || (await own(kind, [record])).has(record.externalId)) return
      const key = `${kind}:${record.externalId}`
      if (!file) throw new Error("foreignContacts: spend needs the count file")
      const path = await file()
      const day = new Date(options.now?.() ?? Date.now()).toISOString().slice(0, 10)
      await withFileLockAsync(
        path,
        "the day's count of foreign contacts",
        () => {
          const shown = shownIn(path, day)
          if (shown.seen.includes(key)) return
          if (shown.seen.length >= DAILY_FOREIGN_CONTACTS)
            throw new CliError(
              "permission_error",
              `${DAILY_FOREIGN_CONTACTS} contacts and companies that are not your clients were shown today, the ` +
                "most a day; your own clients are not counted, and the CRM's administrator has no limit",
              { reason: "crm.foreign-contacts-spent", limit: DAILY_FOREIGN_CONTACTS },
            )
          writeSecurely(path, JSON.stringify({ day, seen: [...shown.seen, key] }), 0o600)
        },
        options.lockWaitMs,
      )
    },
  }
}

/**
 * `api call` of a method that returns contacts or companies or their contact data: only the CRM's administrator
 * makes it (NEED-2488), since one raw list would hand over the whole client base past the day's limit. The CLI knows
 * its methods and says which read clients; a source without `isAdmin` is not limited.
 */
export const refuseForeignClientReads = async (source: CrmSource, readsClients: boolean, method: string) => {
  if (!readsClients || !source.isAdmin || (await source.isAdmin())) return
  throw new CliError(
    "permission_error",
    `${method} reads contacts or companies, which only the CRM's administrator reads through api call: your ` +
      `clients come with sync, and another one with people show or organizations show, ${DAILY_FOREIGN_CONTACTS} a day`,
    { reason: "crm.client-reads-admin-only", sent: false },
  )
}
