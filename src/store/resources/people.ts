import type { Id } from "../../domain/models.js"
import type { PersonRecord } from "../contracts/models.js"
import type { PeopleStore } from "../contracts/people.js"
import * as identities from "../sqlite/identities.js"
import * as personLinks from "../sqlite/person-links.js"
import { personSeenInAccounts } from "../sqlite/person-scope.js"
import type { PrivateContactNote } from "../sqlite/private-people.js"
import * as privatePeople from "../sqlite/private-people.js"
import * as reads from "../sqlite/reads.js"
import * as tagQueries from "../sqlite/tags.js"
import type { StoreRuntime } from "./runtime.js"

export const peopleStoreOver = ({
  context,
  inTransaction,
  accountPk,
  findAccountPk,
  identityPk,
}: Pick<StoreRuntime, "context" | "inTransaction" | "accountPk" | "findAccountPk" | "identityPk">): PeopleStore => {
  return {
    personOf: async (identity) => personLinks.personOf(context, identity),

    personSeenInAccounts: async (uid, accountIds) => personSeenInAccounts(context, uid, accountIds),

    personByUid: async (uid) => personLinks.personByUid(context, uid),

    linkIdentities: async (person, other, options) => {
      let linked: PersonRecord | undefined
      inTransaction(() => {
        linked = personLinks.linkIdentities(context, person, other, options)
      })
      return linked as PersonRecord
    },

    unlinkIdentity: async (identity, options) => {
      let alone: PersonRecord | undefined
      inTransaction(() => {
        alone = personLinks.unlinkIdentity(context, identity, options)
      })
      return alone as PersonRecord
    },

    mentioning: async (key, person, limit) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { items: [], hasMore: false }
        : personLinks.mentioning(context, accountKey, person, limit)
    },

    contacts: async (key, options) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { items: [], hasMore: false }
      return identities.contacts(context, accountKey, key, options)
    },

    countContacts: async (key, { query } = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? 0 : identities.countContacts(context, accountKey, key, query)
    },

    refreshRecency: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey !== undefined) identities.refreshRecency(context, accountKey)
    },

    savePeople: async (key, people) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const person of people) identityPk(accountKey, key.provider, person.id, person.name, person)
      }),

    people: async (provider, options = {}) => identities.people(context, provider, options),

    senderStats: async (key, senderId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : reads.senderStats(context, accountKey, key.provider, senderId)
    },

    personNames: async (key, personId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : identities.namesOf(context, accountKey, key.provider, personId)
    },

    privateContact: async (key, person) => privatePeople.privateContact(context, key, person),

    setContactAlias: async (key, person, alias) => {
      let result: { personId: Id; alias: string | null } | undefined
      inTransaction(() => {
        result = privatePeople.setAlias(context, key, person, alias)
      })
      return result as { personId: Id; alias: string | null }
    },

    addContactNote: async (key, person, text) => {
      let added: PrivateContactNote | undefined
      inTransaction(() => {
        added = privatePeople.addNote(context, key, person, text)
      })
      return added as PrivateContactNote
    },

    contactNote: async (key, person, id) => privatePeople.note(context, key, person, id),

    editContactNote: async (key, person, id, text, revision) => {
      let edited: PrivateContactNote | undefined
      inTransaction(() => {
        edited = privatePeople.editNote(context, key, person, id, text, revision)
      })
      return edited as PrivateContactNote
    },

    removeContactNote: async (key, person, id) => privatePeople.removeNote(context, key, person, id),

    addTags: async (key, target, list) => {
      let added: string[] = []
      inTransaction(() => {
        added = tagQueries.addTags(context, tagQueries.targetThing(context, key, target), list)
      })
      return added
    },

    removeTags: async (key, target, list, source) => {
      let removed: string[] = []
      inTransaction(() => {
        removed = tagQueries.removeTags(context, tagQueries.targetThing(context, key, target), list, source)
      })
      return removed
    },

    tags: async (key, filter = {}) => tagQueries.tagsOf(context, key, filter),
  }
}
