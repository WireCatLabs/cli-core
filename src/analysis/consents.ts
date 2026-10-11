import { CliError } from "@wirecat/cli-base"
import type { AccountKey, MessageStore } from "../store/store.js"

const KEY = "analysis-consents-v1"
export interface AnalysisConsent {
  chat: string
  provider: string
  at: string
}
export const analysisConsents = (store: MessageStore, account: AccountKey) => {
  const list = async (): Promise<AnalysisConsent[]> => {
    const state = await store.syncState(account, KEY)
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
      return items
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
      await store.setSyncState(
        account,
        KEY,
        JSON.stringify([...items, { chat, provider, at: new Date().toISOString() }]),
      )
    },
    revoke: async (chat?: string, provider?: string) => {
      if (chat === undefined && provider === undefined) {
        await store.clearSyncState(account, KEY)
        return
      }
      const items = (await list()).filter(
        (item) =>
          !((chat === undefined || item.chat === chat) && (provider === undefined || item.provider === provider)),
      )
      await store.setSyncState(account, KEY, JSON.stringify(items))
    },
  }
}
