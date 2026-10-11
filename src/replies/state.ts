import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import * as v from "valibot"
import type { AppIdentity } from "../cli/app.js"
import type { Id, Message } from "../domain/models.js"
import type { ReplyRule } from "./rules.js"

/** Enough to cover any restart's catch-up; older ids are past the catch-up start and never answered anyway. */
export const ANSWERED_KEPT = 1000

const times = v.record(v.string(), v.array(v.string()))

const stateFile = v.object({
  paused: v.boolean(),
  /** `<chat>:<message>`, oldest first. */
  answered: v.array(v.string()),
  /** Per rule, when it replied, by chat and by person: what its limits count. */
  sent: v.record(v.string(), v.object({ chats: times, people: times })),
})

export type RepliesState = v.InferOutput<typeof stateFile>

export const emptyState = (): RepliesState => ({ paused: false, answered: [], sent: {} })

export const answeredKey = (message: Pick<Message, "chatId" | "id">): string => `${message.chatId}:${message.id}`

/**
 * What the rules did, apart from the rules: editing the rules file never forgets what was already
 * answered. Read on every message, so `pause` stops a running `serve` without a restart.
 */
export const repliesStatePathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, `${profile}.replies-state.json`)

/** A file that does not check out refuses: guessing would forget what was answered, and answer it twice. */
export const readRepliesState = (path: string): RepliesState => {
  if (!existsSync(path)) return emptyState()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw broken(path, error instanceof Error ? error.message : String(error))
  }
  const checked = v.safeParse(stateFile, parsed)
  if (!checked.success) {
    throw broken(path, checked.issues.map((issue) => `${v.getDotPath(issue) ?? "file"}: ${issue.message}`).join("; "))
  }
  return checked.output
}

export const writeRepliesState = (path: string, state: RepliesState): void =>
  writeSecurely(path, `${JSON.stringify(state)}\n`, 0o600)

export const paused = (state: RepliesState, on: boolean): RepliesState => ({ ...state, paused: on })

/**
 * The state after `rule` replied to `message` at `now`: the message answered, the reply counted for
 * its chat and its sender. Counts older than the rule's longest limit are dropped, since no limit
 * reads them.
 */
export const recordReply = (
  state: RepliesState,
  rule: Pick<ReplyRule, "id" | "limits">,
  message: Pick<Message, "chatId" | "id" | "senderId">,
  now: number,
): RepliesState => {
  const oldest = now - Math.max(rule.limits.perChat.ms, rule.limits.perPerson.ms)
  const kept = (all: Record<Id, string[]>, key: Id | null): Record<Id, string[]> => {
    const recent = Object.fromEntries(
      Object.entries(all)
        .map(([id, at]) => [id, at.filter((one) => Date.parse(one) > oldest)] as const)
        .filter(([, at]) => at.length > 0),
    )
    if (key === null) return recent
    return { ...recent, [key]: [...(recent[key] ?? []), new Date(now).toISOString()] }
  }
  const before = state.sent[rule.id] ?? { chats: {}, people: {} }
  return {
    ...state,
    answered: [...state.answered.filter((one) => one !== answeredKey(message)), answeredKey(message)].slice(
      -ANSWERED_KEPT,
    ),
    sent: {
      ...state.sent,
      [rule.id]: { chats: kept(before.chats, message.chatId), people: kept(before.people, message.senderId) },
    },
  }
}

const broken = (path: string, why: string) =>
  new CliError("configuration_error", `the reply state ${path} cannot be read (${why}) — fix or move the file`)
