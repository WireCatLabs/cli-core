import type { ProviderEntry } from "../domain/providers.js"
import type { AppIdentity } from "../ports/app.js"
import type { MessageStore } from "../store/store.js"

/**
 * The shared store, with the CLI's provider entry written, so every other CLI's search knows it (WC-ARCH-21). A
 * read-only open writes nothing, the entry included, and fails when the file is missing or needs a migration.
 */
export const openAppStore = async (
  env: NodeJS.ProcessEnv,
  {
    app,
    provider,
    readOnly = false,
  }: { app: Pick<AppIdentity, "command" | "version">; provider: ProviderEntry; readOnly?: boolean },
): Promise<MessageStore> => {
  const { ensureSqlite } = await import("../sqlite-runtime.js")
  await ensureSqlite()
  const { openStore, registerProvider, storePath } = await import("../store/index.js")
  const store = await openStore({
    path: storePath(env),
    env,
    command: app.command,
    version: app.version,
    ...(readOnly ? { readOnly } : {}),
  })
  try {
    if (!readOnly) await registerProvider(store, provider)
    return store
  } catch (error) {
    await store.close()
    throw error
  }
}
