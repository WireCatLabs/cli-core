import { CliError, singleLine } from "@wirecat/cli-base"
import type { Chat, Id, Page, Provider } from "../domain/models.js"
import type { ProviderDescription as Messenger } from "../ports/provider.js"
import { isId, pickChat, pickPerson } from "../resolve.js"
import { inSource, parseQuery, sourceOf } from "../search/query.js"
import { codeOf } from "../sends/guarded.js"
import type { AccountStore } from "../store/account-store.js"
import type { AccountKey, MessageStore, SearchScope, WordQuery } from "../store/store.js"
import { nothingStored, type ServiceDeps } from "./deps.js"
import type { SearchQuery } from "./message-contracts.js"
import { accountsOfKind, listedAccounts } from "./search-kind.js"

/** What a store search reads of the messenger: its saved-messages chat, and its command for a hint. */
export type Saved = Partial<Pick<Messenger, "savedChatId" | "app">>

/**
 * The chat a store read is about. Offline, a chat with nothing kept answers empty, as it always has;
 * in store mode the store is the only source, so an empty answer would pass for "nothing was said".
 */
export const readChatId = async (
  deps: { reads?: ServiceDeps["reads"]; messenger: Pick<Messenger, "app" | "savedChatId"> },
  reference: string,
  store: Pick<MessageStore, "chats" | "countMessages">,
  account: AccountKey,
): Promise<string> => {
  if (deps.reads !== "store") return storedChatId(deps.messenger, reference, store, account)
  const chatId = await storedChatId(deps.messenger, reference, store, account).catch((error: unknown) => {
    if (codeOf(error) === "not_found") throw new CliError("not_found", nothingStored(deps.messenger))
    throw error
  })
  if ((await store.countMessages(account, chatId)) === 0) {
    throw new CliError("not_found", nothingStored(deps.messenger), { chat: chatId })
  }
  return chatId
}

/** A chat as typed, found among the stored chats the way an adapter finds it among its own. */
export const storedChatId = async (
  messenger: Saved,
  reference: string,
  store: Pick<MessageStore, "chats">,
  account: AccountKey,
): Promise<string> => chatIdAmong(messenger, reference, account, () => store.chats(account, {}))

/** `storedChatId`, among the chats of the account the store is bound to. */
export const chatIdIn = (messenger: Saved, reference: string, store: AccountStore): Promise<string> =>
  chatIdAmong(messenger, reference, store.account, () => store.chats({}))

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
        const held: Chat[] = (await store.chats(account, {})).items
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
      const person = pickPerson(reference, await store.people(only.provider, { account: only.account }))
      return { provider: only.provider, id: person.id }
    }
    const found = (
      await Promise.all(
        providers.map(async (provider) => {
          const ids = accounts.filter((one) => one.provider === provider).map(({ account }) => account)
          const person = await store
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

/**
 * The parsed query and the scope it names: the account the command runs as, or every account of the
 * messenger `in:` or `--source` names. `chat:` resolves as `--chat` does, `from:` through the names
 * `contacts search` uses, `from:me` as what the accounts sent — all inside the accounts chosen.
 */
export const scopeOf = async (
  messenger: Saved,
  store: MessageStore,
  account: AccountKey,
  {
    text,
    chat,
    source,
    accounts: given,
    senders,
    kind,
  }: Pick<SearchQuery, "chat" | "source" | "accounts" | "senders" | "kind"> & {
    text: string
  },
): Promise<[WordQuery, SearchScope]> => {
  const held = await store.accounts()
  const providers = [...new Set(held.map(({ provider }) => provider))]
  const parsed = parseQuery(text, { providers })
  if (chat !== undefined && parsed.chat !== undefined && parsed.chat !== chat) {
    throw new CliError("validation_error", `--chat and chat: name different chats: "${chat}" and "${parsed.chat}"`)
  }
  const listed = await listedAccounts(store, account, source, messenger.app, kind)
  if (listed && parsed.in !== undefined)
    throw new CliError("validation_error", "--source names the accounts — leave in: out, or put it in the list")
  const sourced = source === undefined || listed ? undefined : sourceOf("--source", source, providers)
  if (sourced !== undefined && parsed.in !== undefined && sourced !== parsed.in) {
    throw new CliError("validation_error", `--source and in: name different messengers: ${sourced} and ${parsed.in}`)
  }
  const wanted = parsed.in ?? sourced
  if (given !== undefined && (wanted !== undefined || listed)) {
    throw new CliError("validation_error", "this search reads the accounts it was given — not with in: or --source")
  }
  if (given?.length === 0) throw new CliError("validation_error", "a search names at least one account")
  if (senders !== undefined && parsed.from !== undefined) {
    throw new CliError("validation_error", "--from and from: together — name the people once")
  }
  const accounts = accountsOfKind(
    kind,
    given ??
      listed?.accounts ??
      (wanted === undefined || held.length === 0
        ? [account]
        : held.filter(({ provider }) => inSource(wanted, provider))),
    held,
    wanted,
    messenger.app?.command,
    undefined,
    listed !== undefined || given !== undefined,
  )
  const named = parsed.chat ?? chat
  const scope: SearchScope = { accounts }
  if (named !== undefined) scope.chat = await chatAmong(messenger, store, accounts, named)
  if (senders !== undefined) scope.senders = senders
  if (parsed.from?.toLowerCase() === "me") scope.outgoing = true
  else if (parsed.from !== undefined) scope.sender = await senderAmong(store, accounts, parsed.from)
  if (parsed.after !== undefined) scope.after = parsed.after
  if (parsed.before !== undefined) scope.before = parsed.before
  if (parsed.has.length > 0) {
    const held = await store.attachmentKinds()
    const unknown = parsed.has.find((kind) => !["attachment", "link", ...held].includes(kind))
    if (unknown !== undefined) {
      throw new CliError(
        "validation_error",
        `has:${unknown} — the store holds no ${unknown}; it holds ${["attachment", "link", ...held].join(", ")}`,
      )
    }
    scope.has = parsed.has
  }
  return [{ required: parsed.required, excluded: parsed.excluded }, scope]
}
