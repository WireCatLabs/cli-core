import { annotate, metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import type * as v from "valibot"
import { ENTITIES, type EntityName } from "../entities/index.js"
import type { RowShape } from "./compact.js"

const schemas = new WeakMap<
  Command,
  { name: string; schema: v.GenericSchema; project?: v.GenericSchema; row?: RowShape }
>()

/** Provider-specific wire fields must not redefine an entity shared by every CLI. */
export const answerEntity = (
  command: Command,
  name: string,
  schema: v.GenericSchema,
  options: { project?: v.GenericSchema; row?: RowShape } = {},
): Command => {
  if (Object.hasOwn(ENTITIES, name)) throw new Error(`${name} is a shared entity; use its existing schema`)
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("an answer entity needs a lowercase name")
  if (!("entries" in schema) && schema.type !== "union")
    throw new Error("an answer entity needs an object schema or a union of object schemas")
  if (options.project && !("entries" in options.project) && options.project.type !== "union")
    throw new Error("projection needs an object schema or a union of object schemas")
  schemas.set(command, { name, schema, ...options })
  return annotate(command, { output: { entity: name } })
}

export const answerEntitySchema = (command: Command | undefined): v.GenericSchema | undefined => {
  const output = command && metaOf(command).output
  if (!output) return undefined
  const name = output.view ? `${output.entity}.${output.view}` : output.entity
  const shared = ENTITIES[name as EntityName]
  if (shared) return shared as v.GenericSchema
  const own = schemas.get(command as Command)
  return own?.name === name ? own.schema : undefined
}

export const answerProjectionSchema = (command: Command | undefined): v.GenericSchema | undefined => {
  const own = command && schemas.get(command)
  return own && metaOf(command as Command).output?.entity === own.name ? own.project : undefined
}

/** The row a command declared with `answerEntity(…, { row })`, while it still answers that entity. */
export const answerRow = (command: Command | undefined): RowShape | undefined => {
  const own = command && schemas.get(command)
  return own && metaOf(command as Command).output?.entity === own.name ? own.row : undefined
}
