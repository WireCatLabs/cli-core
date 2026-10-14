import { CliError } from "@wirecat/cli-base"
import { parseLucene, validateQuery } from "@wirecat/cli-base/query"
import { formatLocator } from "../domain/locator.js"
import type { Page } from "../domain/models.js"
import { MENTION_QUERY, type MentionsRebuild, type MentionsState, type StoredMention } from "../store/store.js"
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
}

export interface Mentions extends Page<Mention> {
  /** `rebuiltAt` null: messages stored before mentions existed are not read yet. */
  state: MentionsState
}

export interface MentionsService {
  /** `query` empty lists every mention; a bare word is a value. */
  list(query: string, window: { limit?: number; offset: number }): Promise<Mentions>
  show(id: number): Promise<MentionDetails>
  rebuild(options?: { onBatch?: (done: number, total: number) => void }): Promise<MentionsRebuild>
}

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
    show: async (id) => {
      const { store, mention } = await located()
      const found = await store.mention(id)
      if (!found) throw new CliError("not_found", `no mention ${id} in this account`)
      const { before, after, sameValue, ...rest } = found
      return { ...mention(rest), before, after, sameValue }
    },
    rebuild: async (options = {}) =>
      (await crossAccount(deps, "mentions are derived from every account's stored text")).rebuildMentions(options),
  }
}
