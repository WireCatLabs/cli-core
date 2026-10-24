import { isFolderProvider } from "../domain/providers.js"
import type { Profiles } from "../search/account-list.js"
import type { Note, NoteFolder } from "../store/index.js"

/** Imported sources keep their remote edit time; indexing time still belongs to the local row. */
export const documentSource = (note: Note, folders: NoteFolder[], profiles: Profiles) => {
  const metadata = note.frontMatter as Record<string, unknown> | null
  const folder = folders.find(({ id }) => id === note.folderId)
  const remote = note.source === "file" && metadata?.source === "google-drive"
  const profile =
    remote && folder
      ? Object.entries(profiles.drive ?? {}).find(([, key]) =>
          folder.account
            ? key.provider === folder.account.provider && key.account === folder.account.account
            : isFolderProvider(key.provider) && key.account === folder.name,
        )?.[0]
      : undefined
  return {
    kind: remote ? ("document" as const) : ("note" as const),
    provider: profile ? "drive" : "notes",
    account: profile ?? note.folderId ?? "internal",
    ...(remote && typeof metadata?.sourceUrl === "string" ? { url: metadata.sourceUrl } : {}),
    updated_at:
      remote && typeof metadata?.modifiedAt === "string" && Number.isFinite(Date.parse(metadata.modifiedAt))
        ? metadata.modifiedAt
        : note.updatedAt,
  }
}
