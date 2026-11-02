import { CliError } from "@wirecat/cli-base"
import { isLocator, parseLocator } from "../../../domain/locator.js"
import { PROMISE_FORMS } from "../../../domain/status-words.js"
import { dueDayOf } from "../../../search/task-signature.js"
import { normalize } from "../../../store/normalize.js"
import { inboxKey, type TaskDetails } from "../../../store/store.js"
import { taskAccount } from "../../task-rules.js"
import { day, evidenceOf, excerpt, fromOwner, whoOf } from "../items.js"
import type { StatusChat, StatusContext, StatusItem, StatusSignal } from "../types.js"

export interface PromisesData {
  /** Where it came from: a stored task, a recorded fact, or a word match in a message (a guess). */
  source: "task" | "fact" | "pattern"
  /** `promise` or `request` for a task; a fact's and a pattern's are promises. */
  kind: string
  title: string
  /** Who promised, for a pattern: the owner (`yours`) or the other side. */
  side: "yours" | "theirs" | null
  due: string | null
  status: string
}

const PATTERNS_PER_CHAT = 3
const DAY = 86_400_000
const KINDS = new Set(["promise", "request"])
const OPEN = new Set(["open", "todo", "in_progress"])

const chatOfSource = (context: StatusContext, source: string | null): StatusChat | undefined => {
  if (source === null || !isLocator(source)) return undefined
  const { provider, account, chat } = parseLocator(source)
  return context.chats.find(
    (one) => one.account.provider === provider && one.account.account === account && one.chatId === chat,
  )
}

// An account that never had a task has no inbox project yet.
const orNone = (error: unknown): TaskDetails[] => {
  if (error instanceof CliError && error.code === "not_found") return []
  throw error
}

const tasksOf = async (context: StatusContext): Promise<TaskDetails[]> => {
  const projects = [context.project.ref, ...context.project.children.map((child) => child.ref)]
  const accounts = new Map(context.chats.map((chat) => [taskAccount(chat.account), chat.account]))
  const inboxes = [...accounts.keys()].map(inboxKey)
  const found = await Promise.all(
    [...projects, ...inboxes].map((project) => context.store.tasks.find({ project, limit: 500 }).catch(orNone)),
  )
  const projectRefs = new Set(projects)
  return found
    .flat()
    .filter((task) => KINDS.has(task.type) && OPEN.has(task.status))
    .filter((task) => projectRefs.has(task.project) || chatOfSource(context, task.source) !== undefined)
}

const taskItem = (context: StatusContext, task: TaskDetails): StatusItem<PromisesData> => ({
  signal: "promises",
  chat: chatOfSource(context, task.source)?.ref ?? null,
  at: task.createdAt,
  who: null,
  evidence: [{ ref: task.ref, fingerprint: null }, ...(task.source ? [{ ref: task.source, fingerprint: null }] : [])],
  basis: "task",
  data: {
    source: "task",
    kind: task.type,
    title: excerpt(task.title),
    side: null,
    due: task.dueAt === null ? null : day(task.dueAt),
    status: task.status,
  },
})

const patternItems = (chat: StatusChat): StatusItem<PromisesData>[] =>
  chat.messages
    .filter((message) => !message.text.includes("?") && PROMISE_FORMS.test(message.text))
    .slice(-PATTERNS_PER_CHAT)
    .reverse()
    .map((message) => {
      const due = dueDayOf(normalize(message.text), Date.parse(message.timestamp))
      return {
        signal: "promises",
        chat: chat.ref,
        at: message.timestamp,
        who: whoOf(message),
        evidence: evidenceOf(chat, message),
        basis: "pattern",
        data: {
          source: "pattern",
          kind: "promise",
          title: excerpt(message.text),
          side: fromOwner(message) ? "yours" : "theirs",
          due: due === null ? null : day(due * DAY),
          status: "open",
        },
      }
    })

/**
 * Open promise and request tasks of the project or from its chats, promise facts proposed or accepted, and up to
 * three promises per chat found by first person future words ("сделаю", "I'll send"), marked as patterns.
 */
export const promises: StatusSignal<PromisesData> = {
  id: "promises",
  version: 1,
  scope: "project",
  read: async (context) => {
    const projects = [context.project.ref, ...context.project.children.map((child) => child.ref)]
    const facts = (await Promise.all(projects.map((project) => context.store.facts.list({ type: "promise", project }))))
      .flat()
      .filter((fact) => fact.status === "proposed" || fact.status === "accepted")
    return [
      ...(await tasksOf(context)).map((task) => taskItem(context, task)),
      ...facts.map(
        (fact): StatusItem<PromisesData> => ({
          signal: "promises",
          chat: null,
          at: fact.occurredAt ?? fact.createdAt,
          who: null,
          evidence: [{ ref: fact.ref, fingerprint: null }],
          basis: "fact",
          data: {
            source: "fact",
            kind: "promise",
            title: excerpt(fact.statement),
            side: null,
            due: null,
            status: fact.status,
          },
        }),
      ),
      ...context.chats.flatMap(patternItems),
    ]
  },
}
