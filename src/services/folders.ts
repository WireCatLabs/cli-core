import { CliError } from "@wirecat/cli-base"
import type { Chat, Folder, FolderKind, FolderRules, FolderSkip, Id } from "../domain/models.js"
import { capability, type MessengerAdapter } from "../ports/messenger.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import { type ServiceDeps, storeIfOpen } from "./deps.js"

/** Chats as typed; `include` and `skip` replace what the folder had. */
export interface FolderRulesEdit {
  emoji?: string
  include?: FolderKind[]
  skip?: FolderSkip[]
  exclude?: string[]
  pin?: string[]
}

export interface FolderChat {
  id: Id
  title: string | null
  kind: Chat["kind"] | null
}

export type FolderShown = Omit<Folder, "chatIds" | "excludedChatIds" | "pinnedChatIds"> & {
  chats: FolderChat[]
  pinned: FolderChat[]
  excluded: FolderChat[]
}

export interface FolderEdit extends FolderRulesEdit {
  title?: string
  add?: string[]
  remove?: string[]
}

/** The owner's chat folders. Nobody else sees them, but they change the owner's own app, so each change is guarded. */
export interface FoldersService {
  list(): Promise<Folder[]>
  /** `folder` is its id, or its title exactly; its chats by name. */
  show(folder: string): Promise<FolderShown>
  create(title: string, chats: string[], rules?: FolderRulesEdit): Promise<Operated<{ folder: Folder }>>
  /** `folder` is its id, or its title exactly. */
  update(folder: string, edit: FolderEdit): Promise<Operated<{ folder: Folder }>>
  delete(folder: string): Promise<Operated<{ folderId: string }>>
  /** The folders named go first, in this order; the others keep theirs after them. */
  order(folders: string[]): Promise<Operated<{ folders: Pick<Folder, "id" | "title">[] }>>
  /** A folder shared by a link: every chat in it is joined. */
  join(link: string): Promise<Operated<{ folder: Folder }>>
}

export const foldersService = (deps: ServiceDeps): FoldersService => {
  const online = async (command: string) => {
    if (deps.offline) throw new CliError("validation_error", `\`${command}\` asks the messenger; not with --offline`)
    return deps.connection()
  }
  const ids = async (connection: MessengerAdapter, chats: string[] = []): Promise<Id[]> => {
    const found: Id[] = []
    for (const chat of chats) found.push((await connection.resolve(chat)).id)
    return found
  }
  const folderOf = async (connection: MessengerAdapter, typed: string): Promise<Folder> => {
    const all = await capability(connection, "folders", "list its folders")()
    const found = all.find((one) => one.id === typed) ?? all.filter((one) => one.title === typed)
    if (!Array.isArray(found)) return found
    if (found.length === 1) return found[0] as Folder
    throw new CliError(
      found.length === 0 ? "not_found" : "validation_error",
      found.length === 0
        ? `no folder "${typed}" — \`chats folders list\` shows them`
        : `${found.length} folders are called "${typed}" — name one by its id`,
    )
  }
  const rulesOf = async (connection: MessengerAdapter, edit: FolderRulesEdit): Promise<FolderRules> => {
    const asked = [edit.emoji, edit.include, edit.skip, edit.exclude?.length, edit.pin?.length].some(
      (one) => one !== undefined && one !== 0,
    )
    if (asked && !deps.messenger.folderRules)
      throw new CliError("validation_error", "this messenger's folders hold only the chats named in them")
    return {
      ...(edit.emoji === undefined ? {} : { emoji: edit.emoji }),
      ...(edit.include === undefined ? {} : { include: edit.include }),
      ...(edit.skip === undefined ? {} : { skip: edit.skip }),
      ...(edit.exclude?.length ? { exclude: await ids(connection, edit.exclude) } : {}),
      ...(edit.pin?.length ? { pin: await ids(connection, edit.pin) } : {}),
    }
  }
  const changes = (edit: FolderEdit) =>
    [
      edit.title,
      edit.add?.length,
      edit.remove?.length,
      edit.emoji,
      edit.include,
      edit.skip,
      edit.exclude?.length,
      edit.pin?.length,
    ].some((one) => one !== undefined && one !== 0)
  return {
    list: async () => capability(await online("chats folders list"), "folders", "list its folders")(),

    show: async (typed) => {
      const connection = await online("chats folders show")
      const { chatIds, excludedChatIds = [], pinnedChatIds = [], ...folder } = await folderOf(connection, typed)
      const held = await storeIfOpen(deps)
      const known = new Map<Id, FolderChat>()
      for (const one of held ? (await held.store.chats(held.account, {})).items : [])
        known.set(one.id, { id: one.id, title: one.title, kind: one.kind })
      const named = async (ids: Id[]) => {
        const chats: FolderChat[] = []
        for (const id of ids) {
          let found = known.get(id)
          if (!found) {
            found = await connection.resolve(id).then(
              (one) => ({ id, title: one.title, kind: one.kind }),
              (error: unknown) => {
                if (error instanceof CliError && error.code === "not_found") return { id, title: null, kind: null }
                throw error
              },
            )
            known.set(id, found)
          }
          chats.push(found)
        }
        return chats
      }
      return {
        ...folder,
        chats: await named(chatIds),
        pinned: await named(pinnedChatIds),
        excluded: await named(excludedChatIds),
      }
    },

    create: async (title, chats, edit = {}) => {
      if (title.trim() === "") throw new CliError("validation_error", "a folder needs a name")
      const connection = await online("chats folders create")
      const create = capability(connection, "createFolder", "create a folder")
      const chatIds = await ids(connection, chats)
      const rules = await rulesOf(connection, edit)
      const operationId = newOperationId()
      const folder = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "folder-create" },
        () => (Object.keys(rules).length > 0 ? create(title.trim(), chatIds, rules) : create(title.trim(), chatIds)),
      )
      return { operationId, folder }
    },

    update: async (folder, edit) => {
      if (!changes(edit)) throw new CliError("validation_error", "nothing to change — give --title, --add or --remove")
      const connection = await online("chats folders update")
      const update = capability(connection, "updateFolder", "change a folder")
      const { id } = await folderOf(connection, folder)
      const change = {
        ...(edit.title === undefined ? {} : { title: edit.title }),
        ...(edit.add?.length ? { add: await ids(connection, edit.add) } : {}),
        ...(edit.remove?.length ? { remove: await ids(connection, edit.remove) } : {}),
        ...(await rulesOf(connection, edit)),
      }
      const operationId = newOperationId()
      const changed = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "folder-update" },
        () => update(id, change),
      )
      return { operationId, folder: changed }
    },

    delete: async (folder) => {
      const connection = await online("chats folders delete")
      const remove = capability(connection, "deleteFolder", "delete a folder")
      const { id } = await folderOf(connection, folder)
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId: null, kind: "account", action: "folder-delete" }, () =>
        remove(id),
      )
      return { operationId, folderId: id }
    },

    order: async (typed) => {
      if (typed.length === 0) throw new CliError("validation_error", "name the folders in the order you want them")
      const connection = await online("chats folders order")
      const reorder = capability(connection, "orderFolders", "order folders")
      const named: Folder[] = []
      for (const one of typed) {
        const folder = await folderOf(connection, one)
        if (named.some((seen) => seen.id === folder.id))
          throw new CliError("validation_error", `"${one}" is named twice`)
        named.push(folder)
      }
      const all = await capability(connection, "folders", "list its folders")()
      const folders = [...named, ...all.filter((one) => !named.some((seen) => seen.id === one.id))]
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId: null, kind: "account", action: "folder-order" }, () =>
        reorder(folders.map((one) => one.id)),
      )
      return { operationId, folders: folders.map(({ id, title }) => ({ id, title })) }
    },

    join: async (link) => {
      if (link.trim() === "") throw new CliError("validation_error", "give the folder's link")
      const connection = await online("chats folders join")
      const join = capability(connection, "joinFolder", "join a shared folder")
      const operationId = newOperationId()
      const folder = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "folder-join" },
        () => join(link.trim()),
      )
      return { operationId, folder }
    },
  }
}
