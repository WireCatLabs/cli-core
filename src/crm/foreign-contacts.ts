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

/** Where the day's count of one CRM account is kept, whose copy is one user's: the CLI's state folder. */
export const foreignContactsPathFor = (
  app: AppIdentity,
  account: AccountKey,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  join(
    resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state,
    "crm",
    "foreign-contacts",
    `${`${account.provider}-${account.account}`.replace(/[^\w.-]+/gu, "_")}.json`,
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

const stripped = <T extends Live>(record: T): T => {
  const { phones: _phones, emails: _emails, email: _email, phone: _phone, ...rest } = record as CrmPerson
  return rest as T
}

export interface ForeignContacts {
  /** Phones and e-mails kept only on the sign-in's own clients; an administrator's list comes back as it was. */
  strip<T extends Live>(kind: CrmLiveKind, records: T[]): Promise<T[]>
  /** One record shown whole: a foreign one spends one of the day's slots, the same one again that day is free. */
  spend(kind: CrmLiveKind, record: Live): Promise<void>
}

/**
 * The shared rule over one source, for anyone but the CRM's administrator. A source without `isAdmin` is not
 * limited. The count is read and written under a file lock, so two runs never both take the day's last slot.
 */
export const foreignContacts = (
  source: CrmSource,
  file: () => string,
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
    async spend(kind, record) {
      if (!(await limited()) || (await own(kind, [record])).has(record.externalId)) return
      const key = `${kind}:${record.externalId}`
      const path = file()
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
