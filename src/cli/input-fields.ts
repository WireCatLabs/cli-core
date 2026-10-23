import type { errorObjectOf } from "@wirecat/cli-base"
import type { Command } from "commander"
import { INPUT_FIELD_REASONS } from "../errors/reasons.js"

export const showInputFields = (object: ReturnType<typeof errorObjectOf>, command: Command): void => {
  if (!INPUT_FIELD_REASONS.some((reason) => reason.reason === object.error.reason)) return
  const fields = object.error.details?.fields
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every((field) => typeof field === "string")) return
  const options = new Map<string, string>()
  for (let at: Command | null = command; at; at = at.parent)
    for (const option of at.options)
      if (!option.hidden && option.long && !options.has(option.attributeName()))
        options.set(option.attributeName(), option.long)
  const flags: string[] = []
  for (const field of fields) {
    const flag = options.get(field)
    if (!flag) return
    if (!flags.includes(flag)) flags.push(flag)
  }
  const first = flags[0]
  if (first === undefined) return
  object.error.message = `${flags.join(", ")}: ${object.error.message}`
  object.error.param = first
  object.error.details = { ...object.error.details, fields: flags }
}
