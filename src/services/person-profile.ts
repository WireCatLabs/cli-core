import type {
  Id,
  PersonAlias,
  PersonCard,
  PersonProfile,
  ProfileFacts,
  Provider,
  SharedChatActivity,
} from "../domain/models.js"
import { pickPerson } from "../resolve.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { type ServiceDeps, storeIfOpen } from "./deps.js"

/**
 * The person as the messenger describes them, and their stored activity in every chat shared with
 * them. Online, one profile read; `--offline`, or a messenger that cannot describe a person, what
 * the store has seen of them. Counts always come from the store, so they are a floor unless the
 * chat is stored whole. `known` is the card already read for them: where the messenger has no profile to give, it is
 * what is known, so a person the store has not saved is not looked up in it a second time.
 */
export const personProfile = async (deps: ServiceDeps, person: string, known?: PersonCard): Promise<PersonProfile> => {
  const online = deps.offline ? undefined : await deps.connection()
  const held = await storeIfOpen(deps)
  const facts = online?.profile
    ? await online.profile(person)
    : known
      ? factsOfCard(known)
      : await storedFacts(held ?? { store: await deps.store(), account: await deps.account() }, person)
  if (!held) return { ...facts, chats: quiet(facts), aliases: [] }
  return {
    ...facts,
    chats: await activityIn(held.store, held.account, facts),
    aliases: pastOf(facts, await held.store.people.personNames(held.account, facts.id), held.account.provider),
  }
}

/** What the store recorded, less the name and usernames they have now. */
const pastOf = (facts: ProfileFacts, recorded: PersonAlias[], provider: Provider): PersonAlias[] =>
  recorded
    .filter(
      ({ name, username }) =>
        (name ?? null) !== facts.name || (username !== undefined && !facts.usernames.includes(username)),
    )
    .map((alias) =>
      alias.username && provider === "telegram" ? { ...alias, link: `https://t.me/${alias.username}` } : alias,
    )
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))

const factsOfCard = ({ id, name, username, description, chats }: PersonCard): ProfileFacts => ({
  id,
  name,
  usernames: username ? [username] : [],
  bio: description,
  flags: {},
  chats,
})

const storedFacts = async (
  { store, account }: { store: MessageStore; account: AccountKey },
  person: string,
): Promise<ProfileFacts> => {
  const found = pickPerson(person, await store.people.people(account.provider, { account: account.account }))
  const chats = await store.chats.chatsWith(account, found.id)
  return {
    id: found.id,
    name: found.name,
    usernames: found.username ? [found.username] : [],
    bio: found.description,
    flags: {},
    chats: chats.map(({ id, title, kind, lastMessageAt }) => ({ id, title, kind, lastMessageAt })),
  }
}

/** The chats the messenger lists, then any other chat the store holds their messages in. */
const activityIn = async (
  store: MessageStore,
  account: AccountKey,
  facts: ProfileFacts,
): Promise<SharedChatActivity[]> => {
  const stats = new Map((await store.messages.senderStats(account, facts.id)).map((one) => [one.chatId, one]))
  const listed = new Set(facts.chats.map(({ id }) => id))
  const chats = [
    ...facts.chats,
    ...[...stats.values()]
      .filter(({ chatId }) => !listed.has(chatId))
      .map(({ chatId, title, kind, lastAt }) => ({ id: chatId, title, kind, lastMessageAt: lastAt })),
  ]
  const whole = new Set(
    (
      await store.chats.chatCompleteness(
        account,
        chats.map(({ id }) => id),
      )
    )
      .filter(({ state }) => state === "complete")
      .map(({ chatId }) => chatId as Id),
  )
  return chats.map(({ id, title, kind }) => {
    const one = stats.get(id)
    return {
      id,
      title,
      kind,
      theirMessages: one?.messages ?? 0,
      firstAt: one?.firstAt ?? null,
      lastAt: one?.lastAt ?? null,
      complete: whole.has(id),
    }
  })
}

const quiet = (facts: ProfileFacts): SharedChatActivity[] =>
  facts.chats.map(({ id, title, kind }) => ({
    id,
    title,
    kind,
    theirMessages: 0,
    firstAt: null,
    lastAt: null,
    complete: false,
  }))
