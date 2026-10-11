import { CliError } from "@wirecat/cli-base"
import { momentOf } from "../../services/moment.js"
import type { After } from "./port.js"

export interface ListStart {
  beforeId?: string
  beforeTime?: string
  afterId?: string
  afterTime?: string
}

/** How each starting point is spelled where it was typed: `--before-id` on the command line, `before_id` in MCP. */
export type Spell = (key: keyof ListStart) => string

export const flagOf: Spell = (key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`

const isId = (value: string) => value !== "" && !/[\s\p{Cc}]/u.test(value)

/**
 * A list reads one way from one place: at most one starting point. Ids are opaque to us, so
 * `afterId` is never read as a time, however it looks.
 */
export const listStart = (
  start: ListStart,
  spell: Spell = flagOf,
): { after?: After; before?: string; beforeTime?: number } => {
  const given = (Object.keys(start) as (keyof ListStart)[]).filter((key) => start[key] !== undefined)
  if (given.length > 1) {
    throw new CliError(
      "validation_error",
      `${given.map(spell).join(" and ")} are two starting points; give one of them`,
    )
  }
  const { beforeId, beforeTime, afterId, afterTime } = start
  if (beforeTime !== undefined) return { beforeTime: momentOf(beforeTime, spell("beforeTime")) }
  if (afterTime !== undefined) return { after: { time: momentOf(afterTime, spell("afterTime")) } }
  const id = (beforeId ?? afterId)?.trim()
  if (id === undefined) return {}
  const key = beforeId === undefined ? "afterId" : "beforeId"
  if (!isId(id)) throw new CliError("validation_error", `${spell(key)} takes a message id — not "${start[key]}"`)
  return key === "beforeId" ? { before: id } : { after: { id } }
}
