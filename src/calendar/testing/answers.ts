import type { Command } from "commander"
import * as v from "valibot"
import { answerEntitySchema } from "../../cli/answer-entity.js"
import { snakeKeys } from "../../cli/envelope.js"

const commandAt = (root: Command, argv: readonly string[]): Command => {
  let at = root
  for (const word of argv) {
    const next = at.commands.find((one) => one.name() === word)
    if (!next) break
    at = next
  }
  return at
}

/**
 * Parses what a shared calendar command handed its host against the command's entity, as a host prints it: keys in
 * snake_case, a list's items one by one, a search's hits each with the search's `untrusted`, and no `next`. A `meta`
 * goes into the host's envelope, never into the item.
 */
export const checkCalendarAnswer = (root: Command, argv: readonly string[], value: unknown): void => {
  const command = commandAt(root, argv)
  const schema = answerEntitySchema(command)
  if (!schema) throw new Error(`${argv.join(" ")} declares no answer entity`)
  const { next: _next, meta: _meta, ...body } = snakeKeys(value) as Record<string, unknown>
  const marker = (body.untrusted as string[] | undefined)
    ?.filter((field) => field.startsWith("hits."))
    .map((field) => field.slice("hits.".length))
  const items = Array.isArray(body.items)
    ? body.items
    : Array.isArray(body.hits)
      ? body.hits.map((hit) => ({ ...(hit as object), untrusted: marker }))
      : [body]
  for (const item of items) {
    const parsed = v.safeParse(schema, item)
    if (!parsed.success)
      throw new Error(
        `${argv.join(" ")}: ${parsed.issues.map((issue) => `${v.getDotPath(issue) ?? ""} ${issue.message}`).join("; ")}`,
      )
  }
}
