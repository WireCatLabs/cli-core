import type { Id } from "../domain/models.js"
import { pickPerson } from "../resolve.js"
import type { ServiceDeps } from "../services/deps.js"
import { storeIfOpen } from "../services/deps.js"
import { type BotCheck, type BotSubject, type PhotoFacts, type StoredActivity, scorePerson } from "./check.js"
import { askRegistries, notCovered, type RegistryAnswer, type RegistryOptions, registriesCover } from "./registries.js"

/** Their stored messages read at most; enough for a first message and repeats, not a whole history. */
const ACTIVITY_MESSAGES = 1000

export interface CheckOptions {
  /** Ask the public ban lists; the person's id goes to each of them. */
  registries: boolean
  registry?: RegistryOptions
}

export interface BotCheckService {
  /** Scores one person; never changes anything, never writes to them. */
  person(reference: string, options: CheckOptions): Promise<BotCheck & { notes: string[] }>
}

/** The registries list Telegram accounts; a bot of another messenger is not in them. */

export const botCheckService = (deps: ServiceDeps): BotCheckService => {
  const subjectOf = async (reference: string): Promise<{ subject: BotSubject; photos?: PhotoFacts }> => {
    if (!deps.offline) {
      const connection = await deps.connection()
      if (connection.profile) {
        const facts = await connection.profile(reference)
        const photos = connection.photos ? await connection.photos(facts.id) : undefined
        const { bot, scam, fake, deleted } = facts.flags
        return {
          subject: {
            id: facts.id,
            name: facts.name,
            usernames: facts.usernames,
            bio: facts.bio,
            flags: {
              ...(bot === undefined ? {} : { bot }),
              ...(scam === undefined ? {} : { scam }),
              ...(fake === undefined ? {} : { fake }),
              ...(deleted === undefined ? {} : { deleted }),
            },
            ...(facts.hasPhoto === undefined ? {} : { hasPhoto: facts.hasPhoto }),
            ...(facts.registered === undefined ? {} : { registered: facts.registered }),
          },
          ...(photos ? { photos } : {}),
        }
      }
      if (connection.contact) {
        const card = await connection.contact(reference)
        const photos = connection.photos ? await connection.photos(card.id) : undefined
        return {
          subject: {
            id: card.id,
            name: card.name,
            usernames: card.username ? [card.username] : [],
            bio: card.description,
          },
          ...(photos ? { photos } : {}),
        }
      }
    }
    const store = await deps.store()
    const account = await deps.account()
    const found = pickPerson(reference, await store.people.people(account.provider, { account: account.account }))
    return { subject: { id: found.id, name: found.name, usernames: found.username ? [found.username] : [] } }
  }

  const activityOf = async (id: Id): Promise<StoredActivity | undefined> => {
    const held = await storeIfOpen(deps)
    if (!held) return undefined
    const { store, account } = held
    const page = await store.messages.find({ account, senders: [id], limit: ACTIVITY_MESSAGES })
    return {
      messages: page.items,
      complete: !page.hasMore,
      chatsStored: (await store.chats.chatsWith(account, id)).length,
    }
  }

  return {
    person: async (reference, { registries, registry }) => {
      const { subject, photos } = await subjectOf(reference)
      const provider = deps.messenger.provider
      const notes: string[] = []
      let answers: RegistryAnswer[] = []
      if (!registries) notes.push("the ban lists were not asked")
      else if (deps.offline) notes.push("offline: the ban lists were not asked")
      else answers = registriesCover(provider) ? await askRegistries(subject.id, registry) : notCovered(provider)
      const activity = await activityOf(subject.id)
      if (!activity) notes.push("no local store: what they wrote was not judged")
      return {
        ...scorePerson({
          subject,
          provider,
          ...(activity ? { activity } : {}),
          ...(photos ? { photos } : {}),
          registries: answers,
        }),
        notes,
      }
    },
  }
}
