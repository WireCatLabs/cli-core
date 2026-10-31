import { isFolderProvider, kindIn } from "../domain/providers.js"
import type { Profiles } from "../search/account-list.js"
import type { Note, StoredAccount, StoredFile } from "../store/index.js"

/**
 * Where a hit came from. The document's preferred file says it: its account's provider and its link.
 * A Drive document under a notes folder (before version 31 moves it) is still known by its front matter.
 * The hit's time is the store search's: the one `date:` reads.
 */
export const documentSource = (
  note: Note,
  accounts: readonly StoredAccount[],
  profiles: Profiles,
  file?: StoredFile,
) => {
  const metadata = note.frontMatter as Record<string, unknown> | null
  const account = accounts.find(({ id }) => String(id) === note.folderId)
  const remote =
    note.source === "file" &&
    ((account !== undefined && kindIn(account.provider) === "documents") || metadata?.source === "google-drive")
  const profile =
    remote && account
      ? Object.entries(profiles)
          .flatMap(([command, named]) => Object.entries(named).map(([name, key]) => ({ command, name, key })))
          .find(
            ({ key }) =>
              (key.provider === account.provider && key.account === account.account) ||
              (isFolderProvider(key.provider) && key.account === account.name),
          )
      : undefined
  const url = file?.url ?? (remote && typeof metadata?.sourceUrl === "string" ? metadata.sourceUrl : undefined)
  return {
    kind: remote ? ("document" as const) : ("note" as const),
    provider: profile ? profile.command : "notes",
    account: profile?.name ?? note.folderId ?? "internal",
    ...(remote && url !== undefined ? { url } : {}),
  }
}
