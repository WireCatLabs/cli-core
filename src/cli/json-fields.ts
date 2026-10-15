import { CliError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { ENTITIES, type EntityName } from "../entities/index.js"

/** Provider adapters may describe a result whose fields differ from the shared entity. */
export type JsonFieldsResolver = (command: Command | undefined) => readonly string[] | undefined

/** An entity's fields: a list of names, or an object schema whose entries are the fields. */
export type EntityFields = readonly string[] | { readonly entries: Readonly<Record<string, unknown>> }

const declaredEntity = (command: Command | undefined): string | undefined => {
  const output = command ? metaOf(command).output : undefined
  return output && (output.view ? `${output.entity}.${output.view}` : output.entity)
}

const isNames = (fields: EntityFields): fields is readonly string[] => Array.isArray(fields)

const namesOf = (fields: EntityFields | undefined): string[] | undefined =>
  fields === undefined ? undefined : isNames(fields) ? [...fields] : Object.keys(fields.entries)

/**
 * An app's own entities, by the name (or `name.view`) its commands declare in `annotate(…, { output })`, so
 * `--json=a,b` is checked against them as against cli-core's. Pass the result as `resolve` to `liftJson` and
 * `checkJson`. A shared entity's name is refused: two meanings for one name would part the CLIs.
 */
export const entityFields = (table: Readonly<Record<string, EntityFields>>): JsonFieldsResolver => {
  const shared = Object.keys(table).filter((name) => name in ENTITIES)
  if (shared.length > 0) throw new Error(`entityFields: ${shared.join(", ")} is cli-core's entity; name yours apart`)
  return (command) => {
    const name = declaredEntity(command)
    return name !== undefined && Object.hasOwn(table, name) ? namesOf(table[name]) : undefined
  }
}

/** The fields of the answer a command declares (`annotate(…, { output })`); nothing until it declares one. */
export const answerFields = (command: Command | undefined, resolve?: JsonFieldsResolver): string[] | undefined => {
  const own = resolve?.(command)
  if (own !== undefined) return [...own]
  const name = declaredEntity(command)
  const schema = name === undefined ? undefined : ENTITIES[name as EntityName]
  return schema && "entries" in schema ? namesOf(schema) : undefined
}

const PATHS = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(,[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*)*$/
const topOf = (fields: string, known: readonly string[]) =>
  fields.split(",").map((path) => {
    const parts = path.trim().split(".")
    if (parts[0] === "items" && parts.length > 1 && !known.includes("items")) parts.shift()
    return parts[0] ?? path
  })

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
export const liftJson = (
  argv: readonly string[],
  target: (argv: string[]) => Command | undefined,
  resolve?: JsonFieldsResolver,
): JsonRequest => {
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
    const known = answerFields(target([...argv.slice(0, index), ...argv.slice(index + 2)]), resolve)
    if (known && topOf(following, known).every((name) => known.includes(name))) {
      fields = following
      index++
    }
  }
  return { argv: out, json, ...(fields === undefined ? {} : { fields }) }
}

/** Refuses a field the answer does not have, and at a terminal asks which fields instead of printing them all. */
export const checkJson = (
  command: Command,
  { json, fields }: Omit<JsonRequest, "argv">,
  terminal: boolean,
  resolve?: JsonFieldsResolver,
): void => {
  const known = answerFields(command, resolve)
  if (!json || !known) return
  const list = known.join(", ")
  if (fields !== undefined) {
    const unknown = topOf(fields, known).filter((name) => !known.includes(name))
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
