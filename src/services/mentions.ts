import { CliError } from "@wirecat/cli-base"
import { parseLucene, validateQuery } from "@wirecat/cli-base/query"
import { formatLocator } from "../domain/locator.js"
import type { MentionKind } from "../domain/mentions.js"
import type { Page } from "../domain/models.js"
import { parseReference } from "../domain/references.js"
import {
  MENTION_QUERY,
  type MentionDecision,
  type MentionsRebuild,
  type MentionsState,
  type StoredMention,
} from "../store/store.js"
import { accountStore, crossAccount, type ServiceDeps } from "./deps.js"

/** One mention as `mentions list` and `show` answer it: the message it is in, by locator. */
export interface Mention extends Omit<StoredMention, "chatId" | "messageId"> {
  locator: string
}

export interface MentionDetails extends Mention {
  before: string
  after: string
  /** Other places, in any account, that hold the same kind and value. */
  sameValue: number
  /** A name's possible people, `person:<uid>`, those who wrote in its chat first. */
  candidates: string[]
}

export interface Mentions extends Page<Mention> {
  /** `rebuiltAt` null: messages stored before mentions existed are not read yet. */
  state: MentionsState
}

export interface MentionsService {
  /** `query` empty lists every mention; a bare word is a value. */
  list(query: string, window: { limit?: number; offset: number; foundAfter?: number }): Promise<Mentions>
  /** Undecided mentions found after `foundAfter` (ms), or at all: up to `REVIEW_COUNT`, and whether more wait. */
  newCount(foundAfter: number | undefined): Promise<{ count: number; more: boolean }>
  show(id: number): Promise<MentionDetails>
  rebuild(options?: {
    kinds?: readonly MentionKind[]
    onBatch?: (done: number, total: number) => void
  }): Promise<MentionsRebuild>
  /** `target` is `person:<uid>` or `organization:<id>` for a phone or an address; a document needs none. */
  confirm(id: number, target: string | undefined, by: string): Promise<MentionDecision>
  reject(id: number, by: string): Promise<MentionDecision>
}

/** How many a sync counts toward its review note: enough to say "many", cheap on a big store. */
export const REVIEW_COUNT = 500

export const mentionsService = (deps: ServiceDeps): MentionsService => {
  const located = async () => {
    const store = await accountStore(deps)
    return {
      store,
      mention: ({ chatId, messageId, ...rest }: StoredMention): Mention => ({
        ...rest,
        locator: formatLocator({ ...store.account, chat: chatId, message: messageId }),
      }),
    }
  }
  return {
    list: async (query, window) => {
      const ast = query.trim()
        ? validateQuery(parseLucene(query, { ...MENTION_QUERY, defaultField: "value" }), MENTION_QUERY)
        : undefined
      const { store, mention } = await located()
      const page = await store.mentions(ast, window)
      const state = await (await deps.store()).mentionsState()
      return { items: page.items.map(mention), hasMore: page.hasMore, state }
    },
    newCount: async (foundAfter) => {
      const found = parseLucene("status:found", { ...MENTION_QUERY, defaultField: "value" })
      const window = { offset: 0, limit: REVIEW_COUNT, ...(foundAfter === undefined ? {} : { foundAfter }) }
      const page = await (await accountStore(deps)).mentions(found, window)
      return { count: page.items.length, more: page.hasMore }
    },
    show: async (id) => {
      const { store, mention } = await located()
      const found = await store.mention(id)
      if (!found) throw new CliError("not_found", `no mention ${id} in this account`)
      const { before, after, sameValue, candidates, ...rest } = found
      return { ...mention(rest), before, after, sameValue, candidates }
    },
    confirm: async (id, target, by) => {
      let owner: string | undefined
      if (target !== undefined) {
        const reference = parseReference(target)
        if (reference.type !== "person" && reference.type !== "organization")
          throw new CliError(
            "validation_error",
            `a mention is confirmed to person:<uid> or organization:<id>, not ${reference.type}`,
          )
        owner = `${reference.type}:${reference.id}`
      }
      return (await accountStore(deps)).confirmMention(id, owner, by)
    },
    reject: async (id, by) => (await accountStore(deps)).rejectMention(id, by),
    rebuild: async (options = {}) =>
      (await crossAccount(deps, "mentions are derived from every account's stored text")).rebuildMentions(options),
  }
}
