import { CliError } from "@wirecat/cli-base"
import { timezoneOf } from "@wirecat/cli-base/query"
import { type MailTurn, mailTurn } from "../mail/owed.js"
import {
  type AccountKey,
  type ChatActivity,
  MAIL_AGENDA_COLUMNS,
  type MessageStore,
  queryFilter,
  type Where,
} from "../store/store.js"
import type { ChatCoverage } from "./chat-coverage.js"

export interface TurnActivity extends ChatActivity {
  turn: MailTurn
}

const absent = (error: unknown): undefined => {
  if (error instanceof CliError && error.code === "not_found") return undefined
  throw error
}

/**
 * `tasks agenda` over an email account: each thread with mail in the window, its newest email deciding whose turn it
 * is (`mailTurn`). `storedAt` is when sync last proved the mailbox, so a quiet day with no mail is not `stale`.
 */
export const mailActivity = async (
  store: MessageStore,
  account: AccountKey,
  since: number,
  chats: Parameters<typeof queryFilter>[0] | undefined,
): Promise<{ chats: TurnActivity[]; storedAt: string | null; coverage: (ids: string[]) => ChatCoverage[] }> => {
  const stored = await store.accounts.storedAccount(account).catch(absent)
  if (!stored) return { chats: [], storedAt: null, coverage: () => [] }
  const where: Where | undefined = chats
    ? queryFilter(chats, MAIL_AGENDA_COLUMNS, { command: "tasks agenda", zone: timezoneOf() })
    : undefined
  const threads = await store.mail.threadActivity(stored.id, since, where)
  const synced = await store.sync.syncState(account, "mail_coverage")
  const window = (() => {
    try {
      return JSON.parse(synced?.value ?? "{}") as { until?: string; state?: string }
    } catch {
      return {}
    }
  })()
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]))
  return {
    chats: threads.map((thread) => ({
      chatId: thread.threadId,
      title: thread.subject,
      kind: "dialog",
      lastMessageAt: new Date(thread.newest?.at ?? thread.lastEmailAt).toISOString(),
      lastMessageId: thread.newest?.externalId ?? null,
      lastFromOwner: thread.newest ? thread.newest.outgoing : null,
      turn: mailTurn(thread.newest),
    })),
    storedAt: synced?.at ?? null,
    coverage: (ids) =>
      ids.map((chatId) => {
        const thread = byId.get(chatId)
        const newest = thread?.newest?.at ?? thread?.lastEmailAt
        const until = window.until === undefined ? Number.NaN : Date.parse(window.until)
        return {
          chatId,
          title: thread?.subject ?? null,
          completeness: {
            chatId,
            // Sync holds a window of the mailbox, never a thread's whole history.
            state: synced ? "partial" : "unknown",
            upToDate:
              window.state === "window" && newest !== undefined && !Number.isNaN(until) ? newest <= until : null,
            gaps: false,
            reachesStart: false,
            fetchedAt: synced?.at ?? null,
          },
          held: {
            messages: thread?.emails ?? 0,
            oldestAt: null,
            newestAt: newest === undefined ? null : new Date(newest).toISOString(),
          },
        }
      }),
  }
}
