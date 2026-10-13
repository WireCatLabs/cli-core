import type { Contact, Id, Page, PersonAlias, Provider } from "../../domain/models.js"
import type { PeopleLookup } from "../../resolve.js"
import type { StoredTag, TagFilter, TagTarget } from "../sqlite/tags.js"
import type {
  AccountKey,
  IdentityRef,
  LinkOptions,
  PersonFacts,
  PersonRecord,
  SenderChatStats,
  StoredHit,
} from "./models.js"
import type { PrivateContact, PrivateContactNote } from "./private-people-types.js"

export interface PeopleStore {
  savePeople(key: AccountKey, people: PersonFacts[]): Promise<void>

  /**
   * The people this account has a one-to-one chat with — as far as the saved member lists go —
   * newest conversation first or by name. `query` matches three letters or more of a name or
   * username.
   */
  contacts(
    key: AccountKey,
    options: { order: "recent" | "name"; query?: string; limit: number; offset?: number },
  ): Promise<Page<Contact>>

  countContacts(key: AccountKey, options?: { query?: string }): Promise<number>

  /** Works out again when each contact was last written to, from their one-to-one chats. */
  refreshRecency(key: AccountKey): Promise<void>

  /** Everyone this provider's accounts have seen; with `account`, only who that account has seen. */
  people(provider: Provider, options?: { account?: Id; accounts?: Id[] }): Promise<PeopleLookup>

  personOf(identity: IdentityRef): Promise<PersonRecord | undefined>

  /** The person a `person:<uid>` reference names. */
  personSeenInAccounts(uid: string, accountIds: readonly number[]): Promise<boolean>

  personByUid(uid: string): Promise<PersonRecord | undefined>

  /** Records the decision in `identity_link_events`; `unlinkIdentity` undoes it. */
  linkIdentities(person: IdentityRef, other: IdentityRef, options: LinkOptions): Promise<PersonRecord>

  unlinkIdentity(identity: IdentityRef, options: LinkOptions): Promise<PersonRecord>

  /** Messages of the account that name this person, newest first. */
  mentioning(key: AccountKey, person: { id: Id; username: string | null }, limit: number): Promise<Page<StoredHit>>

  /** One person's stored messages per chat of this account, newest first. */
  senderStats(key: AccountKey, senderId: Id): Promise<SenderChatStats[]>

  /** Every name and username this account's store recorded for one person, the current ones included. */
  personNames(key: AccountKey, personId: Id): Promise<PersonAlias[]>

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

  addTags(key: AccountKey, target: TagTarget, tags: string[]): Promise<string[]>

  /** Answers the tags it had. */
  removeTags(key: AccountKey, target: TagTarget, tags: string[], source?: "manual" | "auto"): Promise<string[]>

  /** The account's tagged chats and messages, and its messenger's tagged people. */
  tags(key: AccountKey, filter?: TagFilter): Promise<StoredTag[]>
}
