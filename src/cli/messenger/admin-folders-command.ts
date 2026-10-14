import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { FOLDER_KINDS, FOLDER_SKIPS } from "../../domain/models.js"
import { folder as folderEntity } from "../../entities/index.js"
import type { FolderRulesEdit } from "../../services/folders.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { listQuery, typedQuery, unfilteredQuery, withQuery } from "../list-query.js"
import { folderAnswer, lines, renderItem, wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

const collect = (value: string, previous: string[] = []) => [...previous, value]

const wordsOf =
  <T extends string>(flag: string, allowed: readonly T[]) =>
  (value: string): T[] => {
    if (value.trim() === "none") return []
    const words = value.split(",").map((one) => one.trim())
    const wrong = words.find((one) => !allowed.includes(one as T))
    if (wrong !== undefined)
      throw new CliError("validation_error", `${flag} takes ${allowed.join(", ")} or none — not "${wrong}"`)
    return words as T[]
  }

/** Offered only where the messenger's folders have rules, so a CLI never lists a flag it refuses. */
const withRules = (command: Command, messenger: Messenger, replaces: boolean): Command => {
  if (!messenger.folderRules) return command
  const set = replaces ? "; replaces what it had, none clears it" : ""
  return command
    .option(
      "--include <kinds>",
      `every chat of these kinds: ${FOLDER_KINDS.join(", ")}${set}`,
      wordsOf("--include", FOLDER_KINDS),
    )
    .option(
      "--skip <which>",
      `leave out chats that are ${FOLDER_SKIPS.join(", ")}${set}`,
      wordsOf("--skip", FOLDER_SKIPS),
    )
    .option("--exclude-chat <chat>", "never show this chat in it; repeat it for more", collect)
    .option("--pin <chat>", "pin this chat at the top of the folder; repeat it for more", collect)
    .option("--emoji <emoji>", "the folder's icon")
}

const rulesOf = (command: Command): FolderRulesEdit => {
  const { include, skip, excludeChat, pin, emoji } = command.opts<{
    include?: FolderRulesEdit["include"]
    skip?: FolderRulesEdit["skip"]
    excludeChat?: string[]
    pin?: string[]
    emoji?: string
  }>()
  return {
    ...(include === undefined ? {} : { include }),
    ...(skip === undefined ? {} : { skip }),
    ...(excludeChat === undefined ? {} : { exclude: excludeChat }),
    ...(pin === undefined ? {} : { pin }),
    ...(emoji === undefined ? {} : { emoji }),
  }
}

const FOLDERS_QUERY = unfilteredQuery("folder", folderEntity)

/** `chats folders …`, in max-cli's words. */
export const foldersCommand = (messenger: Messenger): Command => {
  const folders = new Command("folders").description("your chat folders")
  folders.addCommand(
    withQuery(
      annotate(new Command("list"), { effects: REMOTE_READ }).description(
        "your chat folders, in the order the app shows them",
      ),
      FOLDERS_QUERY,
    ).action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      listQuery(typedQuery(words), FOLDERS_QUERY, "chats folders list")
      const found = await context.withServices((services) => services.folders.list())
      renderAnswer(
        this,
        context,
        wholeList("chats folders list", found.map(folderAnswer)),
        lines(({ id, title, emoji, chat_ids }) => [id, emoji ?? "", title, `${chat_ids.length} chats`].join("  ")),
      )
    }),
  )
  folders.addCommand(
    annotate(
      annotate(new Command("show"), { effects: REMOTE_READ })
        .description("one chat folder, with the names of the chats in it")
        .argument("<folder>", "the folder's id, or its title exactly"),
      { output: { entity: "folder" } },
    ).action(async function (this: Command, folder: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.folders.show(folder))
      renderAnswer(this, context, itemOf(folderAnswer(found)))
    }),
  )
  folders.addCommand(
    withRules(
      annotate(new Command("create"), { effects: REMOTE_WRITE })
        .description("create a chat folder")
        .argument("<title>", "the folder's name; the app may refuse a long one")
        .option("--chat <chat>", "a chat to put in it, by id or name; repeat it for more", collect),
      messenger,
      false,
    ).action(async function (this: Command, title: string) {
      const context = messengerContext(this, messenger)
      const { chat = [] } = this.opts<{ chat?: string[] }>()
      const rules = rulesOf(this)
      renderItem(this, context, await context.withServices((services) => services.folders.create(title, chat, rules)))
    }),
  )
  folders.addCommand(
    withRules(
      annotate(new Command("update"), { effects: REMOTE_WRITE })
        .description("rename a folder, or change which chats are in it")
        .argument("<folder>", "folder id, or its title exactly")
        .option("--title <title>", "a new name")
        .option("--add <chat>", "put a chat in it; repeat it for more", collect)
        .option(
          "--remove <chat>",
          "take a chat out of it, and off its excluded and pinned lists; repeat it for more",
          collect,
        ),
      messenger,
      true,
    ).action(async function (this: Command, folder: string) {
      const context = messengerContext(this, messenger)
      const { title, add, remove } = this.opts<{ title?: string; add?: string[]; remove?: string[] }>()
      const edit = {
        ...(title === undefined ? {} : { title }),
        ...(add === undefined ? {} : { add }),
        ...(remove === undefined ? {} : { remove }),
        ...rulesOf(this),
      }
      renderItem(this, context, await context.withServices((services) => services.folders.update(folder, edit)))
    }),
  )
  folders.addCommand(
    annotate(new Command("delete"), { effects: REMOTE_WRITE })
      .description("delete a folder; the chats in it stay")
      .argument("<folder>", "folder id, or its title exactly")
      .action(async function (this: Command, folder: string) {
        const context = messengerContext(this, messenger)
        renderItem(this, context, await context.withServices((services) => services.folders.delete(folder)))
      }),
  )
  if (messenger.folderOrder !== false)
    folders.addCommand(
      annotate(new Command("order"), { effects: REMOTE_WRITE })
        .description("put folders in this order; the ones not named keep theirs after them")
        .argument("<folders...>", "folder ids, or titles exactly, first one first")
        .action(async function (this: Command, typed: string[]) {
          const context = messengerContext(this, messenger)
          renderItem(this, context, await context.withServices((services) => services.folders.order(typed)))
        }),
    )
  if (messenger.folderJoin !== false)
    folders.addCommand(
      annotate(new Command("join"), { effects: REMOTE_WRITE })
        .description(
          "add a folder someone shared by a link; joins every chat in it, and the others there see you joined",
        )
        .argument("<link>", "the folder's link, as t.me/addlist/…")
        .action(async function (this: Command, link: string) {
          const context = messengerContext(this, messenger)
          renderItem(this, context, await context.withServices((services) => services.folders.join(link)))
        }),
    )
  return folders
}
