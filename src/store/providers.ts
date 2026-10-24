import type { ProviderEntry } from "../domain/providers.js"
import type { MessageStore } from "./store.js"

/**
 * A CLI's entry, written into the store on every run so cli-core in every other CLI knows its provider's kind and
 * aliases. Two entries that disagree on a kind, or an alias another provider already has, are an error.
 */
export const registerProvider = (store: Pick<MessageStore, "accounts">, entry: ProviderEntry): Promise<void> =>
  store.accounts.registerProvider(entry)
