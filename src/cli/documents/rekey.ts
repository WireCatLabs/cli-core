import { existsSync } from "node:fs"
import type { ProviderEntry } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import type { MessageStore } from "../../store/index.js"
import { storePath } from "../../store/path.js"
import { openAppStore } from "../app-store.js"

export interface SyncedDocumentRekey {
  env: NodeJS.ProcessEnv
  app: Pick<AppIdentity, "command" | "version">
  provider: ProviderEntry
  /** The same ingestion the CLI's documents commands file documents with. */
  ingestion(store: MessageStore): { rekey(principal: string, from: string, to: string): Promise<boolean> }
  /** The account's principal, as the documents sync names it. */
  account: string
  from: string
  to: string
  warn(message: string): void
}

/**
 * After a write that gave a file a new id at the provider, moves its synced copy to that id, so the owner's tags and
 * notes follow the file. The write already happened, so a failure only warns; a store never opened stays unopened.
 */
export const rekeySyncedDocument = async (input: SyncedDocumentRekey): Promise<boolean> => {
  if (!existsSync(storePath(input.env))) return false
  try {
    const store = await openAppStore(input.env, { app: input.app, provider: input.provider })
    try {
      return await input.ingestion(store).rekey(input.account, input.from, input.to)
    } finally {
      await store.close()
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    input.warn(`the synced copy keeps its tags and notes under the old id ${input.from}: ${why}`)
    return false
  }
}
