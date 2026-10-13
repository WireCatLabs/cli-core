import { RULES_VERSION } from "../conversations/link.js"
import type { Id } from "../domain/models.js"
import type { StoredReadiness } from "../store/store.js"
import type { ChatReadiness, ReadinessState, SearchReadiness } from "./embedding-contracts.js"

export const needsBuild = (one: ChatReadiness) => one.graph === null || isStale(one)

export const needsEmbed = (one: ChatReadiness) => one.graph !== null && one.vectors.missing > 0

/** Never finished first, then the oldest build: the longest-waiting change goes first. */
export const byOldestBuild = (a: ChatReadiness, b: ChatReadiness) =>
  (a.graph?.builtAt ?? "").localeCompare(b.graph?.builtAt ?? "")

/** The chats in readiness by how a meaning search with these vectors could see them, and the word matches outside any. */
export const searchReadiness = (chats: ChatReadiness[], meaning: boolean, outside: Set<Id>): SearchReadiness => {
  const built = new Set(chats.filter(({ state }) => state !== "not-built").map(({ chat }) => chat))
  const ids = (keep: (one: ChatReadiness) => boolean) => chats.filter(keep).map(({ chat }) => chat)
  const byMeaning = (one: ChatReadiness) =>
    meaning && built.has(one.chat) && one.state !== "words-only" && one.vectors.chunks > 0
  return {
    searchedByMeaning: ids(byMeaning),
    wordsOnly: ids((one) => built.has(one.chat) && !byMeaning(one)),
    partial: ids((one) => byMeaning(one) && one.vectors.missing > 0),
    stale: ids((one) => built.has(one.chat) && isStale(one)),
    notBuilt: [
      ...new Set([...ids((one) => one.state === "not-built"), ...[...outside].filter((id) => !built.has(id))]),
    ].sort(),
  }
}

export const isStale = ({ graph, pending, vectors }: ChatReadiness) =>
  Boolean(graph?.outdatedRules) || pending.new + pending.edited + pending.deleted > 0 || vectors.stale > 0

export const shaped = ({ chatId, builtAt, algorithmVersion, pending, vectors }: StoredReadiness): ChatReadiness => {
  const { embedded, ...counts } = vectors
  const graph =
    builtAt === null
      ? null
      : { builtAt, rulesVersion: algorithmVersion, outdatedRules: algorithmVersion !== RULES_VERSION }
  const one: ChatReadiness = { chat: chatId, state: "ready", graph, pending, vectors: counts }
  const state: ReadinessState =
    graph === null
      ? "not-built"
      : counts.chunks > 0 && embedded === 0
        ? "words-only"
        : isStale(one)
          ? "stale"
          : counts.missing > 0
            ? "partial"
            : "ready"
  return { ...one, state }
}
