import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@wirecat/cli-base"
import { matchDownloads, NOT_FILES } from "../domain/attachments.js"
import type { Message } from "../domain/models.js"
import { acquireLock } from "../files/index.js"
import type { Download } from "../ports/messenger.js"
import type { AccountKey } from "../store/store.js"
import type { ChatsService } from "./chats.js"
import { archiveMediaFile } from "./media-archive-files.js"
import { type MediaArchiveEntry, mediaKey, readMediaManifests, verifyMediaEntry } from "./media-archive-manifest.js"
import type { MessagesService } from "./messages.js"

export interface MediaArchivePorts {
  chats: Pick<ChatsService, "list" | "account" | "show">
  messages: Pick<MessagesService, "list" | "download">
}
export interface MediaArchiveOptions {
  directory: string
  chats?: readonly string[]
  sinceTime?: string
  orderByTime?: boolean
  pageSize?: number
  pauseMs?: number
  signal?: AbortSignal
  onSaved?: (entry: MediaArchiveEntry) => void
}
export const validateMediaSince = (value?: string): number | undefined => {
  if (value === undefined) return undefined
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new CliError("validation_error", "--since-time needs an ISO timestamp with a time zone")
  const date = value.slice(0, 10)
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new CliError("validation_error", "--since-time has an invalid calendar date")
  return Date.parse(value)
}
const withArchiveLock = async <T>(
  directory: string,
  signal: AbortSignal | undefined,
  run: (root: string, beforeWrite: () => Promise<void>) => Promise<T>,
  create = false,
): Promise<T> => {
  signal?.throwIfAborted()
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  const root = await realpath(directory)
  const lease = await acquireLock(join(root, ".media-writers"), { signal })
  const beforeWrite = async () => {
    signal?.throwIfAborted()
    if (!(await lease.held())) throw new CliError("validation_error", "media archive writer lost its lock")
  }
  try {
    return await run(root, beforeWrite)
  } finally {
    await lease.release()
  }
}
export const checkMediaArchive = (directory: string, signal?: AbortSignal) =>
  withArchiveLock(directory, signal, async (root) => {
    const entries = await readMediaManifests(root, signal)
    if (!entries.length) throw new CliError("not_found", "no media archive manifests in this directory")
    const files: { path: string; valid: boolean }[] = []
    for (const entry of entries) {
      let valid = false
      try {
        valid = await verifyMediaEntry(root, entry, signal)
      } catch {
        signal?.throwIfAborted()
      }
      files.push({ path: entry.path, valid })
    }
    return { valid: files.every((one) => one.valid), checked: files.length, files }
  })

const saveMessage = async (
  root: string,
  account: AccountKey,
  message: Message,
  ports: MediaArchivePorts,
  known: Map<string, MediaArchiveEntry>,
  beforeWrite: () => Promise<void>,
  options: MediaArchiveOptions,
) => {
  let download: Download | undefined
  let saved = 0
  let existing = 0
  for (const [position, attachment] of message.attachments.entries()) {
    if (NOT_FILES.has(attachment.kind)) continue
    await beforeWrite()
    const identity = { ...account, chat: message.chatId, message: message.id, position }
    const key = mediaKey(identity)
    if (known.has(key)) {
      existing++
      continue
    }
    const entry = await archiveMediaFile(
      root,
      identity,
      attachment.kind,
      async () => {
        download ??= await ports.messages.download(message.chatId, message.id)
        const positions = matchDownloads(
          message.attachments.map((one, index) => ({
            position: index,
            kind: one.kind,
            name: one.name ?? null,
          })),
          download.files,
        )
        const index = positions.indexOf(position)
        const file = download.files[index]
        if (!file) throw new CliError("invalid_response", "the messenger did not return an identifiable attachment")
        return file
      },
      beforeWrite,
      options.signal,
    )
    known.set(key, entry)
    saved++
    options.onSaved?.(entry)
  }
  return { saved, existing }
}

export const archiveMedia = async (ports: MediaArchivePorts, options: MediaArchiveOptions) => {
  const since = validateMediaSince(options.sinceTime)
  const pageSize = options.pageSize ?? 100
  const pauseMs = options.pauseMs ?? 1000
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 1000 ||
    !Number.isSafeInteger(pauseMs) ||
    pauseMs < 0
  )
    throw new CliError("validation_error", "invalid media archive page size or pause")
  return withArchiveLock(
    options.directory,
    options.signal,
    async (root, beforeWrite) => {
      const known = new Map<string, MediaArchiveEntry>()
      for (const entry of await readMediaManifests(root, options.signal)) {
        let valid = false
        try {
          valid = await verifyMediaEntry(root, entry, options.signal)
        } catch {
          options.signal?.throwIfAborted()
        }
        if (!valid)
          throw new CliError("validation_error", "archive checksum mismatch or missing file; choose a new destination")
        known.set(mediaKey(entry), entry)
      }
      const account = await ports.chats.account()
      let saved = 0,
        existing = 0,
        chats = 0
      const walk = async (chat: string) => {
        const seen = new Set<string>()
        let before: string | undefined
        for (;;) {
          await beforeWrite()
          const page = await ports.messages.list(chat, { limit: pageSize, ...(before ? { before } : {}) })
          let fresh = 0
          let reachedSince = false
          let oldest: Message | undefined
          for (const message of page.items) {
            const timestamp = Date.parse(message.timestamp)
            if (!Number.isFinite(timestamp))
              throw new CliError("invalid_response", "media history has an invalid timestamp")
            if (!oldest || timestamp < Date.parse(oldest.timestamp)) oldest = message
            if (since !== undefined && timestamp < since) {
              reachedSince = true
              continue
            }
            if (seen.has(message.id)) continue
            seen.add(message.id)
            fresh++
            const one = await saveMessage(root, account, message, ports, known, beforeWrite, options)
            saved += one.saved
            existing += one.existing
          }
          if (!page.hasMore || reachedSince) break
          if (!oldest || !fresh)
            throw new CliError("invalid_response", "media history pagination did not advance; archive is incomplete")
          before = options.orderByTime ? new Date(Date.parse(oldest.timestamp) + 1).toISOString() : page.items[0]?.id
          if (pauseMs) await sleep(pauseMs, undefined, { signal: options.signal })
        }
        chats++
      }
      if (options.chats?.length) {
        const ids = new Set<string>()
        for (const chat of options.chats) {
          const found = await ports.chats.show(chat)
          if (!ids.has(found.id)) {
            ids.add(found.id)
            await walk(found.id)
          }
        }
      } else {
        const seen = new Set<string>()
        let offset = 0
        for (;;) {
          await beforeWrite()
          const page = await ports.chats.list({ offset, limit: 100 })
          let fresh = 0
          for (const chat of page.items)
            if (!seen.has(chat.id)) {
              seen.add(chat.id)
              fresh++
              await walk(chat.id)
            }
          if (!page.hasMore) break
          if (!fresh) throw new CliError("invalid_response", "chat pagination did not advance; archive is incomplete")
          offset += page.items.length
          if (pauseMs) await sleep(pauseMs, undefined, { signal: options.signal })
        }
      }
      return { directory: root, chats, saved, existing, complete: true }
    },
    true,
  )
}
