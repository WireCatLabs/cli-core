import { CliError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { ENTITIES, type EntityName } from "../entities/index.js"

/** The fields of the answer a command declares (`annotate(…, { output })`); nothing until it declares one. */
export const answerFields = (command: Command | undefined): string[] | undefined => {
  const output = command ? metaOf(command).output : undefined
  if (!output) return undefined
  const schema = ENTITIES[(output.view ? `${output.entity}.${output.view}` : output.entity) as EntityName]
  return schema && "entries" in schema ? Object.keys(schema.entries) : undefined
}

const PATHS = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(,[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*)*$/
const topOf = (fields: string) => fields.split(",").map((path) => path.split(".")[0] ?? path)

export interface JsonRequest {
  argv: string[]
  /** `--json` was given; `fields` says which, absent means all. */
  json: boolean
  fields?: string
}

/**
 * `--json=a,b` or `--json a,b` keeps those fields, a bare `--json` all of them. The separate word is taken only when
 * every name in it is a field of the command's answer, so `--json chats list` and `messages list --json 111` keep
 * their words. Commander sees a plain `--json` either way.
 */
export const liftJson = (argv: readonly string[], target: (argv: string[]) => Command | undefined): JsonRequest => {
  const end = argv.indexOf("--")
  const out: string[] = []
  let json = false
  let fields: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index] as string
    if (end >= 0 && index >= end) {
      out.push(word)
      continue
    }
    if (word.startsWith("--json=")) {
      json = true
      fields = word.slice("--json=".length) || undefined
      out.push("--json")
      continue
    }
    if (word !== "--json") {
      out.push(word)
      continue
    }
    json = true
    fields = undefined
    out.push(word)
    const following = argv[index + 1]
    if (following === undefined || !PATHS.test(following) || (end >= 0 && index + 1 >= end)) continue
    const known = answerFields(target([...argv.slice(0, index), ...argv.slice(index + 2)]))
    if (known && topOf(following).every((name) => known.includes(name))) {
      fields = following
      index++
    }
  }
  return { argv: out, json, ...(fields === undefined ? {} : { fields }) }
}

/** Refuses a field the answer does not have, and at a terminal asks which fields instead of printing them all. */
export const checkJson = (command: Command, { json, fields }: Omit<JsonRequest, "argv">, terminal: boolean): void => {
  const known = answerFields(command)
  if (!json || !known) return
  const list = known.join(", ")
  if (fields !== undefined) {
    const unknown = topOf(fields).filter((name) => !known.includes(name))
    if (unknown.length > 0)
      throw new CliError("validation_error", `--json: no field ${unknown.join(", ")} here; the fields are ${list}`, {
        reason: "output.unknown-field",
        param: "--json",
        allowed: known,
      })
    return
  }
  if (terminal)
    throw new CliError(
      "validation_error",
      `--json at a terminal names its fields, --json=${known.slice(0, 2).join(",")}; the fields are ${list}`,
      { reason: "output.choose-fields", param: "--json", allowed: known },
    )
}
