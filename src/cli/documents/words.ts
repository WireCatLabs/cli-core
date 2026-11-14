import { annotate } from "@wirecat/cli-base/commands"
import type { Meta, Missing, NextStep } from "@wirecat/cli-base/standards"
import { defineSteps, type StepDefinition, stepOf } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError } from "commander"
import { type ListBody, listOf } from "../envelope.js"

/** How a documents CLI names itself and its provider in the shared commands' help, examples and answers. */
export interface DocumentWords {
  /** The command: the first word of every example (`drive`). */
  app: string
  /** The profile examples name. */
  profile?: string
  /** The provider's side, as the user types it: `mirrors sync --keep local|<remote>|both`, `<remote>-id`. */
  remote: string
  /** The provider in sentences (`Google`). */
  provider: string
  /** The place files live, in sentences (`Google Drive`); the provider when absent. */
  place?: string
  /** The store's provider name, which an issue names as its `source` (`google-drive`). */
  source: string
  /** Texts that differ from the ones made from the words above. */
  text?: Partial<DocumentTexts>
}

export interface DocumentTexts {
  documents: string
  documentsList: string
  documentArgument: string
  knowledgeArgument: string
  catalog: string
  catalogArgument: string
  treeArgument: string
  folders: string
  folderArgument: string
  syncLimit: string
  identities: string
  identitiesList: string
  identitiesLink: string
  identityArgument: string
  mirrors: string
  mirrorsAdd: string
  mirrorsSync: string
  mirrorParent: string
}

export interface Words extends Required<Omit<DocumentWords, "text">> {
  text: DocumentTexts
  /** `drive personal`: what every example starts with. */
  prefix: string
}

export const wordsOf = (words: DocumentWords): Words => {
  const profile = words.profile ?? "personal"
  const place = words.place ?? words.provider
  const { provider } = words
  return {
    ...words,
    profile,
    place,
    prefix: `${words.app} ${profile}`,
    text: {
      documents: `read imported documents and ${provider} documents`,
      documentsList: `list imported documents with their ${provider} URLs`,
      documentArgument: `document id, ${provider} URL, or a search hit's document: ref`,
      knowledgeArgument: `${provider} file or folder id or URL in the local catalog, or a document:<n> ref`,
      catalog: `browse stored ${place} files and folders offline`,
      catalogArgument: `${provider} file or folder id, or its URL`,
      treeArgument: `${provider} folder id or URL; defaults to the explicitly selected profile's roots`,
      folders: `choose the ${place} folders that sync imports`,
      folderArgument: `folder id or ${place} URL`,
      syncLimit: `how many documents to read from ${provider} in this run`,
      identities: `the ${provider} accounts seen on a document, and the people they belong to`,
      identitiesList: `list the people ${provider} shows for a document`,
      identitiesLink: `record that a ${provider} account belongs to a known person`,
      identityArgument: `${provider} account id, as identities list prints it`,
      mirrors: `keep local folders mirrored into ${place}`,
      mirrorsAdd: `mirror a local folder into ${place}`,
      mirrorsSync: `sync both ways with ${place}; a part changed on both sides is reported`,
      mirrorParent: `the ${place} folder to write into, by id or URL`,
      ...words.text,
    },
  }
}

export const examples = (command: Command, lines: string[]): Command => annotate(command, { examples: lines })

export const positive = (input: string) => {
  const n = Number(input)
  if (!Number.isSafeInteger(n) || n < 1) throw new InvalidArgumentError("use a positive integer")
  return n
}

export const nonnegative = (input: string) => {
  const n = Number(input)
  if (!Number.isSafeInteger(n) || n < 0) throw new InvalidArgumentError("use a nonnegative integer")
  return n
}

/** A list that is never paged: everything there is, in one answer. */
export const allOf = <T>(items: T[]): ListBody<T> =>
  listOf("", { items, limit: Math.max(1, items.length), has_more: false })

/** The `documents` group, made once: the shared commands and the CLI's live ones join it in the order they are added. */
export const documentsGroup = (program: Command, words: Words): Command =>
  program.commands.find((command) => command.name() === "documents") ??
  annotate(program.command("documents"), { effects: { remote: "none", local: "read" } }).description(
    words.text.documents,
  )

const DAY = 24 * 60 * 60 * 1000

export interface CopyAge {
  synced_at: string | null
  age_days: number | null
}

export const ageOf = (lastSync: string | undefined, now = Date.now()): CopyAge => {
  const at = lastSync ? Date.parse(lastSync) : Number.NaN
  return Number.isNaN(at)
    ? { synced_at: null, age_days: null }
    : { synced_at: lastSync ?? null, age_days: Math.max(0, Math.floor((now - at) / DAY)) }
}

// Only the local copy is read: when it is older than a day, say so instead of letting it pass for current.
export const staleCopy = (provider: string, lastSync: string | undefined, now = Date.now()) => {
  const sync = defineSteps([
    { id: "sync.run", command: "sync", args: [], why: `copy the changes ${provider} has made into the local store` },
  ])[0] as StepDefinition
  const { synced_at, age_days } = ageOf(lastSync, now)
  const old = synced_at === null || now - Date.parse(synced_at) > DAY
  if (!old) return {}
  const why =
    age_days === null
      ? `the local copy has no sync time; ${provider} may have changed the document since it was copied`
      : `the local copy was synced ${age_days} day${age_days === 1 ? "" : "s"} ago; ${provider} may have changed the document since`
  return {
    missing: [{ field: "synced_at", why, step: sync.id }] satisfies Missing[],
    next: [stepOf(sync)] satisfies NextStep[],
    meta: { complete: false } satisfies Partial<Meta>,
  }
}
