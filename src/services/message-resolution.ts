import { CliError, singleLine } from "@wirecat/cli-base"
import type { Chat, Id, Page, Provider } from "../domain/models.js"
import type { MessengerTraits } from "../ports/traits.js"
import { isId, pickChat, pickPerson } from "../resolve.js"
import { codeOf } from "../sends/guarded.js"
import type { AccountStore } from "../store/account-store.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { nothingStored, type ServiceDeps } from "./deps.js"

/** What a store search reads of the messenger: its saved-messages chat, and its command for a hint. */
export type Saved = Partial<Pick<MessengerTraits, "savedChatId" | "app">>

/**
 * The chat a store read is about. Offline, a chat with nothing kept answers empty, as it always has;
 * in store mode the store is the only source, so an empty answer would pass for "nothing was said".
 */
export const readChatId = async (
  deps: ServiceDeps,
  reference: string,
  store: MessageStore,
  account: AccountKey,
): Promise<string> => {
  if (deps.reads !== "store") return keptChatId(deps.messenger, reference, store, account)
  const chatId = await keptChatId(deps.messenger, reference, store, account).catch((error: unknown) => {
    if (codeOf(error) === "not_found") throw new CliError("not_found", nothingStored(deps.messenger))
    throw error
  })
  if ((await store.messages.countMessages(account, chatId)) === 0) {
    const all = (await store.chats.chats(account, { includeLeft: true })).items
    const left = all.some((one) => one.id === chatId && one.membershipState === "left")
    throw new CliError("not_found", left ? LEFT_EMPTY : nothingStored(deps.messenger), { chat: chatId })
  }
  return chatId
}

const LEFT_EMPTY = "you left this chat, and the store holds none of its messages"

/** A chat as typed, found among the stored chats the way an adapter finds it among its own. */
export const storedChatId = async (
  messenger: Saved,
  reference: string,
  store: MessageStore,
  account: AccountKey,
): Promise<string> => chatIdAmong(messenger, reference, account, () => store.chats.chats(account, {}))

/** `storedChatId`, then among the chats the account left: their history is kept, so a read of it still finds them. */
const keptChatId = (messenger: Saved, reference: string, store: MessageStore, account: AccountKey): Promise<string> =>
  storedChatId(messenger, reference, store, account).catch((error: unknown) => {
    if (codeOf(error) !== "not_found") throw error
    return chatIdAmong(messenger, reference, account, () => store.chats.chats(account, { includeLeft: true }))
  })

/** `storedChatId`, among the chats of the account the store is bound to; `includeLeft` tries the left ones last. */
export const chatIdIn = (
  messenger: Saved,
  reference: string,
  store: AccountStore,
  { includeLeft = false }: { includeLeft?: boolean } = {},
): Promise<string> => {
  const among = chatIdAmong(messenger, reference, store.account, () => store.chats.chats({}))
  if (!includeLeft) return among
  return among.catch((error: unknown) => {
    if (codeOf(error) !== "not_found") throw error
    return chatIdAmong(messenger, reference, store.account, () => store.chats.chats({ includeLeft: true }))
  })
}

const chatIdAmong = async (
  messenger: Saved,
  reference: string,
  account: AccountKey,
  held: () => Promise<Page<Chat>>,
): Promise<string> => {
  const trimmed = reference.trim()
  if (messenger.savedChatId && ["me", "self", "saved"].includes(trimmed.toLowerCase())) {
    return messenger.savedChatId(account)
  }
  if (/^-?\d+$/.test(trimmed)) return trimmed
  const chats = (await held()).items
  const exact = chats.find((one) => one.id === trimmed)
  if (exact) return exact.id
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).toLowerCase()
    const found = chats.find((one) => String(one.providerMetadata?.username ?? "").toLowerCase() === username)
    if (!found) throw new CliError("not_found", `no stored chat is ${trimmed}`)
    return found.id
  }
  return pickChat(trimmed, chats).id
}

/** Several candidates in different accounts: which messenger each is in says which one was meant. */
const ambiguousAcross = (
  reference: string,
  what: string,
  candidates: { provider: Provider; id: Id; label: string }[],
) => {
  const width = Math.max(...candidates.map(({ provider, id }) => `${provider}  ${id}`.length))
  const lines = candidates.map(({ provider, id, label }) => `  ${`${provider}  ${id}`.padEnd(width)}  ${label}`)
  return new CliError(
    "validation_error",
    `"${singleLine(reference)}" matches ${candidates.length} ${what} in different accounts — ` +
      `name one by its id, or narrow the search with in:<messenger>:\n${lines.join("\n")}`,
    { candidates: candidates.map(({ provider, id }) => ({ provider, id })) },
  )
}

const missing = (error: unknown) => {
  if (codeOf(error) === "not_found") return undefined
  throw error
}

/** A chat as `--chat` names it, in whichever of the accounts holds it — one of them, or it is an error. */
export const chatAmong = async (
  messenger: Saved,
  store: MessageStore,
  accounts: AccountKey[],
  reference: string,
): Promise<{ account: AccountKey; chatId: Id }> => {
  const [only] = accounts
  if (accounts.length === 1 && only)
    return { account: only, chatId: await storedChatId(messenger, reference, store, only) }
  const found = (
    await Promise.all(
      accounts.map(async (account) => {
        const held: Chat[] = (await store.chats.chats(account, {})).items
        const chatId = await storedChatId(messenger, reference, store, account).catch(missing)
        const chat = held.find((one) => one.id === chatId)
        return chat ? [{ account, chat }] : []
      }),
    )
  ).flat()
  const [one] = found
  if (found.length === 1 && one) return { account: one.account, chatId: one.chat.id }
  if (found.length === 0) throw new CliError("not_found", `no stored chat matches "${singleLine(reference)}"`)
  throw ambiguousAcross(
    reference,
    "chats",
    found.map(({ account, chat }) => ({
      provider: account.provider,
      id: chat.id,
      label: singleLine(chat.title ?? ""),
    })),
  )
}

/** A sender, through the names each messenger's accounts have seen; `from:` names one person. */
export const senderAmong = async (store: MessageStore, accounts: AccountKey[], reference: string) => {
  const providers = [...new Set(accounts.map(({ provider }) => provider))]
  const [only] = accounts
  try {
    if (accounts.length === 1 && only) {
      const person = pickPerson(reference, await store.people.people(only.provider, { account: only.account }))
      return { provider: only.provider, id: person.id }
    }
    const found = (
      await Promise.all(
        providers.map(async (provider) => {
          const ids = accounts.filter((one) => one.provider === provider).map(({ account }) => account)
          const person = await store.people
            .people(provider, { accounts: ids })
            .then((people) => pickPerson(reference, people))
            .catch(missing)
          return person ? [{ provider, person }] : []
        }),
      )
    ).flat()
    const [one] = found
    if (found.length === 1 && one) return { provider: one.provider, id: one.person.id }
    if (found.length === 0) {
      throw new CliError(
        "not_found",
        isId(reference) ? `no person ${reference} in what these accounts have seen` : `nobody matches "${reference}"`,
      )
    }
    throw ambiguousAcross(
      reference,
      "people",
      found.map(({ provider, person }) => ({ provider, id: person.id, label: singleLine(person.name ?? "") })),
    )
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") {
      throw new CliError("not_found", `from:${reference} — ${error.message}`)
    }
    throw error
  }
}
