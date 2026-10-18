import type { Id, Provider } from "../../domain/models.js"
import type { AppIdentity } from "../../ports/app.js"
import type { RemoteFile } from "../../ports/messenger.js"
import { refreshedFiles } from "../../services/file-download.js"
import { openStore } from "../../store/store.js"
import { recalledAccount } from "./accounts.js"

/**
 * Saves the new reference of files read without saving them — a voice message heard, a photo looked at — on the
 * stored attachments of the account this profile last logged in as. The read succeeded whatever happens here:
 * a ref not saved costs only another fetch next time, so it warns and never fails. The warning never shows the ref.
 */
export const keepRefreshedRefs = async (
  messenger: { app: AppIdentity; provider: Provider },
  where: { profile: string; env: NodeJS.ProcessEnv },
  chatId: Id,
  messageId: Id,
  files: readonly RemoteFile[],
  warn: (message: string) => void = () => {},
): Promise<void> => {
  const refreshed = refreshedFiles(files)
  if (refreshed.length === 0) return
  const unsaved = `message ${messageId}: a new file reference from the messenger was not saved; the next read asks again`
  const account = recalledAccount(messenger.app, messenger.provider, where.profile, where.env)
  if (!account) return warn(unsaved)
  try {
    const store = await openStore({ env: where.env })
    try {
      if ((await store.attachments.keepProviderRefs(account, chatId, messageId, refreshed)) < refreshed.length)
        warn(unsaved)
    } finally {
      await store.close()
    }
  } catch {
    warn(unsaved)
  }
}
