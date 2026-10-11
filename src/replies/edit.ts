import { CliError } from "@wirecat/cli-base"
import {
  type Audience,
  defaultRule,
  REPLY_ACTIONS,
  REPLY_KINDS,
  REPLY_MODELS,
  type RepliesFile,
  type ReplyRuleFile,
  readRepliesFile,
  writeRepliesFile,
} from "./rules.js"

export interface RuleEdits {
  do?: string
  kinds?: string
  chats?: string
  notChats?: string
  words?: string
  question?: boolean
  mentionsMe?: boolean
  people?: string
  notPeople?: string
  contactsOnly?: boolean
  template?: string
  model?: string
  asReply?: boolean
  perChat?: string
  perPerson?: string
  outside?: string
  days?: string
  timezone?: string
  hours?: boolean
}

export interface AudienceEdits {
  reply?: string
  allowPeople?: string
  allowChats?: string
  denyPeople?: string
  denyChats?: string
}

const list = (value: string): string[] => (value === "" ? [] : value.split(",").map((one) => one.trim()))

const choices = <T extends string>(values: string[], allowed: readonly T[], flag: string): T[] =>
  values.map((value) => {
    const found = allowed.find((one) => one === value)
    if (found === undefined) throw new CliError("validation_error", `${flag} takes ${allowed.join(", ")}; got ${value}`)
    return found
  })

const findRule = (file: RepliesFile, id: string): ReplyRuleFile => {
  const rule = file.rules.find((one) => one.id === id)
  if (!rule) {
    throw new CliError(
      "not_found",
      `no reply rule ${id}; available: ${file.rules.map((one) => one.id).join(", ") || "none"}`,
    )
  }
  return rule
}

export const addRule = (path: string, provider: string, id: string): ReplyRuleFile => {
  const file = readRepliesFile(path, provider)
  if (file.rules.some((one) => one.id === id)) throw new CliError("validation_error", `reply rule ${id} already exists`)
  const rule = defaultRule(id)
  file.rules.push(rule)
  writeRepliesFile(path, file)
  return rule
}

export const switchRule = (path: string, provider: string, id: string, on: boolean): ReplyRuleFile => {
  const file = readRepliesFile(path, provider)
  const rule = findRule(file, id)
  rule.on = on
  writeRepliesFile(path, file)
  return rule
}

export const editRule = (path: string, provider: string, id: string, edits: RuleEdits): ReplyRuleFile => {
  const file = readRepliesFile(path, provider)
  const rule = findRule(file, id)
  if (Object.values(edits).every((value) => value === undefined)) {
    throw new CliError("validation_error", "replies edit needs at least one field option")
  }
  if (edits.do !== undefined) rule.do = choices(list(edits.do), REPLY_ACTIONS, "--do")
  if (edits.kinds !== undefined) rule.where.kinds = choices(list(edits.kinds), REPLY_KINDS, "--kinds")
  if (edits.chats !== undefined) rule.where.chats = list(edits.chats)
  if (edits.notChats !== undefined) rule.where.notChats = list(edits.notChats)
  if (edits.words !== undefined) rule.when.words = list(edits.words)
  if (edits.question !== undefined) rule.when.question = edits.question
  if (edits.mentionsMe !== undefined) rule.when.mentionsMe = edits.mentionsMe
  if (edits.people !== undefined) rule.when.from.people = list(edits.people)
  if (edits.notPeople !== undefined) rule.when.from.notPeople = list(edits.notPeople)
  if (edits.contactsOnly !== undefined) rule.when.from.contactsOnly = edits.contactsOnly
  if (edits.template !== undefined) rule.reply.template = edits.template
  if (edits.model !== undefined) rule.reply.model = choices([edits.model], REPLY_MODELS, "--model")[0] ?? "fill-only"
  if (edits.asReply !== undefined) rule.reply.asReply = edits.asReply
  if (edits.perChat !== undefined) rule.limits.perChat = edits.perChat
  if (edits.perPerson !== undefined) rule.limits.perPerson = edits.perPerson
  const hours = [edits.outside, edits.days, edits.timezone].some((value) => value !== undefined)
  if (edits.hours === false) {
    if (hours)
      throw new CliError("validation_error", "--no-hours cannot be combined with --outside, --days or --timezone")
    rule.when.hours = null
  } else if (hours) {
    const outside = edits.outside ?? rule.when.hours?.outside
    const days = edits.days ?? rule.when.hours?.days
    const timezone = edits.timezone ?? rule.when.hours?.timezone
    if (outside === undefined || days === undefined || timezone === undefined) {
      throw new CliError("validation_error", "first setting hours needs --outside, --days and --timezone together")
    }
    rule.when.hours = { outside, days, timezone }
  }
  writeRepliesFile(path, file)
  return rule
}

export const editAudience = (path: string, provider: string, edits: AudienceEdits): Audience => {
  const file = readRepliesFile(path, provider)
  const { audience } = file
  if (Object.values(edits).every((value) => value === undefined)) return audience
  if (edits.reply !== undefined) audience.reply = choices([edits.reply], ["all", "listed"], "--reply")[0] ?? "all"
  if (edits.allowPeople !== undefined) audience.allow.people = list(edits.allowPeople)
  if (edits.allowChats !== undefined) audience.allow.chats = list(edits.allowChats)
  if (edits.denyPeople !== undefined) audience.deny.people = list(edits.denyPeople)
  if (edits.denyChats !== undefined) audience.deny.chats = list(edits.denyChats)
  writeRepliesFile(path, file)
  return audience
}
