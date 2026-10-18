import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { sendTime } from "../../domain/send-time.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import type { SendGuard } from "../../sends/guard.js"
import type { AccountService } from "../../services/account.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, tool, WRITE } from "../tool.js"

const OWN = "Only the owner sees it; nobody in the chat is told. Only when the owner asked for it."

/** The owner's own chat list — mute, archive, pin, unread — each behind the switch that mounts its command. */
export const chatStateTools = (messenger: Messenger): Record<string, AnyTool> => {
  const account = (adapter: MessengerAdapter, guard: SendGuard): AccountService =>
    servicesFor(onlineDeps(messenger, adapter, guard)).account
  const chat = chatOf(messenger)
  const onChat = (
    title: string,
    description: string,
    change: (service: AccountService, chat: string) => Promise<object>,
  ): AnyTool =>
    tool({
      title,
      description: `${description} ${OWN}`,
      input: v.object({ chat }),
      annotations: WRITE,
      permission: "profile",
      online: async (adapter, args, { guard }) => itemOf(snakeKeys(await change(account(adapter, guard), args.chat))),
    })
  return {
    ...(messenger.chatMute === true
      ? {
          chats_mute: tool({
            title: "Mute a chat",
            description: `Stop notifications from a chat, for good or until a time. ${OWN}`,
            input: v.object({
              chat,
              until: v.optional(
                v.pipe(
                  v.string(),
                  v.minLength(1),
                  v.description("only until then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d from now"),
                ),
              ),
            }),
            annotations: WRITE,
            permission: "profile",
            online: async (adapter, args, { guard }) =>
              itemOf(
                snakeKeys(
                  await account(adapter, guard).mute(
                    args.chat,
                    args.until === undefined ? "forever" : sendTime(args.until, Date.now(), "until"),
                  ),
                ),
              ),
          }),
          chats_unmute: onChat("Unmute a chat", "Hear a muted chat again.", (one, id) => one.mute(id, null)),
        }
      : {}),
    ...(messenger.chatArchive === true
      ? {
          chats_archive: onChat("Archive a chat", "Move a chat into the archive.", (one, id) => one.archive(id, true)),
          chats_unarchive: onChat("Unarchive a chat", "Bring an archived chat back to the chat list.", (one, id) =>
            one.archive(id, false),
          ),
        }
      : {}),
    ...(messenger.chatPin === true
      ? {
          chats_pin: onChat(
            "Pin a chat",
            "Keep a chat at the top of the owner's chat list; messages pin pins a message for everyone.",
            (one, id) => one.pinChat(id, true),
          ),
          chats_unpin: onChat("Unpin a chat", "Let a pinned chat move down the chat list again.", (one, id) =>
            one.pinChat(id, false),
          ),
        }
      : {}),
    ...(messenger.chatMarkUnread === true
      ? {
          chats_mark_unread: {
            ...onChat(
              "Mark a chat unread",
              "Mark a chat unread on the owner's own devices; chats mark-read undoes it, and that one the other side sees.",
              (one, id) => one.markUnread(id),
            ),
            command: "chats mark-unread",
          },
        }
      : {}),
  }
}
