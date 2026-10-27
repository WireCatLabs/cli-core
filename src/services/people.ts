import { CliError } from "@wirecat/cli-base"
import { type Predicate, queryError } from "@wirecat/cli-base/query"
import type { Chat, Contact, Id, Member, Page, PersonCard, PersonProfile, PhoneBookEntry } from "../domain/models.js"
import { isCliFailure } from "../errors/failures.js"
import { capability } from "../ports/messenger.js"
import { pickPerson } from "../resolve.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { AccountKey, MessageStore, PersonRecord } from "../store/store.js"
import type { PageWindow } from "./chats.js"
import { fromStore, type ServiceDeps, storeIfOpen } from "./deps.js"

import { storedChatId } from "./message-resolution.js"
import {
  CHAT_MESSAGES,
  type ContextOptions,
  type Detail,
  identityIn,
  type PersonContext,
  type PersonMessages,
  personContext,
  personMessages,
} from "./person-context.js"
import { type PersonPreparation, personPreparation } from "./person-preparation.js"
import { personProfile } from "./person-profile.js"
import { type PersonTimeline, personTimeline, type TimelineOptions } from "./person-timeline.js"

export interface ContactSync {
  added: number
  changed: number
  known: number
}

/**
 * A contact is somebody this account has a one-to-one chat with — a query over the chat list, never
 * a flag somebody maintains (max-cli `NEED-105`). Where the store holds who is in each one-to-one
 * chat, it answers; otherwise the dialogs themselves do, offline from the stored chats.
 */
export interface PeopleService {
  /**
   * `name` matches the name, the local alias or the @username, as the store searches them; `notes` the owner's
   * private notes. Both are answered only from the contacts the store keeps: never filtered in memory.
   */
  list(options: { order: "recent" | "name"; name?: Predicate; notes?: Predicate } & PageWindow): Promise<Page<Contact>>
  show(person: string, options?: { notes?: boolean }): Promise<PersonCard>
  /** What the messenger says about them, and their stored activity in each shared chat. */
  profile(person: string): Promise<PersonProfile>
  /** `phone` as digits, parsed by the caller (`phoneOf`). */
  lookup(phone: string): Promise<Member>
  /** The whole contact list from the messenger into the store: what was new, what changed. */
  sync(): Promise<ContactSync>
  add(person: string): Promise<Operated<{ person: Member }>>
  remove(person: string): Promise<Operated<{ personId: Id }>>
  block(person: string): Promise<Operated<{ personId: Id }>>
  unblock(person: string): Promise<Operated<{ personId: Id }>>
  rename(person: string, firstName: string, lastName?: string): Promise<Operated<{ person: Member }>>
  /** What the store holds about them, across every messenger linked to them; never connects. */
  context(person: string, options?: ContextOptions): Promise<PersonContext>
  /** `context` and what to know before talking to them: chats waiting on you, tasks, facts, notes, meetings. */
  prepare(person: string, options?: ContextOptions & { notes?: boolean }): Promise<PersonPreparation>
  /** Everything they took part in, from the store's involvement index; never connects. */
  timeline(person: string, options?: TimelineOptions): Promise<PersonTimeline>
  /**
   * Their newest messages in each chat named, from the store; `fetch` reads them from the messenger
   * first — by sender where it can search so, the newest page of the chat where it cannot.
   */
  messagesIn(
    person: string,
    options: { chats: string[]; limit?: number; detail?: Detail; fetch?: boolean },
  ): Promise<PersonMessages>
  /** `other` may name another messenger of the store: `max:Ana`. */
  link(person: string, other: string, method?: string): Promise<PersonRecord>
  unlink(person: string): Promise<PersonRecord>
  /**
   * Only counts and the people recognised: never a number. `IMPORT_CHUNK` numbers a request, each request
   * through the guard, each number counted toward the hourly limit.
   */
  import(entries: PhoneBookEntry[]): Promise<Operated<{ sent: number; recognised: Member[] }>>
}

type ContactAction = "contact-add" | "contact-remove" | "contact-block" | "contact-unblock" | "contact-rename"

export const peopleService = (deps: ServiceDeps): PeopleService => {
  const localCard = async (card: PersonCard, includeNotes = false): Promise<PersonCard> => {
    const held = await storeIfOpen(deps)
    if (
      !held ||
      !(await held.store.people.people(held.account.provider, { account: held.account.account })).get(card.id)
    )
      return card
    const local = await held.store.people.privateContact(held.account, card.id)
    return {
      ...card,
      ...(local.alias === null ? {} : { alias: local.alias, displayName: local.alias }),
      ...(!includeNotes || local.notes.length === 0 ? {} : { notes: local.notes }),
    }
  }
  const referenceOf = async (reference: string) => {
    const held = await storeIfOpen(deps)
    if (!held) return reference
    const lookup = await held.store.people.people(held.account.provider, { account: held.account.account })
    const wanted = reference.trim().toLowerCase()
    return lookup.all().some((person) => person.alias?.toLowerCase().includes(wanted))
      ? pickPerson(reference, lookup).id
      : reference
  }
  const online = async (command: string) => {
    if (deps.offline)
      throw new CliError("validation_error", `\`${command}\` changes the address book; not with --offline`)
    return deps.connection()
  }
  const change = async <T>(
    action: ContactAction,
    person: string,
    act: (connection: Awaited<ReturnType<ServiceDeps["connection"]>>, personId: Id) => Promise<T>,
  ): Promise<{ operationId: string; personId: Id; done: T }> => {
    const connection = await online(`contacts ${action.slice("contact-".length)}`)
    const [personId] = await capability(connection, "people", "find people")([await referenceOf(person)])
    const operationId = newOperationId()
    const done = await guardedWrite(deps.guard, { operationId, chatId: null, kind: "account", action }, () =>
      act(connection, personId as Id),
    )
    return { operationId, personId: personId as Id, done }
  }

  return {
    list: async (options) => {
      // The chats first: a messenger whose login brings its people writes them before the store is asked.
      const stored = fromStore(deps)
      const chats = stored
        ? undefined
        : (await capability(await deps.connection(), "chats", "list chats")({ offset: 0 })).items
      const held = stored ? { store: await deps.store(), account: await deps.account() } : await storeIfOpen(deps)
      if (held && (await held.store.people.countContacts(held.account)) > 0)
        return storedContacts(held.store, held.account, options)
      for (const term of [options.name, options.notes])
        if (term)
          queryError(
            "query.unsupported-field",
            term.span,
            `${term.field}: reads the contacts kept in the local store, and it keeps none yet; \`contacts sync\` fills it`,
            { command: "contacts list" },
            { supported: [] },
          )
      return contactsIn(
        chats ?? (await (await deps.store()).chats.chats(await deps.account(), {})).items,
        options,
        deps.messenger.partnerOf,
      )
    },

    show: async (person, { notes = false } = {}) => {
      if (fromStore(deps)) {
        const store = await deps.store()
        const account = await deps.account()
        const found = pickPerson(person, await store.people.people(account.provider, { account: account.account }))
        return localCard({ ...found, chats: await sharedChats(store, account, found.id) }, notes)
      }
      const card = await capability(await deps.connection(), "contact", "show a person")(await referenceOf(person))
      if (card.chats.length > 0) return localCard(card, notes)
      const held = await storeIfOpen(deps)
      return localCard(held ? { ...card, chats: await sharedChats(held.store, held.account, card.id) } : card, notes)
    },

    profile: (person) => personProfile(deps, person),

    context: async (person, options) => personContext(await deps.store(), await deps.account(), person, options),

    prepare: async (person, options) => personPreparation(await deps.store(), await deps.account(), person, options),

    timeline: async (person, options) => personTimeline(await deps.store(), await deps.account(), person, options),

    messagesIn: async (person, { chats, limit, detail, fetch = false }) => {
      const store = await deps.store()
      const account = await deps.account()
      if (!fetch) {
        const ids = await Promise.all(
          chats.map((chat) => storedChatId(deps.messenger, chat, store, account, { includeLeft: true })),
        )
        return personMessages(store, account, person, {
          chats: ids,
          ...(limit ? { limit } : {}),
          ...(detail ? { detail } : {}),
        })
      }
      if (deps.offline) throw new CliError("validation_error", "--fetch asks the messenger; not with --offline")
      const connection = await deps.connection()
      const sender = pickPerson(person, await store.people.people(account.provider, { account: account.account })).id
      const ids: Id[] = []
      for (const chat of chats) {
        const { id } = await connection.resolve(chat)
        ids.push(id)
        const page = connection.historyFrom
          ? await connection.historyFrom(id, sender, { limit: limit ?? CHAT_MESSAGES })
          : await capability(connection, "history", "read a chat's history")(id, { limit: 100 })
        if (page.items.length > 0) await store.messages.saveMessages(account, id, page.items, { via: "history" })
      }
      return personMessages(store, account, person, {
        chats: ids,
        ...(limit ? { limit } : {}),
        ...(detail ? { detail } : {}),
      })
    },

    link: async (person, other, method = "manual") =>
      linkPeople(await deps.store(), await deps.account(), person, other, method),

    unlink: async (person) => {
      const store = await deps.store()
      return store.people.unlinkIdentity(await identityIn(store, await deps.account(), person), {
        method: "manual",
        by: "owner",
      })
    },

    lookup: async (phone) => capability(await deps.connection(), "lookup", "find a person by phone")(phone),

    sync: async () => {
      if (deps.offline) {
        throw new CliError("validation_error", "`contacts sync` takes the list from the messenger; not with --offline")
      }
      const people = await capability(await deps.connection(), "addressBook", "list its contacts")()
      const store = await deps.store()
      const account = await deps.account()
      const before = await store.people.people(account.provider, { account: account.account })
      let added = 0
      let changed = 0
      for (const person of people) {
        const known = before.get(person.id)
        if (!known) added += 1
        else if (known.name !== person.name || known.username !== person.username) changed += 1
      }
      await store.people.savePeople(account, people)
      return {
        added,
        changed,
        known: (await store.people.people(account.provider, { account: account.account })).all().length,
      }
    },

    add: async (person) => {
      const { operationId, done } = await change("contact-add", person, (connection, id) =>
        capability(connection, "addContact", "add a contact")(id),
      )
      return { operationId, person: done }
    },

    remove: async (person) => {
      const { operationId, personId } = await change("contact-remove", person, (connection, id) =>
        capability(connection, "removeContact", "remove a contact")(id),
      )
      return { operationId, personId }
    },

    block: async (person) => {
      const { operationId, personId } = await change("contact-block", person, (connection, id) =>
        capability(connection, "block", "block a person")(id),
      )
      return { operationId, personId }
    },

    unblock: async (person) => {
      const { operationId, personId } = await change("contact-unblock", person, (connection, id) =>
        capability(connection, "unblock", "unblock a person")(id),
      )
      return { operationId, personId }
    },

    rename: async (person, firstName, lastName) => {
      if (firstName.trim() === "") throw new CliError("validation_error", "a name cannot be empty")
      const { operationId, done } = await change("contact-rename", person, (connection, id) =>
        capability(connection, "renameContact", "rename a contact")(id, firstName.trim(), lastName?.trim()),
      )
      return { operationId, person: done }
    },

    import: async (entries) => {
      if (entries.length === 0) throw new CliError("validation_error", "the file names nobody")
      const connection = await online("contacts import")
      const importing = capability(connection, "importContacts", "import contacts")
      const operationId = newOperationId()
      const recognised: Member[] = []
      for (let sent = 0; sent < entries.length; sent += IMPORT_CHUNK) {
        const chunk = entries.slice(sent, sent + IMPORT_CHUNK)
        try {
          recognised.push(
            ...(await guardedWrite(
              deps.guard,
              { operationId, chatId: null, kind: "account", action: "contact-import", count: chunk.length },
              () => importing(chunk),
            )),
          )
        } catch (error) {
          if (sent === 0 || !isCliFailure(error)) throw error
          throw new CliError(
            error.code,
            `${error.message} — ${sent} of ${entries.length} numbers were sent before this; importing again is safe`,
            { ...error.details, operation_id: operationId, sent_count: sent },
          )
        }
      }
      return { operationId, sent: entries.length, recognised }
    },
  }
}

/** Numbers per request: one big list in one request is what a contact-scraping account sends. */
const IMPORT_CHUNK = 10

/** Digits, with the `+` and the spaces, dashes and brackets people type dropped. */
/**
 * The owner's link of two people, each read in the account's messenger unless prefixed (`max:Ana`, `email:ana@x.com`,
 * `person:12`); `me` links the first to the owner. A tool without a messenger (a calendar CLI) calls it directly.
 */
export const linkPeople = async (
  store: MessageStore,
  account: AccountKey,
  person: string,
  other: string,
  method = "manual",
): Promise<PersonRecord> => {
  const one = await identityIn(store, account, person)
  if (other === "me") return store.people.linkToOwner(one)
  const two = await identityIn(store, account, other)
  if (one.provider === two.provider && one.id === two.id)
    throw new CliError("validation_error", "that is the same person twice")
  return store.people.linkIdentities(one, two, { method, by: "owner" })
}

export const phoneOf = (typed: string): string => {
  const digits = typed.replace(/[\s()+-]/g, "")
  if (!/^\d{6,15}$/.test(digits)) {
    throw new CliError("validation_error", "that is not a phone number — digits, with a country code")
  }
  return digits
}

const storedContacts = async (
  store: MessageStore,
  account: AccountKey,
  { order, name, notes, limit, offset }: { order: "recent" | "name"; name?: Predicate; notes?: Predicate } & PageWindow,
): Promise<Page<Contact>> => {
  // Chats saved since the last refresh may have moved someone up; the order is worked out again here.
  if (order === "recent") await store.people.refreshRecency(account)
  const query = name?.value.replace(/^\*+|\*+$/g, "").trim() || undefined
  const filter = {
    ...(query === undefined ? {} : { query }),
    ...(notes ? { notes: notes.value.replace(/^\*+|\*+$/g, "") } : {}),
  }
  return store.people.contacts(account, {
    order,
    ...filter,
    limit: limit ?? (await store.people.countContacts(account, filter)),
    offset,
  })
}

const sharedChats = async (store: MessageStore, account: AccountKey, personId: string) =>
  (await store.chats.chatsWith(account, personId)).map(({ id, title, kind, lastMessageAt }) => ({
    id,
    title,
    kind,
    lastMessageAt,
  }))

/**
 * A dialog's id is its person's only where the messenger says so: without `partnerOf` it is (Telegram);
 * with it, a dialog whose person the messenger cannot name is left out rather than listed under the
 * chat's id (MAX, where a dialog's id is not the partner's).
 */
const contactsIn = (
  chats: readonly Chat[],
  { order, limit, offset }: { order: "recent" | "name" } & PageWindow,
  partnerOf?: (chat: Chat) => Id | undefined,
): Page<Contact> => {
  const people = chats
    .filter((chat) => chat.kind === "dialog")
    .flatMap((chat) => {
      const id = partnerOf ? partnerOf(chat) : chat.id
      return id === undefined ? [] : [{ ...toContact(chat), id }]
    })
    .sort(order === "name" ? byName : byRecency)
  const end = limit === undefined ? people.length : offset + limit
  return { items: people.slice(offset, end), hasMore: people.length > end }
}

const toContact = (chat: Chat): Contact => ({
  id: chat.id,
  name: chat.title,
  username: typeof chat.providerMetadata?.username === "string" ? chat.providerMetadata.username : null,
  description: null,
  lastMessagedAt: chat.lastMessageAt,
})

const byRecency = (a: Contact, b: Contact) => (b.lastMessagedAt ?? "").localeCompare(a.lastMessagedAt ?? "")
const byName = (a: Contact, b: Contact) => (a.name ?? "").localeCompare(b.name ?? "")

/** The phone cut to its last four digits: enough to tell two accounts apart. */
export const maskedAccount = <T extends { phone?: string | null }>(account: T): T =>
  account.phone ? { ...account, phone: `***${account.phone.replace(/\D/g, "").slice(-4)}` } : account
