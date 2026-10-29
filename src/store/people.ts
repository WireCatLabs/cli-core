import { CliError } from "@wirecat/cli-base"
import type { Contact, Id, Page, PersonAlias, Provider } from "../domain/models.js"
import type { PeopleLookup } from "../resolve.js"
import { keysOver } from "./keys.js"
import { ownerPerson } from "./sqlite/actors.js"
import type { ContactFilter } from "./sqlite/identities.js"
import * as identities from "./sqlite/identities.js"
import type { StoreContext } from "./sqlite/open.js"
import { linkToOwner } from "./sqlite/own-identities.js"
import * as personLinks from "./sqlite/person-links.js"
import { type PersonPreparationRead, personPreparation } from "./sqlite/person-preparation.js"
import { personSeenInAccounts } from "./sqlite/person-scope.js"
import type { PrivateContact, PrivateContactNote } from "./sqlite/private-people.js"
import * as privatePeople from "./sqlite/private-people.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey, IdentityRef, LinkOptions, PersonFacts, PersonRecord } from "./types.js"

export interface AccountPeople {
  savePeople(key: AccountKey, people: PersonFacts[]): Promise<void>
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
  /** Accepted facts, the owner's notes and open tasks about them; tasks of an account only if `accounts` holds it. */
  preparation(uid: string, options: { accounts: readonly AccountKey[]; limit: number }): Promise<PersonPreparationRead>
  /** Records the decision in `identity_link_events`; `unlinkIdentity` undoes it. */
  linkIdentities(person: IdentityRef, other: IdentityRef, options: LinkOptions): Promise<PersonRecord>
  unlinkIdentity(identity: IdentityRef, options: LinkOptions): Promise<PersonRecord>
  /** The identity, and everyone linked with it, is the owner. */
  linkToOwner(identity: IdentityRef): Promise<PersonRecord>
}

export const accountPeopleOver = (context: StoreContext): AccountPeople => {
  const { database } = context
  const { accountPk, findAccountPk, identityPk } = keysOver(context)
  return {
    savePeople: async (key, people) =>
      write(database, () => {
        const accountKey = accountPk(key)
        for (const person of people) {
          identityPk(accountKey, key.provider, person.id, person.name, person)
          if (person.email)
            personLinks.joinByAddress(context, { provider: key.provider, id: person.id }, person.email, key.provider)
        }
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
    removeContactNote: async (key, person, id) => privatePeople.removeNote(context, key, person, id),
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
    linkToOwner: async (identity) => linkToOwner(context, identity),
  }
}
