import { CliError } from "@wirecat/cli-base"
import type { Pagination } from "@wirecat/cli-base/codegen/runtime"
import type {
  DocumentSource,
  FeedlessDocumentSource,
  IndexedSource,
  SourceChange,
  SourceFile,
} from "../../../documents.js"
import type { ApiCommandInput } from "../../bot/api.js"
import type { ServiceApiCall } from "../../service-api-call.js"
import {
  answerAt as at,
  nextPage,
  parameterValue,
  type ServiceApiManifest,
  withValue,
} from "../../service-api-manifest.js"
import { type DocumentCall, type DocumentFileMap, type DocumentManifest, parseDocumentManifest } from "./manifest.js"

/** What a slot in a call is filled with; one left without a value is left out of the request. */
export interface DocumentSlots {
  id?: string
  since?: string
  cursor?: string
}

/** A source of a `files` CLI: a change feed when the manifest or a hook gives one. */
export type ManifestDocumentSource<M extends SourceFile = SourceFile> = FeedlessDocumentSource<M> &
  Partial<Pick<DocumentSource<M>, "startToken" | "changes">>

/** What a hook builds on: the manifest's own calls, and the source the manifest alone describes. */
export interface DocumentManifestTools<M extends SourceFile = SourceFile> {
  manifest: DocumentManifest
  /** Sends one named call of `reads`, or `identity`, `get`, `children`, `changes`, `content`. */
  read(name: string, slots?: DocumentSlots, body?: unknown): Promise<unknown>
  /** One row of an answer as a file, by `get.map` (or the named call's own map). */
  file(row: unknown, from?: "get" | "children" | "changes"): M
  base: Partial<ManifestDocumentSource<M>>
}

export interface DocumentManifestSourceOptions<M extends SourceFile = SourceFile> {
  api: ServiceApiManifest
  call: ServiceApiCall
  now?: () => number
  /** The methods the manifest cannot describe, or that the provider does otherwise; each wins over the manifest's. */
  hooks?: (tools: DocumentManifestTools<M>) => Partial<ManifestDocumentSource<M>>
}

const OVERLAP_MS = 10 * 60_000
/** A change round reads at most this many pages; the next round goes on from the time the first one started. */
const MOST_PAGES = 100

const DROP = Symbol("drop")
const fill = (value: unknown, slots: DocumentSlots): unknown => {
  if (value === "{id}") return slots.id ?? DROP
  if (value === "{since}") return slots.since ?? DROP
  if (value === "{cursor}") return slots.cursor ?? DROP
  if (Array.isArray(value)) return value.map((one) => fill(one, slots)).filter((one) => one !== DROP)
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, one]) => {
        const filled = fill(one, slots)
        return filled === DROP ? [] : [[key, filled]]
      }),
    )
  return value
}

const inputOf = (call: DocumentCall, slots: DocumentSlots, body?: unknown): ApiCommandInput => {
  const path = fill(call.path ?? {}, slots) as Record<string, unknown>
  const query = fill(call.query ?? {}, slots) as Record<string, unknown>
  const sent = body ?? (call.body === undefined ? undefined : fill(call.body, slots))
  return {
    path: Object.fromEntries(Object.entries(path).map(([key, one]) => [key, String(one)])),
    query: Object.fromEntries(Object.entries(query).map(([key, one]) => [key, String(one)])),
    headers: {},
    fields: {},
    ...(sent === undefined || sent === DROP ? {} : { body: JSON.stringify(sent) }),
  }
}

const SINCE: Record<NonNullable<DocumentManifest["changes"]>["since"], (ms: number) => string> = {
  iso: (ms) => new Date(ms).toISOString(),
  ms: (ms) => String(ms),
  seconds: (ms) => String(Math.floor(ms / 1000)),
}

const pageParameter = (pagination: Pagination) =>
  pagination.style === "cursor"
    ? pagination.cursor
    : pagination.style === "offset"
      ? pagination.offset
      : pagination.style === "page"
        ? pagination.page
        : undefined

const text = (value: unknown) =>
  value === null || value === undefined ? undefined : typeof value === "string" ? value : String(value)
const time = (value: unknown) => {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/**
 * A `DocumentSource` read from a manifest: the account, one file, a folder's children and the changes since a time
 * by the calls it names, each paged by its operation's own `pagination`, each row mapped onto a file; a document's
 * Markdown from one call. What the manifest cannot say comes from `hooks`, which send their requests through the
 * calls the manifest names.
 */
export const documentSourceFromManifest = <M extends SourceFile = SourceFile>(
  input: unknown,
  options: DocumentManifestSourceOptions<M>,
): ManifestDocumentSource<M> => {
  const manifest = parseDocumentManifest(input, options.api)
  const now = options.now ?? Date.now
  const operations = new Map(options.api.operations.map((one) => [one.id, one]))
  const calls: Record<string, DocumentCall | undefined> = {
    ...manifest.reads,
    identity: manifest.identity,
    get: manifest.get,
    children: manifest.children,
    changes: manifest.changes,
    content: manifest.content,
  }
  const callOf = (name: string) => {
    const call = calls[name]
    if (!call)
      throw new CliError("configuration_error", `source manifest: no call ${name}`, { reason: "manifest.invalid" })
    return call
  }
  const send = (call: DocumentCall, request: ApiCommandInput) => options.call(call.operation, request)
  const read = (name: string, slots: DocumentSlots = {}, body?: unknown) => {
    const call = callOf(name)
    return send(call, inputOf(call, slots, body))
  }
  const rowsOf = (call: DocumentCall, answer: unknown) => {
    const pagination = operations.get(call.operation)?.pagination
    const listed = call.items ? at(answer, call.items) : pagination?.items ? at(answer, pagination.items) : answer
    return Array.isArray(listed) ? listed : []
  }
  /** One page of a listing call: its rows and the token of the next page, when there is one. */
  const page = async (call: DocumentCall, slots: DocumentSlots, token?: string) => {
    const pagination = operations.get(call.operation)?.pagination
    const parameter = pagination ? pageParameter(pagination) : undefined
    // A next-page link names no parameter to carry between rounds; one page of it would pass the rest over.
    if (pagination && !parameter)
      throw new CliError(
        "configuration_error",
        `source manifest: ${call.operation} pages by a link, which a source cannot`,
        {
          reason: "manifest.invalid",
        },
      )
    const first = inputOf(call, slots)
    const value = pagination?.style === "cursor" ? token : Number(token)
    const request = token !== undefined && parameter && value !== undefined ? withValue(first, parameter, value) : first
    const answer = await send(call, request)
    if (!pagination || !parameter) return { rows: rowsOf(call, answer) }
    const step = nextPage(pagination, request, answer)
    const next = step.next && "input" in step.next ? parameterValue(step.next.input, parameter) : undefined
    return { rows: rowsOf(call, answer), ...(next === undefined || next === null ? {} : { next: String(next) }) }
  }

  const mapOf = (from: "get" | "children" | "changes"): DocumentFileMap => {
    const own = from === "get" ? undefined : manifest[from]?.map
    const map = own ?? manifest.get?.map
    if (!map)
      throw new CliError("configuration_error", `source manifest: ${from} has no map`, { reason: "manifest.invalid" })
    return map
  }
  const file = (row: unknown, from: "get" | "children" | "changes" = "get"): M => {
    const map = mapOf(from)
    const id = text(at(row, map.id))
    if (!id)
      throw new CliError("invalid_response", `a ${manifest.provider} answer has no id at ${map.id}`, {
        reason: "source.no-id",
      })
    const folder = map.folder ? at(row, map.folder.path) === map.folder.is : false
    const listed = map.parents ? at(row, map.parents) : undefined
    const parents = Array.isArray(listed)
      ? listed.map(text).filter((one): one is string => Boolean(one))
      : map.parent && text(at(row, map.parent))
        ? [text(at(row, map.parent)) as string]
        : []
    const modifiedAt = map.modifiedAt ? time(at(row, map.modifiedAt)) : undefined
    const createdAt = map.createdAt ? time(at(row, map.createdAt)) : undefined
    const version = map.version ? text(at(row, map.version)) : modifiedAt
    const mime =
      (map.mime && text(at(row, map.mime))) ||
      (map.folder?.mime ? (folder ? map.folder.mime.folder : map.folder.mime.file) : "application/octet-stream")
    return {
      id,
      name: text(at(row, map.name))?.trim() || id,
      mime,
      parents,
      url: (map.url && text(at(row, map.url))) || "",
      trashed: map.trashed ? at(row, map.trashed) === true : false,
      canDownload: !folder,
      ...(version ? { version } : {}),
      ...(modifiedAt ? { modifiedAt } : {}),
      ...(createdAt ? { createdAt } : {}),
    } as M
  }

  const base: Partial<ManifestDocumentSource<M>> = {}
  let account: Promise<string> | undefined
  base.identity = () => {
    account ??= read("identity").then((answer) => {
      const paths = typeof manifest.identity.id === "string" ? [manifest.identity.id] : manifest.identity.id
      const parts = paths.map((path) => text(at(answer, path)))
      if (parts.some((part) => !part))
        throw new CliError("invalid_response", `${manifest.provider} did not name the signed-in account`, {
          reason: "source.no-account",
        })
      return parts.join(":")
    })
    // A failed read is not kept: a long-lived server would fail every later call on one network error.
    account.catch(() => {
      account = undefined
    })
    return account
  }
  const { get, children, changes, content } = manifest
  if (get)
    base.metadata = async (id) => {
      const answer = await read("get", { id })
      return file(get.items ? at(answer, get.items) : answer)
    }
  if (children) {
    base.childrenPage = async (id, cursor) => {
      const { rows, next } = await page(children, { id }, cursor)
      return { files: rows.map((row) => file(row, "children")), ...(next ? { cursor: next } : {}) }
    }
    base.children = async (id) => {
      const files: M[] = []
      let cursor: string | undefined
      do {
        const listed = await (base.childrenPage as NonNullable<typeof base.childrenPage>)(id, cursor)
        for (const one of listed.files) files.push(one)
        cursor = listed.cursor
      } while (cursor)
      return files
    }
  }
  if (changes) {
    base.startToken = async () => String(now())
    base.changes = async (token) => {
      const from = Number(token)
      if (!Number.isSafeInteger(from))
        throw new CliError("validation_error", `not a change token of ${manifest.provider}: ${token}`, {
          reason: "source.token-invalid",
        })
      const started = now()
      const sinceMs = from - (changes.overlapMs ?? OVERLAP_MS)
      const since = SINCE[changes.since](sinceMs)
      const items: SourceChange<M>[] = []
      let cursor: string | undefined
      let last = Number.NEGATIVE_INFINITY
      let oldestFirst = true
      for (let pages = 0; pages < MOST_PAGES; pages++) {
        const { rows, next } = await page(changes, { since }, cursor)
        let older = false
        for (const row of rows) {
          const edited = Date.parse(time(at(row, changes.time)) ?? "")
          if (Number.isFinite(edited)) {
            if (edited < last) oldestFirst = false
            last = Math.max(last, edited)
            // A provider that sorts by time without filtering by it lists older rows too; they are not changes.
            if (edited < sinceMs) {
              older = true
              continue
            }
          }
          const changed = file(row, "changes")
          items.push({ id: changed.id, removed: changed.trashed, file: changed })
        }
        if (!next || (older && !oldestFirst)) return { items, cursor: String(started) }
        cursor = next
      }
      // Past its pages, a round listed oldest first goes on next time from the newest row it read; any other order
      // cannot say where it stopped, and would read the same pages on every round.
      if (oldestFirst && Number.isFinite(last) && last > from) return { items, cursor: String(last) }
      throw new CliError(
        "invalid_response",
        `more than ${MOST_PAGES} pages of ${manifest.provider} changed since one sync; list changes oldest first`,
        { reason: "source.changes-too-many" },
      )
    }
  }
  if (content)
    base.content = async (id, maxChars, known) => {
      const metadata = known ?? (await (source.metadata as (id: string) => Promise<M>)(id))
      const answer = await read("content", { id })
      const markdown = text(at(answer, content.markdown)) ?? ""
      const cut = maxChars === undefined ? markdown : markdown.slice(0, maxChars)
      return { metadata, markdown: cut, text: cut, tabs: [] }
    }
  if (manifest.reread) {
    const missing = manifest.reread.missing
    base.reread = (saved: IndexedSource<M>) => at(saved.metadata.providerMetadata, missing) === undefined
  }

  const source = { ...base, ...options.hooks?.({ manifest, read, file, base }) } as ManifestDocumentSource<M>
  source.bytes ??= async (id, known) => new TextEncoder().encode((await source.content(id, undefined, known)).markdown)
  for (const method of ["identity", "metadata", "children", "content"] as const)
    if (typeof source[method] !== "function")
      throw new CliError(
        "configuration_error",
        `source manifest: no ${method}: describe it in the manifest or give it as a hook`,
        { reason: "manifest.invalid" },
      )
  // The manifest's own content gives back the metadata it was given, so the field `reread` waits for never comes.
  if (manifest.reread && source.content === base.content)
    throw new CliError(
      "configuration_error",
      "source manifest: reread needs content from a hook, which saves the field",
      {
        reason: "manifest.invalid",
      },
    )
  if (Boolean(source.startToken) !== Boolean(source.changes))
    throw new CliError("configuration_error", "source manifest: a change feed needs both startToken and changes", {
      reason: "manifest.invalid",
    })
  return source
}
