import { CliError } from "@wirecat/cli-base"
import type { AccountKey, MessageStore } from "../store/store.js"

const KEY = "analysis-consents-v1"
export interface AnalysisConsent {
  chat: string
  provider: string
  at: string
}
export interface AnalysisConsentFilter {
  chat?: string
  provider?: string
}

export interface AnalysisConsents {
  list(filter?: AnalysisConsentFilter): Promise<AnalysisConsent[]>
  has(chat: string, provider: string): Promise<boolean>
  remember(chat: string, provider: string): Promise<void>
  revoke(chat?: string, provider?: string): Promise<void>
}

export const analysisConsents = (store: MessageStore, account: AccountKey): AnalysisConsents => {
  const list = async (filter?: AnalysisConsentFilter): Promise<AnalysisConsent[]> => {
    const state = await store.sync.syncState(account, KEY)
    if (!state) return []
    try {
      const items = JSON.parse(state.value) as AnalysisConsent[]
      if (
        !Array.isArray(items) ||
        items.some(
          (item) =>
            !item || typeof item.chat !== "string" || typeof item.provider !== "string" || typeof item.at !== "string",
        )
      )
        throw new Error("invalid")
      return filter === undefined
        ? items
        : items.filter(
            (item) =>
              (filter.chat === undefined || item.chat === filter.chat) &&
              (filter.provider === undefined || item.provider === filter.provider),
          )
    } catch {
      throw new CliError("configuration_error", "stored analysis consent is invalid; revoke it before running analysis")
    }
  }
  return {
    list,
    has: async (chat: string, provider: string) =>
      (await list()).some((item) => item.chat === chat && item.provider === provider),
    remember: async (chat: string, provider: string) => {
      const items = (await list()).filter((item) => item.chat !== chat || item.provider !== provider)
      await store.sync.setSyncState(
        account,
        KEY,
        JSON.stringify([...items, { chat, provider, at: new Date().toISOString() }]),
      )
    },
    revoke: async (chat?: string, provider?: string) => {
      if (chat === undefined && provider === undefined) {
        await store.sync.clearSyncState(account, KEY)
        return
      }
      const items = (await list()).filter(
        (item) =>
          !((chat === undefined || item.chat === chat) && (provider === undefined || item.provider === provider)),
      )
      await store.sync.setSyncState(account, KEY, JSON.stringify(items))
    },
  }
}
