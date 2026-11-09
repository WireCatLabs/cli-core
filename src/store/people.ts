import { CliError } from "@wirecat/cli-base"
import type { Contact, Id, Page, PersonAlias, Provider } from "../domain/models.js"
import type { PeopleLookup } from "../resolve.js"
import type {
  IdentityLinkDecision,
  IdentityLinkFilter,
  IdentityLinkInput,
  IdentityLinkRow,
  MatchScan,
} from "./identity-links.js"
import { keysOver } from "./keys.js"
import { ownerPerson } from "./sqlite/actors.js"
import type { ContactFilter } from "./sqlite/identities.js"
import * as identities from "./sqlite/identities.js"
import * as identityProposals from "./sqlite/identity-proposals.js"
import type { StoreContext } from "./sqlite/open.js"
import { linkToOwner } from "./sqlite/own-identities.js"
import {
  listPeople,
  type PeopleList,
  type PeopleListOptions,
  type SimilarPerson,
  similarPeople,
} from "./sqlite/people-list.js"
import * as personLinks from "./sqlite/person-links.js"
import { RULE, scanMatches } from "./sqlite/person-match-scan.js"
import type { PersonMerge } from "./sqlite/person-merges.js"
import * as personMerges from "./sqlite/person-merges.js"
import { type PersonPreparationRead, personPreparation } from "./sqlite/person-preparation.js"
import { personSeenInAccounts } from "./sqlite/person-scope.js"
import type { PrivateContact, PrivateContactNote } from "./sqlite/private-people.js"
import * as privatePeople from "./sqlite/private-people.js"
import type { ProposedAction } from "./sqlite/proposed-actions.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey, IdentityRef, LinkOptions, PersonFacts, PersonRecord, StoredAccount } from "./types.js"

export interface AccountPeople {
  savePeople(key: AccountKey, people: PersonFacts[]): Promise<void>
  /**
   * The account's whole address book: saves them as `savePeople` does and marks them as in the book, a tie to the
   * owner; someone no longer in it loses the mark.
   */
  saveAddressBook(key: AccountKey, people: PersonFacts[]): Promise<void>
  /**
   * The people this account has a one-to-one chat with — as far as the saved member lists go —
   * newest conversation first or by name.
   */
  contacts(
    key: AccountKey,
    options: { order: "recent" | "name"; limit: number; offset?: number } & ContactFilter,
  ): Promise<Page<Contact>>
  countContacts(key: AccountKey, options?: ContactFilter): Promise<number>
  /** Works out again when each contact was last written to, from their one-to-one chats. */
  refreshRecency(key: AccountKey): Promise<void>
  /** Every name and username this account's store recorded for one person, the current ones included. */
  personNames(key: AccountKey, personId: Id): Promise<PersonAlias[]>
  /** The phone saved for them, `null` when none was ever shown to the owner. */
  phoneOf(key: AccountKey, personId: Id): Promise<string | null>
  privateContact(key: AccountKey, personId: Id): Promise<PrivateContact>
  setContactAlias(key: AccountKey, personId: Id, alias: string | null): Promise<{ personId: Id; alias: string | null }>
  addContactNote(key: AccountKey, personId: Id, text: string): Promise<PrivateContactNote>
  contactNote(key: AccountKey, personId: Id, id: string): Promise<PrivateContactNote>
  editContactNote(
    key: AccountKey,
    personId: Id,
    id: string,
    text: string,
    revision: number,
  ): Promise<PrivateContactNote>
  removeContactNote(key: AccountKey, personId: Id, id: string): Promise<{ id: string; personId: Id; removed: boolean }>
}

export interface PeopleStore extends AccountPeople {
  /** Everyone this provider's accounts have seen; with `account`, only who that account has seen. */
  people(provider: Provider, options?: { account?: Id; accounts?: Id[] }): Promise<PeopleLookup>
  personOf(identity: IdentityRef): Promise<PersonRecord | undefined>
  /** The person a `person:<uid>` reference names. */
  personSeenInAccounts(uid: string, accountIds: readonly number[]): Promise<boolean>
  personByUid(uid: string): Promise<PersonRecord | undefined>
  /** The person marked as the owner, with every identity linked to them; `undefined` when none is. */
  owner(): Promise<PersonRecord | undefined>
  /**
   * Accepted facts, the owner's notes and open tasks about them; tasks of an account only if `accounts` holds it,
   * and what belongs to no account only in `scopes`.
   */
  preparation(
    uid: string,
    options: { accounts: readonly AccountKey[]; scopes: readonly StoredAccount["scope"][]; limit: number },
  ): Promise<PersonPreparationRead>
  /** Records the decision in `identity_link_events`; `unlinkIdentity` undoes it. */
  linkIdentities(person: IdentityRef, other: IdentityRef, options: LinkOptions): Promise<PersonRecord>
  unlinkIdentity(identity: IdentityRef, options: LinkOptions): Promise<PersonRecord>
  /** The people merged into this one, newest first, each with the identities that came from it. */
  merges(uid: string): Promise<PersonMerge[]>
  /** The owner's undo of a merge: the identities that came from `from` go back to it. Gives `from` again. */
  undoMerge(to: string, from: string, by: string): Promise<PersonRecord>
  /** The owner's split: the chosen identities become one new person, which this gives. */
  split(uid: string, identities: IdentityRef[], by: string): Promise<PersonRecord>
  /**
   * Proposes that two identities' people are one, as an `identity_link` only the owner decides. Refused over the
   * owner's separation or rejection; an open proposal for the same two people is given back instead of a second.
   */
  proposeLink(input: IdentityLinkInput): Promise<ProposedAction>
  /** The owner's decision on an `identity_link`; confirm is refused with `identity.stale` when either person changed. */
  decideLink(id: string, decision: IdentityLinkDecision): Promise<ProposedAction>
  /**
   * One pass of the people matcher: the same address joins people in every scope, a phone exactly two people have
   * joins them, a phone more people share, a role address such as `info@`, a meeting guest's typed address, and one
   * name with a shared phone, address, chat or company domain become proposals. Never over the owner's separation; a pair the owner rejected is proposed again only on new evidence.
   */
  scanMatches(options?: { full?: boolean }): Promise<MatchScan>
  /** The `identity_link` proposals, newest first, naming the people as they are now; `proposed` unless `status` says. */
  linkProposals(filter: IdentityLinkFilter): Promise<{ items: IdentityLinkRow[]; hasMore: boolean }>
  /** The identity, and everyone linked with it, is the owner. */
  linkToOwner(identity: IdentityRef): Promise<PersonRecord>
  /** A person known by name only, with no identity yet: someone to assign a task to before any message names them. */
  add(input: { name: string }): Promise<PersonRecord>
  /**
   * People with their shown name, contact and ties to the owner, a page at a time. By default only those with a tie
   * (a one-to-one chat, a small group, mail the owner wrote, a meeting, a CRM, the address book), the owner, people
   * added by hand and people assigned a task; `all` adds the rest.
   */
  list(options: PeopleListOptions): Promise<PeopleList>
  /** People whose names start like the typed one, the same name first: for a form that adds a person. */
  similar(name: string, options?: { limit?: number }): Promise<SimilarPerson[]>
}

export const accountPeopleOver = (context: StoreContext): AccountPeople => {
  const { database } = context
  const { accountPk, findAccountPk, identityPk } = keysOver(context)
  const save = (key: AccountKey, people: PersonFacts[]): number[] => {
    const accountKey = accountPk(key)
    const saved: number[] = []
    for (const person of people) {
      saved.push(identityPk(accountKey, key.provider, person.id, person.name, person))
      if (person.email) personLinks.noteAddress(context, { provider: key.provider, id: person.id }, person.email)
    }
    // Every address of the batch is noted before any joins, so one shared by the whole batch is seen as shared.
    for (const person of people) {
      if (!person.email) continue
      const held = personLinks.joinByAddress(
        context,
        { provider: key.provider, id: person.id },
        person.email,
        key.provider,
      )
      if (held) identityProposals.openIdentityLink(context, { ...held, joins: "person", signal: "email", by: RULE })
    }
    return saved
  }
  return {
    savePeople: async (key, people) => {
      write(database, () => save(key, people))
    },

    saveAddressBook: async (key, people) =>
      write(database, () => {
        const saved = JSON.stringify(save(key, people))
        database
          .prepare(
            "UPDATE account_identities SET address_book = CASE WHEN identity_id IN (SELECT value FROM json_each(?)) " +
              "THEN 1 END WHERE account_id = ? AND (address_book = 1 OR identity_id IN (SELECT value FROM json_each(?)))",
          )
          .run(saved, accountPk(key), saved)
      }),

    contacts: async (key, options) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { items: [], hasMore: false }
      return identities.contacts(context, accountKey, key, options)
    },

    countContacts: async (key, filter = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? 0 : identities.countContacts(context, accountKey, key, filter)
    },

    refreshRecency: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey !== undefined) identities.refreshRecency(context, accountKey)
    },

    personNames: async (key, personId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : identities.namesOf(context, accountKey, key.provider, personId)
    },

    phoneOf: async (key, personId) => identities.phoneOf(context, key.provider, personId),

    privateContact: async (key, person) => privatePeople.privateContact(context, key, person),
    setContactAlias: async (key, person, alias) => {
      return write(database, () => privatePeople.setAlias(context, key, person, alias))
    },
    addContactNote: async (key, person, text) => {
      return write(database, () => privatePeople.addNote(context, key, person, text))
    },
    contactNote: async (key, person, id) => privatePeople.note(context, key, person, id),
    editContactNote: async (key, person, id, text, revision) => {
      return write(database, () => privatePeople.editNote(context, key, person, id, text, revision))
    },
    removeContactNote: async (key, person, id) =>
      write(database, () => privatePeople.removeNote(context, key, person, id)),
  }
}

export const peopleStoreOver = (context: StoreContext, keyed: AccountPeople): PeopleStore => {
  const { database } = context
  return {
    ...keyed,
    people: async (provider, options = {}) => identities.people(context, provider, options),
    personOf: async (identity) => personLinks.personOf(context, identity),
    personSeenInAccounts: async (uid, accountIds) => personSeenInAccounts(context, uid, accountIds),
    personByUid: async (uid) => personLinks.personByUid(context, uid),
    add: async ({ name }) => {
      const text = typeof name === "string" ? name.trim() : ""
      if (!text || text.length > 200) throw new CliError("validation_error", "a person's name takes 1–200 characters")
      const id = write(database, () => {
        const at = context.now()
        return Number(
          database
            .prepare("INSERT INTO persons (name, owner, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id")
            .get(text, at, at)?.id,
        )
      })
      return personLinks.personByUid(context, String(id)) as PersonRecord
    },
    owner: async () => {
      try {
        return personLinks.personByUid(context, String(ownerPerson(database).id))
      } catch (error) {
        if (error instanceof CliError && error.code === "configuration_error") return undefined
        throw error
      }
    },
    preparation: async (uid, options) => personPreparation(context, uid, options),
    linkIdentities: async (person, other, options) => {
      return write(database, () => personLinks.linkIdentities(context, person, other, options))
    },
    unlinkIdentity: async (identity, options) => {
      return write(database, () => personLinks.unlinkIdentity(context, identity, options))
    },
    merges: async (uid) => personMerges.merges(context, uid),
    undoMerge: async (to, from, by) => write(database, () => personMerges.undoMerge(context, to, from, by)),
    split: async (uid, chosen, by) => write(database, () => personMerges.split(context, uid, chosen, by)),
    proposeLink: async (input) => identityProposals.proposeIdentityLink(context, input),
    decideLink: async (id, decision) => identityProposals.decideIdentityLink(context, id, decision),
    scanMatches: async (options) => scanMatches(context, options),
    linkProposals: async (filter) => identityProposals.identityLinkRows(context, filter),
    linkToOwner: async (identity) => linkToOwner(context, identity),
    list: async (options) => listPeople(database, options),
    similar: async (name, { limit = 8 } = {}) => similarPeople(database, name, limit),
  }
}
