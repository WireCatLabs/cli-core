import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import { folderAnswer, wholeList } from "../../cli/messenger/chat-answers.js"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import { FOLDER_KINDS, FOLDER_SKIPS, type FolderKind, type FolderSkip } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import type { FolderRulesEdit } from "../../services/folders.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, READ, tool, WRITE } from "../tool.js"

const folderRef = v.pipe(v.string(), v.minLength(1), v.description("folder id, or its title exactly"))
const chatList = v.optional(v.array(v.pipe(v.string(), v.minLength(1))))
const rules = {
  include: v.optional(
    v.pipe(v.array(v.picklist(FOLDER_KINDS)), v.description("every chat of these kinds; [] clears on update")),
  ),
  skip: v.optional(v.pipe(v.array(v.picklist(FOLDER_SKIPS)), v.description("leave out chats that are these"))),
  exclude_chats: v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.description("never in it"))),
  pin: v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.description("pinned at its top"))),
  emoji: v.optional(v.pipe(v.string(), v.minLength(1), v.description("the folder's icon"))),
}
const rulesOf = (args: {
  include?: FolderKind[] | undefined
  skip?: FolderSkip[] | undefined
  exclude_chats?: string[] | undefined
  pin?: string[] | undefined
  emoji?: string | undefined
}): FolderRulesEdit => ({
  ...(args.include === undefined ? {} : { include: args.include }),
  ...(args.skip === undefined ? {} : { skip: args.skip }),
  ...(args.exclude_chats === undefined ? {} : { exclude: args.exclude_chats }),
  ...(args.pin === undefined ? {} : { pin: args.pin }),
  ...(args.emoji === undefined ? {} : { emoji: args.emoji }),
})

/** The owner's chat folders: only the owner sees them, but each change is the owner's app changing. */
export const folderTools = (messenger: Messenger): Record<string, AnyTool> => {
  const folders = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).folders
  const definitions: Record<string, AnyTool> = {
    chats_folders_list: tool({
      title: "Chat folders",
      description:
        "The owner's chat folders, in the order the app shows them, with the chats added to each (chat_ids).",
      input: v.object({}),
      annotations: READ,
      output: { entity: "folder", list: true },
      online: async (adapter, _args, { guard }) =>
        wholeList("chats folders list", (await folders(adapter, guard).list()).map(folderAnswer)),
    }),
    chats_folders_show: tool({
      title: "One chat folder",
      description:
        "One of the owner's chat folders with the names of its chats. Returns { id, title, chats, pinned, " +
        "excluded }, each chat { id, title, kind }; a chat that cannot be found has title and kind null.",
      input: v.object({ folder: folderRef }),
      annotations: READ,
      online: async (adapter, args, { guard }) => itemOf(snakeKeys(await folders(adapter, guard).show(args.folder))),
    }),
    chats_folders_create: tool({
      title: "Create a chat folder",
      description: "Create a chat folder with these chats in it. Only when the owner asked.",
      input: v.object({ title: v.pipe(v.string(), v.minLength(1)), chats: chatList, ...rules }),
      annotations: WRITE,
      permission: "folders",
      online: async (adapter, args, { guard }) =>
        itemOf(snakeKeys(await folders(adapter, guard).create(args.title, args.chats ?? [], rulesOf(args)))),
    }),
    chats_folders_update: tool({
      title: "Change a chat folder",
      description: "Rename a chat folder, or add chats to it or take them out. Only when the owner asked.",
      input: v.object({
        folder: folderRef,
        title: v.optional(v.pipe(v.string(), v.minLength(1))),
        add: chatList,
        remove: chatList,
        ...rules,
      }),
      annotations: WRITE,
      permission: "folders",
      online: async (adapter, args, { guard }) =>
        itemOf(
          snakeKeys(
            await folders(adapter, guard).update(args.folder, {
              ...(args.title === undefined ? {} : { title: args.title }),
              ...(args.add ? { add: args.add } : {}),
              ...(args.remove ? { remove: args.remove } : {}),
              ...rulesOf(args),
            }),
          ),
        ),
    }),
    chats_folders_delete: tool({
      title: "Delete a chat folder",
      description: "Delete a chat folder; the chats in it stay. Only when the owner asked.",
      input: v.object({ folder: folderRef }),
      annotations: WRITE,
      permission: "folders",
      online: async (adapter, args, { guard }) => itemOf(snakeKeys(await folders(adapter, guard).delete(args.folder))),
    }),
    chats_folders_order: tool({
      title: "Order chat folders",
      description:
        "Put chat folders in this order, first one first; the ones not named keep their order after them. " +
        "Only when the owner asked.",
      input: v.object({ folders: v.pipe(v.array(folderRef), v.minLength(1)) }),
      annotations: WRITE,
      permission: "folders",
      online: async (adapter, args, { guard }) => itemOf(snakeKeys(await folders(adapter, guard).order(args.folders))),
    }),
    chats_folders_join: tool({
      title: "Join a shared chat folder",
      description:
        "Add a folder someone shared by a t.me/addlist/ link. This joins every chat in it, and the others there " +
        "see that the owner joined. Only when the owner asked for this exact link.",
      input: v.object({ link: v.pipe(v.string(), v.minLength(1)) }),
      annotations: WRITE,
      permission: "folders",
      online: async (adapter, args, { guard }) => itemOf(snakeKeys(await folders(adapter, guard).join(args.link))),
    }),
  }
  if (messenger.folderOrder === false) delete definitions.chats_folders_order
  if (messenger.folderJoin === false) delete definitions.chats_folders_join
  return definitions
}
