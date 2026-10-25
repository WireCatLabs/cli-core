import { isFolderProvider, kindIn } from "../domain/providers.js"
import type { Profiles } from "../search/account-list.js"
import type { Note, StoredAccount, StoredFile } from "../store/index.js"

/**
 * Where a hit came from. The document's preferred file says it: its account's provider, its link and its edit time.
 * A Drive document under a notes folder (before version 31 moves it) is still known by its front matter.
 * Indexing time belongs to the local row.
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
  const modified =
    file?.externalUpdatedAt ??
    (remote && typeof metadata?.modifiedAt === "string" && Number.isFinite(Date.parse(metadata.modifiedAt))
      ? metadata.modifiedAt
      : undefined)
  return {
    kind: remote ? ("document" as const) : ("note" as const),
    provider: profile ? profile.command : "notes",
    account: profile?.name ?? note.folderId ?? "internal",
    ...(remote && url !== undefined ? { url } : {}),
    updated_at: remote && modified !== undefined ? modified : note.updatedAt,
  }
}
