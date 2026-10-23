import type { Provider } from "./models.js"

/** What a search reads; the same names `--only`, `searched` and `skipped` use. */
export const KINDS = ["messages", "mail", "notes", "documents", "meetings"] as const
export type Kind = (typeof KINDS)[number]

export interface ProviderEntry {
  name: Provider
  kind: Kind
  aliases: readonly string[]
}

/** Adding a provider is one entry here; `--source` and every search read it. */
export const PROVIDERS: readonly ProviderEntry[] = [
  { name: "telegram", kind: "messages", aliases: ["tg"] },
  { name: "telegram-bot", kind: "messages", aliases: ["tg-bot"] },
  { name: "max", kind: "messages", aliases: [] },
  { name: "max-bot", kind: "messages", aliases: [] },
  { name: "whatsapp", kind: "messages", aliases: ["wa"] },
  { name: "whatsapp-bot", kind: "messages", aliases: ["wa-bot"] },
  { name: "email", kind: "mail", aliases: [] },
  { name: "notes", kind: "notes", aliases: [] },
  { name: "zoom", kind: "meetings", aliases: [] },
]

/** The store keeps a notes folder as an `accounts` row of this provider; people call it `notes`. */
export const FOLDER_PROVIDER = "folder"
/** Notes written in memo have no account row; this is their account. */
export const INTERNAL_NOTES = "internal"

export const isKind = (word: string): word is Kind => (KINDS as readonly string[]).includes(word.toLowerCase())

/** The registry's provider a name or alias stands for. */
export const providerNamed = (word: string): ProviderEntry | undefined => {
  const wanted = word.toLowerCase()
  return PROVIDERS.find(({ name, aliases }) => name === wanted || aliases.includes(wanted))
}

/** A provider the registry does not list is a messenger: consumers define their own and tests use made-up ones. */
export const kindOf = (provider: Provider): Kind =>
  provider === FOLDER_PROVIDER ? "notes" : (providerNamed(provider)?.kind ?? "messages")
