import type { Meta, Missing, NextStep } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { type Body, itemOf, listOf, snakeKeys } from "./envelope.js"

const ENVELOPE_KEYS = new Set(["item", "items", "page", "next", "missing", "meta"])
const LISTED_KEYS = new Set(["items", "page", "limit", "has_more", "missing", "meta"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: Set<string>) => Object.keys(value).every((key) => keys.has(key))

const pathOf = (command: Command): string[] =>
  command.parent?.parent ? [...pathOf(command.parent), command.name()] : [command.name()]

/**
 * What the shared meetings commands and tools `write`, as the host's answer body: an envelope as it is, a `listed()`
 * page through `listOf`, so a page with more rows gets its `page.next` step to `command`, and any other value as one
 * item. `command` is the running command, as `write` gets it, or its path below the program, such as `events list`.
 */
export const meetingAnswerBody = (command: Command | string, value: unknown): Body => {
  const path = typeof command === "string" ? command : pathOf(command).join(" ")
  const data = snakeKeys(value)
  if (!isRecord(data)) return itemOf(data)
  if (only(data, ENVELOPE_KEYS) && ("item" in data || (Array.isArray(data.items) && isRecord(data.page))))
    return data as unknown as Body
  if (
    Array.isArray(data.items) &&
    only(data, LISTED_KEYS) &&
    (data.page === undefined || typeof data.page === "number")
  )
    return listOf(path, {
      items: data.items,
      limit: Math.max(1, typeof data.limit === "number" ? data.limit : data.items.length),
      has_more: data.has_more === true,
      ...(typeof data.page === "number" ? { page: data.page } : {}),
      ...(Array.isArray(data.missing) ? { missing: data.missing as Missing[] } : {}),
      ...(isRecord(data.meta) ? { meta: data.meta as Partial<Meta> } : {}),
    })
  // A packet such as `meetings people`'s is one entity whose steps, gaps and meta belong to the answer, not to it.
  const { next, missing, meta, ...item } = data
  return itemOf(item, {
    ...(Array.isArray(next) ? { next: next as NextStep[] } : {}),
    ...(Array.isArray(missing) ? { missing: missing as Missing[] } : {}),
    ...(isRecord(meta) ? { meta: meta as Partial<Meta> } : {}),
  })
}
