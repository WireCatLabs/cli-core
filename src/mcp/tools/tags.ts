import * as v from "valibot"
import { itemOf, listOf, snakeKeys } from "../../cli/envelope.js"
import { listQuery, queryArgument } from "../../cli/list-query.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { TAGGING_QUERY } from "../../services/tags.js"
import { type AnyTool, chatOf, limit, page, paging, READ, tool } from "../tool.js"

const LOCAL = { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
const TARGET =
  "One target: `chat` alone, `contact` (id, @username or name), `task` (its id or key), or `message` with `chat` " +
  "— or `message` as a msg: locator alone. Writes only to the local store; nothing is sent."

export const tagsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const input = v.object({
    tags: v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(64))),
      v.minLength(1),
      v.maxLength(32),
      v.description("tags: 1–32 letters a–z, digits and hyphens; upper case is lowered"),
    ),
    chat: v.optional(chatOf(messenger)),
    contact: v.optional(v.pipe(v.string(), v.minLength(1), v.description("a person: id, @username or name"))),
    message: v.optional(
      v.pipe(v.string(), v.minLength(1), v.description("a message id in `chat`, or a msg: locator alone")),
    ),
    task: v.optional(v.pipe(v.string(), v.minLength(1), v.description("a task's id or key, from `tasks list`"))),
  })
  const targetOf = (args: v.InferOutput<typeof input>) => ({
    ...(args.chat === undefined ? {} : { chat: args.chat }),
    ...(args.contact === undefined ? {} : { contact: args.contact }),
    ...(args.message === undefined ? {} : { message: args.message }),
    ...(args.task === undefined ? {} : { task: args.task }),
  })
  return {
    tags_list: tool({
      title: "List tags",
      description:
        "The owner's own tags in the local store: this account's tagged chats, messages and tasks, and the people of its " +
        "messenger. `tag:<tag>` in `search messages` finds the messages they label.",
      input: v.object({ query: queryArgument(TAGGING_QUERY), limit, page }),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "tagging", list: true },
      stored: async (store, account, args, defaults) => {
        const { size, number, window } = paging(args, defaults)
        const query = listQuery(args.query ?? "", TAGGING_QUERY, "tags list")
        const found = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).tags.list({
          ...window,
          ...(query ? { query } : {}),
        })
        return listOf("tags list", { items: found.items, limit: size, has_more: found.has_more, page: number })
      },
    }),

    tags_add: tool({
      title: "Tag a chat, person, message or task",
      description: `Puts tags on one chat, person, message or task. ${TARGET} Returns { item: { target, added, unchanged } }.`,
      input,
      annotations: { ...LOCAL, destructiveHint: false },
      stored: async (store, account, args, defaults) => {
        return itemOf(
          snakeKeys(
            await servicesFor(storedDeps(messenger, store, account, defaults.guard)).tags.add(
              targetOf(args),
              args.tags,
            ),
          ),
        )
      },
    }),

    tags_remove: tool({
      title: "Untag a chat, person, message or task",
      description: `Takes tags off one chat, person, message or task. ${TARGET} Returns { item: { target, removed, unchanged } }.`,
      input: v.object({ ...input.entries, source: v.optional(v.picklist(["manual", "auto"])) }),
      annotations: { ...LOCAL, destructiveHint: true },
      stored: async (store, account, args, defaults) => {
        return itemOf(
          snakeKeys(
            await servicesFor(storedDeps(messenger, store, account, defaults.guard)).tags.remove(
              targetOf(args),
              args.tags,
              args.source,
            ),
          ),
        )
      },
    }),
  }
}
