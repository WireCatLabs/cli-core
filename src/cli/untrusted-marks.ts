import type { Command } from "commander"
import { type AppIdentity, ancestorValue, envName, readOnlyLockOf } from "../ports/app.js"

const OPEN = "⟦"
const CLOSE = "⟧"

/**
 * The mark a scheduled agent's run put on the CLIs it may run, or nothing outside such a run. It is read from the
 * agent's own start, so a command the agent runs cannot name another, and only a locked run has one.
 */
export const untrustedMarkOf = (app: AppIdentity, env: NodeJS.ProcessEnv): string | undefined => {
  if (readOnlyLockOf(app, env) === undefined) return undefined
  const mark = ancestorValue(envName(app, "UNTRUSTED_MARK"), env)
  return mark && /^[0-9a-f]{16}$/.test(mark) ? mark : undefined
}

/** Other people's text between the run's markers, with every bracket and the mark taken out, so it can close none. */
export const marked = (text: string, mark: string, source: string, id?: string): string => {
  const inside = text.replaceAll(OPEN, "").replaceAll(CLOSE, "").replaceAll(mark, "")
  const named = id === undefined ? "" : ` id=${id.replaceAll(OPEN, "").replaceAll(CLOSE, "").replace(/\s/g, "")}`
  return `${OPEN}untrusted:${mark} source=${source}${named}${CLOSE}${inside}${OPEN}/untrusted:${mark}${CLOSE}`
}

const idOf = (value: Record<string, unknown>): string | undefined => {
  const id = value.ref ?? value.id
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined
}

const markAt = (value: unknown, path: readonly string[], mark: string, source: string, id?: string): unknown => {
  if (Array.isArray(value)) return value.map((one) => markAt(one, path, mark, source, id))
  // A text a nested answer already marked holds no bracket of its own, so its opening one is the mark's.
  if (path.length === 0)
    return typeof value === "string" && !value.startsWith(`${OPEN}untrusted:${mark} `)
      ? marked(value, mark, source, id)
      : value
  if (value === null || typeof value !== "object") return value
  const [key = "", ...rest] = path
  const record = value as Record<string, unknown>
  if (!(key in record)) return value
  return { ...record, [key]: markAt(record[key], rest, mark, source, idOf(record) ?? id) }
}

/**
 * The answer with each field an object names in its `untrusted` list between the run's markers, at any depth. Other
 * fields, and the shape, stay as they are.
 */
export const withUntrustedMarked = <T>(value: T, mark: string, id?: string): T => {
  if (Array.isArray(value)) return value.map((one) => withUntrustedMarked(one, mark, id)) as T
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const own = idOf(record) ?? id
  let result: Record<string, unknown> = Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      key === "untrusted" ? child : withUntrustedMarked(child, mark, own),
    ]),
  )
  const fields = Array.isArray(record.untrusted) ? record.untrusted.filter((one) => typeof one === "string") : []
  for (const field of fields) result = markAt(result, field.split("."), mark, field, own) as Record<string, unknown>
  return result as T
}

/**
 * Other people's text in a message or an email at any depth of an answer: its text and transcript, who sent it and to
 * whom, the chat's title, the subject, and the attachments' names and text. The fields a read lists here are not in
 * its answer's own `untrusted` list, which would change what every caller reads.
 */
export const MESSAGE_UNTRUSTED = [
  "text",
  "transcript",
  "excerpt",
  "sender_name",
  "sender_username",
  "chat_title",
  "subject",
  "snippet",
  "attachments.name",
  "attachments.title",
  "attachments.text",
  "from.name",
  "to.name",
  "cc.name",
  "bcc.name",
  "reply_addresses.name",
] as const

const DECLARED = new WeakMap<Command, readonly string[]>()

/** Declares the fields of a read's answer that hold other people's text, at any depth, for a scheduled agent's run. */
export const marksUntrusted = <T extends Command>(command: T, fields: readonly string[] = MESSAGE_UNTRUSTED): T => {
  DECLARED.set(command, fields)
  return command
}

export const untrustedFieldsOf = (command: Command): readonly string[] | undefined => DECLARED.get(command)

/** The answer with each of `fields` marked wherever an object in it has that path. */
export const withFieldsMarked = <T>(value: T, fields: readonly string[], mark: string, id?: string): T => {
  if (Array.isArray(value)) return value.map((one) => withFieldsMarked(one, fields, mark, id)) as T
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const own = idOf(record) ?? id
  let result: Record<string, unknown> = Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, withFieldsMarked(child, fields, mark, own)]),
  )
  for (const field of fields) result = markAt(result, field.split("."), mark, field, own) as Record<string, unknown>
  return result as T
}
