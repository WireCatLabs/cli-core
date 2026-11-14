import { CliError } from "@wirecat/cli-base"
import type { Meta, NextStep } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { type Body, itemOf, listOf, snakeKeys } from "../../cli/envelope.js"
import { pagingOf } from "../../cli/paging.js"
import type { MessageStore } from "../../store/store.js"
import type { CalendarRun } from "./index.js"

/** The command's words below the program, as `page.next` and `sync`'s next step rerun it. */
export const pathOf = (command: Command): string[] =>
  command.parent?.parent ? [...pathOf(command.parent), command.name()] : [command.name()]

const snakeMeta = (meta: object | undefined): Partial<Meta> | undefined =>
  meta === undefined ? undefined : (snakeKeys(meta) as Partial<Meta>)

interface Listed {
  items: object[]
  page?: number
  limit?: number
  hasMore?: boolean
}

/** A list the shared reads answer (`listed`), as the envelope: `page.next` reruns the same query one page on. */
export const listBody = (command: Command, { items, page, limit, hasMore }: Listed, meta?: object): Body => {
  const query = command.processedArgs[0]
  const facts = snakeMeta(meta)
  return listOf(pathOf(command).join(" "), {
    items: items.map((item) => snakeKeys(item)),
    limit: Math.max(1, limit ?? items.length),
    has_more: hasMore === true,
    ...(page === undefined ? {} : { page }),
    ...(Array.isArray(query) && query.length > 0 ? { args: { query } } : {}),
    ...(facts ? { meta: facts } : {}),
  })
}

export const itemBody = (value: object, extra: { meta?: object; next?: NextStep[] } = {}): Body => {
  const meta = snakeMeta(extra.meta)
  return itemOf(snakeKeys(value), { ...(meta ? { meta } : {}), ...(extra.next ? { next: extra.next } : {}) })
}

interface Hits {
  hits: object[]
  has_more?: boolean
  next_offset?: number
  meaning_skipped?: string
  untrusted?: string[]
}

/**
 * A search's hits as a list with cursor paging (WC-OUT-4, WC-OUT-5); each hit names its own untrusted fields, as
 * `events list` does. Without a cursor there is no next page to run: the provider's search pages per calendar.
 */
export const hitsBody = (command: Command, value: Hits): Body => {
  const opts = command.opts<{ exact?: boolean; newest?: boolean }>()
  const untrusted = (value.untrusted ?? []).filter((field) => field.startsWith("hits.")).map((f) => f.slice(5))
  const { next, ...list } = listOf(pathOf(command).join(" "), {
    items: value.hits.map((hit) => snakeKeys({ ...hit, untrusted })),
    limit: pagingOf(command).limit,
    has_more: value.has_more === true,
    paging: "cursor",
    ...(typeof value.next_offset === "number" ? { cursor: String(value.next_offset) } : {}),
    args: {
      query: command.processedArgs[0],
      ...(opts.exact ? { exact: true } : {}),
      ...(opts.newest ? { newest: true } : {}),
    },
    ...(typeof value.meaning_skipped === "string"
      ? { missing: [{ field: "items", why: `not searched by meaning: ${value.meaning_skipped}` }] }
      : {}),
  })
  const kept = typeof value.next_offset === "number" ? next : next?.filter((one) => one.step !== "page.next")
  return { ...list, ...(kept?.length ? { next: kept } : {}) } as Body
}

export const messagesOf = (run: CalendarRun, what: string): MessageStore => {
  if (!run.messages) throw new CliError("configuration_error", `${what} needs the shared store`)
  return run.messages
}
