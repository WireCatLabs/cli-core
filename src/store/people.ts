import { CliError } from "@wirecat/cli-base"
import type { Contact, Id, Page, PersonAlias, Provider } from "../domain/models.js"
import type { PersonKind } from "../domain/person-kinds.js"
import type { PeopleLookup } from "../resolve.js"
import type { Decider } from "./decisions.js"
import type {
  AgentLink,
  AgentLinkInput,
  AgentMerge,
  IdentityLinkDecision,
  IdentityLinkFilter,
  IdentityLinkInput,
  IdentityLinkRow,
  LinkEvidence,
  MatchScan,
} from "./identity-links.js"
import type {
  IdentitySplitDecision,
  IdentitySplitFilter,
  IdentitySplitInput,
  IdentitySplitRow,
} from "./identity-splits.js"
import { keysOver } from "./keys.js"
import { ownerPerson } from "./sqlite/actors.js"
import { agentLink, agentMergeOf, agentMerges, linkEvidenceOver } from "./sqlite/agent-links.js"
import { sendsWhere } from "./sqlite/bot-sends.js"
import type { ContactFilter } from "./sqlite/identities.js"
import * as identities from "./sqlite/identities.js"
import * as identityProposals from "./sqlite/identity-proposals.js"
import { type IdentityRekey, type IdentityRekeys, rekeyIdentities } from "./sqlite/identity-rekey.js"
import * as identitySplits from "./sqlite/identity-split-proposals.js"
import type { StoreContext } from "./sqlite/open.js"
import { linkToOwner } from "./sqlite/own-identities.js"
import {
  countPeople,
  listPeople,
  type PeopleList,
  type PeopleListOptions,
  type SimilarPerson,
  similarPeople,
  storeKinds,
} from "./sqlite/people-list.js"
import {
  type KeptPerson,
  keepPerson,
  markTestData,
  type PersonDoubts,
  personDoubts,
  type TestDataPerson,
} from "./sqlite/person-doubts.js"
import { erasePerson, type PersonErasure } from "./sqlite/person-erase.js"
import * as personLinks from "./sqlite/person-links.js"
import { linkPhones, PROPOSAL_SCORE, RULE, scanMatches } from "./sqlite/person-match-scan.js"
import type { PersonMerge } from "./sqlite/person-merges.js"
import * as personMerges from "./sqlite/person-merges.js"
import { ownerOnly } from "./sqlite/person-merges.js"
import { type PersonPreparationRead, personPreparation } from "./sqlite/person-preparation.js"
import { personSeenInAccounts } from "./sqlite/person-scope.js"
import { type ShownBecause, shownReasons } from "./sqlite/person-ties.js"
import type { PrivateContact, PrivateContactNote } from "./sqlite/private-people.js"
import * as privatePeople from "./sqlite/private-people.js"
import type { ProposedAction } from "./sqlite/proposed-actions.js"
import {
  type BotList,
  type BotListOptions,
  listBots,
  moveToBot,
  moveToPerson,
  type SenderBot,
  type SenderBotDetails,
  showBot,
} from "./sqlite/sender-bots.js"
import { write } from "./sqlite/transaction.js"
import type {
  AccountKey,
  IdentityRef,
  LinkOptions,
  PersonFacts,
  PersonRecord,
  StoredAccount,
  UnlinkOptions,
} from "./types.js"

/** @experimental */
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
  unlinkIdentity(identity: IdentityRef, options: UnlinkOptions): Promise<PersonRecord>
  /**
   * The provider now names its identities by other ids, such as a phone number written another way. Each pair, in
   * order and each in its own savepoint: with no `to` stored the identity takes the new id, and `phone` when given
   * (`renamed`); with `to` stored, `from` merges into it, with its person and every row that points at it (`merged`);
   * with no `from`, or `from` equal to `to`, nothing changes (`unchanged`), so a second run is all `unchanged`; an
   * empty `to` is `skipped`. Stops once it has held the write lock for `lockMs` (default 250): `taken` says how many
   * pairs it got to, so the caller passes the rest again. A pair that cannot merge is in `refused`, and the others
   * still apply. Then the phone rule links the renamed and merged identities to the people with their number.
   */
  rekeyIdentities(
    provider: Provider,
    pairs: readonly IdentityRekey[],
    options?: { lockMs?: number; by?: string },
  ): Promise<IdentityRekeys>
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
  /**
   * An agent's link. It merges at once only on strong evidence the store finds itself, never on the agent's word:
   * one value, a mobile number or a personal address, that no one else holds or that each of its holders has from a
   * different source, whatever their names; from two different sources; and for a phone at least one that keeps its
   * user's own number (a messenger account or a call's number). A landline, a value two
   * records of one source share, a company's line, a role address, a name or a CRM's word alone is weak. The
   * merge is recorded as an `identity_link` the agent decided, with the evidence, the reason and the run, and the owner
   * undoes it with `undoMerge`. Weak evidence, the owner's person, a pair the owner rejected, or `apply: false` (the
   * owner's setting) open a proposal instead, which says why. Refused over the owner's separation.
   */
  agentLink(input: AgentLinkInput): Promise<AgentLink>
  /** What two people share and whether it is strong, for each pair of `person:<uid>` or uids; reads the store once. */
  linkEvidence(pairs: readonly (readonly [string, string])[]): Promise<LinkEvidence[]>
  /** The merges agents made that are still in place, newest first. */
  agentMerges(page: {
    limit: number
    offset: number
  }): Promise<{ items: (PersonMerge & { agent: AgentMerge })[]; hasMore: boolean }>
  /**
   * The owner's decision on an `identity_link`; confirm is refused with `identity.stale` when either person changed.
   * `company` turns down a shared-mailbox proposal and gives its address to an organization;
   * `organization` turns down a match whose two sides are a company's mailboxes and gives them all to it.
   */
  decideLink(id: string, decision: IdentityLinkDecision): Promise<ProposedAction>
  /**
   * One pass of the people matcher: the same address joins people in every scope, a phone two people have, or one each
   * source has once whatever the names, joins them, a phone more people of one source share, a role address such as `info@`, a meeting guest's typed address, and one
   * name with a shared phone, address, chat or company domain become proposals. Never over the owner's separation; a pair the owner rejected is proposed again only on new evidence.
   */
  scanMatches(options?: { full?: boolean }): Promise<MatchScan>
  /**
   * The `identity_link` proposals, newest first or by score (`order`), naming the people as they are now; `proposed`
   * unless `status` says.
   */
  linkProposals(filter: IdentityLinkFilter): Promise<{ items: IdentityLinkRow[]; hasMore: boolean }>
  /**
   * Proposes to take identities off their person, or to undo a merge, as an `identity_split` only the owner decides:
   * an agent's unlink or unmerge waits for the owner beside the matches. An open one for the same identities is given
   * back; one the owner turned down is refused.
   */
  proposeSplit(input: IdentitySplitInput): Promise<ProposedAction>
  /** The owner's decision on an `identity_split`; confirm is refused with `identity.stale` when the person changed. */
  decideSplit(id: string, decision: IdentitySplitDecision): Promise<ProposedAction>
  /** The `identity_split` proposals, newest first; `proposed` unless `status` says. */
  splitProposals(filter: IdentitySplitFilter): Promise<{ items: IdentitySplitRow[]; hasMore: boolean }>
  /**
   * People that may be wrong, the owner first: the owner's person holding another name, test data, an address people
   * with other names share, one person with different names and nothing in common. Each says why and how to fix it.
   */
  doubts(page: { limit: number; offset: number }): Promise<PersonDoubts>
  /**
   * The owner says a person in doubt is right as they are: the identities in doubt stop being listed until one of them
   * moves, and what looked like test data is a real contact, shown again even when memo hid it. The owner's alone;
   * refused with `person.no-doubt` when nothing about the person is in doubt or hidden.
   */
  keep(person: string, by: Decider): Promise<KeptPerson>
  /**
   * The owner says a person is test data: hidden from every list, `list({ kind: "test" })` lists them, until `keep`.
   * The owner's alone; refused for the owner's own person.
   */
  markTestData(person: string, by: Decider): Promise<TestDataPerson>
  /**
   * Deletes a person and what memo knows of them alone; see `erasePerson`. `apply: false` answers what would go and
   * changes nothing. The owner's alone; refused for the owner's own person.
   */
  erase(person: string, by: Decider, options: { apply: boolean }): Promise<PersonErasure>
  /** The identity, and everyone linked with it, is the owner. */
  linkToOwner(identity: IdentityRef): Promise<PersonRecord>
  /** A person known by name only, with no identity yet: someone to assign a task to before any message names them. */
  add(input: { name: string }): Promise<PersonRecord>
  /**
   * People of one kind with their shown name, contact, interactions and ties, a page at a time. `person` (the default)
   * is the owner, people added by hand, task assignees, and named people with a tie (a one-to-one chat, a small group,
   * mail the owner wrote, a meeting, a CRM, the address book); `automated`, `organization`, `stranger` (a
   * name, no tie) and `unsorted` (nothing to show as a name) hold the rest. `test` holds what a test run left: a seed
   * id, an address at a reserved domain, or what the owner called test data; `all` and every other kind leave it out.
   */
  list(options: PeopleListOptions): Promise<PeopleList>
  /** How many people of each kind match a name or username, or the whole store: `list`'s `counts` without a page. */
  counts(query?: string): Promise<Record<PersonKind, number>>
  /** People whose names start like the typed one, the same name first: for a form that adds a person. */
  similar(name: string, options?: { limit?: number }): Promise<SimilarPerson[]>
  /** Why each `person:<uid>` is shown by default, as `list` gives it; an empty list for one with no tie. */
  ties(people: readonly string[]): Promise<Record<string, ShownBecause[]>>
  /**
   * The sender bots: programs that write to the owner, apart from people (`sender-bot:<id>`), by name. `query` looks in
   * their names, addresses and usernames; `organization` (`organization:<id>`) keeps the ones that send for it.
   * @experimental
   */
  listBots(options: BotListOptions): Promise<BotList>
  /** One sender bot (`sender-bot:<id>`), its identities and every move to or from it. @experimental */
  showBot(bot: string): Promise<SenderBotDetails>
  /**
   * The owner says a sender is a program: a person (`person:<uid>`), a bot (`sender-bot:<id>`) or one identity moves
   * to a sender bot for its whole history, and no rule gives it back. Its messages keep pointing at the identity. `bot`
   * joins a stored bot; else a bot already holding it keeps it, or a new one takes it. A person every identity left is
   * hidden from lists, and a move back gives their uid back. The owner's alone; refused for the owner's own person.
   * @experimental
   */
  moveToBot(
    subject: string | IdentityRef,
    by: Decider,
    options?: { bot?: string; name?: string; reason?: string },
  ): Promise<SenderBot>
  /**
   * The owner says a sender is a person: a bot (`sender-bot:<id>`) or one identity of it moves to a person for its
   * whole history, and no rule makes it a bot again. `person` takes it; else each identity goes back to the person it
   * came from, or a person of its own. Said of a person, it keeps them one. The owner's alone. @experimental
   */
  moveToPerson(
    subject: string | IdentityRef,
    by: Decider,
    options?: { person?: string; reason?: string },
  ): Promise<PersonRecord>
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
      if (held)
        identityProposals.openIdentityLink(context, {
          ...held,
          joins: "person",
          signal: "email",
          by: RULE,
          score: PROPOSAL_SCORE.newEvidence,
        })
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
    rekeyIdentities: async (provider, pairs, { lockMs = 250, by = provider } = {}) => {
      const done = write(database, () => rekeyIdentities(context, provider, pairs, { lockMs, by }))
      if (done.touched.length > 0) linkPhones(context, new Set(done.touched))
      return done
    },
    merges: async (uid) =>
      personMerges.merges(context, uid).map((merge) => {
        const agent = merge.method === "agent" ? agentMergeOf(context, merge.id) : undefined
        return agent === undefined ? merge : { ...merge, agent }
      }),
    undoMerge: async (to, from, by) => write(database, () => personMerges.undoMerge(context, to, from, by)),
    split: async (uid, chosen, by) => write(database, () => personMerges.split(context, uid, chosen, by)),
    proposeLink: async (input) => identityProposals.proposeIdentityLink(context, input),
    agentLink: async (input) => agentLink(context, input),
    linkEvidence: async (pairs) => {
      const evidence = linkEvidenceOver(context)
      const uid = (person: string) => Number(person.replace(/^person:/, ""))
      return pairs.map(([a, b]) => evidence(uid(a), uid(b)))
    },
    agentMerges: async (page) => agentMerges(context, page),
    decideLink: async (id, decision) => identityProposals.decideIdentityLink(context, id, decision),
    scanMatches: async (options) => scanMatches(context, options),
    linkProposals: async (filter) => identityProposals.identityLinkRows(context, filter),
    proposeSplit: async (input) => identitySplits.proposeIdentitySplit(context, input),
    decideSplit: async (id, decision) => identitySplits.decideIdentitySplit(context, id, decision),
    splitProposals: async (filter) => identitySplits.identitySplitRows(context, filter),
    doubts: async (page) => personDoubts(context, page),
    keep: async (person, by) => write(database, () => keepPerson(context, person, by)),
    markTestData: async (person, by) => write(database, () => markTestData(context, person, by)),
    erase: async (person, by, { apply }) => write(database, () => erasePerson(context, person, by, apply)),
    linkToOwner: async (identity) => linkToOwner(context, identity),
    list: async (options) => listPeople(database, options),
    counts: async (query) => countPeople(database, query),
    similar: async (name, { limit = 8 } = {}) => similarPeople(database, name, limit),
    ties: async (people) => {
      const reasons = shownReasons(database)
      return Object.fromEntries(people.map((ref) => [ref, reasons.get(Number(ref.replace(/^person:/, ""))) ?? []]))
    },
    listBots: async (options) => {
      storeKinds(database)
      return listBots(database, options, options.sends === undefined ? undefined : sendsWhere(database, options.sends))
    },
    showBot: async (bot) => showBot(database, bot),
    moveToBot: async (subject, by, options) => {
      ownerOnly(by, "moves a sender to a bot")
      return moveToBot(context, subject, options)
    },
    moveToPerson: async (subject, by, options) => {
      ownerOnly(by, "moves a sender to a person")
      return moveToPerson(context, subject, options)
    },
  }
}
