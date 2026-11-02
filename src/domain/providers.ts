import { CliError } from "@wirecat/cli-base"
import type { Provider } from "./models.js"

/** What a search reads; the same names `--only`, `searched` and `skipped` use. */
export const KINDS = ["messages", "mail", "notes", "documents", "meetings", "events"] as const
export type Kind = (typeof KINDS)[number]

export interface ProviderEntry {
  name: Provider
  kind: Kind
  aliases: readonly string[]
  /** The CLI that wrote the entry (`zm`, `drive`). One CLI may write several providers, so it is not an alias. */
  command?: string
}

/** The seed: what cli-core knows before any CLI has written its entry into the store. */
export const PROVIDERS: readonly ProviderEntry[] = [
  { name: "telegram", kind: "messages", aliases: ["tg"], command: "tg" },
  { name: "telegram-bot", kind: "messages", aliases: ["tg-bot"] },
  { name: "max", kind: "messages", aliases: [], command: "max" },
  { name: "max-bot", kind: "messages", aliases: [] },
  { name: "whatsapp", kind: "messages", aliases: ["wa"], command: "wa" },
  { name: "whatsapp-bot", kind: "messages", aliases: ["wa-bot"] },
  { name: "email", kind: "mail", aliases: [] },
  { name: "notes", kind: "notes", aliases: [] },
  { name: "local", kind: "notes", aliases: [] },
  { name: "obsidian", kind: "notes", aliases: [] },
  { name: "zoom", kind: "meetings", aliases: [] },
]

const LABELS: Readonly<Record<string, string>> = {
  telegram: "Telegram",
  "telegram-bot": "Telegram bot",
  max: "MAX",
  "max-bot": "MAX bot",
  whatsapp: "WhatsApp",
  "whatsapp-bot": "WhatsApp bot",
  "google-drive": "Google Drive",
  email: "mail",
}

/** How a text names a provider to a person: `MAX`, not `max`. */
export const providerLabel = (provider: Provider): string => LABELS[provider] ?? provider

/**
 * A notes folder is an `accounts` row of one of these providers; people call every one `notes`. `obsidian` is a vault,
 * `local` a plain folder (store version 32). `folder` is what they were before, and what Drive's stand-in folders and
 * profile keys saved before that still say.
 */
export const FOLDER_PROVIDERS = ["local", "obsidian", "folder"] as const
export const isFolderProvider = (provider: string): boolean =>
  (FOLDER_PROVIDERS as readonly string[]).includes(provider)
/** The same test in SQL, over an `accounts` row's `provider` column. */
export const folderProviderSql = (column = "provider"): string =>
  `${column} IN (${FOLDER_PROVIDERS.map((name) => `'${name}'`).join(", ")})`
/** The provider a new folder of this format gets. */
export const folderProviderOf = (format: "obsidian" | "markdown"): "obsidian" | "local" =>
  format === "markdown" ? "local" : "obsidian"
/**
 * Providers whose account holds documents the way a notes folder does: one account per remote principal, its
 * files as `documents` rows (store version 31 moved Drive here from a `folder` named `google-drive:<principal>`).
 * The provider registry's `documents` kind replaces this list when Drive leaves `notes` (Wave 3 R2).
 */
export const DOCUMENT_ACCOUNT_PROVIDERS = ["google-drive"] as const
export const isDocumentAccountProvider = (provider: string): boolean =>
  (DOCUMENT_ACCOUNT_PROVIDERS as readonly string[]).includes(provider)
/** A folder or a documents account, in SQL over an `accounts` row's `provider` column. */
export const filesAccountSql = (column = "provider"): string =>
  `${column} IN (${[...FOLDER_PROVIDERS, ...DOCUMENT_ACCOUNT_PROVIDERS].map((name) => `'${name}'`).join(", ")})`
/** Notes written in memo have no account row; this is their account. */
export const INTERNAL_NOTES = "internal"

/** The reason a search gives for an account whose provider no entry names. */
export const UNKNOWN_PROVIDER = "unknown provider — run its CLI once"

const WORD = /^[a-z0-9][a-z0-9_-]*$/

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

const wordOf = (value: unknown, what: string): string =>
  typeof value === "string" && WORD.test(value)
    ? value
    : invalid(`${what} is lowercase letters, digits, - and _ — not ${JSON.stringify(value)}`)

/** An entry as a CLI or the store gives it, checked: anything else is a `validation_error`. */
export const providerEntryOf = (value: unknown): ProviderEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid("a provider entry is an object")
  const { name, kind, aliases = [], command } = value as Record<string, unknown>
  const named = wordOf(name, "a provider's name")
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind))
    invalid(`provider ${named}'s kind is one of ${KINDS.join(", ")} — not ${JSON.stringify(kind)}`)
  if (!Array.isArray(aliases)) invalid(`provider ${named}'s aliases are a list`)
  return {
    name: named,
    kind: kind as Kind,
    aliases: [...new Set((aliases as unknown[]).map((alias) => wordOf(alias, `an alias of ${named}`)))],
    ...(command === undefined ? {} : { command: wordOf(command, `the command of ${named}`) }),
  }
}

const describe = ({ name, kind, command }: ProviderEntry) => `${name} (${kind}${command ? `, from ${command}` : ""})`

const wordsOf = ({ name, aliases }: ProviderEntry) => [name, ...aliases]

/** `entry` joined to `known`: the same name keeps one entry with both entries' aliases; a clash is an error. */
const joined = (known: readonly ProviderEntry[], entry: ProviderEntry): ProviderEntry[] => {
  const same = known.find(({ name }) => name === entry.name)
  if (same && same.kind !== entry.kind)
    invalid(`two provider entries disagree on the kind: ${describe(same)} and ${describe(entry)}`)
  const merged: ProviderEntry = same
    ? {
        ...same,
        aliases: [...new Set([...same.aliases, ...entry.aliases])],
        ...(entry.command ? { command: entry.command } : {}),
      }
    : entry
  const others = known.filter((one) => one !== same)
  for (const word of wordsOf(merged)) {
    const owner = others.find((one) => wordsOf(one).includes(word))
    if (owner) invalid(`"${word}" names two providers: ${describe(owner)} and ${describe(merged)}`)
  }
  return same ? known.map((one) => (one === same ? merged : one)) : [...known, merged]
}

let registry: readonly ProviderEntry[] = PROVIDERS

/** The built-ins and the entries the store or the CLI running gave; what `kindOf` and `providerNamed` read. */
export const providers = (): readonly ProviderEntry[] => registry

/**
 * Replaces the entries beyond the built-ins. Opening the store calls it with the stored entries; a test or a CLI
 * with no store may call it too. Two entries that disagree on a kind, or one word naming two providers, throw.
 */
export const useProviders = (entries: readonly ProviderEntry[]): void => {
  registry = entries.map(providerEntryOf).reduce(joined, PROVIDERS)
}

/**
 * Like `useProviders`, but an entry that clashes is left out instead of failing: what the store holds was written
 * by CLIs of other versions, and one stale entry must not stop the store opening. Answers the entries left out.
 */
export const useStoredProviders = (entries: readonly unknown[]): unknown[] => {
  const left: unknown[] = []
  registry = entries.reduce<readonly ProviderEntry[]>((known, entry) => {
    try {
      return joined(known, providerEntryOf(entry))
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      left.push(entry)
      return known
    }
  }, PROVIDERS)
  return left
}

/** Adds one entry to those in use, strictly: a clash throws and leaves the registry as it was. */
export const addProvider = (entry: ProviderEntry): void => {
  registry = joined(registry, providerEntryOf(entry))
}

export const isKind = (word: string): word is Kind => (KINDS as readonly string[]).includes(word.toLowerCase())

/** The registry's provider a name or alias stands for. */
export const providerNamed = (word: string): ProviderEntry | undefined => {
  const wanted = word.toLowerCase()
  return registry.find((entry) => wordsOf(entry).includes(wanted))
}

/** The kind of a provider the registry knows; `undefined` for one no entry names, which a search skips. */
export const kindIn = (provider: Provider): Kind | undefined =>
  isFolderProvider(provider) ? "notes" : registry.find(({ name }) => name === provider)?.kind

/** A provider the registry does not list counts as a messenger here; a search asks `kindIn` and skips it. */
export const kindOf = (provider: Provider): Kind => kindIn(provider) ?? "messages"
