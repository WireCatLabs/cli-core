import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CliError, type ErrorCode, isCliError, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import { annotate, metaOf } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { resolveAISettings } from "../../analysis/settings.js"
import type { Deadline, RunBudget } from "../../background/budget.js"
import { progressOf } from "../../background/checkpoints.js"
import {
  catalogFiles,
  type documentIngestion,
  documentKnowledge,
  type FeedlessDocumentSource,
  SCAN_READERS,
  type ScanReaderChoice,
  type SourceContent,
  type SourceFile,
  type SourceState,
  type SourceStatePort,
  scanReader,
  scanRetry,
  scanSkipReason,
  syncDocuments,
} from "../../documents.js"
import type { ProviderEntry } from "../../domain/providers.js"
import { acquireLock } from "../../files/lock.js"
import { modelGateway } from "../../models/index.js"
import { modelTarget } from "../../models/settings.js"
import type { AppIdentity } from "../../ports/app.js"
import { readOnlyLockOf } from "../../ports/app.js"
import type { EventSink } from "../../runs/events.js"
import type { MessageStore } from "../../store/index.js"
import { openAppStore } from "../app-store.js"
import { actorOf } from "../author.js"
import { baseContext, environmentOf, outputFor } from "../context.js"
import { refuseOffline } from "../early-refusal.js"
import { writesOwnerFiles } from "../effects.js"
import { type Body, renderAnswer } from "../envelope.js"
import { accountFileFor, profilesHere, rememberAccount } from "../messenger/accounts.js"
import { ProfileTokenStore } from "../profile-token.js"
import { fromFile, type Settings } from "../settings.js"
import { DOCUMENT_UNTRUSTED, marksUntrusted } from "../untrusted-marks.js"
import { addDocumentCatalogCommands, type DocumentCatalogCommands } from "./catalog.js"
import { addLocalDocumentCommands, type LocalDocumentCommands } from "./documents.js"
import { addDocumentFolderCommands, type DocumentFolderCommands } from "./folders.js"
import { addDocumentHistoryCommands, type DocumentHistoryCommands, keepVersionsForDays } from "./history.js"
import type { DocumentKnowledgePort } from "./knowledge.js"
import { addDocumentKnowledgeCommands, type DocumentKnowledgeCommands } from "./knowledge.js"
import { factItem, memoryItem } from "./queries.js"
import { addDocumentSearchCommand, type DocumentSearchCommands } from "./search.js"
import {
  addDocumentSyncCommands,
  DOCUMENT_SYNC_LIMIT,
  type DocumentSyncAnswer,
  type DocumentSyncCommands,
  documentSyncPart,
} from "./sync.js"
import { type DocumentWords, wordsOf } from "./words.js"

/** `read_scans`: a documents CLI adds it to `settingsFor`; left out, scans are read on this computer. */
export const DOCUMENT_SCAN_SETTINGS = {
  profile: {
    read_scans: v.optional(v.picklist(SCAN_READERS, `has to be one of ${SCAN_READERS.join(", ")}`)),
  },
  settings: [
    {
      key: "read_scans",
      default: "local",
      description:
        "who reads the text of scans and pictures: local (the tesseract program), anthropic or openai " +
        "(the AI model `ai set` chose, with pictures allowed), or off",
    },
  ],
}

const readScans = (settings: Pick<Settings, "configured" | "shared">): ScanReaderChoice =>
  fromFile<ScanReaderChoice>(settings, "read_scans", "local").value

type Resolve = Parameters<typeof baseContext>[1]
type Group<T> = Omit<T, "words" | "output">
interface DocumentGroups {
  folders: Group<DocumentFolderCommands>
  sync: Group<DocumentSyncCommands>
  documents: Group<LocalDocumentCommands>
  search: Group<DocumentSearchCommands>
  catalog: Group<DocumentCatalogCommands>
  knowledge: Group<DocumentKnowledgeCommands>
  history: Group<DocumentHistoryCommands>
}
type Ingestion<M extends SourceFile> = ReturnType<typeof documentIngestion<M>>

/** Something a source met on its way and went on past: one per file, gathered into the answer's issues. */
export interface DocumentWarning {
  id?: string
  code: ErrorCode
  reason: string
  message: string
}

/** What a run gives the CLI's source beside the request log. */
export interface DocumentSourceRun {
  deadline?: Deadline
  warn(warning: DocumentWarning): void
}

export interface DocumentLibraryOptions<M extends SourceFile> {
  app: AppIdentity
  /** The CLI's settings, as `baseContext` reads them: `configuration.resolveSettings`. */
  resolveSettings: Resolve
  provider: ProviderEntry
  words: DocumentWords
  /** The service's name in messages: "Yandex Disk". */
  service: string
  /** The provider's adapter for one run, built inside cli-core's run so its requests are recorded. */
  source(command: Command, events: EventSink, run: DocumentSourceRun): FeedlessDocumentSource<M>
  /** How the CLI files a document in the shared store: its catalog entry and front matter. */
  ingestion(store: MessageStore): Ingestion<M>
  /** A file or folder id from what the user typed: an id, a link, a path. */
  idOf(input: string): string
  /** The folder `folders add` names, read live; refuse one the account cannot use. Defaults to `metadata(idOf(input))`. */
  folder?(source: FeedlessDocumentSource<M>, input: string): Promise<M>
  isFolder(file: M): boolean
  isDocument?(file: M): boolean
  /** Why a file is kept by name only (an unsupported type, too large); undefined reads it. */
  skipReason?(file: M): string | undefined
  /** One row of `documents list`. */
  row(file: M, reference: string): object
  /** The longest text the store keeps of one document. */
  textLimit: number
  /** The entries one sync walks before it stops and saves. */
  maxEntries: number
  /** What `sync` says it covers. */
  coverage: string
  /** The accounts a document names, for `identities list`; none when the provider shows none. */
  people?: DocumentKnowledgePort["people"]
  /** Where a chosen folder is at the provider, for `folders list`: a Disk path. Unset: the answer has no path. */
  folderPath?(folder: M): string | undefined
  /** The CLI's own `folders browse`. */
  browse?(folders: Command, tools: DocumentLibraryTools<M>): void
}

/** What the CLI's own commands beside the shared ones may use, for the running command. */
export interface DocumentLibraryTools<M extends SourceFile> {
  env(): NodeJS.ProcessEnv
  profile(): string
  output(body: Body): void
  roots(): string[]
  /** Runs `body` with the provider's source inside cli-core's run. */
  withSource<T>(body: (source: FeedlessDocumentSource<M>) => Promise<T>): Promise<T>
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new CliError("configuration_error", `${path} cannot be read; move it away and sync again`, {
      reason: "state.unreadable",
    })
  }
}

const writeJson = (path: string, value: unknown) => writeSecurely(path, JSON.stringify(value), 0o600)

/** A provider id is a file name as it is; anything else is hashed, so no id reaches outside the folder. */
const fileName = (id: string) =>
  /^[0-9a-f-]{1,64}$/u.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 40)

interface Folders<M extends SourceFile> {
  roots: string[]
  /** Each chosen folder as `folders add` read it: a source that addresses by path finds it before the first sync. */
  files?: Record<string, M>
  /** When the choice last changed: a sync before it copied another scope. */
  changed_at?: string
}

/**
 * One profile's document files under the CLI's state folder: the chosen folders, the sync's checkpoint, its walk and
 * one snapshot per document, each a private file.
 */
export const documentProfile = <M extends SourceFile>(app: AppIdentity, env: NodeJS.ProcessEnv, profile: string) => {
  const dir = join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "profiles", profile)
  const sync = join(dir, "sync")
  const snapshot = (id: string) => join(sync, "snapshots", `${fileName(id)}.json`)
  const folders = () => readJson<Folders<M>>(join(dir, "folders.json")) ?? { roots: [] }
  const state = (principal: string): SourceStatePort<M> => ({
    read: () =>
      readJson<SourceState<M>>(join(sync, "state.json")) ?? {
        version: 1,
        principal,
        scope: "",
        folders: {},
        documents: {},
        skipped: [],
      },
    save: (next) => writeJson(join(sync, "state.json"), next),
    readWalk: (scope) => {
      const walk = readJson<{ scope: string }>(join(sync, "walk.json"))
      return walk?.scope === scope ? (walk as never) : undefined
    },
    saveWalk: (walk) => writeJson(join(sync, "walk.json"), walk),
    removeWalk: () => rmSync(join(sync, "walk.json"), { force: true }),
    saveSnapshot: (content) => writeJson(snapshot(content.metadata.id), content),
    removeSnapshot: (id) => rmSync(snapshot(id), { force: true }),
  })
  return {
    dir,
    folders,
    saveFolders: (roots: string[], files: Record<string, M>) =>
      writeJson(join(dir, "folders.json"), {
        roots,
        files: Object.fromEntries(roots.flatMap((id) => (files[id] ? [[id, files[id]]] : []))),
        changed_at: new Date().toISOString(),
      }),
    /** Keeps a chosen folder's newer metadata (a new path) without changing the choice or its date. */
    saveFolderFile: (file: M) => {
      const chosen = folders()
      writeJson(join(dir, "folders.json"), { ...chosen, files: { ...chosen.files, [file.id]: file } })
    },
    state,
    synced: () => existsSync(join(sync, "state.json")),
    walkUnderWay: () => existsSync(join(sync, "walk.json")),
    snapshot: (id: string) => readJson<SourceContent<M>>(snapshot(id)),
    /**
     * The lock a sync and every write to the local copy take, so a tag added during a sync is not lost. A second
     * holder is refused at once: waiting would hold an agent's tool call for the length of a sync.
     */
    locked: async <T>(fn: (assertHeld: () => void) => Promise<T>): Promise<T> => {
      const lock = await acquireLock(join(dir, "sync.lock")).catch((error: unknown) => {
        throw new CliError(
          "provider_unavailable",
          "another sync or write holds this profile's local copy; retry later",
          {
            reason: "profile.busy",
            ...(error instanceof CliError ? { holders: error.details.holders } : {}),
          },
        )
      })
      let held = true
      try {
        return await fn(() => {
          if (!held)
            throw new CliError("provider_unavailable", "the profile's lock was released", { reason: "profile.busy" })
        })
      } finally {
        held = false
        await lock.release()
      }
    },
  }
}

const recalled = (app: AppIdentity, env: NodeJS.ProcessEnv, profile: string) =>
  readJson<{ account?: unknown }>(accountFileFor(app, profile, env))?.account

/**
 * Takes a provider account for a profile before its copy is written. One account is one collection in the shared
 * store, so two profiles on it would each remove the other's documents; and a profile's copy stays with the account
 * it was synced from.
 */
export const claimDocumentAccount = (
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  profile: string,
  account: string,
  tokens: Pick<ProfileTokenStore, "read">,
) => {
  const other = profilesHere(app, [], env).find(
    (name) => name !== profile && recalled(app, env, name) === account && tokens.read(name) !== undefined,
  )
  if (other) {
    const fromVariable = tokens.read(other)?.source === "environment"
    throw new CliError(
      "conflict",
      `profile ${other} already uses this account; use \`${app.command} ${other} …\`, or ` +
        (fromVariable
          ? `give this profile its own token instead of ${app.envPrefix}_TOKEN`
          : `run \`${app.command} ${other} session end\` first`),
      { reason: "profile.account-taken", profile: other },
    )
  }
  const synced = documentProfile(app, env, profile).state("").read().principal
  if (synced && synced !== account)
    throw new CliError(
      "conflict",
      `profile ${profile} holds a copy synced from another account; sign this one in under a new profile ` +
        `(\`${app.command} <new profile> session start\`)`,
      { reason: "profile.other-account" },
    )
  if (recalled(app, env, profile) !== account) rememberAccount(app, profile, account, env)
}

const DOCUMENT_REF = /^document:[1-9]\d*$/u

/** The documents half of a `sync` another group mounts, as the shared `sync` would have answered it. */
export interface DocumentSyncOutcome {
  /** The shared `sync`'s answer, its warnings included; `skipped` when the profile has nothing to sync. */
  item: (DocumentSyncAnswer & { warnings: unknown[] }) | { skipped: string }
  meta: { complete?: false; issues?: { code: ErrorCode; reason: string; source: string }[] }
  next: NextStep[]
  diagnostics: string[]
}

/** Runs the documents sync inside the command another group mounted as `sync`. */
export type DocumentSyncStep = (
  command: Command,
  args: {
    rescan?: boolean
    embed?: boolean
    budget: RunBudget
    deadline?: Deadline
    /** The account the other group's part synced; the documents of another account of it are refused. */
    account?: { provider: string; account: string }
  },
) => Promise<DocumentSyncOutcome>

/**
 * `documentLibraryCommands` without its `sync`, and that sync as a step, for a CLI whose own `sync` brings the
 * documents too: linear-cli's tracker `sync` (`addTrackerCommands({ documents })`), so the owner and Desktop keep one
 * `<cli> sync`.
 */
export const documentLibrary = <M extends SourceFile>(
  options: DocumentLibraryOptions<M>,
): { commands: Command[]; sync: DocumentSyncStep } => libraryOf(options, false)

const libraryOf = <M extends SourceFile>(
  options: DocumentLibraryOptions<M>,
  withSync: boolean,
): { commands: Command[]; sync: DocumentSyncStep } => {
  const { app } = options
  const holder = new Command(app.command)
  // The shared helpers take no command, so each run's command is caught as it starts; an MCP server builds the tree
  // anew for every call.
  let running: Command | undefined
  let warnings: DocumentWarning[] = []
  // Set while another group's `sync` runs the documents step: a named run leaves the answer's run_id to that sync.
  let sideRun: string | undefined
  let expected: string | undefined
  const command = () => {
    if (!running) throw new CliError("configuration_error", "a shared documents port ran outside a command")
    return running
  }
  const context = () => baseContext(command(), options.resolveSettings)
  const env = () => context().env
  const profile = () => {
    const name = context().settings.profile
    if (!name) throw new CliError("validation_error", "a profile is required")
    return name
  }
  const files = () => documentProfile<M>(app, env(), profile())
  const tokens = () => {
    const { env: variables, keyring } = context()
    return new ProfileTokenStore({ app, env: variables, ...(keyring ? { keyring } : {}) })
  }
  const roots = () => files().folders().roots
  const principal = () => {
    const account = recalled(app, env(), profile())
    if (typeof account !== "string" || !files().synced())
      throw new CliError("not_found", `profile ${profile()} has no local copy yet — ${app.command} ${profile()} sync`, {
        reason: "profile.not-synced",
      })
    return account
  }
  const withStore = async <T>(write: boolean, fn: (store: MessageStore) => Promise<T>) => {
    const store = await openAppStore(env(), {
      app,
      provider: options.provider,
      readOnly: !write || readOnlyLockOf(app, env()) !== undefined,
    })
    try {
      return await fn(store)
    } finally {
      await store.close()
    }
  }
  const locked = <T>(write: boolean, fn: (assertHeld: () => void) => Promise<T>) =>
    write ? files().locked(fn) : fn(() => undefined)
  const writes = () => metaOf(command()).effects?.local === "write"
  const warningIssues = () => {
    const seen = new Set<string>()
    return warnings.flatMap((warning) => {
      const key = `${warning.code}:${warning.reason}`
      if (seen.has(key)) return []
      seen.add(key)
      return [{ code: warning.code, reason: warning.reason, source: options.provider.name }]
    })
  }
  const output = (body: Body) => {
    const issues = warningIssues()
    renderAnswer(command(), outputFor(command()), {
      ...body,
      ...(issues.length ? { meta: { ...body.meta, issues: [...(body.meta?.issues ?? []), ...issues] } } : {}),
    })
  }
  // The folder as `folders add` read it stands in for the one the last pass held, before the first sync.
  const known = (source: FeedlessDocumentSource<M>): FeedlessDocumentSource<M> => {
    const chosen = files().folders().files ?? {}
    // The folder as `folders add` last read it wins over the walk's copy: adding a moved folder again under its new
    // path is how a path-addressed source finds it.
    const metadata: FeedlessDocumentSource<M>["metadata"] = (id, held) => source.metadata(id, chosen[id] ?? held)
    // A proxy, not a spread: a source written as a class keeps its methods and private fields.
    return new Proxy(source, {
      get: (target, name) => {
        if (name === "metadata") return metadata
        const value = Reflect.get(target, name)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }
  const withSource = <T>(body: (source: FeedlessDocumentSource<M>) => Promise<T>, deadline?: Deadline) => {
    refuseOffline(command(), options.service)
    return context().run(
      (events) =>
        body(
          known(
            options.source(command(), events, { warn: (one) => warnings.push(one), ...(deadline ? { deadline } : {}) }),
          ),
        ),
      sideRun === undefined ? {} : { name: sideRun },
    )
  }
  const errorOf = (error: unknown) =>
    isCliError(error)
      ? error
      : new CliError("provider_error", `a ${options.service} read failed`, { reason: "provider.failed" })
  const knowledgeOf = (store: MessageStore, account: string): DocumentKnowledgePort => {
    const ingestion = options.ingestion(store)
    const shared = documentKnowledge(store, async (one) =>
      one === account ? (await ingestion.collection(one, false))?.id : undefined,
    )
    const people: DocumentKnowledgePort["people"] = options.people ?? (async () => ({ items: [] }))
    return {
      ...shared,
      context: async (one, ref) => ({
        document: await shared.document(one, ref),
        tags: await store.notes.noteTags(ref),
        links: await store.notes.links({ from: ref }),
        notes: await store.notes.notes({ source: "internal", about: ref, limit: 100 }),
        memories: (await store.memories.list({ subject: ref, limit: 100 })).items.map(memoryItem),
        facts: (await store.facts.list({ subject: ref, limit: 100 })).items.map(factItem),
        people: await people(one, ref),
      }),
      people,
      linkPerson: async () => {
        throw new CliError("not_found", `${options.service} shows no accounts on a document`, {
          reason: "identity.none",
        })
      },
    }
  }
  const imported = (input: string) => {
    const held = files().state("").read()
    const id = DOCUMENT_REF.test(input)
      ? Object.entries(held.documents).find(([, doc]) => doc.reference === input)?.[0]
      : options.idOf(input)
    const doc = id ? held.documents[id] : undefined
    const snapshot = id && doc ? files().snapshot(id) : undefined
    if (!id || !doc || !snapshot)
      throw new CliError("not_found", "this document is not in the selected profile's local copy", {
        reason: "document.not-imported",
      })
    return { id, ref: doc.reference, hash: doc.hash, snapshot, metadata: options.row(doc.metadata, doc.reference) }
  }
  const refOf = async (store: MessageStore, account: string, input: string) => {
    if (DOCUMENT_REF.test(input)) return input
    const id = options.idOf(input)
    const held = files().state(account).read().documents[id]
    if (held) return held.reference
    const entry = await options.ingestion(store).catalog.get(account, id)
    if (entry) return entry.ref
    throw new CliError("not_found", "this document or folder is not in the selected profile's local copy", {
      reason: "document.not-imported",
    })
  }
  const decider = () => {
    const actor = actorOf(command())
    return actor === "owner" ? ("owner" as const) : { bot: actor, reason: `asked by ${actor} through ${app.command}` }
  }

  const groups: DocumentGroups = {
    folders: {
      add: async (input) => {
        const file = await withSource((source) =>
          options.folder ? options.folder(source, input) : source.metadata(options.idOf(input)),
        )
        if (file.trashed || !options.isFolder(file))
          throw new CliError("validation_error", `choose a folder the ${options.service} account can read`, {
            reason: "folder.not-a-folder",
          })
        const chosen = files().folders()
        // A folder already chosen keeps its date, so status does not report a new plan for it.
        if (!chosen.roots.includes(file.id))
          files().saveFolders([...chosen.roots, file.id], { ...chosen.files, [file.id]: file })
        else files().saveFolderFile(file)
        return { id: file.id, name: file.name }
      },
      list: (filter) =>
        roots()
          .filter((id) => filter.id === undefined || filter.id === id)
          .map((id) => {
            const file = files().folders().files?.[id]
            const path = file ? options.folderPath?.(file) : undefined
            return { id, ...(file ? { name: file.name } : {}), ...(path ? { path } : {}) }
          }),
      remove: (input) => {
        const id = options.idOf(input)
        const chosen = files().folders()
        if (!chosen.roots.includes(id))
          throw new CliError("not_found", `${id} is not a chosen folder; folders list shows them`, {
            reason: "folder.not-chosen",
          })
        files().saveFolders(
          chosen.roots.filter((root) => root !== id),
          chosen.files ?? {},
        )
        return id
      },
      ...(options.browse
        ? {
            browse: (folders: Command) =>
              options.browse?.(folders, { env, profile, output, roots, withSource: (body) => withSource(body) }),
          }
        : {}),
    },
    sync: {
      diagnostic: (text) => outputFor(command()).streams.diagnostic(text),
      profile,
      maxEntries: options.maxEntries,
      sync: async ({ limit, rescan, embed, budget, deadline }) => {
        const name = profile()
        const chosen = roots()
        const synced = await withSource(async (source) => {
          const live = await source.identity()
          if (expected !== undefined && live !== expected)
            throw new CliError(
              "configuration_error",
              `the documents are signed in as ${options.service} account ${live}, not ${expected}, the account the ` +
                `rest of this sync read; sign in again with one account (\`${app.command} ${name} session start\`)`,
              { reason: "documents.other-account" },
            )
          claimDocumentAccount(app, env(), name, live, tokens())
          const { keyring, settings } = context()
          const signal = environmentOf(command()).signal as AbortSignal | undefined
          const scans = await scanReader(readScans(settings), {
            app,
            env: env(),
            command: app.command,
            ...(keyring ? { keyring } : {}),
            ...(signal ? { signal } : {}),
          })
          const skipReason = options.skipReason ?? (() => undefined)
          return files().locked((assertHeld) =>
            withStore(true, async (store) => {
              const result = await syncDocuments<M>({
                source,
                index: {
                  ...options.ingestion(store),
                  openPictures: async () => {
                    throw new CliError("not_found", `${options.service} pictures are not searched`)
                  },
                },
                state: files().state(live),
                principal: live,
                profile: name,
                roots: chosen,
                textLimit: options.textLimit,
                max: limit,
                maxEntries: options.maxEntries,
                isFolder: options.isFolder,
                ...(options.isDocument ? { isDocument: options.isDocument } : {}),
                skipReason: (file) => scanSkipReason(scans, file, skipReason(file)),
                // A file an older version kept by name for its type is read once a newer one reads that type; the
                // planner asks only when `skipReason` no longer gives a reason. The words are the CLIs' own.
                retryable: (skip) => skip.reason.startsWith("unsupported type: ") || scanRetry(scans, skip.reason),
                ...(scans ? { scans } : {}),
                errorOf,
                assertHeld,
                storeVersion: app.version,
                keepVersionsForDays: keepVersionsForDays(context().settings),
                ...(environmentOf(command()).signal ? { signal: environmentOf(command()).signal as AbortSignal } : {}),
                ...(rescan ? { rescan } : {}),
                ...(budget ? { budget } : {}),
                ...(deadline ? { deadline } : {}),
              })
              if (!embed) return result
              const { embedNotes } = await import("../../services/notes-search.js")
              return {
                ...result,
                embeddings: await embedNotes(store, {
                  maxChunks: 600,
                  env: env(),
                  command: app.command,
                  ...(deadline ? { deadline } : {}),
                }),
              }
            }),
          )
        }, deadline)
        return {
          ...synced,
          warnings: warnings.map(({ id, code, reason, message }) => ({ id: id ?? null, code, reason, message })),
        }
      },
      status: () => {
        const name = profile()
        const held = files().state("").read()
        const pending = held.pending?.jobs.length ?? 0
        const queued = new Set(held.pending?.jobs.map((job) => job.id))
        const done = Object.keys(held.documents).filter((id) => !queued.has(id)).length
        const changed = files().folders().changed_at
        const unplanned =
          files().walkUnderWay() ||
          (changed !== undefined && (!held.lastSync || Date.parse(changed) > Date.parse(held.lastSync)))
        return {
          profile: name,
          selected_folders: roots(),
          documents: Object.keys(held.documents).length,
          pending,
          skipped: held.skipped.map(({ id, reason }) => ({ id, reason })),
          last_sync: held.lastSync ?? null,
          progress: progressOf({
            job: "sync",
            profile: name,
            done,
            ...(unplanned || (!held.lastSync && !held.pending) ? {} : { total: done + pending }),
            ...(held.lastSync ? { updatedAt: held.lastSync } : {}),
            complete: Boolean(held.lastSync) && !held.pending && !unplanned,
          }),
          coverage: options.coverage,
          remote_checked: false,
        }
      },
    },
    documents: {
      list: (query, page) => {
        const account = principal()
        return withStore(false, async (store) => {
          const found = await knowledgeOf(store, account).documents(account, query, page)
          const held = files().state(account).read().documents
          return {
            items: found.items.map((note) => {
              const id = (note.path ?? "").replace(/\.md$/u, "")
              const doc = held[id]
              return doc ? options.row(doc.metadata, doc.reference) : { id, name: note.title, reference: note.ref }
            }),
            hasMore: found.hasMore,
          }
        })
      },
      document: (input) => {
        const { id, metadata, snapshot } = imported(input)
        return { id, metadata, snapshot }
      },
      lastSync: () => files().state("").read().lastSync,
    },
    history: {
      run: (fn) => {
        const account = principal()
        return withStore(false, (store) => fn(options.ingestion(store).history, account))
      },
      id: (input) => options.idOf(input),
    },
    search: {
      search: (query, searchOptions) => {
        const account = principal()
        return withStore(false, async (store) => {
          const folder = await options.ingestion(store).collection(account, false)
          if (!folder) return { query, by: "words", hits: [], has_more: false }
          const { searchNotes } = await import("../../services/notes-search.js")
          const { items, hasMore, nextOffset, ...rest } = await searchNotes(store, query, {
            ...searchOptions,
            folderIds: [folder.id],
            env: env(),
            command: app.command,
          })
          return {
            ...rest,
            hits: items.map((hit) => ({ id: (hit.path ?? "").replace(/\.md$/u, ""), ...hit })),
            has_more: hasMore,
            ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
          }
        })
      },
      imported: () => ({
        profile: profile(),
        chosen: roots().length > 0,
        documents: Object.keys(files().state("").read().documents).length,
      }),
    },
    catalog: {
      run: (fn, write) => {
        const account = principal()
        return withStore(write, (store) =>
          locked(write, async (assertHeld) => {
            const ingestion = options.ingestion(store)
            assertHeld()
            const value = await fn(
              {
                catalog: {
                  import: (one) => ingestion.catalog.import(one, catalogFiles(files().state(one).read(), roots())),
                  get: (one, id) => ingestion.catalog.get(one, id),
                  list: (one, query) => ingestion.catalog.list(one, query),
                },
                knowledge: knowledgeOf(store, account),
              },
              account,
            )
            assertHeld()
            return value
          }),
        )
      },
      id: (input) => options.idOf(input),
      roots,
    },
    knowledge: {
      run: (input, fn) => {
        const write = writes()
        const account = principal()
        return withStore(write, (store) =>
          locked(write, async (assertHeld) => {
            const ref = await refOf(store, account, input)
            assertHeld()
            const value = await fn(knowledgeOf(store, account), account, ref)
            assertHeld()
            return value
          }),
        )
      },
      document: (input) => {
        const { id, ref, hash, snapshot } = imported(input)
        return { id, ref, hash, snapshot }
      },
      complete: () => {
        const { values } = resolveAISettings(app.envPrefix, [], env())
        const variables = env()
        return modelGateway({
          resolve: (purpose) => modelTarget(values, purpose),
          // Called only by `memories extract`, which the owner or an agent runs on purpose.
          consent: () => true,
          key: (provider) =>
            variables[`${app.envPrefix}_${provider.toUpperCase()}_API_KEY`] ??
            variables[`${provider.toUpperCase()}_API_KEY`],
          ...(environmentOf(command()).signal ? { signal: environmentOf(command()).signal as AbortSignal } : {}),
        }).complete
      },
      author: () => {
        const actor = actorOf(command())
        return actor === "owner" ? "owner" : { bot: actor, kind: "agent" }
      },
      decider,
    },
  }
  const shared = { words: options.words, output }
  addDocumentFolderCommands(holder, { ...shared, ...groups.folders })
  addDocumentSyncCommands(holder, { ...shared, ...groups.sync })
  addLocalDocumentCommands(holder, { ...shared, ...groups.documents })
  addDocumentHistoryCommands(holder, { ...shared, ...groups.history })
  addDocumentSearchCommand(holder, { ...shared, ...groups.search })
  addDocumentCatalogCommands(holder, { ...shared, ...groups.catalog })
  addDocumentKnowledgeCommands(holder, { ...shared, ...groups.knowledge })
  const find = (group: Command, name: string) => group.commands.find((one) => one.name() === name) as Command
  const folders = find(holder, "folders")
  // Choosing a folder changes what the next sync keeps and removes, so an agent asks for it through the write tool.
  writesOwnerFiles(find(folders, "add"))
  // The CLI's own listing of the provider's folders: names others chose.
  if (options.browse) marksUntrusted(annotate(find(folders, "browse"), { partial: true }), DOCUMENT_UNTRUSTED)
  const start = (action: Command, side?: string, account?: string) => {
    running = action
    warnings = []
    sideRun = side
    expected = account
  }
  for (const group of holder.commands) group.hook("preAction", (_group, action) => start(action))
  const sync: DocumentSyncStep = async (action, { rescan, embed, budget, deadline, account }) => {
    start(
      action,
      `${environmentOf(action).agent ? "mcp " : ""}sync documents`,
      account?.provider === options.provider.name ? account.account : undefined,
    )
    const held = files().state("").read()
    // With no folder chosen and nothing kept, a sync would only ask who is signed in; a held copy still runs, so the
    // documents of folders removed since leave it.
    if (!roots().length && !Object.keys(held.documents).length && !held.pending && !files().walkUnderWay())
      return { item: { skipped: "no folders chosen" }, meta: {}, next: [], diagnostics: [] }
    const item = await groups.sync.sync({
      limit: DOCUMENT_SYNC_LIMIT,
      budget,
      ...(rescan ? { rescan } : {}),
      ...(embed ? { embed } : {}),
      ...(deadline ? { deadline } : {}),
    })
    const timeout = action.optsWithGlobals<{ timeout?: string }>().timeout
    const part = documentSyncPart(item, {
      again: `${app.command} ${profile()} sync`,
      source: wordsOf(options.words).source,
      resume: { ...(timeout === undefined ? {} : { timeout }), ...(embed ? { embed: true } : {}) },
      longer: {},
    })
    // The other group's answer names its parts by what they sync, as `tracker` and `documents`.
    const issues = [...(part.meta.issues ?? []), ...warningIssues()].map((one) => ({ ...one, source: "documents" }))
    return {
      item: item as DocumentSyncOutcome["item"],
      meta: { ...part.meta, ...(issues.length ? { complete: false, issues } : {}) },
      next: part.next,
      diagnostics: part.diagnostics,
    }
  }
  return { commands: holder.commands.filter((one) => withSync || one.name() !== "sync"), sync }
}

/**
 * cli-core's shared `folders`, `sync`, `status`, `documents`, `search`, `catalog` and knowledge groups over a CLI's
 * document source, its files under the CLI's state folder and the shared store. The CLI gives the source, how it
 * files a document and its words. Returned as commands to add to the program.
 */
export const documentLibraryCommands = <M extends SourceFile>(options: DocumentLibraryOptions<M>): Command[] =>
  libraryOf(options, true).commands
